import { loadEnvIntoProcess, createClientFromEnv } from "../packages/common/dist/index.js";
import { readCanonicalTasks } from "../packages/data/dist/index.js";
import { buildRq1Input, RQ1_CONDITIONS, type Rq1Condition } from "../packages/experiments/dist/rq1.js";
import { AppWorldExecutor, makeAppWorldExecutorConfig } from "../packages/experiments/dist/index.js";
import { Session } from "../packages/session/dist/index.js";
import { join } from "node:path";

async function main(): Promise<void> {
  loadEnvIntoProcess();

  const tasksPath = "data/canonical/appworld-sample_5.jsonl";
  const tasks = await readCanonicalTasks(tasksPath);
  console.log(`loaded ${tasks.length} tasks`);

  const workspaceRoot = process.cwd();
  const session = await Session.start({
    rq: "rq1",
    method: "oracle_attribution_llm",
    config: {
      tasksPath,
      appworldRoot: "data/raw/appworld",
      pythonPath: ".venv-appworld/bin/python",
      basePort: 9100,
      experimentNamePrefix: "prologue_rq1_llm",
      llmProvider: "dashscope",
      llmModel: "qwen3.5-35b-a3b",
      enableThinking: false,
      maxSteps: 60,
    },
    dataset: {
      taskCount: tasks.length,
      sources: Array.from(new Set(tasks.map((t) => t.source))),
    },
    models: {
      executor: "appworld_llm",
      agent: "llm_react",
      llmProvider: "dashscope",
      llmModel: "qwen3.5-35b-a3b",
    },
    runsRoot: join(workspaceRoot, "runs"),
  });

  const llm = createClientFromEnv("dashscope", { rpm: 500, maxConcurrency: 20 });

  const executor = new AppWorldExecutor(
    makeAppWorldExecutorConfig({
      appworldRoot: "data/raw/appworld",
      pythonPath: ".venv-appworld/bin/python",
      pythonScriptsDir: join(workspaceRoot, "python", "appworld"),
      basePort: 9100,
      experimentNamePrefix: "prologue_rq1_llm",
      llm,
      llmModel: "qwen3.5-35b-a3b",
      enableThinking: false,
      maxSteps: 60,
    }),
  );

  const results: Array<{
    taskId: string;
    condition: Rq1Condition;
    success: boolean;
    score: number;
    steps: number;
    durationMs: number;
  }> = [];

  // Build all (task, condition) work items
  const workItems: Array<{ task: typeof tasks[number]; condition: Rq1Condition; runIndex: number }> = [];
  let runIndex = 0;
  for (const task of tasks) {
    for (const condition of RQ1_CONDITIONS) {
      workItems.push({ task, condition, runIndex: ++runIndex });
    }
  }
  const totalRuns = workItems.length;
  const RUN_CONCURRENCY = 20;

  console.log(`\nrunning ${totalRuns} runs with concurrency=${RUN_CONCURRENCY}\n`);

  let completedCount = 0;
  let queueCursor = 0;

  async function runOne(item: { task: typeof tasks[number]; condition: Rq1Condition; runIndex: number }): Promise<void> {
    const { task, condition, runIndex } = item;
    const input = buildRq1Input(task, condition);
    const startedAt = Date.now();

    console.log(
      `[${runIndex}/${totalRuns}] START task=${task.taskId} condition=${condition} ` +
        `memory=${input.memory.length} tools=${input.tools.length}`,
    );

    try {
      const result = await executor.execute(input);
      const durationMs = Date.now() - startedAt;
      const stepCount = result.steps.length;

      results.push({
        taskId: task.taskId,
        condition,
        success: result.success,
        score: result.score ?? 0,
        steps: stepCount,
        durationMs,
      });

      console.log(
        `[${runIndex}/${totalRuns}] DONE  task=${task.taskId} cond=${condition} ` +
          `success=${result.success} score=${result.score?.toFixed(2) ?? 0} ` +
          `steps=${stepCount} dur=${(durationMs / 1000).toFixed(1)}s`,
      );

      await session.logger.write({
        level: result.success ? "info" : "warn",
        type: "eval_result",
        rq: "rq1",
        taskId: task.taskId,
        source: task.source,
        method: "oracle_attribution_llm",
        payload: {
          condition,
          success: result.success,
          score: result.score,
          steps: stepCount,
          durationMs,
          experimentName: result.metadata?.experimentName,
        },
      });

      session.addTrajectory({
        taskId: task.taskId,
        source: task.source,
        method: "oracle_attribution_llm",
        input: {
          query: input.query,
          memoryIds: input.memory.map((m) => m.id),
          toolIds: input.tools.map((t) => t.id),
          oracleCondition: condition,
        },
        prologue: {
          usesOracleIntent: input.usesOracleIntent,
          usesOracleMemory: input.usesOracleMemory,
          usesOracleTool: input.usesOracleTool,
        },
        steps: result.steps,
        result: {
          success: result.success,
          score: result.score,
          error: result.reason,
        },
      });
      await session.flush();
    } catch (error) {
      const durationMs = Date.now() - startedAt;
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[${runIndex}/${totalRuns}] ERROR task=${task.taskId} cond=${condition}: ${message}`);
      results.push({
        taskId: task.taskId,
        condition,
        success: false,
        score: 0,
        steps: 0,
        durationMs,
      });
    } finally {
      completedCount += 1;
    }
  }

  // Worker pool: each worker pulls next item from the queue
  async function worker(workerId: number): Promise<void> {
    while (true) {
      const idx = queueCursor++;
      if (idx >= workItems.length) return;
      await runOne(workItems[idx]);
    }
  }

  const workers = Array.from({ length: Math.min(RUN_CONCURRENCY, totalRuns) }, (_, i) => worker(i));
  await Promise.all(workers);

  // Summary
  console.log("\n" + "=".repeat(80));
  console.log("=== SUMMARY ===");
  console.log("=".repeat(80));

  const byCondition: Record<string, { total: number; success: number }> = {};
  for (const r of results) {
    if (!byCondition[r.condition]) byCondition[r.condition] = { total: 0, success: 0 };
    byCondition[r.condition].total += 1;
    if (r.success) byCondition[r.condition].success += 1;
  }

  console.log("\n=== by condition ===");
  for (const cond of RQ1_CONDITIONS) {
    const s = byCondition[cond] ?? { total: 0, success: 0 };
    const rate = s.total > 0 ? ((s.success / s.total) * 100).toFixed(0) : "0";
    console.log(`  ${cond.padEnd(25)} ${s.success}/${s.total} (${rate}%)`);
  }

  console.log("\n=== by task ===");
  const byTask: Record<string, { total: number; success: number }> = {};
  for (const r of results) {
    if (!byTask[r.taskId]) byTask[r.taskId] = { total: 0, success: 0 };
    byTask[r.taskId].total += 1;
    if (r.success) byTask[r.taskId].success += 1;
  }
  for (const [tid, s] of Object.entries(byTask)) {
    const rate = ((s.success / s.total) * 100).toFixed(0);
    console.log(`  ${tid}  ${s.success}/${s.total} (${rate}%)`);
  }

  const totalSuccess = results.filter((r) => r.success).length;
  console.log(`\ntotal: ${totalSuccess}/${results.length} (${((totalSuccess / results.length) * 100).toFixed(0)}%)`);
  console.log(`total duration: ${(results.reduce((s, r) => s + r.durationMs, 0) / 1000 / 60).toFixed(1)} min`);

  await session.logger.write({
    level: "info",
    type: "rq1_llm_summary",
    rq: "rq1",
    method: "oracle_attribution_llm",
    payload: {
      taskCount: tasks.length,
      runCount: results.length,
      successCount: totalSuccess,
      byCondition,
      byTask,
    },
  });

  await session.finish("completed");
  console.log(`\nsession: ${session.runDir}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

