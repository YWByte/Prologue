import { readCanonicalTasks } from "../packages/data/dist/index.js";
import { buildRq1Input, getRq1Conditions } from "../packages/experiments/dist/rq1.js";
import { BfclV4MemoryExecutor } from "../packages/experiments/dist/index.js";

const TASKS_PATH = "data/canonical/bfcl_v4_memory.jsonl";
const SAMPLE_SIZE = 15;

function pickSample(tasks: Awaited<ReturnType<typeof readCanonicalTasks>>): Awaited<ReturnType<typeof readCanonicalTasks>> {
  const seen = new Set<string>();
  const sample = [];
  for (const task of tasks) {
    const key = `${task.metadata.scenario}__${task.metadata.backend}`;
    if (seen.has(key)) continue;
    seen.add(key);
    sample.push(task);
    if (sample.length === SAMPLE_SIZE) break;
  }
  return sample;
}

async function main(): Promise<void> {
  const tasks = await readCanonicalTasks(TASKS_PATH);
  const sample = pickSample(tasks);
  const executor = new BfclV4MemoryExecutor();
  let checks = 0;
  let failures = 0;

  for (const task of sample) {
    const conditions = getRq1Conditions(task);
    if (JSON.stringify(conditions) !== JSON.stringify([
      "baseline", "oracle_memory", "oracle_tool", "oracle_memory_tool",
    ])) {
      failures += 1;
      console.log(`[FAIL] ${task.taskId}: unsupported BFCL condition matrix ${JSON.stringify(conditions)}`);
      continue;
    }

    const baseline = buildRq1Input(task, "baseline");
    const oracleMemory = buildRq1Input(task, "oracle_memory");
    const oracleTool = buildRq1Input(task, "oracle_tool");
    const oracleAll = buildRq1Input(task, "oracle_memory_tool");
    const relevantId = task.oracleMemoryIds[0];
    const baselineRelevant = baseline.memory.find((memory) => memory.id === relevantId);
    const oracleRelevant = oracleMemory.memory.find((memory) => memory.id === relevantId);
    const baselineResult = await executor.execute(baseline);
    const oracleResult = await executor.execute(oracleMemory);

    const assertions = [
      ["baseline retains relevant conversation in backend", Boolean(baselineRelevant)],
      ["baseline does not pre-stage relevant conversation", baselineRelevant?.metadata.promptInjected === false],
      ["oracle_memory pre-stages the same complete conversation", oracleRelevant?.metadata.promptInjected === true && oracleRelevant.content === baselineRelevant?.content],
      ["tool oracle only filters baseline tools", oracleTool.tools.every((tool) => baseline.tools.some((candidate) => candidate.id === tool.id))],
      ["joint condition combines the two interventions", oracleAll.tools.length === oracleTool.tools.length && oracleAll.memory.length === oracleMemory.memory.length],
      ["stub never derives a gold answer", baselineResult.metadata?.derivedAnswer === "" && oracleResult.metadata?.derivedAnswer === ""],
      ["stub is not an attribution oracle", baselineResult.success === false && oracleResult.success === false],
    ] as const;
    for (const [label, passed] of assertions) {
      checks += 1;
      if (!passed) {
        failures += 1;
        console.log(`[FAIL] ${task.taskId}: ${label}`);
      }
    }
  }

  console.log(`BFCL harness checks: ${checks - failures}/${checks} passed`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
