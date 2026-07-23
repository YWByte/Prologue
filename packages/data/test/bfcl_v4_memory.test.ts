import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { canonicalTaskSchema } from "@prologue/schemas";
import { BfclV4MemoryAdapter } from "../src/adapters/bfcl_v4_memory.js";

function resolveRawRoot(): string {
  const candidates = [process.env.INIT_CWD, process.cwd()].filter(Boolean) as string[];
  for (const base of candidates) {
    if (base.includes("Prologue")) return join(base, "data", "raw", "bfcl_v4_memory");
  }
  throw new Error("Could not locate Prologue workspace root. Run via `pnpm test` from the workspace root.");
}

const RAW_ROOT = resolveRawRoot();

async function loadAll() {
  const adapter = new BfclV4MemoryAdapter();
  const tasks = [];
  for await (const task of adapter.convert(RAW_ROOT)) {
    tasks.push(canonicalTaskSchema.parse(task));
  }
  return tasks;
}

describe("BfclV4MemoryAdapter", () => {
  it("emits only uniquely aligned tasks across three backends", async () => {
    const tasks = await loadAll();
    expect(tasks.length).toBe(390);
    for (const task of tasks) {
      expect(task.taskId).toMatch(/^memory_\d+-[a-z]+-\d+__(kv|vector|rec_sum)$/);
      expect(task.metadata.adapterVersion).toBe("0.3.0");
    }
  });

  it("supports only identifiable memory and tool RQ1 axes", async () => {
    const tasks = await loadAll();
    for (const task of tasks) {
      expect(task.capabilities.hasOracleIntent).toBe(false);
      expect(task.capabilities.hasOracleMemory).toBe(true);
      expect(task.capabilities.hasOracleTool).toBe(true);
      expect(task.oracleIntent).toBeUndefined();
    }
  });

  it("models each prerequisite conversation as a candidate memory unit", async () => {
    const tasks = await loadAll();
    for (const task of tasks) {
      const scenario = task.metadata.scenario as string;
      const conversations = task.memoryPool.filter((memory) => (
        memory.metadata.memoryRole === "common" && memory.type === "history"
      ));
      expect(conversations.length).toBe(task.metadata.prereqConversationCount);
      expect(conversations.every((memory) => memory.id.includes(":memory:conversation:"))).toBe(true);
      expect(conversations.every((memory) => memory.metadata.promptInjected === false)).toBe(true);
      expect(task.oracleMemoryIds).toHaveLength(1);
      expect(conversations.some((memory) => memory.id === task.oracleMemoryIds[0])).toBe(true);
      expect(task.evaluator.metadata?.rq1GoldMemoryIds).toEqual(task.oracleMemoryIds);
      expect(conversations.every((memory) => memory.metadata.scenario === scenario)).toBe(true);
    }
  });

  it("keeps gold evidence evaluator-side and out of agent-visible memory", async () => {
    const tasks = await loadAll();
    for (const task of tasks) {
      const goldCandidates = task.evaluator.metadata?.groundTruthCandidates as string[];
      expect(goldCandidates.length).toBeGreaterThan(0);
      expect(task.evaluator.metadata?.sourceSnippet).toBeUndefined();
      for (const memory of task.memoryPool) {
        expect(memory.metadata.oracle).toBeUndefined();
        expect(memory.metadata.goldAnswerCandidates).toBeUndefined();
        expect(memory.metadata.sourceSnippet).toBeUndefined();
        expect(memory.metadata.keySnippetMatchedBy).toBeUndefined();
      }
    }
  });

  it("uses stable cross-scenario distractors alongside same-scenario hard negatives", async () => {
    const tasks = await loadAll();
    for (const task of tasks) {
      const targetScenario = task.metadata.scenario as string;
      const distractors = task.memoryPool.filter((memory) => memory.metadata.memoryRole === "distractor");
      expect(distractors).toHaveLength(4);
      expect(distractors.every((memory) => memory.metadata.scenario !== targetScenario)).toBe(true);
      const commonConversations = task.memoryPool.filter((memory) => memory.metadata.memoryRole === "common" && memory.type === "history");
      expect(commonConversations.length).toBeGreaterThan(1);
    }
  });

  it("keeps oracle tools a strict read-only subset without new capabilities", async () => {
    const tasks = await loadAll();
    for (const task of tasks) {
      const allTools = new Set(task.toolPool.map((tool) => tool.id));
      expect(task.oracleToolIds.length).toBeGreaterThan(0);
      expect(task.oracleToolIds.every((id) => allTools.has(id))).toBe(true);
      expect(task.oracleToolIds.every((id) => /retrieve|search|list_keys/i.test(id))).toBe(true);
      const retrieveAll = task.toolPool.filter((tool) => tool.id.endsWith("_retrieve_all")).map((tool) => tool.id);
      expect(retrieveAll.every((id) => task.oracleToolIds.includes(id))).toBe(true);
    }
  });

  it("records source or unique-candidate alignment without exposing the source text", async () => {
    const tasks = await loadAll();
    for (const task of tasks) {
      expect(["source", "unique_candidate"]).toContain(task.evaluator.metadata?.rq1AlignmentMethod);
      expect(task.metadata.rq1MemoryOracleMode).toBe("prestage_existing");
      expect(task.metadata.rq1SupportedComponents).toEqual(["memory", "tool"]);
    }
  });
});
