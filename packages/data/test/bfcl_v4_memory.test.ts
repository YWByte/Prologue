// Unit tests for BfclV4MemoryAdapter.
// Loads the real raw BFCL V4 Memory data from data/raw/bfcl_v4_memory and
// verifies structural invariants, distribution, oracle three-component
// completeness, and intent/memory/tool separation for RQ1 attribution.
import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { canonicalTaskSchema } from "@prologue/schemas";
import { BfclV4MemoryAdapter } from "../src/adapters/bfcl_v4_memory.js";

// vitest resolves process.cwd() to the workspace root (where vitest runs).
// Use INIT_CWD (set by pnpm to the package root) as a fallback, then
// resolve to the canonical Prologue workspace.
function resolveRawRoot(): string {
  const candidates = [
    process.env.INIT_CWD,
    process.cwd(),
  ].filter(Boolean) as string[];
  for (const base of candidates) {
    const candidate = join(base, "data", "raw", "bfcl_v4_memory");
    // Quick sync check via require would need fs; just return first candidate
    // that looks plausible. The adapter will throw a clear error if missing.
    if (base.includes("Prologue")) return candidate;
  }
  throw new Error(
    "Could not locate Prologue workspace root. Run via `pnpm test` from the workspace root.",
  );
}

const RAW_ROOT = resolveRawRoot();

async function loadAll() {
  const adapter = new BfclV4MemoryAdapter();
  const tasks = [];
  for await (const task of adapter.convert(RAW_ROOT)) {
    // Every emitted task must parse against the canonical schema.
    tasks.push(canonicalTaskSchema.parse(task));
  }
  return tasks;
}

describe("BfclV4MemoryAdapter", () => {
  it("emits 465 tasks (155 questions × 3 backends)", async () => {
    const tasks = await loadAll();
    expect(tasks.length).toBe(465);
  });

  it("distributes tasks across 5 scenarios × 3 backends", async () => {
    const tasks = await loadAll();
    const counts: Record<string, number> = {};
    for (const t of tasks) {
      const scenario = t.metadata.scenario as string;
      const backend = t.metadata.backend as string;
      const key = `${scenario}__${backend}`;
      counts[key] = (counts[key] ?? 0) + 1;
    }
    // Expected per-scenario counts (customer 30, finance 25, healthcare 25,
    // notetaker 25, student 50) × 3 backends.
    const expected = {
      customer__kv: 30, customer__vector: 30, customer__rec_sum: 30,
      finance__kv: 25, finance__vector: 25, finance__rec_sum: 25,
      healthcare__kv: 25, healthcare__vector: 25, healthcare__rec_sum: 25,
      notetaker__kv: 25, notetaker__vector: 25, notetaker__rec_sum: 25,
      student__kv: 50, student__vector: 50, student__rec_sum: 50,
    };
    expect(counts).toEqual(expected);
  });

  it("produces taskId of form <bfclId>__<backend>", async () => {
    const tasks = await loadAll();
    for (const t of tasks) {
      expect(t.taskId).toMatch(/^memory_\d+-[a-z]+-\d+__(kv|vector|rec_sum)$/);
      expect(t.metadata.rawTaskId).toBeTruthy();
      expect(t.metadata.backend).toBeTruthy();
    }
  });

  it("every task has oracle three-component flags true", async () => {
    const tasks = await loadAll();
    for (const t of tasks) {
      expect(t.capabilities.hasOracleIntent).toBe(true);
      expect(t.capabilities.hasOracleMemory).toBe(true);
      expect(t.capabilities.hasOracleTool).toBe(true);
      expect(t.capabilities.hasExecutableEval).toBe(true);
      expect(t.capabilities.supportsInteraction).toBe(false);
    }
  });

  it("memoryPool partitions into common/oracle/distractor with disjoint ids", async () => {
    const tasks = await loadAll();
    for (const t of tasks) {
      const common = new Set(t.commonMemoryIds);
      const oracle = new Set(t.oracleMemoryIds);
      const distractor = new Set(t.distractorMemoryIds);
      // Disjoint
      for (const id of common) {
        expect(oracle.has(id)).toBe(false);
        expect(distractor.has(id)).toBe(false);
      }
      for (const id of oracle) {
        expect(common.has(id)).toBe(false);
        expect(distractor.has(id)).toBe(false);
      }
      // Union matches memoryPool ids
      const all = new Set([...common, ...oracle, ...distractor]);
      expect(all.size).toBe(t.memoryPool.length);
    }
  });

  it("oracle memory item carries oracle=true, gold answer hint, and prereq conversation content", async () => {
    const tasks = await loadAll();
    const sample = tasks.find((t) => t.metadata.scenario === "customer" && t.metadata.backend === "kv")!;
    expect(sample.oracleMemoryIds.length).toBeGreaterThan(0);
    const oracleItem = sample.memoryPool.find((m) => m.id === sample.oracleMemoryIds[0])!;
    expect(oracleItem.metadata.oracle).toBe(true);
    expect(oracleItem.metadata.memoryRole).toBe("oracle");
    expect(Array.isArray(oracleItem.metadata.goldAnswerCandidates)).toBe(true);
    expect((oracleItem.metadata.goldAnswerCandidates as string[]).length).toBeGreaterThan(0);
    expect(typeof oracleItem.metadata.sourceSnippet).toBe("string");
    // Content includes conversation topic markers
    expect(oracleItem.content).toContain("=== Conversation 1:");
    expect(oracleItem.content).toContain("First-Time Inquiry About a Product");
  });

  it("oracleToolIds are a strict subset of toolPool and only contain readiness tools", async () => {
    const tasks = await loadAll();
    for (const t of tasks) {
      const toolIds = new Set(t.toolPool.map((x) => x.id));
      for (const id of t.oracleToolIds) {
        expect(toolIds.has(id)).toBe(true);
      }
      // Every oracle tool name must contain search/retrieve/list_keys
      for (const id of t.oracleToolIds) {
        const lower = id.toLowerCase();
        const isReadiness = ["search", "retrieve", "list_keys"].some((p) => lower.includes(p));
        expect(isReadiness).toBe(true);
      }
    }
  });

  it("oracleIntent does NOT leak goldAnswer source snippet", async () => {
    const tasks = await loadAll();
    for (const t of tasks) {
      const snippet = t.evaluator.metadata?.sourceSnippet as string | undefined;
      if (!snippet) continue;
      // The gold answer source sentence must not appear verbatim in oracleIntent
      expect(t.oracleIntent).not.toContain(snippet);
    }
  });

  it("oracleIntent contains scenario, topic chain and question text", async () => {
    const tasks = await loadAll();
    const sample = tasks.find((t) => t.metadata.scenario === "customer" && t.metadata.backend === "kv")!;
    expect(sample.oracleIntent).toContain(sample.query);
    expect(sample.oracleIntent).toContain("scenario = customer");
    expect(sample.oracleIntent).toContain("Operational constraints:");
    // Topic chain from prereq conversations
    expect(sample.oracleIntent).toContain("First-Time Inquiry About a Product");
  });

  it("first customer/kv task ground truth is Michael for 'What is my first name?'", async () => {
    const tasks = await loadAll();
    const first = tasks.find((t) => t.taskId === "memory_0-customer-0__kv")!;
    expect(first.query).toBe("What is my first name?");
    expect(first.evaluator.metadata?.groundTruthCandidates).toEqual(["Michael"]);
    expect(first.evaluator.metadata?.sourceSnippet).toContain("My name is Michael");
  });

  it("distractor memory comes from other scenarios (cross-scenario interference)", async () => {
    const tasks = await loadAll();
    for (const t of tasks) {
      const targetScenario = t.metadata.scenario as string;
      for (const id of t.distractorMemoryIds) {
        const item = t.memoryPool.find((m) => m.id === id)!;
        expect(item.metadata.scenario).not.toBe(targetScenario);
        expect(item.metadata.memoryRole).toBe("distractor");
        expect(item.metadata.oracle).toBe(false);
      }
    }
  });

  it("evaluator is exact_match with goldAnswer JSON containing ground_truth array", async () => {
    const tasks = await loadAll();
    for (const t of tasks) {
      expect(t.evaluator.type).toBe("exact_match");
      expect(t.evaluator.goldAnswer).toBeDefined();
      const parsed = JSON.parse(t.evaluator.goldAnswer!);
      expect(Array.isArray(parsed.groundTruth)).toBe(true);
      expect(parsed.groundTruth.length).toBeGreaterThan(0);
    }
  });

  it("rec_sum backend has at least one oracle tool (memory_retrieve)", async () => {
    const tasks = await loadAll();
    const recSumTasks = tasks.filter((t) => t.metadata.backend === "rec_sum");
    expect(recSumTasks.length).toBe(155);
    for (const t of recSumTasks) {
      expect(t.oracleToolIds).toContain("memory_retrieve");
    }
  });
});
