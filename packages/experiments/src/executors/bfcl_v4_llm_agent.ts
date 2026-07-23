import { randomUUID } from "node:crypto";
import type { LlmClient, LlmMessage } from "@prologue/common";
import type { ExecutorInput, ToolCallResult } from "@prologue/prologue";
import type { MemoryItem, ToolItem, TrajectoryStep } from "@prologue/schemas";

/**
 * Real ReAct LLM agent for BFCL V4 Memory track tasks.
 *
 * Modeled on `LlmAppWorldAgent`, but BFCL has no REST backend — the
 * "memory backend" is conceptual. Tool calls are simulated in-process
 * against `input.memory` (pure function, no I/O).
 *
 * Protocol (same as AppWorld agent):
 *   - Each LLM response MUST start with `TOOL_CALL <id> <json>` or
 *     `COMPLETE <answer>`.
 *   - The agent loops up to `maxSteps` (default 60, generous for
 *     single-turn Q&A — most runs should COMPLETE in 3-5 steps).
 *
 * RQ1 attribution semantics:
 *   - The LLM NEVER reads `memory.metadata`. Only `content`, `id`, `type`
 *     and the `memoryRole` tag (oracle/common/distractor) are surfaced via
 *     the user prompt. Eval-only fields (`goldAnswerCandidates`,
 *     `sourceSnippet`) are invisible to the LLM — they live in the executor.
 *   - When `usesOracleMemory` is false (baseline / oracle_intent /
 *     oracle_tool), the prereq conversation is NOT in `input.memory`, so
 *     the LLM cannot retrieve the answer → eval fails by design.
 *
 * `hasOracleMemory` is computed by inspecting `input.memory.metadata.oracle`
 * for trajectory logging only — it is NOT shared with the LLM.
 */
export type BfclLlmAgentConfig = {
  llm: LlmClient;
  model: string;
  input: ExecutorInput;
  maxSteps?: number;
  maxTokens?: number;
  enableThinking?: boolean;
};

export type BfclLlmAgentResult = {
  steps: TrajectoryStep[];
  derivedAnswer: string;
  success: boolean;
  hasOracleMemory: boolean;
  reason: string;
};

type ParsedResponse =
  | { toolId: string; args: Record<string, unknown> }
  | { action: "complete"; answer: string };

const DEFAULT_MAX_STEPS = 60;
const DEFAULT_MAX_TOKENS = 4096;
const TOOL_OUTPUT_MAX_CHARS = 4000;

function now(): string {
  return new Date().toISOString();
}

/**
 * Build the system prompt: static skeleton + dynamic tool list rendered
 * from `input.tools`. Tool descriptions use `tool.description` plus a
 * compact rendering of `tool.schema.parameters.properties` (BFCL shape:
 * `{type, properties, required}`).
 *
 * MUST NOT mention `goldAnswerCandidates`, `oracle`, `sourceSnippet`, or
 * any metadata field — those are eval-only.
 */
function buildSystemPrompt(tools: ToolItem[]): string {
  const toolList = tools
    .map((t) => {
      const schema = (t.schema ?? {}) as {
        parameters?: {
          properties?: Record<string, { type?: string; description?: string }>;
          required?: string[];
        };
      };
      const props = schema.parameters?.properties ?? {};
      const required = new Set(schema.parameters?.required ?? []);
      const paramParts: string[] = [];
      for (const [name, prop] of Object.entries(props)) {
        const type = prop?.type ?? "?";
        const desc = (prop?.description ?? "").toString().trim();
        const descShort = desc ? `:${desc.slice(0, 60)}` : "";
        const reqMark = required.has(name) ? "*" : "";
        paramParts.push(`${name}${reqMark}(${type})${descShort}`);
      }
      const params = paramParts.length > 0 ? paramParts.join(", ") : "(none)";
      const desc = (t.description ?? "").toString().trim().slice(0, 120);
      return `- ${t.id}: ${desc} [params: ${params}]`;
    })
    .join("\n");

  return [
    "You are an autonomous agent operating in a memory-backed environment.",
    "You must answer the user's question by querying your memory state via the provided memory-operation tools, then return a final answer.",
    "",
    "Available memory tools:",
    toolList,
    "",
    "Response format (STRICT):",
    "- Each response MUST be EXACTLY one line, starting with TOOL_CALL or COMPLETE.",
    "- No explanation, no reasoning, no markdown, no multi-line output before the command.",
    "- If you want to think, do it silently; only output the final command line.",
    "",
    "To call a tool:",
    "TOOL_CALL <tool_id> <json_args>",
    'Example: TOOL_CALL archival_memory_key_search {"query": "user first name"}',
    "Example: TOOL_CALL core_memory_list_keys {}",
    "",
    "To return the final answer:",
    "COMPLETE <answer>",
    "Example: COMPLETE Michael",
    "",
    "Tool semantics:",
    "- *_list_keys: returns all keys (memory item IDs) currently in memory.",
    "- *_key_search {query, k?}: case-insensitive substring search over memory contents; returns ranked (key, score) pairs. Default k=5.",
    "- *_retrieve {key}: fetch the full content for an exact key match.",
    "- *_retrieve_all: dump every (key, value) pair in memory.",
    "- *_add / *_clear / *_remove / *_replace: mutation tools — no-ops in this eval environment (do not call).",
    "",
    "Rules:",
    "- ALWAYS start your response with TOOL_CALL or COMPLETE. Never start with any other text.",
    "- Some memory is pre-staged in the prompt (under 'Pre-staged context'); some is only available via memory tools (under 'Available in memory backend').",
    "- Read pre-staged context carefully before deciding whether a memory tool is needed.",
    "- Otherwise, use the available retrieval tools to find the relevant conversation.",
    "- Most questions are answerable in 0-3 tool calls. Do not over-search.",
    "- When you have the answer, emit COMPLETE <answer>. The answer must be the concise factual value (e.g. \"Michael\", \"35\", \"Diabetes\", \"Legend Investments\"), not a full sentence.",
    "- If a key_search returns multiple results, retrieve the highest-ranked one and read its content carefully to extract the answer.",
  ].join("\n");
}

/**
 * Build the user prompt.
 *
 * RQ1 direction A design: only memory items with `metadata.promptInjected === true`
 * are FULLY expanded in the user prompt. Other memory items are listed by ID
 * only under "Available in memory backend (use tools to retrieve)".
 *
 * This makes the failure mode meaningful: baseline has the prereq conversation
 * in `input.memory` (physically reachable via tools) but NOT in the prompt,
 * so the agent must actively call `list_keys` / `retrieve` / `key_search` to
 * read it. If the agent doesn't retrieve (or retrieves the wrong chunk),
 * it fails — which is the "context exists but wasn't pre-staged in the
 * starting prompt" failure mode the paper attributes to insufficient
 * pre-execution context.
 *
 * The `[oracle]` / `[common]` / `[distractor]` tag is fine to expose — it
 * tells the LLM which chunk is the authoritative pre-staged context. The
 * LLM still has to extract the answer from the content; nothing about the
 * gold answer itself is leaked.
 */
function buildUserPrompt(input: ExecutorInput): string {
  const promptInjected: MemoryItem[] = [];
  const toolOnly: MemoryItem[] = [];
  for (const m of input.memory) {
    const meta = m.metadata as Record<string, unknown> | undefined;
    if (meta?.promptInjected === true) {
      promptInjected.push(m);
    } else {
      toolOnly.push(m);
    }
  }

  const injectedText =
    promptInjected.length > 0
      ? promptInjected
          .map((m) => {
            const meta = m.metadata as Record<string, unknown> | undefined;
            const role = (meta?.memoryRole as string) ?? "common";
            return `[${m.id}] [${role}] (${m.type}) ${m.content}`;
          })
          .join("\n")
      : "(no pre-staged context)";

  const toolOnlyText =
    toolOnly.length > 0
      ? toolOnly
          .map((m) => {
            const meta = m.metadata as Record<string, unknown> | undefined;
            const role = (meta?.memoryRole as string) ?? "common";
            return `- [${m.id}] [${role}] (${m.type}) (content not shown; use memory tools to retrieve)`;
          })
          .join("\n")
      : "(none)";

  const intentText = input.intentSpec ? `\nClarified intent: ${input.intentSpec}` : "";

  return [
    `Task: ${input.query}${intentText}`,
    "",
    "Pre-staged context (already in your prompt):",
    injectedText,
    "",
    "Available in memory backend (use list_keys / key_search / retrieve to read):",
    toolOnlyText,
    "",
    "Answer the question now. Use the pre-staged context when it is relevant; otherwise, call a memory tool to retrieve the relevant conversation.",
  ].join("\n");
}

/**
 * Parse one LLM response line into a TOOL_CALL or COMPLETE directive.
 * Mirrors `appworld_llm_agent.ts:parseLlmResponse` — fallback treats a
 * non-TOOL_CALL message as a COMPLETE with the raw text as the answer
 * (best-effort for models that don't follow the protocol strictly).
 */
function parseLlmResponse(content: string): ParsedResponse | null {
  const trimmed = content.trim();
  const lines = trimmed.split("\n").filter(Boolean);

  for (const line of lines) {
    const l = line.trim();
    if (l.startsWith("TOOL_CALL ")) {
      const rest = l.slice("TOOL_CALL ".length);
      const spaceIdx = rest.indexOf(" ");
      if (spaceIdx === -1) {
        return { toolId: rest, args: {} };
      }
      const toolId = rest.slice(0, spaceIdx);
      const argsJson = rest.slice(spaceIdx + 1);
      try {
        const args = JSON.parse(argsJson) as Record<string, unknown>;
        return { toolId, args };
      } catch {
        return { toolId, args: {} };
      }
    }
    if (l.startsWith("COMPLETE ")) {
      const answer = l.slice("COMPLETE ".length).trim();
      return { action: "complete", answer };
    }
  }

  // Fallback: no TOOL_CALL marker — treat whole output as the final answer.
  if (trimmed.length > 0 && !trimmed.includes("TOOL_CALL")) {
    return { action: "complete", answer: trimmed };
  }
  return null;
}

function truncateOutput(output: unknown, maxChars = TOOL_OUTPUT_MAX_CHARS): string {
  const str = typeof output === "string" ? output : JSON.stringify(output);
  if (str.length <= maxChars) return str;
  return str.slice(0, maxChars) + `\n... [truncated, ${str.length} total chars]`;
}

/**
 * Simulate a BFCL memory-tool call against `input.memory`. Pure function,
 * no I/O. Matches on substrings in `tool.id` (lowercase).
 *
 * The simulation treats every memory item uniformly as `{id, content}` —
 * it does NOT read `metadata` (goldAnswerCandidates etc. are eval-only).
 */
function rankMemory(memory: MemoryItem[], query: string, k: number): Array<{ key: string; score: number; value: string }> {
  const queryLower = query.toLowerCase();
  const queryTokens = queryLower.split(/\s+/).filter(Boolean);
  return memory
    .map((item) => {
      const contentLower = item.content.toLowerCase();
      let score = 0;
      for (const token of queryTokens) {
        if (contentLower.includes(token)) score += 1;
      }
      if (contentLower.includes(queryLower)) score += 2;
      return { key: item.id, score, value: item.content };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
}

function toolParameterNames(tool: ToolItem): Set<string> {
  const schema = tool.schema as { parameters?: { properties?: Record<string, unknown> } } | undefined;
  return new Set(Object.keys(schema?.parameters?.properties ?? {}));
}

function simulateToolCall(
  tool: ToolItem,
  args: Record<string, unknown>,
  memory: MemoryItem[],
): ToolCallResult {
  const id = tool.id.toLowerCase();
  const params = toolParameterNames(tool);

  if (id.endsWith("_list_keys")) {
    return { ok: true, output: { keys: memory.map((item) => item.id) } };
  }

  if (id.endsWith("_retrieve_all")) {
    return {
      ok: true,
      output: { items: memory.map((item) => ({ key: item.id, value: item.content })) },
    };
  }

  if (id.endsWith("_key_search") || (id.endsWith("_retrieve") && params.has("query"))) {
    const query = typeof args.query === "string" ? args.query : "";
    const kRaw = args.k ?? args.top_k ?? 5;
    const k = typeof kRaw === "number" && kRaw > 0 ? Math.floor(kRaw) : 5;
    if (query.length === 0) {
      return { ok: false, output: null, error: `${tool.id} requires a non-empty 'query' argument` };
    }
    const ranked = rankMemory(memory, query, k);
    if (id.endsWith("_key_search")) {
      return { ok: true, output: { ranked_results: ranked.map(({ key, score }) => ({ key, score })) } };
    }
    return { ok: true, output: { results: ranked } };
  }

  if (id.endsWith("_retrieve") && params.has("key")) {
    const key = typeof args.key === "string" ? args.key : "";
    if (key.length === 0) {
      return { ok: false, output: null, error: `${tool.id} requires a 'key' argument` };
    }
    const item = memory.find((candidate) => candidate.id === key);
    if (!item) {
      return { ok: false, output: null, error: `key not found: ${key}` };
    }
    return { ok: true, output: { key: item.id, value: item.content } };
  }

  if (id.endsWith("_retrieve") && params.size === 0) {
    return {
      ok: true,
      output: { memory_content: memory.map((item) => `[${item.id}]\n${item.content}`).join("\n\n") },
    };
  }

  if (id.endsWith("_add") || id.endsWith("_clear") || id.endsWith("_remove") || id.endsWith("_replace") || id.endsWith("_update") || id.endsWith("_append")) {
    return {
      ok: true,
      output: { mutated: false, note: "mutation tools are no-ops in this eval environment" },
    };
  }

  return { ok: false, output: null, error: `unknown tool: ${tool.id}` };
}

function makeLlmStep(messages: LlmMessage[], response: string): TrajectoryStep {
  return {
    stepId: randomUUID(),
    type: "llm",
    timestamp: now(),
    input: { messageCount: messages.length },
    output: { response },
    metadata: {},
  };
}

function makeToolStep(
  tool: ToolItem,
  args: Record<string, unknown>,
  result: ToolCallResult,
): TrajectoryStep {
  return {
    stepId: randomUUID(),
    type: "tool",
    timestamp: now(),
    input: { toolId: tool.id, args },
    output: { ok: result.ok, output: result.output, error: result.error },
    metadata: {
      backend: tool.metadata?.backend,
      suite: tool.metadata?.suite,
    },
  };
}

function makeToolErrorStep(toolId: string, args: Record<string, unknown>, error: string): TrajectoryStep {
  return {
    stepId: randomUUID(),
    type: "tool",
    timestamp: now(),
    input: { toolId, args },
    output: { ok: false, error },
    metadata: {},
  };
}

export class LlmBfclMemoryAgent {
  private readonly config: Required<Omit<BfclLlmAgentConfig, "llm" | "model" | "input">> &
    Pick<BfclLlmAgentConfig, "llm" | "model" | "input">;

  constructor(config: BfclLlmAgentConfig) {
    this.config = {
      maxSteps: DEFAULT_MAX_STEPS,
      maxTokens: DEFAULT_MAX_TOKENS,
      enableThinking: false,
      ...config,
    };
  }

  async run(): Promise<BfclLlmAgentResult> {
    const { llm, model, input } = this.config;
    const steps: TrajectoryStep[] = [];

    const systemPrompt = buildSystemPrompt(input.tools);
    const userPrompt = buildUserPrompt(input);
    const messages: LlmMessage[] = [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ];

    let derivedAnswer = "";
    let success = false;

    for (let step = 0; step < this.config.maxSteps; step += 1) {
      const llmResponse = await llm.call({
        model,
        messages,
        enableThinking: this.config.enableThinking,
        temperature: 0.3,
        maxTokens: this.config.maxTokens,
      });

      steps.push(makeLlmStep(messages, llmResponse.content));

      const parsed = parseLlmResponse(llmResponse.content);
      if (!parsed) {
        messages.push({ role: "assistant", content: llmResponse.content });
        messages.push({
          role: "user",
          content: "Invalid response. Use TOOL_CALL <id> <json> or COMPLETE <answer>.",
        });
        continue;
      }

      if ("action" in parsed && parsed.action === "complete") {
        derivedAnswer = parsed.answer;
        success = true;
        break;
      }

      if ("toolId" in parsed) {
        messages.push({ role: "assistant", content: llmResponse.content });

        const tool = input.tools.find((t) => t.id === parsed.toolId);
        if (!tool) {
          const errMsg = `Tool "${parsed.toolId}" not found. Available: ${input.tools
            .map((t) => t.id)
            .slice(0, 8)
            .join(", ")}...`;
          steps.push(makeToolErrorStep(parsed.toolId, parsed.args, errMsg));
          messages.push({ role: "user", content: `Tool error: ${errMsg}` });
          continue;
        }

        const result = simulateToolCall(tool, parsed.args, input.memory);
        steps.push(makeToolStep(tool, parsed.args, result));

        const observation = result.ok
          ? `Tool ${parsed.toolId} returned:\n${truncateOutput(result.output)}`
          : `Tool ${parsed.toolId} failed: ${result.error ?? "unknown error"}`;
        messages.push({ role: "user", content: observation });
        continue;
      }
    }

    // Loop exhausted without COMPLETE — best-effort: grab the last non-TOOL_CALL
    // assistant message as the answer. If none, leave derivedAnswer empty.
    if (!success) {
      const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant");
      if (lastAssistant && !lastAssistant.content.trim().startsWith("TOOL_CALL")) {
        derivedAnswer = lastAssistant.content.trim().slice(0, 200);
      }
    }

    const hasOracleMemory = input.memory.some((memory) => {
      const metadata = memory.metadata as Record<string, unknown> | undefined;
      return metadata?.promptInjected === true
        && metadata?.memoryRole === "common"
        && memory.type === "history";
    });

    return {
      steps,
      derivedAnswer,
      success,
      hasOracleMemory,
      reason: success
        ? "llm: agent emitted COMPLETE"
        : "llm: maxSteps reached without COMPLETE",
    };
  }
}

export { buildSystemPrompt, buildUserPrompt, parseLlmResponse, simulateToolCall };
