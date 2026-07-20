/**
 * BFCL V4 Memory adapter structural tests (standalone, tsx).
 *
 * Verifies the adapter v0.2.0 (RQ1 direction A design) produces canonical
 * tasks with the expected memory pool structure:
 *   - 465 tasks total (155 questions × 3 backends)
 *   - Distribution: 5 scenarios × 3 backends
 *   - Memory pool has 3 tiers: common (scenario_profile + prereq_conversation),
 *     oracle (key_snippet), distractor (cross-scenario prereq snippets)
 *   - prereq_conversation is COMMON (baseline gets it), promptInjected=false
 *   - oracle key_snippet is ORACLE, promptInjected=true, carries goldAnswerCandidates
 *   - distractors are promptInjected=false
 *   - oracleIntent does NOT leak goldAnswer.source
 *   - oracleToolIds is a subset of toolPool
 *   - Gold answer candidates are reachable from oracle key snippet content
 *
 * Run: node_modules/.bin/tsx scripts/test-bfcl-adapter.ts
 */
import { readCanonicalTasks } from "../packages/data/dist/index.js";
import { buildRq1Input, RQ1_CONDITIONS } from "../packages/experiments/dist/rq1.js";

const TASKS_PATH = "/Users/wondery/paper/Prologue/data/canonical/bfcl_v4_memory.jsonl";

type TestResult = { name: string; passed: boolean; detail?: string };
const results: TestResult[] = [];

function check(name: string, cond: boolean, detail?: string): void {
  results.push({ name, passed: cond, detail });
}

async function main(): Promise<void> {
  const tasks = await readCanonicalTasks(TASKS_PATH);

  // 1. Total task count
  check("task count = 465", tasks.length === 465, `got ${tasks.length}`);

  // 2. Distribution: 5 scenarios × 3 backends
  const byScenarioBackend: Record<string, number> = {};
  for (const t of tasks) {
    const key = `${t.metadata.scenario}_${t.metadata.backend}`;
    byScenarioBackend[key] = (byScenarioBackend[key] ?? 0) + 1;
  }
  const expectedKeys = [
    "customer_kv", "customer_vector", "customer_rec_sum",
    "finance_kv", "finance_vector", "finance_rec_sum",
    "healthcare_kv", "healthcare_vector", "healthcare_rec_sum",
    "notetaker_kv", "notetaker_vector", "notetaker_rec_sum",
    "student_kv", "student_vector", "student_rec_sum",
  ];
  for (const key of expectedKeys) {
    check(`distribution ${key} > 0`, (byScenarioBackend[key] ?? 0) > 0, `got ${byScenarioBackend[key] ?? 0}`);
  }

  // 3. Task ID format: <bfcl_id>__<backend>
  const badTaskIds = tasks.filter((t) => !t.taskId.includes("__")).map((t) => t.taskId);
  check("all taskIds contain '__'", badTaskIds.length === 0, `${badTaskIds.length} bad IDs`);

  // 4. Every task has exactly 1 oracle memory item (key snippet)
  let tasksWithoutOracle = 0;
  for (const t of tasks) {
    if (t.oracleMemoryIds.length !== 1) tasksWithoutOracle += 1;
  }
  check("every task has exactly 1 oracle memory id", tasksWithoutOracle === 0, `${tasksWithoutOracle} tasks without oracle`);

  // 5. Memory pool structure for first task (detailed inspection)
  const sample = tasks[0];
  const profileItem = sample.memoryPool.find((m) => m.id.includes("scenario_profile"));
  const prereqItem = sample.memoryPool.find((m) => m.id.includes("prereq_conversation"));
  const oracleItem = sample.memoryPool.find((m) => m.id.includes("oracle_key_snippet"));
  const distractorItems = sample.memoryPool.filter((m) => m.id.includes("distractor"));

  check("scenario_profile exists", !!profileItem);
  check("prereq_conversation exists", !!prereqItem);
  check("oracle_key_snippet exists", !!oracleItem);
  check("distractors exist (>= 1)", distractorItems.length >= 1, `got ${distractorItems.length}`);

  // 6. Memory role tags
  if (profileItem) {
    check("scenario_profile.memoryRole = common", profileItem.metadata.memoryRole === "common");
    check("scenario_profile.promptInjected = true", profileItem.metadata.promptInjected === true);
    check("scenario_profile.oracle = false", profileItem.metadata.oracle === false);
  }
  if (prereqItem) {
    check("prereq_conversation.memoryRole = common", prereqItem.metadata.memoryRole === "common");
    check("prereq_conversation.promptInjected = false", prereqItem.metadata.promptInjected === false);
    check("prereq_conversation.oracle = false", prereqItem.metadata.oracle === false);
  }
  if (oracleItem) {
    check("oracle_key_snippet.memoryRole = oracle", oracleItem.metadata.memoryRole === "oracle");
    check("oracle_key_snippet.promptInjected = true", oracleItem.metadata.promptInjected === true);
    check("oracle_key_snippet.oracle = true", oracleItem.metadata.oracle === true);
    check("oracle_key_snippet has goldAnswerCandidates", Array.isArray(oracleItem.metadata.goldAnswerCandidates) && oracleItem.metadata.goldAnswerCandidates.length > 0);
    check("oracle_key_snippet has sourceSnippet", typeof oracleItem.metadata.sourceSnippet === "string");
  }

  // 7. Common/oracle/distractor memory IDs are disjoint
  const commonIds = new Set(sample.commonMemoryIds);
  const oracleIds = new Set(sample.oracleMemoryIds);
  const distractorIds = new Set(sample.distractorMemoryIds);
  const overlapCO = [...commonIds].filter((id) => oracleIds.has(id));
  const overlapCD = [...commonIds].filter((id) => distractorIds.has(id));
  const overlapOD = [...oracleIds].filter((id) => distractorIds.has(id));
  check("common/oracle disjoint", overlapCO.length === 0, `${overlapCO.length} overlaps`);
  check("common/distractor disjoint", overlapCD.length === 0, `${overlapCD.length} overlaps`);
  check("oracle/distractor disjoint", overlapOD.length === 0, `${overlapOD.length} overlaps`);

  // 8. oracleToolIds is subset of toolPool
  const toolIds = new Set(sample.toolPool.map((t) => t.id));
  const missingTools = sample.oracleToolIds.filter((id) => !toolIds.has(id));
  check("oracleToolIds ⊆ toolPool", missingTools.length === 0, `${missingTools.length} missing`);

  // 9. oracleIntent does NOT contain goldAnswer.source (no leak)
  const goldSource = sample.evaluator.metadata?.sourceSnippet as string | undefined;
  if (goldSource && goldSource.length > 10) {
    const sourcePrefix = goldSource.replace(/\s*\.\.\.\s*$/, "").trim().slice(0, 30);
    check("oracleIntent does not leak source snippet", !sample.oracleIntent.includes(sourcePrefix),
      `source prefix "${sourcePrefix}" found in oracleIntent`);
  }

  // 10. Gold answer candidates reachable from oracle key snippet content
  if (oracleItem && Array.isArray(oracleItem.metadata.goldAnswerCandidates)) {
    const candidates = oracleItem.metadata.goldAnswerCandidates as string[];
    const hit = candidates.find((c) => c.length > 0 && oracleItem.content.includes(c));
    check("gold answer candidate in oracle snippet content", !!hit, `candidates=${JSON.stringify(candidates)}`);
  }

  // 11. Distractors are from OTHER scenarios
  const targetScenario = sample.metadata.scenario;
  for (const d of distractorItems) {
    check(`distractor ${d.id.slice(-30)} from different scenario`, d.metadata.scenario !== targetScenario,
      `got ${d.metadata.scenario}`);
  }

  // 12. Evaluator metadata has groundTruthCandidates (task-level, for all conditions)
  const evalMeta = sample.evaluator.metadata as Record<string, unknown>;
  check("evaluator.metadata.groundTruthCandidates exists", Array.isArray(evalMeta.groundTruthCandidates) && (evalMeta.groundTruthCandidates as string[]).length > 0);

  // 13. buildRq1Input passes evaluatorMetadata (so executor can read gold in all conditions)
  const baselineInput = buildRq1Input(sample, "baseline");
  check("baseline input has evaluatorMetadata", !!baselineInput.evaluatorMetadata,
    "evaluatorMetadata missing from baseline input");
  const oracleInput = buildRq1Input(sample, "oracle_memory");
  check("oracle_memory input has evaluatorMetadata", !!oracleInput.evaluatorMetadata);

  // 14. Baseline input.memory contains prereq_conversation (common) but NOT oracle_key_snippet
  const baselineMemoryIds = new Set(baselineInput.memory.map((m) => m.id));
  check("baseline has prereq_conversation", [...baselineMemoryIds].some((id) => id.includes("prereq_conversation")));
  check("baseline does NOT have oracle_key_snippet", ![...baselineMemoryIds].some((id) => id.includes("oracle_key_snippet")));

  // 15. oracle_memory input.memory contains BOTH prereq_conversation AND oracle_key_snippet
  const oracleMemoryIds = new Set(oracleInput.memory.map((m) => m.id));
  check("oracle_memory has prereq_conversation", [...oracleMemoryIds].some((id) => id.includes("prereq_conversation")));
  check("oracle_memory has oracle_key_snippet", [...oracleMemoryIds].some((id) => id.includes("oracle_key_snippet")));

  // 16. First task ground truth (customer scenario, "What is my first name?")
  const firstGold = (evalMeta.groundTruthCandidates as string[])[0];
  check("first task gold = Michael", firstGold === "Michael", `got ${firstGold}`);

  // 17. rec_sum backend has oracle tools (readiness + retrieve_all)
  const recSumTask = tasks.find((t) => t.metadata.backend === "rec_sum");
  if (recSumTask) {
    check("rec_sum task has oracleToolIds", recSumTask.oracleToolIds.length > 0, `${recSumTask.oracleToolIds.length} oracle tools`);
  }

  // 18. All 8 RQ1 conditions can be built without error
  let buildErrors = 0;
  for (const t of tasks.slice(0, 10)) {
    for (const cond of RQ1_CONDITIONS) {
      try {
        buildRq1Input(t, cond);
      } catch {
        buildErrors += 1;
      }
    }
  }
  check("buildRq1Input works for all 8 conditions (first 10 tasks)", buildErrors === 0, `${buildErrors} errors`);

  // === Report ===
  console.log("=".repeat(80));
  console.log(`BFCL V4 Memory Adapter Tests (v0.2.0 design) — ${results.length} checks`);
  console.log("=".repeat(80));
  let passed = 0;
  let failed = 0;
  for (const r of results) {
    if (r.passed) {
      passed += 1;
    } else {
      failed += 1;
      console.log(`[FAIL] ${r.name}${r.detail ? ` — ${r.detail}` : ""}`);
    }
  }
  console.log("-".repeat(80));
  console.log(`${passed}/${results.length} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
