import { describe, expect, it } from "vitest";
import type { LlmClient, LlmMessage } from "@prologue/common";
import type { ToolItem } from "@prologue/schemas";
import { LlmAppWorldAgent } from "../src/executors/appworld_llm_agent.js";
import { AppWorldToolExecutor } from "../src/executors/appworld_http.js";

function makeTool(id: string, app: string, method: string, path: string): ToolItem {
  return {
    id,
    name: id,
    description: id,
    type: "api",
    schema: { parameters: [], requestBody: null },
    metadata: { app, method, path },
  };
}

describe("LlmAppWorldAgent token handling", () => {
  it("stores tokens per app and redacts them from trajectory steps", async () => {
    const requests: Array<{ url: string; headers: Record<string, string>; body?: string }> = [];
    const originalFetch = globalThis.fetch;
    (globalThis as { fetch: unknown }).fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof URL ? input.toString() : typeof input === "string" ? input : input.url;
      const headers = (init?.headers ?? {}) as Record<string, string>;
      requests.push({ url, headers, body: typeof init?.body === "string" ? init.body : undefined });

      if (url.endsWith("/spotify/auth/token")) {
        return new Response(JSON.stringify({ access_token: "spotify-token" }), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    };

    const responses = [
      "TOOL_CALL spotify__login {\"username\":\"user@example.com\",\"password\":\"secret\"}",
      "TOOL_CALL spotify__show_profile {}",
      "COMPLETE done",
    ];
    const llm: LlmClient = {
      async call(_request: { model: string; messages: LlmMessage[] }) {
        return { content: responses.shift() ?? "COMPLETE done" };
      },
    };

    try {
      const executor = new AppWorldToolExecutor({ baseUrl: "http://localhost:8000" });
      const agent = new LlmAppWorldAgent({
        llm,
        model: "test-model",
        toolExecutor: executor,
        maxSteps: 5,
        input: {
          taskId: "task_1",
          source: "appworld",
          condition: "baseline",
          query: "show profile",
          memory: [],
          tools: [
            makeTool("spotify__login", "spotify", "post", "/spotify/auth/token"),
            makeTool("spotify__show_profile", "spotify", "get", "/spotify/profile"),
            makeTool("supervisor__complete_task", "supervisor", "post", "/supervisor/task/complete"),
          ],
          usesOracleIntent: false,
          usesOracleMemory: false,
          usesOracleTool: false,
        },
      });

      const result = await agent.run();
      const serializedSteps = JSON.stringify(result.steps);
      const profileRequest = requests.find((request) => request.url.endsWith("/spotify/profile"));

      expect(profileRequest?.headers.Authorization).toBe("Bearer spotify-token");
      expect(serializedSteps).not.toContain("spotify-token");
      expect(serializedSteps).not.toContain("secret");
      expect(serializedSteps).toContain("[REDACTED]");
    } finally {
      (globalThis as { fetch: unknown }).fetch = originalFetch;
    }
  });
});
