import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { CanonicalTask, MemoryItem, ToolItem } from "@prologue/schemas";
import type { DatasetAdapter } from "../index.js";

/**
 * BFCL V4 Memory adapter for RQ1 memory/tool attribution.
 *
 * Each prerequisite conversation is an independently retrievable memory unit.
 * The oracle identifies a complete relevant conversation, never an answer-bearing
 * turn. Gold answers and source alignment remain evaluator-side only.
 */

type BfclQuestion = {
  id: string;
  question: Array<Array<{ role: string; content: string }>>;
  involved_classes: string[];
  scenario: string;
};

type BfclPrereqConversation = {
  id: string;
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
type ConversationAlignment = {
  conversationIndex: number;
  matchedBy: "source" | "unique_candidate";
};

const BACKENDS: BackendName[] = ["kv", "vector", "rec_sum"];
const SCENARIOS = ["customer", "finance", "healthcare", "notetaker", "student"];
const BACKEND_LABEL: Record<BackendName, string> = {
  kv: "key_value_store",
  vector: "vector_store",
  rec_sum: "recursive_summarization",
};

async function readJsonLines<T>(path: string): Promise<T[]> {
  const raw = await readFile(path, "utf8");
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as T);
}

function extractQuestionText(entry: BfclQuestion): string {
  const firstTurn = entry.question[0];
  return firstTurn?.map((message) => message.content).join(" ") ?? "";
}

function extractConversationText(entry: BfclPrereqConversation): string {
  return entry.question
    .map((turn, index) => `Turn ${index + 1} [${entry.topic}]: ${turn.map((message) => message.content).join(" ")}`)
    .join("\n");
}

function normalizeSource(source: string | undefined): string {
  return (source ?? "")
    .trim()
    .replace(/^\s*"+\s*/, "")
    .replace(/\s*"+\s*$/, "")
    .replace(/\s*\.\.\.\s*$/, "")
    .trim();
}

/**
 * Align a question to a full prerequisite conversation for offline labels only.
 * Source evidence is preferred. Candidate matching is accepted only when exactly
 * one conversation contains a candidate, avoiding ambiguous answer-localization.
 */
function alignRelevantConversation(
  prereq: BfclPrereqConversation[],
  answer: BfclAnswer | undefined,
): ConversationAlignment | null {
  if (!answer) return null;
  const conversations = prereq.map((conversation) => extractConversationText(conversation));
  const source = normalizeSource(answer.source);
  if (source.length > 0) {
    const sourceHits = conversations
      .map((content, index) => (content.includes(source) ? index : -1))
      .filter((index) => index >= 0);
    if (sourceHits.length === 1) {
      return { conversationIndex: sourceHits[0], matchedBy: "source" };
    }
  }

  const candidateHits = conversations
    .map((content, index) => (
      answer.ground_truth.some((candidate) => candidate.length > 0 && content.includes(candidate))
        ? index
        : -1
    ))
    .filter((index) => index >= 0);
  if (candidateHits.length === 1) {
    return { conversationIndex: candidateHits[0], matchedBy: "unique_candidate" };
  }
  return null;
}

function buildScenarioProfile(scenario: string, prereq: BfclPrereqConversation[]): MemoryItem {
  return {
    id: `bfcl_v4_memory:memory:scenario_profile:${scenario}`,
    type: "profile",
    content: JSON.stringify({
      scenario,
      scenarioDescription: SCENARIO_DESCRIPTIONS[scenario] ?? `BFCL V4 memory scenario: ${scenario}`,
      conversationTopics: prereq.map((conversation) => conversation.topic),
      conversationCount: prereq.length,
    }),
    source: "bfcl_v4_memory.scenario_metadata",
    metadata: { memoryRole: "common", scenario, promptInjected: true },
  };
}

const SCENARIO_DESCRIPTIONS: Record<string, string> = {
  customer: "Customer support interactions with a coffee equipment company",
  finance: "Finance managing director's portfolio and market interactions",
  healthcare: "Healthcare patient history and medical appointment tracking",
  student: "College student advising, courses, and academic planning",
  notetaker: "Personal to-do list and notetaking assistant",
};

function buildConversationMemory(
  taskId: string,
  conversation: BfclPrereqConversation,
  index: number,
  memoryRole: "common" | "distractor",
): MemoryItem {
  return {
    id: `${taskId}:memory:conversation:${conversation.scenario}:${index + 1}`,
    type: "history",
    content: `Conversation ${index + 1} [${conversation.topic}]:\n${extractConversationText(conversation)}`,
    source: `bfcl_v4.memory_prereq_conversation.memory_${conversation.scenario}`,
    metadata: {
      memoryRole,
      scenario: conversation.scenario,
      conversationIndex: index,
      topic: conversation.topic,
      promptInjected: false,
      ...(memoryRole === "distractor" ? { distractorType: "cross_scenario" } : {}),
    },
  };
}

/**
 * Use one stable cross-scenario conversation per non-target scenario as an easy
 * distractor. Target-scenario conversations are hard distractors because all
 * share the same user/domain but only one is labeled relevant.
 */
function buildDistractorMemory(
  taskId: string,
  targetScenario: string,
  allPrereq: Map<string, BfclPrereqConversation[]>,
): MemoryItem[] {
  const distractors: MemoryItem[] = [];
  for (const scenario of SCENARIOS) {
    if (scenario === targetScenario) continue;
    const conversation = allPrereq.get(scenario)?.[0];
    if (!conversation) continue;
    distractors.push(buildConversationMemory(taskId, conversation, 0, "distractor"));
  }
  return distractors;
}

function toToolItem(func: BfclFunction, backend: BackendName): ToolItem {
  return {
    id: func.name,
    name: func.name,
    description: func.description,
    type: "function",
    schema: { parameters: func.parameters, response: func.response ?? null },
    metadata: { backend, backendLabel: BACKEND_LABEL[backend], suite: "memory" },
  };
}

/**
 * T* is a strict subset of the baseline API pool. It only removes mutation and
 * update operations; it never adds a retrieval capability unavailable to the
 * baseline. `retrieve_all` remains in baseline and T* when the backend offers it.
 */
function buildOracleToolIds(tools: ToolItem[]): string[] {
  return tools
    .filter((tool) => {
      const name = tool.id.toLowerCase();
      return name.includes("retrieve") || name.includes("search") || name.includes("list_keys");
    })
    .map((tool) => tool.id);
}

export class BfclV4MemoryAdapter implements DatasetAdapter {
  readonly source = "bfcl_v4_memory";
  readonly version = "0.3.0";

  async *convert(rawRoot: string): AsyncIterable<CanonicalTask> {
    const questions = await readJsonLines<BfclQuestion>(join(rawRoot, "BFCL_v4_memory.json"));
    const prereqByScenario = new Map<string, BfclPrereqConversation[]>();
    for (const scenario of SCENARIOS) {
      prereqByScenario.set(
        scenario,
        await readJsonLines<BfclPrereqConversation>(
          join(rawRoot, "memory_prereq_conversation", `memory_${scenario}.json`),
        ),
      );
    }

    const answers = await readJsonLines<BfclAnswer>(
      join(rawRoot, "possible_answer", "BFCL_v4_memory.json"),
    );
    const answerById = new Map(answers.map((answer) => [answer.id, answer]));

    const toolsByBackend = new Map<BackendName, ToolItem[]>();
    for (const backend of BACKENDS) {
      const functions = await readJsonLines<BfclFunction>(
        join(rawRoot, "multi_turn_func_doc", `memory_${backend}.json`),
      );
      toolsByBackend.set(backend, functions.map((func) => toToolItem(func, backend)));
    }

    for (const question of questions) {
      const prereq = prereqByScenario.get(question.scenario) ?? [];
      const answer = answerById.get(question.id);
      const alignment = alignRelevantConversation(prereq, answer);
      if (!alignment) continue;

      for (const backend of BACKENDS) {
        const tools = toolsByBackend.get(backend);
        if (!tools) continue;
        const taskId = `${question.id}__${backend}`;
        const profile = buildScenarioProfile(question.scenario, prereq);
        const conversations = prereq.map((conversation, index) => (
          buildConversationMemory(taskId, conversation, index, "common")
        ));
        const relevantConversationId = conversations[alignment.conversationIndex]?.id;
        if (!relevantConversationId) continue;
        const distractors = buildDistractorMemory(taskId, question.scenario, prereqByScenario);
        const memoryPool = [profile, ...conversations, ...distractors];
        const commonMemoryIds = [profile.id, ...conversations.map((item) => item.id)];
        const distractorMemoryIds = distractors.map((item) => item.id);
        const oracleToolIds = buildOracleToolIds(tools);

        yield {
          taskId,
          source: this.source,
          domain: `${question.scenario}__${BACKEND_LABEL[backend]}`,
          split: "test",
          query: extractQuestionText(question),
          memoryPool,
          commonMemoryIds,
          oracleMemoryIds: [relevantConversationId],
          distractorMemoryIds,
          toolPool: tools,
          oracleToolIds,
          evaluator: {
            type: "exact_match",
            goldAnswer: answer ? JSON.stringify({ groundTruth: answer.ground_truth }) : undefined,
            metadata: {
              bfclId: question.id,
              scenario: question.scenario,
              backend,
              backendLabel: BACKEND_LABEL[backend],
              groundTruthCandidates: answer?.ground_truth ?? [],
              rq1GoldMemoryIds: [relevantConversationId],
              rq1AlignmentMethod: alignment.matchedBy,
              involvedClasses: question.involved_classes,
            },
          },
          capabilities: {
            hasOracleIntent: false,
            hasOracleMemory: true,
            hasOracleTool: oracleToolIds.length > 0,
            hasExecutableEval: answer !== undefined,
            supportsInteraction: false,
          },
          metadata: {
            adapterVersion: this.version,
            rawTaskId: question.id,
            scenario: question.scenario,
            backend,
            backendLabel: BACKEND_LABEL[backend],
            prereqConversationCount: prereq.length,
            candidateConversationCount: conversations.length + distractors.length,
            rq1MemoryOracleMode: "prestage_existing",
            rq1SupportedComponents: ["memory", "tool"],
            involvedClasses: question.involved_classes,
          },
        };
      }
    }
  }
}
