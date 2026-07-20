import { randomUUID } from "node:crypto";
import { LlmCallError, type LlmClient } from "@prologue/common";
import type { Executor, ExecutorInput, ExecutorResult } from "@prologue/prologue";
import type { MemoryItem, TrajectoryStep } from "@prologue/schemas";
import { StubBfclMemoryAgent } from "./bfcl_v4_stub_agent.js";
import { LlmBfclMemoryAgent } from "./bfcl_v4_llm_agent.js";

/**
 * Executor for BFCL V4 Memory track tasks.
 *
 * Unlike AppWorldExecutor (which spawns a REST server and runs the official
 * evaluator via Python), BFCL V4 has no external server — its "memory backend"
 * is conceptual, and the prereq conversation content is already materialized
 * as oracle memory in the ExecutorInput. Evaluation is exact_match against
 * the gold answer candidates carried in the oracle memory item's metadata
 * (populated by the adapter from BFCL's `possible_answer` file).
 *
 * Two modes (selected via constructor config):
 *   - Stub agent (default, no config): no LLM, deterministic answer
 *     derivation from oracle memory. Used for RQ1 attribution validation.
 *   - LLM agent (when `llm` and `llmModel` are set): real ReAct agent that
 *     calls simulated memory tools and emits COMPLETE <answer>. The LLM
 *     never reads memory metadata; only `content`, `id`, `type`, and the
 *     `memoryRole` tag are surfaced via the user prompt.
 *
 * Evaluation (both modes):
 *   - Gold answer candidates are read from `input.evaluatorMetadata.groundTruthCandidates`
 *     (task-level metadata, available in ALL conditions). This is critical for
 *     RQ1 direction A: under the new design, baseline LLM may correctly answer
 *     by actively retrieving the prereq conversation via tools — that should
 *     be judged PASS, not FAIL. Reading gold from oracle memory item metadata
 *     would produce false negatives in baseline (oracle memory not in
 *     input.memory → goldCandidates=[] → eval fails even when answer is correct).
 *   - Compare the agent's derivedAnswer case-insensitively (trimmed) against
 *     any candidate. BFCL accepts multiple forms like "35" / "thirty five".
 */
export type BfclV4ExecutorConfig = {
  /** LLM client. When set with `llmModel`, enables LLM mode. */
  llm?: LlmClient;
  /** Model name. Required for LLM mode. */
  llmModel?: string;
  /** Max agent ReAct steps. Default 60. */
  maxSteps?: number;
  /** Max LLM tokens per call. Default 4096. */
  maxTokens?: number;
  /** Enable Qwen3.5 thinking mode. Default false. */
  enableThinking?: boolean;
};

export function makeBfclExecutorConfig(
  partial: Partial<BfclV4ExecutorConfig> = {},
): BfclV4ExecutorConfig {
  return {
    maxSteps: 60,
    maxTokens: 4096,
    enableThinking: false,
    ...partial,
  };
}

export class BfclV4MemoryExecutor implements Executor {
  constructor(private readonly config: BfclV4ExecutorConfig = {}) {}

  async execute(input: ExecutorInput): Promise<ExecutorResult> {
    const steps: TrajectoryStep[] = [];
    const useLlm = !!(this.config.llm && this.config.llmModel);
    const metadata: Record<string, unknown> = {
      source: input.source,
      agentMode: useLlm ? "llm" : "stub",
    };
    if (useLlm) {
      metadata.agentModel = this.config.llmModel;
    }

    try {
      const agentResult = useLlm
        ? await new LlmBfclMemoryAgent({
            llm: this.config.llm!,
            model: this.config.llmModel!,
            input,
            maxSteps: this.config.maxSteps,
            maxTokens: this.config.maxTokens,
            enableThinking: this.config.enableThinking,
          }).run()
        : await new StubBfclMemoryAgent(input).run();

      steps.push(...agentResult.steps);
      metadata.hasOracleMemory = agentResult.hasOracleMemory;
      metadata.derivedAnswer = agentResult.derivedAnswer;
      metadata.agentSuccess = agentResult.success;

      // Evaluate: exact_match against goldAnswerCandidates from task-level
      // evaluator metadata (available in ALL conditions, including baseline).
      const goldCandidates = readGoldCandidates(input.evaluatorMetadata);
      const evalResult = evaluateExactMatch(agentResult.derivedAnswer, goldCandidates);
      metadata.goldCandidates = goldCandidates;
      metadata.evalMatched = evalResult.matched;

      const evalStep: TrajectoryStep = {
        stepId: randomUUID(),
        type: "eval",
        timestamp: new Date().toISOString(),
        output: {
          success: evalResult.matched,
          derivedAnswer: agentResult.derivedAnswer,
          goldCandidates,
          reason: evalResult.reason,
        },
        metadata: {},
      };
      steps.push(evalStep);

      return {
        success: evalResult.matched,
        score: evalResult.matched ? 1 : 0,
        reason: evalResult.reason,
        steps,
        metadata,
      };
    } catch (e) {
      // Permanent LLM errors (insufficient_quota, invalid_api_key, model_not_found,
      // etc.) must NOT be swallowed into a generic executor_error string —
      // otherwise the runner's circuit breaker cannot detect them and will
      // grind through the entire batch wasting time. Re-throw so the runner
      // can trip the breaker and abort cleanly.
      if (e instanceof LlmCallError && e.permanent) {
        throw e;
      }
      const message = e instanceof Error ? e.message : String(e);
      steps.push({
        stepId: randomUUID(),
        type: "error",
        timestamp: new Date().toISOString(),
        output: { message: `executor_error: ${message}` },
        metadata: {},
      });
      return {
        success: false,
        score: 0,
        reason: `executor_error: ${message}`,
        steps,
        metadata,
      };
    }
  }
}

/**
 * Read goldAnswerCandidates from task-level evaluator metadata.
 *
 * Under RQ1 direction A design, gold answers must be available in ALL
 * conditions (including baseline) — otherwise a baseline LLM that correctly
 * answers via tool retrieval would be falsely judged as FAIL. The
 * `evaluatorMetadata` field is populated by `buildRq1Input` from
 * `task.evaluator.metadata.groundTruthCandidates`.
 */
function readGoldCandidates(evaluatorMetadata: Record<string, unknown> | undefined): string[] {
  if (!evaluatorMetadata) return [];
  const candidates = evaluatorMetadata.groundTruthCandidates;
  if (Array.isArray(candidates)) {
    return candidates.filter((c): c is string => typeof c === "string");
  }
  return [];
}

function evaluateExactMatch(
  derivedAnswer: string,
  candidates: string[],
): { matched: boolean; reason: string } {
  if (candidates.length === 0) {
    return {
      matched: false,
      reason: "no gold candidates available (oracle memory not in context)",
    };
  }
  if (derivedAnswer.length === 0) {
    return {
      matched: false,
      reason: "agent returned empty answer",
    };
  }
  const norm = (s: string) => s.trim().toLowerCase();
  const normAnswer = norm(derivedAnswer);
  for (const candidate of candidates) {
    if (norm(candidate) === normAnswer) {
      return { matched: true, reason: `exact_match: "${derivedAnswer}"` };
    }
  }
  return {
    matched: false,
    reason: `no exact match: answer="${derivedAnswer}" candidates=${JSON.stringify(candidates)}`,
  };
}
