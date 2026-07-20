import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { CanonicalTask, MemoryItem, ToolItem } from "@prologue/schemas";
import type { DatasetAdapter } from "../index.js";

/**
 * BFCL V4 Memory adapter.
 *
 * Source data layout (BFCL v4 release, github.com/ShishirPatil/gorilla):
 *   <rawRoot>/
 *   ├── BFCL_v4_memory.json                              # 155 test questions, NDJSON
 *   ├── memory_prereq_conversation/
 *   │   ├── memory_customer.json                         # 10 prereq conversations per scenario
 *   │   ├── memory_finance.json
 *   │   ├── memory_healthcare.json
 *   │   ├── memory_notetaker.json
 *   │   └── memory_student.json
 *   ├── multi_turn_func_doc/
 *   │   ├── memory_kv.json                               # 15 KV-store memory APIs
 *   │   ├── memory_vector.json                           # Vector-store memory APIs
 *   │   └── memory_rec_sum.json                          # Recursive summarization APIs
 *   └── possible_answer/
 *       └── BFCL_v4_memory.json                          # ground truth (id, ground_truth[], source)
 *
 * Semantics:
 *   - 155 questions × 3 backends = 465 evaluation instances
 *   - Prereq conversations prefill memory; test question is asked with NO dialogue history
 *   - Model must query its self-managed memory state to answer
 *
 * Mapping to Context Prologue (I/M/T) — RQ1 direction A design:
 *   - Intent (I*): the test question + scenario topic chain (extracted from prereq conversations)
 *   - Memory (M*) — TWO-tier design:
 *       • COMMON prereq conversation: full prereq text, always in `input.memory`
 *         (baseline included) but marked `promptInjected: false` — the agent
 *         must call memory tools (list_keys/retrieve) to read it. Failure
 *         here means "agent didn't actively retrieve the prereq content",
 *         NOT "content was physically unavailable".
 *       • ORACLE key snippet: the turn containing the gold answer, pre-
 *         extracted and marked `promptInjected: true` — when
 *         usesOracleMemory is true, this snippet is both in input.memory
 *         AND expanded in the user prompt. Failure-flip on adding this
 *         is the RQ1 attribution signal: "pre-staging the relevant context
 *         in the starting prompt turns failure into success".
 *   - Tool (T*): the memory operation APIs needed to retrieve (search/retrieve + relevant keys)
 *   - Distractor: prereq conversation snippets from OTHER scenarios (same/跨 topic),
 *     always `promptInjected: false`
 *
 * RQ1 attribution semantics under this design:
 *   - baseline: prereq is in input.memory but not in prompt → agent must
 *     actively call tools to find the answer. May succeed (if agent is
 *     diligent) or fail (if agent doesn't retrieve or uses wrong query).
 *   - oracle_memory: prereq is still in input.memory, AND the key snippet
 *     is pre-injected to the prompt → agent can answer without any tool
 *     call. Higher success rate than baseline is the attribution signal.
 *   - The gap between baseline and oracle_memory measures "the value of
 *     pre-staging context in the prompt vs leaving it for the agent to
 *     retrieve" — which is exactly the paper's thesis.
 */

type BfclQuestion = {
  id: string; // "memory_0-customer-0"
  question: Array<Array<{ role: string; content: string }>>;
  involved_classes: string[];
  scenario: string;
};

type BfclPrereqConversation = {
  id: string; // "memory_prereq_0-customer-0"
  topic: string;
  question: Array<Array<{ role: string; content: string }>>;
  involved_classes: string[];
  scenario: string;
};

type BfclFunction = {
  name: string;
  description: string;
  parameters: {
    type: string;
    properties: Record<string, unknown>;
    required: string[];
  };
  response?: Record<string, unknown>;
};

type BfclAnswer = {
  id: string;
  ground_truth: string[];
  source: string;
};

type BackendName = "kv" | "vector" | "rec_sum";

const BACKENDS: BackendName[] = ["kv", "vector", "rec_sum"];

const BACKEND_LABEL: Record<BackendName, string> = {
  kv: "key_value_store",
  vector: "vector_store",
  rec_sum: "recursive_summarization",
};

const READINESS_TOOL_PATTERNS = ["search", "retrieve", "list_keys"];

async function readJsonLines<T>(path: string): Promise<T[]> {
  const raw = await readFile(path, "utf8");
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as T);
}

/**
 * Extract the test question text from a BFCL question entry.
 * Format: question = [[{role:"user", content:"..."}]]
 */
function extractQuestionText(entry: BfclQuestion): string {
  const firstTurn = entry.question[0];
  if (!firstTurn || firstTurn.length === 0) return "";
  return firstTurn[0].content;
}

/**
 * Extract the full conversation text (concatenated user turns) from a prereq conversation.
 */
function extractConversationText(entry: BfclPrereqConversation): string {
  return entry.question
    .map((turn, idx) => {
      const text = turn.map((msg) => msg.content).join(" ");
      return `Turn ${idx + 1} [${entry.topic}]: ${text}`;
    })
    .join("\n");
}

/**
 * Build a concise scenario profile (non-oracle, common memory).
 * Acts as "domain context" available to baseline. Always injected into the
 * user prompt (promptInjected=true) because it's small and provides framing.
 */
function buildScenarioProfile(scenario: string, prereq: BfclPrereqConversation[]): MemoryItem {
  const topics = prereq.map((conv) => conv.topic);
  return {
    id: `bfcl_v4_memory:memory:scenario_profile:${scenario}`,
    type: "profile",
    content: JSON.stringify({
      scenario,
      scenarioDescription: SCENARIO_DESCRIPTIONS[scenario] ?? `BFCL V4 memory scenario: ${scenario}`,
      conversationTopics: topics,
      conversationCount: prereq.length,
    }),
    source: "bfcl_v4.possible_answer.scenario_metadata",
    metadata: { oracle: false, memoryRole: "common", scenario, promptInjected: true },
  };
}

const SCENARIO_DESCRIPTIONS: Record<string, string> = {
  customer: "Customer support interactions with a coffee equipment company",
  finance: "Finance managing director's portfolio and market interactions",
  healthcare: "Healthcare patient history and medical appointment tracking",
  student: "College student advising, courses, and academic planning",
  notetaker: "Personal to-do list and notetaking assistant",
};

/**
 * Build the COMMON prereq conversation memory item.
 *
 * Design (RQ1 direction A): the prereq conversation is ALWAYS in the agent's
 * `input.memory` (baseline included) — so it is physically reachable via
 * memory tools. However, it is marked `promptInjected: false`, meaning the
 * LLM agent's user prompt will NOT expand its content; the agent must
 * actively call `list_keys` / `retrieve` / `key_search` to read it. This
 * mirrors the real-world situation where context exists in the environment
 * but is not pre-staged in the agent's starting prompt.
 *
 * Baseline failure under this design means: "the agent had access to the
 * prereq conversation but did not retrieve it (or retrieved the wrong
 * chunk) before answering" — which is precisely the failure mode the
 * paper attributes to insufficient pre-execution context, NOT to physical
 * unavailability of information.
 */
function buildCommonPrereqMemory(
  taskId: string,
  scenario: string,
  prereq: BfclPrereqConversation[],
): MemoryItem {
  const conversationText = prereq
    .map((conv, idx) => `=== Conversation ${idx + 1}: ${conv.topic} ===\n${extractConversationText(conv)}`)
    .join("\n\n");
  return {
    id: `${taskId}:memory:prereq_conversation:${scenario}`,
    type: "history",
    content: conversationText,
    source: `bfcl_v4.memory_prereq_conversation.memory_${scenario}`,
    metadata: {
      oracle: false,
      memoryRole: "common",
      scenario,
      conversationCount: prereq.length,
      topics: prereq.map((c) => c.topic),
      promptInjected: false,
    },
  };
}

/**
 * Extract the "key snippet" — the prereq conversation turn that contains
 * the gold answer — from the full prereq conversation set.
 *
 * Strategy (mirrors the stub agent's dual-match approach):
 *   1. Normalize `goldAnswer.source`: strip trailing "..." and surrounding
 *      quotes. BFCL's source field is inconsistent (sometimes truncated,
 *      sometimes quoted).
 *   2. Search every turn of every prereq conversation for a content
 *      substring match against the normalized source.
 *   3. Return the matching turn's full text plus 1 turn of surrounding
 *      context (for narrative coherence). If no match, fall back to
 *      searching for any goldAnswerCandidate verbatim in turn content.
 *   4. If still no match, return the first turn of the first prereq
 *      conversation as a best-effort snippet (rare; logged in metadata).
 */
function extractKeySnippet(
  prereq: BfclPrereqConversation[],
  goldAnswer: BfclAnswer | undefined,
): { snippet: string; matchedBy: "source" | "candidate" | "fallback"; conversationIndex: number; turnIndex: number } | null {
  if (!goldAnswer || prereq.length === 0) return null;

  // Strategy 1: match by source snippet (preferred — it's the exact sentence
  // BFCL's annotators identified as containing the answer).
  const rawSource = (goldAnswer.source ?? "").trim();
  const sourceNormalized = rawSource
    .replace(/^\s*"+\s*/, "")
    .replace(/\s*"+\s*$/, "")
    .replace(/\s*\.\.\.\s*$/, "")
    .trim();
  if (sourceNormalized.length > 0) {
    for (let cIdx = 0; cIdx < prereq.length; cIdx += 1) {
      const conv = prereq[cIdx];
      for (let tIdx = 0; tIdx < conv.question.length; tIdx += 1) {
        const turn = conv.question[tIdx];
        const turnText = turn.map((m) => m.content).join(" ");
        if (turnText.includes(sourceNormalized)) {
          // Include 1 turn of prefix context if available, for coherence.
          const startIdx = Math.max(0, tIdx - 1);
          const contextTurns = conv.question.slice(startIdx, tIdx + 1);
          const snippet = `Conversation ${cIdx + 1} [${conv.topic}]:\n` +
            contextTurns.map((t, i) => {
              const turnNum = startIdx + i + 1;
              return `Turn ${turnNum}: ${t.map((m) => m.content).join(" ")}`;
            }).join("\n");
          return { snippet, matchedBy: "source", conversationIndex: cIdx, turnIndex: tIdx };
        }
      }
    }
  }

  // Strategy 2: match by goldAnswerCandidate verbatim in turn content.
  const candidates = (goldAnswer.ground_truth ?? []).filter((c) => c.length > 0);
  if (candidates.length > 0) {
    for (let cIdx = 0; cIdx < prereq.length; cIdx += 1) {
      const conv = prereq[cIdx];
      for (let tIdx = 0; tIdx < conv.question.length; tIdx += 1) {
        const turn = conv.question[tIdx];
        const turnText = turn.map((m) => m.content).join(" ");
        const hit = candidates.find((c) => turnText.includes(c));
        if (hit) {
          const startIdx = Math.max(0, tIdx - 1);
          const contextTurns = conv.question.slice(startIdx, tIdx + 1);
          const snippet = `Conversation ${cIdx + 1} [${conv.topic}]:\n` +
            contextTurns.map((t, i) => {
              const turnNum = startIdx + i + 1;
              return `Turn ${turnNum}: ${t.map((m) => m.content).join(" ")}`;
            }).join("\n");
          return { snippet, matchedBy: "candidate", conversationIndex: cIdx, turnIndex: tIdx };
        }
      }
    }
  }

  // Strategy 3: fallback — first turn of first conversation.
  const firstConv = prereq[0];
  if (firstConv && firstConv.question.length > 0) {
    const snippet = `Conversation 1 [${firstConv.topic}]:\nTurn 1: ${firstConv.question[0].map((m) => m.content).join(" ")}`;
    return { snippet, matchedBy: "fallback", conversationIndex: 0, turnIndex: 0 };
  }
  return null;
}

/**
 * Build the ORACLE memory item: a pre-extracted "key snippet" containing
 * the turn that holds the gold answer, plus 1 turn of surrounding context.
 *
 * Design (RQ1 direction A): the oracle memory is the part of the prereq
 * conversation that has been "pre-retrieved and staged in the agent's
 * starting prompt". It is marked `promptInjected: true`, so the LLM agent's
 * user prompt WILL expand its content. The agent no longer needs to call
 * memory tools to find this specific fact — it's already in the prompt.
 *
 * The oracle memory metadata still carries `goldAnswerCandidates` and
 * `sourceSnippet` for stub-agent attribution validation (these fields are
 * invisible to the LLM agent, which never reads metadata).
 */
function buildOracleKeySnippetMemory(
  taskId: string,
  scenario: string,
  prereq: BfclPrereqConversation[],
  goldAnswer: BfclAnswer | undefined,
): MemoryItem | null {
  const extracted = extractKeySnippet(prereq, goldAnswer);
  if (!extracted) return null;
  return {
    id: `${taskId}:memory:oracle_key_snippet:${scenario}`,
    type: "history",
    content: extracted.snippet,
    source: `bfcl_v4.memory_prereq_conversation.memory_${scenario}.key_snippet`,
    metadata: {
      oracle: true,
      memoryRole: "oracle",
      scenario,
      promptInjected: true,
      keySnippetMatchedBy: extracted.matchedBy,
      keySnippetConversationIndex: extracted.conversationIndex,
      keySnippetTurnIndex: extracted.turnIndex,
      goldAnswerCandidates: goldAnswer?.ground_truth ?? [],
      sourceSnippet: goldAnswer?.source,
    },
  };
}

/**
 * Build distractor memory: prereq conversation snippets from OTHER scenarios.
 * These are same-format but wrong-scenario, simulating cross-topic interference.
 */
function buildDistractorMemory(
  taskId: string,
  targetScenario: string,
  allPrereq: Map<string, BfclPrereqConversation[]>,
): MemoryItem[] {
  const distractors: MemoryItem[] = [];
  for (const [scenario, prereq] of allPrereq.entries()) {
    if (scenario === targetScenario) continue;
    // Pick first conversation from each other scenario as distractor
    const firstConv = prereq[0];
    if (!firstConv) continue;
    distractors.push({
      id: `${taskId}:memory:distractor:scenario_${scenario}`,
      type: "history",
      content: extractConversationText(firstConv),
      source: `bfcl_v4.memory_prereq_conversation.memory_${scenario}`,
      metadata: {
        oracle: false,
        memoryRole: "distractor",
        scenario,
        distractorType: "cross_scenario",
        topic: firstConv.topic,
        promptInjected: false,
      },
    });
  }
  return distractors;
}

/**
 * Convert BFCL function doc format to ToolItem.
 * BFCL uses {name, description, parameters:{type,properties,required}, response?}
 * Our ToolItem schema field accepts arbitrary record; we keep BFCL structure as-is.
 */
function toToolItem(func: BfclFunction, backend: BackendName): ToolItem {
  return {
    id: func.name,
    name: func.name,
    description: func.description,
    type: "function",
    schema: {
      parameters: func.parameters,
      response: func.response ?? null,
    },
    metadata: {
      backend,
      backendLabel: BACKEND_LABEL[backend],
      suite: "memory",
    },
  };
}

/**
 * Determine the oracle tool subset for a given test question.
 *
 * Heuristic:
 *   - Always include the "readiness" tools: search + retrieve + list_keys
 *     (the model needs at least these to query its memory state)
 *   - For KV backend: also include `*_retrieve_all` (lets the model dump everything)
 *     as the "oracle" extension (otherwise the model must guess keys blindly)
 *   - The oracle tool set represents "the minimal sufficient tool subset to answer
 *     given the oracle memory is also injected"; it is NOT the full API set.
 *
 * Note: BFCL gives the model the FULL API set by default (baseline). The oracle
 * condition narrows to the subset that is actually useful, removing distractor
 * tools like clear/replace/remove that risk overwriting prefilled memory.
 */
function buildOracleToolIds(tools: ToolItem[]): string[] {
  const selected = new Set<string>();
  for (const tool of tools) {
    const name = tool.id.toLowerCase();
    // Retrieval-oriented tools are always in oracle
    if (READINESS_TOOL_PATTERNS.some((p) => name.includes(p))) {
      selected.add(tool.id);
    }
    // retrieve_all is oracle-only: lets the model dump the whole memory
    // (baseline doesn't have this hint, must guess keys)
    if (name.endsWith("_retrieve_all")) {
      selected.add(tool.id);
    }
  }
  return Array.from(selected);
}

/**
 * Build oracle intent: the test question augmented with scenario + topic chain.
 * This represents "what the user is really asking" — operationalized as
 * the question + a structured summary of what was discussed in prereq conversations.
 *
 * NOTE: We deliberately do NOT include `goldAnswer.source` here. The source
 * snippet is the exact sentence containing the gold answer (e.g. "My name is
 * Michael, ..."), which lives inside the prereq conversation. Injecting it into
 * oracleIntent would leak oracle_memory content into the oracle_intent
 * condition, making intent-only failures artificially flip to success and
 * contaminating RQ1 attribution. The source is preserved in evaluator
 * metadata for post-hoc analysis, not in the agent-visible intent.
 */
function buildOracleIntent(
  questionText: string,
  scenario: string,
  prereq: BfclPrereqConversation[],
  _goldAnswer: BfclAnswer | undefined,
): string {
  const topicChain = prereq.map((conv, idx) => `${idx + 1}. ${conv.topic}`).join("\n");
  const hints: string[] = [
    `scenario = ${scenario} (${SCENARIO_DESCRIPTIONS[scenario] ?? scenario})`,
    `This question is asked AFTER a series of ${prereq.length} prefilled conversations on these topics:\n${topicChain}`,
    `The answer should be retrievable from the memory state populated by those conversations.`,
  ];
  return `${questionText}\nOperational constraints:\n${hints.map((h) => `- ${h}`).join("\n")}`;
}

export class BfclV4MemoryAdapter implements DatasetAdapter {
  readonly source = "bfcl_v4_memory";
  readonly version = "0.2.0";

  async *convert(rawRoot: string): AsyncIterable<CanonicalTask> {
    // 1. Load test questions
    const questions = await readJsonLines<BfclQuestion>(join(rawRoot, "BFCL_v4_memory.json"));

    // 2. Load all prereq conversations, organized by scenario
    const prereqByScenario = new Map<string, BfclPrereqConversation[]>();
    for (const scenario of ["customer", "finance", "healthcare", "notetaker", "student"]) {
      const path = join(rawRoot, "memory_prereq_conversation", `memory_${scenario}.json`);
      try {
        prereqByScenario.set(scenario, await readJsonLines<BfclPrereqConversation>(path));
      } catch {
        // Skip missing scenario
      }
    }

    // 3. Load ground-truth answers, indexed by id
    const answersRaw = await readJsonLines<BfclAnswer>(
      join(rawRoot, "possible_answer", "BFCL_v4_memory.json"),
    );
    const answerById = new Map<string, BfclAnswer>();
    for (const ans of answersRaw) answerById.set(ans.id, ans);

    // 4. Load function docs for each backend
    const toolsByBackend = new Map<BackendName, ToolItem[]>();
    for (const backend of BACKENDS) {
      const docPath = join(rawRoot, "multi_turn_func_doc", `memory_${backend}.json`);
      try {
        const funcs = await readJsonLines<BfclFunction>(docPath);
        toolsByBackend.set(backend, funcs.map((f) => toToolItem(f, backend)));
      } catch {
        // Skip missing backend
      }
    }

    // 5. For each question × backend, emit a CanonicalTask
    for (const question of questions) {
      const scenario = question.scenario;
      const prereq = prereqByScenario.get(scenario) ?? [];
      const goldAnswer = answerById.get(question.id);
      const questionText = extractQuestionText(question);

      for (const backend of BACKENDS) {
        const tools = toolsByBackend.get(backend);
        if (!tools || tools.length === 0) continue;

        const taskId = `${question.id}__${backend}`;
        const oracleToolIds = buildOracleToolIds(tools);

        // Build memory pool.
        // Design (RQ1 direction A): prereq conversation is COMMON memory
        // (baseline gets it in input.memory, but NOT pre-injected to the
        // prompt — agent must call memory tools to read it). Oracle memory
        // is the "key snippet" — the turn containing the gold answer,
        // pre-extracted and pre-injected to the prompt when usesOracleMemory.
        const memoryPool: MemoryItem[] = [];
        // common: scenario profile (small, always injected to prompt)
        memoryPool.push(buildScenarioProfile(scenario, prereq));
        // common: full prereq conversation (in input.memory, NOT in prompt)
        if (prereq.length > 0) {
          memoryPool.push(buildCommonPrereqMemory(taskId, scenario, prereq));
        }
        // oracle: key snippet extracted from prereq (in input.memory AND in
        // prompt only when usesOracleMemory is true via buildRq1Input)
        const oracleSnippet = buildOracleKeySnippetMemory(taskId, scenario, prereq, goldAnswer);
        if (oracleSnippet) {
          memoryPool.push(oracleSnippet);
        }
        // distractor: prereq conversations from other scenarios
        for (const distractor of buildDistractorMemory(taskId, scenario, prereqByScenario)) {
          memoryPool.push(distractor);
        }

        const commonMemoryIds = memoryPool.filter((m) => m.metadata.memoryRole === "common").map((m) => m.id);
        const oracleMemoryIds = memoryPool.filter((m) => m.metadata.memoryRole === "oracle").map((m) => m.id);
        const distractorMemoryIds = memoryPool.filter((m) => m.metadata.memoryRole === "distractor").map((m) => m.id);

        const oracleIntent = buildOracleIntent(questionText, scenario, prereq, goldAnswer);

        const goldAnswerStr = goldAnswer
          ? JSON.stringify({ groundTruth: goldAnswer.ground_truth, source: goldAnswer.source })
          : undefined;

        yield {
          taskId,
          source: this.source,
          domain: `${scenario}__${BACKEND_LABEL[backend]}`,
          split: "test",
          query: questionText,
          oracleIntent,
          memoryPool,
          commonMemoryIds,
          oracleMemoryIds,
          distractorMemoryIds,
          toolPool: tools,
          oracleToolIds,
          evaluator: {
            type: "exact_match",
            goldAnswer: goldAnswerStr,
            metadata: {
              bfclId: question.id,
              scenario,
              backend,
              backendLabel: BACKEND_LABEL[backend],
              groundTruthCandidates: goldAnswer?.ground_truth ?? [],
              sourceSnippet: goldAnswer?.source,
              involvedClasses: question.involved_classes,
            },
          },
          capabilities: {
            hasOracleIntent: true,
            hasOracleMemory: oracleMemoryIds.length > 0,
            hasOracleTool: oracleToolIds.length > 0,
            hasExecutableEval: goldAnswer !== undefined,
            supportsInteraction: false, // BFCL memory is single-turn: question → answer
          },
          metadata: {
            adapterVersion: this.version,
            rawTaskId: question.id,
            scenario,
            backend,
            backendLabel: BACKEND_LABEL[backend],
            prereqConversationCount: prereq.length,
            prereqTopics: prereq.map((c) => c.topic),
            involvedClasses: question.involved_classes,
            goldAnswerSource: goldAnswer?.source,
          },
        };
      }
    }
  }
}
