import type { ToolExecutor, ToolCallResult } from "@prologue/prologue";
import type { ToolItem } from "@prologue/schemas";

/**
 * Shape of the OpenAPI-encoded schema field on a ToolItem produced by
 * `AppWorldAdapter.loadTools`. Mirrors OpenAPI 3.1 operation parameters
 * and requestBody.
 */
type OpenApiSchema = {
  parameters?: Array<{
    name: string;
    in: "path" | "query" | "header" | "cookie";
    required?: boolean;
    schema?: unknown;
  }>;
  requestBody?: {
    content?: Record<string, { schema?: unknown }>;
    required?: boolean;
  } | null;
};

type AppWorldToolMetadata = {
  app: string;
  method: string;
  path: string;
  summary?: string;
};

export type AppWorldToolExecutorConfig = {
  baseUrl: string;
};

/**
 * Calls AppWorld REST API endpoints described by OpenAPI ToolItems.
 *
 * The caller is responsible for auth: either pass `access_token` as a field
 * in `args` (AppWorld's convention; this class converts it to a Bearer header)
 * or call `setAccessToken(app, token)` once after login.
 */
export class AppWorldToolExecutor implements ToolExecutor {
  private readonly accessTokensByApp = new Map<string, string>();
  private defaultAccessToken: string | null = null;

  constructor(private readonly config: AppWorldToolExecutorConfig) {}

  setAccessToken(token: string | null): void;
  setAccessToken(app: string, token: string | null): void;
  setAccessToken(appOrToken: string | null, token?: string | null): void {
    if (token === undefined) {
      this.defaultAccessToken = appOrToken;
      return;
    }

    if (token === null) {
      this.accessTokensByApp.delete(String(appOrToken));
    } else {
      this.accessTokensByApp.set(String(appOrToken), token);
    }
  }

  getAccessToken(): string | null;
  getAccessToken(app: string): string | null;
  getAccessToken(app?: string): string | null {
    if (app) return this.accessTokensByApp.get(app) ?? null;
    return this.defaultAccessToken;
  }

  async call(tool: ToolItem, args: Record<string, unknown>): Promise<ToolCallResult> {
    const metadata = tool.metadata as AppWorldToolMetadata;
    const schema = (tool.schema ?? {}) as OpenApiSchema;

    if (!metadata?.app || !metadata?.method || !metadata?.path) {
      return { ok: false, output: null, error: "tool.metadata missing app/method/path" };
    }

    const { method, path } = metadata;
    // AppWorld OpenAPI paths already include the app prefix (e.g.
    // "/supervisor/profile", "/spotify/library/songs"), so the full URL is
    // baseUrl + path. The `app` field is used only for logging/metadata.

    let urlPath = path;
    const query: Record<string, string> = {};
    const headers: Record<string, string> = {};
    const remaining: Record<string, unknown> = {};

    for (const [k, v] of Object.entries(args)) {
      const param = schema.parameters?.find((p) => p.name === k);
      if (!param) {
        remaining[k] = v;
        continue;
      }
      if (param.in === "path") {
        urlPath = urlPath.replace(`{${k}}`, encodeURIComponent(String(v)));
      } else if (param.in === "query") {
        query[k] = String(v);
      } else if (param.in === "header") {
        headers[k] = String(v);
      } else {
        remaining[k] = v;
      }
    }

    // Auth: AppWorld convention — access_token as a data field becomes Bearer.
    if (typeof remaining.access_token === "string") {
      headers["Authorization"] = `Bearer ${remaining.access_token}`;
      delete remaining.access_token;
    } else {
      const token = this.getAccessToken(metadata.app) ?? this.getAccessToken();
      if (token) headers["Authorization"] = `Bearer ${token}`;
    }

    // Body: form-urlencoded if the OpenAPI content-type says so, else JSON.
    const requestBodyContent = schema.requestBody?.content ?? {};
    const isForm = "application/x-www-form-urlencoded" in requestBodyContent;
    let body: string | undefined;
    if (Object.keys(remaining).length > 0) {
      body = isForm
        ? new URLSearchParams(remaining as Record<string, string>).toString()
        : JSON.stringify(remaining);
      headers["Content-Type"] = isForm
        ? "application/x-www-form-urlencoded"
        : "application/json";
    }

    const url = new URL(`${this.config.baseUrl}${urlPath}`);
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);

    try {
      const res = await fetch(url, { method: method.toUpperCase(), headers, body });
      const text = await res.text();
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = { raw: text };
      }
      // 2xx = success; 4xx = client error (return structured error for LLM);
      // 5xx = server error (return as error)
      const ok = res.status >= 200 && res.status < 300;
      return {
        ok,
        status: res.status,
        output: parsed,
        error: ok ? undefined : `HTTP ${res.status}`,
      };
    } catch (e) {
      return {
        ok: false,
        output: null,
        error: e instanceof Error ? e.message : String(e),
      };
    }
  }
}
