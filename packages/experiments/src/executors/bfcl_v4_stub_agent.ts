import { randomUUID } from "node:crypto";
import type { ExecutorInput } from "@prologue/prologue";
import type { MemoryItem, TrajectoryStep } from "@prologue/schemas";

/**
 * Deterministic harness agent for BFCL plumbing tests.
 *
 * It deliberately never reads evaluator gold metadata or answer-bearing memory
 * metadata. It records whether a complete conversation was pre-staged so tests
 * can verify the RQ1 input wiring without treating stub outcomes as evidence.
 */

function now(): string {
  return new Date().toISOString();
}

function isPreStagedConversation(item: MemoryItem): boolean {
  const metadata = item.metadata as Record<string, unknown>;
  return item.type === "history"
    && metadata.memoryRole === "common"
    && metadata.promptInjected === true;
}

function pickReadTool(input: ExecutorInput): string | null {
  const preferences = ["key_search", "list_keys", "retrieve_all", "retrieve"];
  for (const preference of preferences) {
    const tool = input.tools.find((candidate) => candidate.id.toLowerCase().includes(preference));
    if (tool) return tool.id;
  }
  return null;
}

export type StubBfclAgentResult = {
  steps: TrajectoryStep[];
  derivedAnswer: string;
  success: boolean;
  hasOracleMemory: boolean;
  reason: string;
};

export class StubBfclMemoryAgent {
  constructor(private readonly input: ExecutorInput) {}

  async run(): Promise<StubBfclAgentResult> {
    const preStaged = this.input.memory.filter(isPreStagedConversation);
    const readToolId = pickReadTool(this.input);
    const steps: TrajectoryStep[] = [
      {
        stepId: randomUUID(),
        type: "llm",
        timestamp: now(),
        input: { query: this.input.query },
        output: {
          stub: true,
          plan: "inspect_context_and_verify_tool_wiring",
          preStagedConversationIds: preStaged.map((item) => item.id),
        },
        metadata: {},
      },
      {
        stepId: randomUUID(),
        type: "tool",
        timestamp: now(),
        input: { toolId: readToolId ?? "__none__", args: {} },
        output: readToolId
          ? { ok: true, output: { stub: true, note: "tool wiring verified" } }
          : { ok: false, error: "no read tool available" },
        metadata: {},
      },
    ];

    return {
      steps,
      derivedAnswer: "",
      success: false,
      hasOracleMemory: preStaged.length > 0,
      reason: "stub: harness-only agent does not derive answers",
    };
  }
}

export type { MemoryItem };
