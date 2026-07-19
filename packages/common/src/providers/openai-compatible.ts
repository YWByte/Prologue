import type { LlmCallInput, LlmCallOutput, LlmClient, TokenUsage } from "../index.js";

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
    if (!model) throw new Error("No model specified and no default model configured.");

    const body = {
      model,
      messages: input.messages,
      temperature: input.temperature ?? this.config.defaultTemperature,
      max_tokens: input.maxTokens ?? this.config.defaultMaxTokens,
      ...(input.stop ? { stop: input.stop } : {}),
      ...(input.enableThinking !== undefined ? { enable_thinking: input.enableThinking } : {}),
    };

    let lastError: Error | undefined;
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
          throw new Error(`HTTP ${response.status}: ${text.slice(0, 500)}`);
        }

        const data = (await response.json()) as OpenAiCompatibleResponse;
        if (data.error) {
          throw new Error(`API error: ${data.error.message ?? "unknown"} (${data.error.type ?? data.error.code ?? "no type"})`);
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
        lastError = error instanceof Error ? error : new Error(String(error));
        if (attempt < this.config.maxRetries) {
          // 429 (rate limit, esp. TPM) needs longer backoff than other errors
          const isRateLimit = lastError.message.includes("HTTP 429") || lastError.message.includes("rate limit");
          const backoffMs = isRateLimit
            ? Math.min(30_000 * (attempt + 1), 90_000)
            : Math.min(1000 * 2 ** attempt, 8000);
          await new Promise((resolve) => setTimeout(resolve, backoffMs));
        }
      }
    }

    throw lastError ?? new Error("LLM call failed after retries.");
  }
}
