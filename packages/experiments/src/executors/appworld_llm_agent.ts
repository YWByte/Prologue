import { randomUUID } from "node:crypto";
import type { LlmClient, LlmMessage } from "@prologue/common";
import type { ExecutorInput, ToolExecutor } from "@prologue/prologue";
import type { MemoryItem, ToolItem, TrajectoryStep } from "@prologue/schemas";
import { AppWorldToolExecutor } from "./appworld_http.js";

export type LlmAgentConfig = {
  llm: LlmClient;
  model: string;
  toolExecutor: AppWorldToolExecutor;
  input: ExecutorInput;
  maxSteps?: number;
  maxTokens?: number;
  enableThinking?: boolean;
};

type ToolCallRequest = {
  toolId: string;
  args: Record<string, unknown>;
} | {
  action: "complete";
  answer: string;
};

const DEFAULT_MAX_STEPS = 200;
const DEFAULT_MAX_TOKENS = 1024;

function now(): string {
  return new Date().toISOString();
}

function buildSystemPrompt(tools: ToolItem[]): string {
  const toolList = tools.map((t) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const schema = (t.schema ?? {}) as any;
    const paramParts: string[] = [];
    // path/query/header params
    if (Array.isArray(schema.parameters)) {
      for (const p of schema.parameters) {
        const name = p.name ?? "?";
        const loc = p.in ?? "?";
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const pSchema = p.schema as any;
        const type = pSchema?.type ?? "?";
        const enumVals = Array.isArray(pSchema?.enum) ? pSchema.enum.join("|") : null;
        const enumPart = enumVals ? `{${enumVals}}` : "";
        paramParts.push(`${name}${p.required ? "*" : ""}(${loc}:${type})${enumPart}`);
      }
    }
    // requestBody properties (body fields)
    const bodyProps = schema.requestBody?.content?.["application/json"]?.schema?.properties;
    if (bodyProps && typeof bodyProps === "object") {
      for (const [name, prop] of Object.entries(bodyProps as Record<string, any>)) {
        const type = prop?.type ?? "?";
        const desc = (prop?.description ?? "").toString() as string;
        const descShort = desc ? `:${desc.slice(0, 60)}` : "";
        const enumVals = Array.isArray(prop?.enum) ? prop.enum.join("|") : null;
        const enumPart = enumVals ? `{${enumVals}}` : "";
        paramParts.push(`${name}*(body:${type})${enumPart}${descShort}`);
      }
    }
    const params = paramParts.length > 0 ? paramParts.join(", ") : "(none)";
    return `- ${t.id}: ${t.description} [params: ${params}]`;
  }).join("\n");

  return [
    "You are an autonomous agent operating in the AppWorld environment.",
    "You must complete the user's task by calling tools and returning a final answer.",
    "",
    "Available tools:",
    toolList,
    "",
    "Response format (STRICT):",
    "- Each response MUST be EXACTLY one line, starting with TOOL_CALL or COMPLETE.",
    "- No explanation, no reasoning, no markdown, no multi-line output before the command.",
    "- If you want to think, do it silently; only output the final command line.",
    "",
    "To call a tool:",
    "TOOL_CALL <tool_id> <json_args>",
    "Example: TOOL_CALL supervisor__show_profile {}",
    "Example: TOOL_CALL spotify__show_song_library {\"page_limit\": 20}",
    "",
    "To return the final answer:",
    "COMPLETE <answer>",
    "Example: COMPLETE Mysteries of the Silent Sea,Crimson Veil",
    "",
    "Rules:",
    "- ALWAYS start your response with TOOL_CALL or COMPLETE. Never start with any other text.",
    "- For app tasks that require authentication, login to each required app first using the user's email/username and the app password from context memory.",
    "- App passwords are in context memory under auth_account_passwords.",
    "- After login, the system automatically injects the correct app access token. Do not manually pass access_token unless a tool explicitly asks for it.",
    "- When calling supervisor__complete_task, the answer must be the final answer string.",
    "- If a tool fails, READ the error message carefully and fix the field indicated (e.g. 'page_limit: ensure ≤ 20' means reduce page_limit to ≤ 20). Do not repeat the same failing call with the same arguments.",
    "- page_limit max is 20. Never use page_limit > 20.",
    "- When searching/listing (search_artists, show_transactions, show_directory, etc.), ALWAYS paginate through ALL pages until the result is exhausted before concluding. Do not assume a single page contains all items.",
    "- For tasks that require a STATE CHANGE (follow, send, move, create, delete, update, like, add, etc.), you MUST actually call the corresponding mutation tool. Merely reading/searching data and stating the answer is NOT enough; the grader checks DB state.",
    "- For tasks that require a COMPUTED ANSWER (how many, total, count, list of names), ensure you have seen ALL relevant data before answering. If multiple pages exist, sum across all pages.",
    "- Do NOT call COMPLETE until you have performed all required mutation/computation steps. Premature COMPLETE leads to task failure.",
    "- If you have called a search/list tool and the result is truncated or has more pages (page_limit items returned), call it again with page_index+1 to get the next page.",
  ].join("\n");
}

function buildUserPrompt(input: ExecutorInput): string {
  const memoryText = input.memory.length > 0
    ? input.memory.map((m) => {
        const meta = m.metadata as Record<string, unknown>;
        const oracleTag = meta?.oracle === true ? " [oracle]" : "";
        return `[${m.id}${oracleTag}] (${m.type}) ${m.content}`;
      }).join("\n")
    : "(no memory provided)";

  const intentText = input.intentSpec
    ? `\nClarified intent: ${input.intentSpec}`
    : "";

  return [
    `Task: ${input.query}${intentText}`,
    "",
    "Context memory:",
    memoryText,
    "",
    "Complete this task now. Start by calling the first tool.",
  ].join("\n");
}

function parseLlmResponse(content: string): ToolCallRequest | null {
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

  // Fallback: if the model didn't follow format, treat whole output as complete
  if (trimmed.length > 0 && !trimmed.includes("TOOL_CALL")) {
    return { action: "complete", answer: trimmed };
  }

  return null;
}

function findTool(input: ExecutorInput, toolId: string): ToolItem | undefined {
  return input.tools.find((t) => t.id === toolId);
}

function redactText(text: string): string {
  return text
    .replace(/("(?:access_token|password)"\s*:\s*)"[^"]*"/gi, "$1\"[REDACTED]\"")
    .replace(/Bearer\s+[A-Za-z0-9._-]+/g, "Bearer [REDACTED]");
}

function makeLlmStep(messages: LlmMessage[], response: string): TrajectoryStep {
  return {
    stepId: randomUUID(),
    type: "llm",
    timestamp: now(),
    input: { messageCount: messages.length },
    output: { response: redactText(response) },
    metadata: {},
  };
}

function redactSensitive(value: unknown): unknown {
  if (typeof value === "string") return redactText(value);
  if (Array.isArray(value)) return value.map((item) => redactSensitive(item));
  if (!value || typeof value !== "object") return value;

  const redacted: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    const normalized = key.toLowerCase();
    if (normalized.includes("access_token") || normalized === "authorization" || normalized === "password") {
      redacted[key] = "[REDACTED]";
    } else {
      redacted[key] = redactSensitive(item);
    }
  }
  return redacted;
}

function makeToolStep(
  tool: ToolItem,
  args: Record<string, unknown>,
  result: { ok: boolean; output: unknown; error?: string; status?: number },
): TrajectoryStep {
  return {
    stepId: randomUUID(),
    type: "tool",
    timestamp: now(),
    input: { toolId: tool.id, args: redactSensitive(args) },
    output: redactSensitive(result),
    metadata: {
      app: tool.metadata?.app,
      method: tool.metadata?.method,
      path: tool.metadata?.path,
    },
  };
}

function truncateOutput(output: unknown, maxChars = 4000): string {
  const str = typeof output === "string" ? output : JSON.stringify(output);
  if (str.length <= maxChars) return str;
  return str.slice(0, maxChars) + `\n... [truncated, ${str.length} total chars]`;
}

export class LlmAppWorldAgent {
  private readonly config: Required<Omit<LlmAgentConfig, "llm" | "model" | "toolExecutor" | "input">> &
    Pick<LlmAgentConfig, "llm" | "model" | "toolExecutor" | "input">;

  constructor(config: LlmAgentConfig) {
    this.config = {
      maxSteps: DEFAULT_MAX_STEPS,
      maxTokens: DEFAULT_MAX_TOKENS,
      enableThinking: false,
      ...config,
    };
  }

  async run(): Promise<{ steps: TrajectoryStep[]; answer: string; success: boolean }> {
    const { llm, model, toolExecutor, input } = this.config;
    const steps: TrajectoryStep[] = [];

    const systemPrompt = buildSystemPrompt(input.tools);
    const userPrompt = buildUserPrompt(input);

    const messages: LlmMessage[] = [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ];

    let lastAnswer = "";
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
          content: "Invalid response format. Respond with either TOOL_CALL <id> <json> or COMPLETE <answer>.",
        });
        continue;
      }

      if ("action" in parsed && parsed.action === "complete") {
        lastAnswer = parsed.answer;
        success = true;
        break;
      }

      if ("toolId" in parsed) {
        messages.push({ role: "assistant", content: llmResponse.content });

        const tool = findTool(input, parsed.toolId);
        if (!tool) {
          const errMsg = `Tool "${parsed.toolId}" not found in tool pool. Available: ${input.tools.slice(0, 5).map((t) => t.id).join(", ")}...`;
          steps.push({
            stepId: randomUUID(),
            type: "tool",
            timestamp: now(),
            input: { toolId: parsed.toolId, args: parsed.args },
            output: { ok: false, error: errMsg },
            metadata: {},
          });
          messages.push({ role: "user", content: `Tool error: ${errMsg}` });
          continue;
        }

        // Auto-inject access_token for the matching app only.
        const args = { ...parsed.args };
        const app = typeof tool.metadata?.app === "string" ? tool.metadata.app : undefined;
        const appRequiresAuth = app && app !== "supervisor";
        if (appRequiresAuth && !("access_token" in args)) {
          const token = toolExecutor.getAccessToken(app);
          if (token) args.access_token = token;
        }

        const result = await toolExecutor.call(tool, args);
        steps.push(makeToolStep(tool, args, result));

        // If any app login succeeded, capture access token for that app only.
        if (parsed.toolId.endsWith("__login") && result.ok && app) {
          const token = (result.output as { access_token?: string } | null)?.access_token;
          if (typeof token === "string") {
            toolExecutor.setAccessToken(app, token);
          }
        }

        const redactedOutput = redactSensitive(result.output);
        const observation = result.ok
          ? `Tool ${parsed.toolId} returned (status ${result.status ?? 200}):\n${truncateOutput(redactedOutput)}`
          : `Tool ${parsed.toolId} failed (status ${result.status ?? "?"}): ${result.error ?? "unknown error"}\nResponse: ${truncateOutput(redactedOutput)}`;
        messages.push({ role: "user", content: observation });
        continue;
      }
    }

    // If agent didn't complete, try supervisor__complete_task with last answer
    if (!success) {
      const completeTool = findTool(input, "supervisor__complete_task");
      if (completeTool) {
        const result = await toolExecutor.call(completeTool, { answer: lastAnswer });
        steps.push(makeToolStep(completeTool, { answer: lastAnswer }, result));
      }
    } else {
      // Call supervisor__complete_task with the answer
      const completeTool = findTool(input, "supervisor__complete_task");
      if (completeTool) {
        const args: Record<string, unknown> = { answer: lastAnswer };
        const result = await toolExecutor.call(completeTool, args);
        steps.push(makeToolStep(completeTool, args, result));
      }
    }

    return { steps, answer: lastAnswer, success };
  }
}

export { buildSystemPrompt, buildUserPrompt, parseLlmResponse };
