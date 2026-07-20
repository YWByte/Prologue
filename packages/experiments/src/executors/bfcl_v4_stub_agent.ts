import { randomUUID } from "node:crypto";
import type { ExecutorInput } from "@prologue/prologue";
import type { MemoryItem, TrajectoryStep } from "@prologue/schemas";

/**
 * Stub agent for BFCL V4 Memory track tasks.
 *
 * Models the minimum trajectory a competent agent would take on this task
 * family:
 *   1. list_keys (or list_all) — discover what's in memory
 *   2. retrieve / key_search — fetch the relevant memory chunk
 *   3. answer — derive the answer from the retrieved memory
 *
 * RQ1 direction A design (v0.2.0 adapter):
 *   - The prereq conversation is ALWAYS in `input.memory` as a COMMON memory
 *     item (baseline included), but NOT pre-injected to the prompt.
 *   - The ORACLE memory is the "key snippet" — the turn containing the gold
 *     answer, pre-extracted. It's in `input.memory` only when
 *     `usesOracleMemory` is true, AND it's marked `promptInjected: true`.
 *
 * Stub success policy (for RQ1 attribution validation):
 *   - The stub succeeds iff the oracle key snippet is in `input.memory`
 *     (i.e. `usesOracleMemory=true`). This simulates an agent that only
 *     answers correctly when the relevant context is pre-staged in its
 *     starting prompt; otherwise it doesn't bother retrieving.
 *   - This deliberately models a "lazy agent" baseline that fails to
 *     actively retrieve the prereq conversation from the memory backend —
 *     the failure mode the paper attributes to insufficient pre-execution
 *     context. A real LLM agent may sometimes succeed in baseline by
 *     diligently calling tools; the stub is the conservative lower bound.
 *
 * Tool steps are recorded even when a tool is missing from the pool, so RQ1
 * attribution reflects "what the agent could do given the selected context".
 */

function now(): string {
  return new Date().toISOString();
}

type OracleMemoryHit = {
  item: MemoryItem;
  sourceSnippet: string;
  candidates: string[];
};

/**
 * Locate the oracle key snippet memory item in the input and verify the gold
 * answer is reachable from it. The oracle memory item carries
 * `goldAnswerCandidates` and `sourceSnippet` in its metadata (populated by
 * the adapter v0.2.0).
 *
 * Under the new design, the oracle memory IS the key snippet (the turn
 * containing the gold answer, pre-extracted). So matching is straightforward:
 * if the oracle item is present, the gold answer is by construction in its
 * content. The dual-match strategy below is kept as a defensive check.
 *
 * Matching strategy:
 *   - Primary: check if any goldAnswerCandidate appears in the memory content.
 *     This is the strongest signal — the answer (e.g. "Michael", "Diabetes")
 *     must appear verbatim in the key snippet.
 *   - Fallback: if no candidate matches verbatim (e.g. multi-word answers
 *     with different casing), check if the source snippet prefix (stripped
 *     of trailing "...") appears in the content.
 *
 * BFCL's `source` field is inconsistent: sometimes a truncated quote ending
 * with "...", sometimes a quoted sentence. We handle both by treating
 * candidate-match as primary and snippet-match as secondary.
 */
function findOracleMemoryHit(input: ExecutorInput): OracleMemoryHit | null {
  for (const item of input.memory) {
    const meta = item.metadata as Record<string, unknown>;
    if (meta.oracle !== true) continue;
    if (!Array.isArray(meta.goldAnswerCandidates) || meta.goldAnswerCandidates.length === 0) continue;
    const candidates = meta.goldAnswerCandidates as string[];

    // Primary: any candidate verbatim in content?
    const candidateHit = candidates.find((c) => c.length > 0 && item.content.includes(c));
    if (candidateHit) {
      return {
        item,
        sourceSnippet: (meta.sourceSnippet as string) ?? "",
        candidates,
      };
    }

    // Fallback: source snippet prefix in content?
    if (typeof meta.sourceSnippet === "string" && meta.sourceSnippet.length > 0) {
      const prefix = meta.sourceSnippet.replace(/\s*\.\.\.\s*$/, "").trim();
      if (prefix.length > 0 && item.content.includes(prefix)) {
        return {
          item,
          sourceSnippet: meta.sourceSnippet,
          candidates,
        };
      }
    }
  }
  return null;
}

function makeLlmStep(input: ExecutorInput, derivedAnswer: string, hasOracleMemory: boolean): TrajectoryStep {
  return {
    stepId: randomUUID(),
    type: "llm",
    timestamp: now(),
    input: { query: input.query, intentSpec: input.intentSpec },
    output: {
      stub: true,
      plan: "list_keys_then_retrieve_then_answer",
      hasOracleMemory,
      derivedAnswer,
    },
    metadata: {},
  };
}

function makeToolStep(
  toolId: string,
  args: Record<string, unknown>,
  result: { ok: boolean; output: unknown; error?: string },
  toolMeta?: Record<string, unknown>,
): TrajectoryStep {
  return {
    stepId: randomUUID(),
    type: "tool",
    timestamp: now(),
    input: { toolId, args },
    output: result,
    metadata: toolMeta ?? {},
  };
}

/**
 * Pick the first available "discovery" tool from the pool. Preference order:
 * list_keys > key_search > retrieve > retrieve_all. Returns null if none are
 * present (oracle_tool condition without any readiness tool — shouldn't happen
 * given adapter's oracleToolIds selection, but handle defensively).
 */
function pickDiscoveryTool(input: ExecutorInput): string | null {
  const preferences = ["list_keys", "key_search", "retrieve_all", "retrieve"];
  const ids = new Set(input.tools.map((t) => t.id));
  for (const pref of preferences) {
    const match = Array.from(ids).find((id) => id.toLowerCase().includes(pref));
    if (match) return match;
  }
  return null;
}

function pickRetrievalTool(input: ExecutorInput): string | null {
  const preferences = ["key_search", "retrieve_all", "retrieve"];
  const ids = new Set(input.tools.map((t) => t.id));
  for (const pref of preferences) {
    const match = Array.from(ids).find((id) => id.toLowerCase().includes(pref));
    if (match) return match;
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
    const steps: TrajectoryStep[] = [];
    const hit = findOracleMemoryHit(this.input);
    const hasOracleMemory = hit !== null;

    // Derive answer: only if oracle memory is present and source snippet is found.
    const derivedAnswer = hit ? hit.candidates[0] : "";
    const success = hit !== null;

    steps.push(makeLlmStep(this.input, derivedAnswer, hasOracleMemory));

    // Tool step 1: discover memory keys
    const discoveryToolId = pickDiscoveryTool(this.input);
    if (discoveryToolId) {
      const tool = this.input.tools.find((t) => t.id === discoveryToolId)!;
      steps.push(
        makeToolStep(
          discoveryToolId,
          {},
          {
            ok: hasOracleMemory,
            output: hasOracleMemory
              ? { keys: [hit!.item.id], note: "stub: located prereq conversation memory" }
              : { keys: [], note: "stub: no oracle memory in context" },
          },
          { backend: tool.metadata?.backend, suite: tool.metadata?.suite },
        ),
      );
    } else {
      steps.push(
        makeToolStep("__none__", {}, {
          ok: false,
          output: null,
          error: "no discovery tool (list_keys/key_search/retrieve) in pool",
        }),
      );
    }

    // Tool step 2: retrieve the relevant memory
    const retrievalToolId = pickRetrievalTool(this.input);
    if (retrievalToolId) {
      const tool = this.input.tools.find((t) => t.id === retrievalToolId)!;
      steps.push(
        makeToolStep(
          retrievalToolId,
          hasOracleMemory ? { query: hit!.sourceSnippet.slice(0, 60) } : {},
          {
            ok: hasOracleMemory,
            output: hasOracleMemory
              ? { retrieved: hit!.sourceSnippet, note: "stub: source snippet located in prereq conversation" }
              : { retrieved: null, note: "stub: no oracle memory to retrieve from" },
          },
          { backend: tool.metadata?.backend, suite: tool.metadata?.suite },
        ),
      );
    } else {
      steps.push(
        makeToolStep("__none__", {}, {
          ok: false,
          output: null,
          error: "no retrieval tool in pool",
        }),
      );
    }

    // Final answer step (recorded as llm step with answer output)
    steps.push({
      stepId: randomUUID(),
      type: "llm",
      timestamp: now(),
      input: { query: this.input.query },
      output: {
        stub: true,
        phase: "final_answer",
        answer: derivedAnswer,
        success,
      },
      metadata: {},
    });

    return {
      steps,
      derivedAnswer,
      success,
      hasOracleMemory,
      reason: success
        ? "stub: oracle memory present, source snippet located, answer derived"
        : "stub: oracle memory not in context, cannot derive answer",
    };
  }
}

// Re-export for downstream convenience.
export type { MemoryItem };
