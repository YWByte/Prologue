import type { LlmCallInput, LlmCallOutput, LlmClient, TokenUsage } from "../index.js";

/**
 * Typed LLM call error. Distinguishes permanent failures (which will never
 * succeed no matter how many times we retry) from transient failures (which
 * may resolve on retry).
 *
 * Callers (executors, runner scripts) can inspect `permanent` to decide
 * whether to circuit-break the whole batch.
 */
export class LlmCallError extends Error {
  readonly permanent: boolean;
  readonly httpStatus?: number;
  readonly errorCode?: string;

  constructor(message: string, opts: { permanent: boolean; httpStatus?: number; errorCode?: string; cause?: unknown }) {
    super(message);
    this.name = "LlmCallError";
    this.permanent = opts.permanent;
    this.httpStatus = opts.httpStatus;
    this.errorCode = opts.errorCode;
    if (opts.cause !== undefined) {
      (this as { cause?: unknown }).cause = opts.cause;
    }
  }
}

/**
 * Error codes that indicate a PERMANENT failure — retrying won't help.
 * The account/quota/model configuration is wrong and must be fixed by an
 * operator before any further calls can succeed.
 *
 * Sources: OpenAI / Dashscope / SiliconFlow error conventions.
 */
const PERMANENT_ERROR_CODES = new Set([
  "invalid_api_key",
  "invalid_auth",
  "account_deactivated",
  "model_not_found",
  "model_not_available",
  "context_length_exceeded",
  "content_policy_violation",
  "content_filter",
]);

/**
 * Error codes that indicate a TRANSIENT 429 — the request is valid but the
 * account is temporarily over its rate limit. Retrying with backoff may help.
 */
const TRANSIENT_RATE_LIMIT_CODES = new Set([
  "rate_limit_exceeded",
  "request_limit_exceeded",
  "tpm_limit_exceeded",
  "rpm_limit_exceeded",
  "limit_burst_rate",
  "insufficient_quota",
]);

/**
 * Classify an HTTP error response body. Returns an LlmCallError with the
 * `permanent` flag set, or null if classification isn't possible from the
 * body (caller falls back to a generic transient error).
 */
function classifyApiError(httpStatus: number, bodyText: string): LlmCallError | null {
  type ApiErrorBody = { error?: { message?: string; type?: string; code?: string } };
  let parsed: ApiErrorBody | null = null;
  try {
    parsed = JSON.parse(bodyText) as ApiErrorBody;
  } catch {
    // Body isn't JSON.
  }

  const errBody = parsed?.error;
  const message = errBody?.message ?? bodyText.slice(0, 200) ?? "unknown API error";
  const code = errBody?.code;
  const type = errBody?.type;

  // 1. Permanent error codes (insufficient_quota, invalid_api_key, etc.) —
  //    these are returned with various HTTP statuses by different providers
  //    (OpenAI uses 429 for insufficient_quota, others use 401/403). The code
  //    is the authoritative signal.
  if (typeof code === "string" && PERMANENT_ERROR_CODES.has(code)) {
    return new LlmCallError(message, { permanent: true, httpStatus, errorCode: code });
  }
  if (typeof type === "string" && PERMANENT_ERROR_CODES.has(type)) {
    return new LlmCallError(message, { permanent: true, httpStatus, errorCode: type });
  }

  // 2. Auth errors (401/403) are always permanent.
  if (httpStatus === 401 || httpStatus === 403) {
    return new LlmCallError(message, {
      permanent: true,
      httpStatus,
      errorCode: code ?? type ?? "auth_error",
    });
  }

  // 3. 429 handling:
  //    - With a transient rate-limit code, or no code at all → retry.
  //    - With an unknown code → be conservative, treat as permanent (avoids
  //      wasting 180s on retries when the account is misconfigured).
  if (httpStatus === 429) {
    const codeOrType = code ?? type ?? "rate_limit_exceeded";
    if (TRANSIENT_RATE_LIMIT_CODES.has(codeOrType) || !code) {
      return new LlmCallError(message, { permanent: false, httpStatus, errorCode: codeOrType });
    }
    return new LlmCallError(message, { permanent: true, httpStatus, errorCode: codeOrType });
  }

  // 4. Other 4xx (except 408 Request Timeout) → permanent (bad request).
  if (httpStatus >= 400 && httpStatus < 500 && httpStatus !== 408) {
    return new LlmCallError(message, {
      permanent: true,
      httpStatus,
      errorCode: code ?? type ?? `http_${httpStatus}`,
    });
  }

  // 5. 5xx / 408 / network → transient.
  return new LlmCallError(message, {
    permanent: false,
    httpStatus,
    errorCode: code ?? type ?? `http_${httpStatus}`,
  });
}

export type ProviderConfig = {
  apiKey: string;
  baseUrl: string;
  defaultModel?: string;
  defaultTemperature?: number;
  defaultMaxTokens?: number;
  timeoutMs?: number;
  maxRetries?: number;
  /** Requests per minute. Default 500. */
  rpm?: number;
  /** Max concurrent in-flight requests. Default 20. */
  maxConcurrency?: number;
};

export type OpenAiCompatibleResponse = {
  id?: string;
  choices?: Array<{
    message?: { role?: string; content?: string };
    finish_reason?: string;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
  error?: { message?: string; type?: string; code?: string };
};

type RunSlot<T> = {
  resolve: (value: T) => void;
  reject: (error: Error) => void;
  task: () => Promise<T>;
};

class RateLimiter {
  private readonly minIntervalMs: number;
  private readonly maxConcurrency: number;
  private lastRequestTime = 0;
  private activeCount = 0;
  private readonly queue: Array<RunSlot<unknown>> = [];

  constructor(rpm: number, maxConcurrency: number) {
    this.minIntervalMs = Math.max(1, Math.floor(60_000 / rpm));
    this.maxConcurrency = Math.max(1, maxConcurrency);
  }

  async run<T>(task: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.queue.push({
        resolve: resolve as (value: unknown) => void,
        reject,
        task: task as () => Promise<unknown>,
      });
      void this.scheduleNext();
    });
  }

  private scheduleNext(): void {
    if (this.activeCount >= this.maxConcurrency || this.queue.length === 0) return;

    const now = Date.now();
    const elapsed = now - this.lastRequestTime;
    const waitMs = elapsed < this.minIntervalMs ? this.minIntervalMs - elapsed : 0;

    setTimeout(() => {
      const slot = this.queue.shift();
      if (!slot) return;

      this.lastRequestTime = Date.now();
      this.activeCount += 1;

      slot.task()
        .then((value) => slot.resolve(value as never))
        .catch((error: unknown) => slot.reject(error instanceof Error ? error : new Error(String(error))))
        .finally(() => {
          this.activeCount -= 1;
          void this.scheduleNext();
        });

      // try to schedule another slot immediately (up to concurrency limit)
      void this.scheduleNext();
    }, waitMs);
  }
}

export class OpenAiCompatibleClient implements LlmClient {
  protected readonly config: Required<Omit<ProviderConfig, "defaultModel">> & { defaultModel?: string };
  private readonly limiter: RateLimiter;

  constructor(config: ProviderConfig) {
    this.config = {
      timeoutMs: 120_000,
      maxRetries: 3,
      defaultTemperature: 0.7,
      defaultMaxTokens: 4096,
      rpm: 500,
      maxConcurrency: 20,
      ...config,
    };
    this.limiter = new RateLimiter(this.config.rpm, this.config.maxConcurrency);
  }

  async call(input: LlmCallInput): Promise<LlmCallOutput> {
    return this.limiter.run(() => this.callInternal(input));
  }

  private async callInternal(input: LlmCallInput): Promise<LlmCallOutput> {
    const model = input.model || this.config.defaultModel;
    if (!model) throw new LlmCallError("No model specified and no default model configured.", { permanent: true });

    const body = {
      model,
      messages: input.messages,
      temperature: input.temperature ?? this.config.defaultTemperature,
      max_tokens: input.maxTokens ?? this.config.defaultMaxTokens,
      ...(input.stop ? { stop: input.stop } : {}),
      ...(input.enableThinking !== undefined ? { enable_thinking: input.enableThinking } : {}),
    };

    let lastError: LlmCallError | undefined;
    for (let attempt = 0; attempt <= this.config.maxRetries; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);
      try {
        const response = await fetch(`${this.config.baseUrl}/chat/completions`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${this.config.apiKey}`,
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        clearTimeout(timer);

        if (!response.ok) {
          const text = await response.text().catch(() => "");
          const classified = classifyApiError(response.status, text);
          if (classified) {
            // Permanent errors: fail immediately, do NOT retry. Retrying an
            // insufficient_quota / invalid_api_key just wastes 180s of
            // backoff for no benefit.
            if (classified.permanent) {
              throw classified;
            }
            // Transient: record and fall through to retry path.
            lastError = classified;
          } else {
            // Unclassifiable HTTP error — treat as transient.
            lastError = new LlmCallError(`HTTP ${response.status}: ${text.slice(0, 500)}`, {
              permanent: false,
              httpStatus: response.status,
            });
          }
          // Fall through to retry path (handled by the catch below for
          // backoff, or the loop exits).
          if (attempt < this.config.maxRetries) {
            const isRateLimit = lastError.httpStatus === 429 || lastError.message.includes("rate limit");
            const backoffMs = isRateLimit
              ? Math.min(30_000 * (attempt + 1), 90_000)
              : Math.min(1000 * 2 ** attempt, 8000);
            await new Promise((resolve) => setTimeout(resolve, backoffMs));
            continue;
          }
          throw lastError;
        }

        const data = (await response.json()) as OpenAiCompatibleResponse;
        if (data.error) {
          // Some providers return 200 with an error body — treat as permanent
          // if the code matches, else transient.
          const code = data.error.code ?? data.error.type ?? "";
          const permanent = PERMANENT_ERROR_CODES.has(code);
          throw new LlmCallError(
            `API error: ${data.error.message ?? "unknown"} (${data.error.type ?? data.error.code ?? "no type"})`,
            { permanent, errorCode: code },
          );
        }

        const content = data.choices?.[0]?.message?.content ?? "";
        const tokenUsage: TokenUsage | undefined = data.usage
          ? {
              input: data.usage.prompt_tokens ?? 0,
              output: data.usage.completion_tokens ?? 0,
              total: data.usage.total_tokens ?? 0,
            }
          : undefined;

        return { content, tokenUsage, raw: data };
      } catch (error) {
        clearTimeout(timer);
        // LlmCallError with permanent=true must NOT be retried — rethrow.
        if (error instanceof LlmCallError && error.permanent) {
          throw error;
        }
        // Convert unknown errors to LlmCallError (transient by default —
        // covers network blips, abort timeouts, etc.).
        if (!(error instanceof LlmCallError)) {
          const msg = error instanceof Error ? error.message : String(error);
          lastError = new LlmCallError(msg, { permanent: false, cause: error });
        } else {
          lastError = error;
        }
        if (attempt < this.config.maxRetries) {
          const isRateLimit = lastError.httpStatus === 429 || lastError.message.includes("rate limit");
          const backoffMs = isRateLimit
            ? Math.min(30_000 * (attempt + 1), 90_000)
            : Math.min(1000 * 2 ** attempt, 8000);
          await new Promise((resolve) => setTimeout(resolve, backoffMs));
          continue;
        }
      }
    }

    throw lastError ?? new LlmCallError("LLM call failed after retries.", { permanent: false });
  }
}
