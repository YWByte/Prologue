/**
 * Stub agent attribution test for BFCL V4 Memory (v0.2.0 design).
 *
 * Loads a sample of canonical tasks, runs the BfclV4MemoryExecutor
 * (which uses StubBfclMemoryAgent) across all 8 RQ1 conditions, and verifies
 * the attribution matrix matches the expected semantics:
 *
 *   - baseline:                    FAIL (stub is "lazy" — doesn't retrieve prereq)
 *   - oracle_intent:               FAIL (intent alone doesn't give the answer)
 *   - oracle_memory:                PASS (key snippet with answer is in context)
 *   - oracle_tool:                 FAIL (tools without oracle memory don't help stub)
 *   - oracle_intent_memory:         PASS
 *   - oracle_intent_tool:           FAIL (no oracle memory)
 *   - oracle_memory_tool:           PASS
 *   - oracle_all:                   PASS
 *
 * Under v0.2.0 direction A design, the stub models a "lazy agent" that only
 * answers when the oracle key snippet is pre-staged in input.memory. A real
 * LLM agent may succeed in baseline by actively calling tools — the stub is
 * the conservative lower bound for attribution validation.
 *
 * Run: node_modules/.bin/tsx scripts/test-bfcl-stub-attribution.ts
 */
import { readCanonicalTasks } from "../packages/data/dist/index.js";
import { buildRq1Input, RQ1_CONDITIONS } from "../packages/experiments/dist/rq1.js";
import { BfclV4MemoryExecutor } from "../packages/experiments/dist/index.js";
import type { Rq1Condition } from "../packages/experiments/dist/rq1.js";

const TASKS_PATH = "data/canonical/bfcl_v4_memory.jsonl";
const SAMPLE_SIZE = 15; // 5 scenarios × 3 backends = 15 tasks × 8 conditions = 120 runs

async function main(): Promise<void> {
  const allTasks = await readCanonicalTasks(TASKS_PATH);
  const sample = pickSample(allTasks, SAMPLE_SIZE);
  console.log(`Loaded ${allTasks.length} tasks, sampling ${sample.length}.`);
  for (const t of sample) {
    console.log(`  ${t.taskId} | scenario=${t.metadata.scenario} backend=${t.metadata.backend} | q="${t.query.slice(0, 60)}"`);
  }
  console.log("");

  const executor = new BfclV4MemoryExecutor();
  const results: Record<Rq1Condition, { total: number; success: number }> = Object.fromEntries(
    RQ1_CONDITIONS.map((c) => [c, { total: 0, success: 0 }]),
  ) as Record<Rq1Condition, { total: number; success: number }>;

  const perTaskCondition: Array<{
    taskId: string;
    condition: Rq1Condition;
    success: boolean;
    reason: string;
    derivedAnswer: string;
    goldCandidates: string[];
  }> = [];

  for (const task of sample) {
    for (const condition of RQ1_CONDITIONS) {
      const input = buildRq1Input(task, condition);
      const result = await executor.execute(input);
      results[condition].total += 1;
      if (result.success) results[condition].success += 1;
      perTaskCondition.push({
        taskId: task.taskId,
        condition,
        success: result.success,
        reason: result.reason ?? "",
        derivedAnswer: (result.metadata?.derivedAnswer as string) ?? "",
        goldCandidates: (result.metadata?.goldCandidates as string[]) ?? [],
      });
    }
  }

  // Print attribution matrix
  console.log("=".repeat(80));
  console.log(`RQ1 Attribution Matrix (stub agent, ${sample.length} tasks × ${RQ1_CONDITIONS.length} conditions)`);
  console.log("=".repeat(80));
  console.log("condition                     success  total   rate");
  console.log("-".repeat(80));
  for (const condition of RQ1_CONDITIONS) {
    const r = results[condition];
    const rate = r.total > 0 ? (r.success / r.total) * 100 : 0;
    console.log(`${condition.padEnd(28)}  ${String(r.success).padStart(6)}  ${String(r.total).padStart(6)}  ${rate.toFixed(1)}%`);
  }
  console.log("");

  // Per-task detail for first task
  console.log("=".repeat(80));
  console.log("Per-task detail (first sampled task):");
  console.log("=".repeat(80));
  const firstTaskId = sample[0].taskId;
  for (const r of perTaskCondition) {
    if (r.taskId !== firstTaskId) continue;
    const marker = r.success ? "PASS" : "FAIL";
    console.log(`[${marker}] ${r.condition.padEnd(28)} | answer="${r.derivedAnswer}" gold=${JSON.stringify(r.goldCandidates)}`);
    console.log(`         reason: ${r.reason}`);
  }
  console.log("");

  // Verify attribution semantics
  console.log("=".repeat(80));
  console.log("Attribution verification (stub = lazy agent lower bound):");
  console.log("=".repeat(80));
  const checks: Array<{ condition: Rq1Condition; expectSuccess: boolean; label: string }> = [
    { condition: "baseline", expectSuccess: false, label: "baseline fails (stub doesn't retrieve prereq)" },
    { condition: "oracle_intent", expectSuccess: false, label: "oracle_intent alone fails (intent without memory)" },
    { condition: "oracle_memory", expectSuccess: true, label: "oracle_memory passes (key snippet in context)" },
    { condition: "oracle_tool", expectSuccess: false, label: "oracle_tool alone fails (tools without oracle memory)" },
    { condition: "oracle_intent_memory", expectSuccess: true, label: "oracle_intent_memory passes" },
    { condition: "oracle_intent_tool", expectSuccess: false, label: "oracle_intent_tool fails (no oracle memory)" },
    { condition: "oracle_memory_tool", expectSuccess: true, label: "oracle_memory_tool passes" },
    { condition: "oracle_all", expectSuccess: true, label: "oracle_all passes" },
  ];
  let allPassed = true;
  for (const check of checks) {
    const r = results[check.condition];
    const actualSuccess = r.success === r.total; // all sample tasks should match
    const ok = actualSuccess === check.expectSuccess;
    if (!ok) allPassed = false;
    console.log(`[${ok ? "OK" : "FAIL"}] ${check.label}: got success=${r.success}/${r.total}, expected ${check.expectSuccess ? "all pass" : "all fail"}`);
  }
  console.log("");
  console.log(allPassed ? "ALL ATTRIBUTION CHECKS PASSED" : "SOME CHECKS FAILED");
  process.exit(allPassed ? 0 : 1);
}

/**
 * Pick one task per (scenario × backend), to spread across the full matrix.
 * 5 scenarios × 3 backends = 15 tasks. If n < 15, picks first n kv tasks.
 */
function pickSample(tasks: any[], n: number): any[] {
  const seenKeys = new Set<string>();
  const sample: any[] = [];
  // First pass: one per scenario on kv (fast sample)
  for (const t of tasks) {
    if (t.metadata.backend !== "kv") continue;
    const sc = t.metadata.scenario;
    const key = `${sc}__kv`;
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);
    sample.push(t);
    if (sample.length >= n) return sample;
  }
  // Second pass: fill in other backends
  for (const t of tasks) {
    const key = `${t.metadata.scenario}__${t.metadata.backend}`;
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);
    sample.push(t);
    if (sample.length >= n) return sample;
  }
  return sample;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
