import { readCanonicalTasks } from "../packages/data/dist/index.js";
import { buildRq1Input, getRq1Conditions } from "../packages/experiments/dist/rq1.js";

const TASKS_PATH = "data/canonical/bfcl_v4_memory.jsonl";
type TestResult = { name: string; passed: boolean; detail?: string };
const results: TestResult[] = [];

function check(name: string, passed: boolean, detail?: string): void {
  results.push({ name, passed, detail });
}

async function main(): Promise<void> {
  const tasks = await readCanonicalTasks(TASKS_PATH);
  check("eligible task count = 390", tasks.length === 390, `got ${tasks.length}`);
  check("all tasks use adapter v0.3.0", tasks.every((task) => task.metadata.adapterVersion === "0.3.0"));

  for (const task of tasks) {
    const history = task.memoryPool.filter((memory) => memory.type === "history" && memory.metadata.memoryRole === "common");
    const distractors = task.memoryPool.filter((memory) => memory.metadata.memoryRole === "distractor");
    const goldIds = task.evaluator.metadata?.rq1GoldMemoryIds as string[];
    const conditions = getRq1Conditions(task);

    check(`${task.taskId}: conversation units match prereq count`, history.length === task.metadata.prereqConversationCount,
      `history=${history.length}, prereq=${task.metadata.prereqConversationCount}`);
    check(`${task.taskId}: exactly one complete relevant conversation`, task.oracleMemoryIds.length === 1 && goldIds?.[0] === task.oracleMemoryIds[0]);
    check(`${task.taskId}: same-scenario hard negatives exist`, history.length > 1);
    check(`${task.taskId}: four cross-scenario distractors exist`, distractors.length === 4, `got ${distractors.length}`);
    check(`${task.taskId}: no agent-visible gold metadata`, task.memoryPool.every((memory) => (
      memory.metadata.goldAnswerCandidates === undefined
      && memory.metadata.sourceSnippet === undefined
      && memory.metadata.oracle === undefined
      && memory.metadata.keySnippetMatchedBy === undefined
    )));
    check(`${task.taskId}: only M×T conditions`, JSON.stringify(conditions) === JSON.stringify([
      "baseline", "oracle_memory", "oracle_tool", "oracle_memory_tool",
    ]), JSON.stringify(conditions));

    const baseline = buildRq1Input(task, "baseline");
    const oracleMemory = buildRq1Input(task, "oracle_memory");
    check(`${task.taskId}: baseline includes all candidate conversations`, baseline.memory.length === task.memoryPool.length);
    check(`${task.taskId}: baseline does not pre-stage histories`, baseline.memory.filter((memory) => memory.type === "history")
      .every((memory) => memory.metadata.promptInjected === false));
    check(`${task.taskId}: memory oracle pre-stages only M*`, oracleMemory.memory.filter((memory) => memory.type === "history" && memory.metadata.promptInjected === true)
      .map((memory) => memory.id).join(",") === task.oracleMemoryIds.join(","));
    check(`${task.taskId}: tool oracle is a subset, not extra capability`, task.oracleToolIds.every((id) => task.toolPool.some((tool) => tool.id === id)));
  }

  const failed = results.filter((result) => !result.passed);
  console.log("=".repeat(80));
  console.log(`BFCL V4 Memory Adapter Tests (v0.3.0) — ${results.length - failed.length}/${results.length} passed`);
  console.log("=".repeat(80));
  for (const result of failed) {
    console.log(`[FAIL] ${result.name}${result.detail ? ` — ${result.detail}` : ""}`);
  }
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
