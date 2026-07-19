// Unit tests for AppWorldToolExecutor URL building logic
// Verifies: multi path params, path+body combination, array body serialization
import { describe, it, expect } from "vitest";
import { AppWorldToolExecutor } from "../src/executors/appworld_http.js";
import type { ToolItem } from "@prologue/schemas";

// Helper: build a ToolItem from OpenAPI-like schema
function makeTool(opts: {
  operationId: string;
  app: string;
  method: string;
  path: string;
  parameters?: Array<{ name: string; in: "path" | "query" | "header"; required?: boolean; schema?: unknown }>;
  requestBody?: { content: Record<string, { schema?: unknown }>; required?: boolean } | null;
}): ToolItem {
  return {
    id: opts.operationId,
    name: opts.operationId,
    description: opts.operationId,
    type: "api",
    schema: {
      parameters: opts.parameters ?? [],
      requestBody: opts.requestBody ?? null,
    },
    metadata: {
      app: opts.app,
      method: opts.method,
      path: opts.path,
    },
  };
}

// Mock fetch that returns the request info so we can inspect it
type CapturedRequest = {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
};

async function captureRequest(fn: () => Promise<void>): Promise<CapturedRequest> {
  const calls: CapturedRequest[] = [];
  const originalFetch = globalThis.fetch;
  (globalThis as { fetch: unknown }).fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof URL ? input.toString() : typeof input === "string" ? input : input.url;
    const headers: Record<string, string> = {};
    if (init?.headers) {
      const h = init.headers as Record<string, string>;
      for (const [k, v] of Object.entries(h)) headers[k] = v;
    }
    calls.push({
      url,
      method: init?.method ?? "GET",
      headers,
      body: typeof init?.body === "string" ? init.body : undefined,
    });
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  try {
    await fn();
  } finally {
    (globalThis as { fetch: unknown }).fetch = originalFetch;
  }
  return calls[0];
}

describe("AppWorldToolExecutor URL building", () => {
  const executor = new AppWorldToolExecutor({ baseUrl: "http://localhost:8000" });

  it("handles single path param", async () => {
    const tool = makeTool({
      operationId: "spotify__follow_artist",
      app: "spotify",
      method: "post",
      path: "/spotify/following_artists/{artist_id}",
      parameters: [{ name: "artist_id", in: "path", required: true, schema: { type: "integer" } }],
    });
    const req = await captureRequest(() =>
      executor.call(tool, { artist_id: 14 }).then(() => Promise.resolve()),
    );
    expect(req.url).toBe("http://localhost:8000/spotify/following_artists/14");
    expect(req.method).toBe("POST");
  });

  it("handles multiple path params (gmail__delete_email_in_thread)", async () => {
    const tool = makeTool({
      operationId: "gmail__delete_email_in_thread",
      app: "gmail",
      method: "delete",
      path: "/gmail/email_threads/{email_thread_id}/emails/{email_id}",
      parameters: [
        { name: "email_thread_id", in: "path", required: true, schema: { type: "integer" } },
        { name: "email_id", in: "path", required: true, schema: { type: "integer" } },
      ],
    });
    const req = await captureRequest(() =>
      executor.call(tool, { email_thread_id: 5, email_id: 12 }).then(() => Promise.resolve()),
    );
    expect(req.url).toBe("http://localhost:8000/gmail/email_threads/5/emails/12");
    expect(req.method).toBe("DELETE");
  });

  it("handles path + body combination (gmail__reply_to_email)", async () => {
    const tool = makeTool({
      operationId: "gmail__reply_to_email",
      app: "gmail",
      method: "post",
      path: "/gmail/email_threads/{email_thread_id}/emails/{email_id}/reply",
      parameters: [
        { name: "email_thread_id", in: "path", required: true, schema: { type: "integer" } },
        { name: "email_id", in: "path", required: true, schema: { type: "integer" } },
      ],
      requestBody: {
        content: {
          "application/json": {
            schema: {
              type: "object",
              properties: {
                email_addresses: { type: "array", items: { type: "string" } },
                body: { type: "string" },
              },
            },
          },
        },
      },
    });
    const req = await captureRequest(() =>
      executor.call(tool, {
        email_thread_id: 5,
        email_id: 12,
        email_addresses: ["a@x.com", "b@y.com"],
        body: "hello",
      }).then(() => Promise.resolve()),
    );
    expect(req.url).toBe("http://localhost:8000/gmail/email_threads/5/emails/12/reply");
    expect(req.method).toBe("POST");
    expect(req.headers["Content-Type"]).toBe("application/json");
    const body = JSON.parse(req.body!);
    expect(body.email_addresses).toEqual(["a@x.com", "b@y.com"]);
    expect(body.body).toBe("hello");
  });

  it("handles array body field in JSON mode", async () => {
    const tool = makeTool({
      operationId: "gmail__send_email",
      app: "gmail",
      method: "post",
      path: "/gmail/emails",
      requestBody: {
        content: {
          "application/json": {
            schema: {
              type: "object",
              properties: {
                email_addresses: { type: "array", items: { type: "string" } },
              },
            },
          },
        },
      },
    });
    const req = await captureRequest(() =>
      executor.call(tool, { email_addresses: ["a@x.com", "b@y.com", "c@z.com"] }).then(() => Promise.resolve()),
    );
    expect(req.headers["Content-Type"]).toBe("application/json");
    const body = JSON.parse(req.body!);
    expect(body.email_addresses).toEqual(["a@x.com", "b@y.com", "c@z.com"]);
  });

  it("handles form-urlencoded body", async () => {
    const tool = makeTool({
      operationId: "spotify__login",
      app: "spotify",
      method: "post",
      path: "/spotify/auth/token",
      requestBody: {
        content: {
          "application/x-www-form-urlencoded": {
            schema: {
              type: "object",
              properties: {
                username: { type: "string" },
                password: { type: "string" },
              },
            },
          },
        },
      },
    });
    const req = await captureRequest(() =>
      executor.call(tool, { username: "user@test.com", password: "pass123" }).then(() => Promise.resolve()),
    );
    expect(req.headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
    expect(req.body).toBe("username=user%40test.com&password=pass123");
  });

  it("handles query params", async () => {
    const tool = makeTool({
      operationId: "spotify__search_artists",
      app: "spotify",
      method: "get",
      path: "/spotify/artists",
      parameters: [
        { name: "query", in: "query", schema: { type: "string" } },
        { name: "page_limit", in: "query", schema: { type: "integer" } },
        { name: "genre", in: "query", schema: { type: "string" } },
      ],
    });
    const req = await captureRequest(() =>
      executor.call(tool, { query: "", page_limit: 20, genre: "classical" }).then(() => Promise.resolve()),
    );
    expect(req.url).toContain("/spotify/artists?");
    expect(req.url).toContain("page_limit=20");
    expect(req.url).toContain("genre=classical");
  });

  it("injects access_token as Bearer header when set", async () => {
    const executorWithToken = new AppWorldToolExecutor({ baseUrl: "http://localhost:8000" });
    executorWithToken.setAccessToken("test-token-123");
    const tool = makeTool({
      operationId: "spotify__show_profile",
      app: "spotify",
      method: "get",
      path: "/spotify/profile",
    });
    const req = await captureRequest(() => executorWithToken.call(tool, {}).then(() => Promise.resolve()));
    expect(req.headers["Authorization"]).toBe("Bearer test-token-123");
  });

  it("keeps access tokens separated by app", async () => {
    const executorWithTokens = new AppWorldToolExecutor({ baseUrl: "http://localhost:8000" });
    executorWithTokens.setAccessToken("spotify", "spotify-token");
    executorWithTokens.setAccessToken("venmo", "venmo-token");

    const spotifyTool = makeTool({
      operationId: "spotify__show_profile",
      app: "spotify",
      method: "get",
      path: "/spotify/profile",
    });
    const venmoTool = makeTool({
      operationId: "venmo__show_profile",
      app: "venmo",
      method: "get",
      path: "/venmo/profile",
    });

    const spotifyReq = await captureRequest(() => executorWithTokens.call(spotifyTool, {}).then(() => Promise.resolve()));
    const venmoReq = await captureRequest(() => executorWithTokens.call(venmoTool, {}).then(() => Promise.resolve()));

    expect(spotifyReq.headers["Authorization"]).toBe("Bearer spotify-token");
    expect(venmoReq.headers["Authorization"]).toBe("Bearer venmo-token");
  });

  it("uses explicit access_token args before stored app tokens", async () => {
    const executorWithTokens = new AppWorldToolExecutor({ baseUrl: "http://localhost:8000" });
    executorWithTokens.setAccessToken("spotify", "stored-token");
    const tool = makeTool({
      operationId: "spotify__show_profile",
      app: "spotify",
      method: "get",
      path: "/spotify/profile",
    });

    const req = await captureRequest(() => executorWithTokens.call(tool, { access_token: "explicit-token" }).then(() => Promise.resolve()));

    expect(req.headers["Authorization"]).toBe("Bearer explicit-token");
  });
});
