import { loadEnvIntoProcess, createClientFromEnv, LlmCallError } from "../packages/common/dist/index.js";
import { readCanonicalTasks } from "../packages/data/dist/index.js";
import {
  buildRq1Input,
  RQ1_CONDITIONS,
  type Rq1Condition,
} from "../packages/experiments/dist/rq1.js";
import {
  BfclV4MemoryExecutor,
  makeBfclExecutorConfig,
} from "../packages/experiments/dist/index.js";
import { Session } from "../packages/session/dist/index.js";
import type { CanonicalTask } from "../packages/schemas/dist/index.js";
import { join, dirname } from "node:path";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const WORKSPACE_ROOT = join(__dirname, "..");

/**
 * RQ1 BFCL V4 Memory experiment with REAL LLM agent.
 *
 * Sample modes:
 *   - "sample5": 5 tasks (first kv-backend task of each scenario) × 8 = 40 runs (smoke test)
 *   - "full":     all 465 tasks × 8 conditions = 3720 runs (full RQ1 experiment)
 *
 * Model: qwen3.5-27b via dashscope. Memory tools are simulated in-process
 * (no REST backend). Eval = exact_match against goldAnswerCandidates from
 * task-level evaluator metadata (available in all conditions).
 *
 * Dual-indicator attribution:
 *   1. Success rate — oracle_memory group vs baseline
 *   2. Efficiency (avg steps) — oracle_memory group vs baseline
 */

const CONFIG = {
  tasksPath: join(WORKSPACE_ROOT, "data/canonical/bfcl_v4_memory.jsonl"),
  sampleMode: "full" as "sample5" | "full",
  llmProvider: "siliconflow" as const,
  llmModel: "Qwen/Qwen3.5-27B",
  // SiliconFlow Qwen3.5 defaults to thinking mode, which consumes tokens
  // without emitting visible content. MUST disable to get non-empty responses.
  enableThinking: false,
  maxSteps: 60,
  maxTokens: 4096,
  // L0 tier: RPM=1000, TPM=40000. With ~3k tokens/call and 20 concurrent,
  // peak TPM ≈ 60k which may trip transient 429s. Keep concurrency at 20
  // to stay safe; the rate limiter will handle RPM.
  rpm: 1000,
  apiMaxConcurrency: 20,
  runConcurrency: 20,
  checkpointEvery: 100,
  /**
   * Circuit breaker: abort the batch when this many CONSECUTIVE permanent
   * LLM errors (insufficient_quota / invalid_api_key / model_not_found / etc.)
   * occur. Prevents wasting time / money when the API is misconfigured or
   * quota is exhausted.
   */
  circuitBreakerThreshold: 5,
};

const METHOD = "oracle_attribution_llm_bfcl_v4";

type RunResult = {
  taskId: string;
  condition: Rq1Condition;
  success: boolean;
  score: number;
  steps: number;
  durationMs: number;
  executorError: boolean;
  derivedAnswer: string;
  goldCandidates: string[];
  reason: string;
};

type Checkpoint = {
  runDir: string;
  tasksPath: string;
  configHash: string;
  completed: RunResult[];
};

function configHash(): string {
  return [CONFIG.llmModel, CONFIG.maxSteps, CONFIG.maxTokens, CONFIG.rpm, CONFIG.runConcurrency].join("|");
}

function checkpointPath(runDir: string): string {
  return join(runDir, "checkpoint.json");
}

async function saveCheckpoint(runDir: string, cp: Checkpoint): Promise<void> {
  await mkdir(runDir, { recursive: true });
  await writeFile(checkpointPath(runDir), JSON.stringify(cp), "utf8");
}

async function loadCheckpoint(runDir: string): Promise<Checkpoint | null> {
  const p = checkpointPath(runDir);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(await readFile(p, "utf8")) as Checkpoint;
  } catch {
    return null;
  }
}

/**
 * Pick tasks based on sampleMode:
 *   - "sample5": first kv-backend task of each scenario → 5 tasks (smoke test)
 *   - "full": all tasks (all scenarios × all backends)
 */
function pickSample(tasks: CanonicalTask[], mode: "sample5" | "full"): CanonicalTask[] {
  if (mode === "full") return tasks;
  const seen = new Set<string>();
  const sample: CanonicalTask[] = [];
  for (const t of tasks) {
    if (t.metadata.backend !== "kv") continue;
    const sc = t.metadata.scenario as string;
    if (seen.has(sc)) continue;
    seen.add(sc);
    sample.push(t);
  }
  return sample;
}

async function main(): Promise<void> {
  loadEnvIntoProcess();

  const tasks = await readCanonicalTasks(CONFIG.tasksPath);
  console.log(`loaded ${tasks.length} canonical tasks`);

  const sample = pickSample(tasks, CONFIG.sampleMode);
  console.log(`sampleMode=${CONFIG.sampleMode}, sampled ${sample.length} tasks`);

  if (CONFIG.sampleMode === "sample5") {
    console.log("\nsampled tasks (first kv task per scenario):");
    for (const t of sample) {
      const gold = (t.evaluator.metadata as { groundTruthCandidates?: string[] }).groundTruthCandidates ?? [];
      console.log(
        `  ${t.taskId.padEnd(40)} scenario=${(t.metadata.scenario as string).padEnd(12)} ` +
          `q=${JSON.stringify(t.query.slice(0, 60))} gold=${JSON.stringify(gold.slice(0, 3))}`,
      );
    }
  } else {
    // Full mode: print distribution instead of full task list
    const byScenario: Record<string, number> = {};
    const byBackend: Record<string, number> = {};
    for (const t of sample) {
      const sc = t.metadata.scenario as string;
      const be = t.metadata.backend as string;
      byScenario[sc] = (byScenario[sc] ?? 0) + 1;
      byBackend[be] = (byBackend[be] ?? 0) + 1;
    }
    console.log("\ndistribution by scenario:", byScenario);
    console.log("distribution by backend:", byBackend);
  }
  console.log("");

  const workspaceRoot = WORKSPACE_ROOT;
  const runsRoot = join(workspaceRoot, "runs");

  const session = await Session.start({
    rq: "rq1",
    method: METHOD,
    config: { ...CONFIG, sampleSize: sample.length, totalRuns: sample.length * RQ1_CONDITIONS.length },
    dataset: {
      taskCount: tasks.length,
      sampledTaskIds: sample.map((t) => t.taskId),
      sources: ["bfcl_v4_memory"],
    },
    models: {
      executor: "bfcl_v4_memory_llm",
      agent: "llm_react_simulated_memory",
      llmProvider: CONFIG.llmProvider,
      llmModel: CONFIG.llmModel,
    },
    runsRoot,
  });
  const runDir = session.runDir;
  console.log(`session: ${runDir}\n`);

  const llm = createClientFromEnv(CONFIG.llmProvider, {
    rpm: CONFIG.rpm,
    maxConcurrency: CONFIG.apiMaxConcurrency,
  });

  const executor = new BfclV4MemoryExecutor(
    makeBfclExecutorConfig({
      llm,
      llmModel: CONFIG.llmModel,
      enableThinking: CONFIG.enableThinking,
      maxSteps: CONFIG.maxSteps,
      maxTokens: CONFIG.maxTokens,
    }),
  );

  // Build work items: tasks × 8 conditions.
  const workItems: Array<{ task: CanonicalTask; condition: Rq1Condition; runIndex: number }> = [];
  let runIndex = 0;
  for (const task of sample) {
    for (const condition of RQ1_CONDITIONS) {
      runIndex += 1;
      workItems.push({ task, condition, runIndex });
    }
  }
  const totalRuns = workItems.length;

  const results: RunResult[] = [];
  const completedKeys = new Set<string>();
  let queueCursor = 0;
  let sinceLastCheckpoint = 0;

  // Attempt to resume from a previous checkpoint with matching configHash.
  // This is critical for the full 3720-run experiment — if it crashes at run
  // 2000, we want to resume rather than restart from 0.
  const previousCheckpoint = await loadCheckpoint(runDir);
  if (previousCheckpoint && previousCheckpoint.configHash === configHash()) {
    console.log(`resuming from checkpoint: ${previousCheckpoint.completed.length}/${totalRuns} runs already completed`);
    for (const r of previousCheckpoint.completed) {
      results.push(r);
      completedKeys.add(`${r.taskId}::${r.condition}`);
    }
  }

  console.log(`running ${totalRuns} runs with concurrency=${CONFIG.runConcurrency}`);
  console.log(`already completed: ${completedKeys.size}, remaining: ${totalRuns - completedKeys.size}\n`);

  // Circuit breaker state: track consecutive permanent LLM errors.
  // When the API is misconfigured or quota is exhausted, every run will fail
  // with a permanent error (insufficient_quota, invalid_api_key, etc.).
  // Without a breaker, the worker pool would grind through all 3720 runs
  // wasting time. With the breaker, we stop after N consecutive permanent
  // errors and save a checkpoint so the user can fix the API and resume.
  let consecutivePermanentErrors = 0;
  let circuitTripped: { reason: string; atRun: number } | null = null;

  async function runOne(item: {
    task: CanonicalTask;
    condition: Rq1Condition;
    runIndex: number;
  }): Promise<void> {
    const { task, condition, runIndex } = item;
    const key = `${task.taskId}::${condition}`;
    if (completedKeys.has(key)) return;

    const input = buildRq1Input(task, condition);
    const startedAt = Date.now();

    let executorError = false;
    try {
      const result = await executor.execute(input);
      const durationMs = Date.now() - startedAt;
      const stepCount = result.steps.length;
      executorError = typeof result.reason === "string" && result.reason.startsWith("executor_error");

      const runResult: RunResult = {
        taskId: task.taskId,
        condition,
        success: result.success,
        score: result.score ?? 0,
        steps: stepCount,
        durationMs,
        executorError,
        derivedAnswer: (result.metadata?.derivedAnswer as string) ?? "",
        goldCandidates: (result.metadata?.goldCandidates as string[]) ?? [],
        reason: result.reason ?? "",
      };
      results.push(runResult);
      completedKeys.add(key);

      // Successful run (even if eval FAILed, the LLM call itself succeeded) —
      // reset the circuit breaker counter.
      consecutivePermanentErrors = 0;
      const completedSoFar = results.length;
      if (totalRuns <= 40 || completedSoFar % 100 === 0 || completedSoFar === totalRuns || executorError) {
        console.log(
          `[${completedSoFar}/${totalRuns}] cond=${condition.padEnd(20)} ` +
            `success=${result.success} steps=${stepCount} dur=${(durationMs / 1000).toFixed(1)}s ` +
            `answer=${JSON.stringify(runResult.derivedAnswer.slice(0, 40))}` +
            (executorError ? " [EXECUTOR_ERROR]" : ""),
        );
      }

      await session.logger.write({
        level: executorError ? "error" : result.success ? "info" : "warn",
        type: executorError ? "executor_error" : "eval_result",
        rq: "rq1",
        taskId: task.taskId,
        source: task.source,
        method: METHOD,
        payload: {
          condition,
          success: result.success,
          score: result.score,
          steps: stepCount,
          durationMs,
          executorError,
          derivedAnswer: runResult.derivedAnswer,
          goldCandidates: runResult.goldCandidates,
          reason: result.reason,
        },
      });

      session.addTrajectory({
        taskId: task.taskId,
        source: task.source,
        method: METHOD,
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
      executorError = true;
      console.error(`[${runIndex}/${totalRuns}] EXECUTOR_ERROR task=${task.taskId} cond=${condition}: ${message}`);

      // Circuit breaker: detect permanent LLM errors (insufficient_quota,
      // invalid_api_key, model_not_found, etc.). These will NEVER succeed
      // no matter how many times we retry, so we count consecutive occurrences
      // and trip the breaker when the threshold is reached.
      if (error instanceof LlmCallError && error.permanent) {
        consecutivePermanentErrors += 1;
        console.error(
          `[circuit-breaker] permanent LLM error #${consecutivePermanentErrors}/${CONFIG.circuitBreakerThreshold} ` +
            `code=${error.errorCode ?? "?"} httpStatus=${error.httpStatus ?? "?"}`,
        );
        if (consecutivePermanentErrors >= CONFIG.circuitBreakerThreshold && !circuitTripped) {
          circuitTripped = {
            reason: `circuit breaker tripped: ${consecutivePermanentErrors} consecutive permanent LLM errors (last: ${error.errorCode ?? "unknown"})`,
            atRun: results.length,
          };
          console.error(`\n[CIRCUIT BREAKER TRIPPED] ${circuitTripped.reason}`);
          console.error(`Stopping worker pool. Fix the API and re-run to resume from checkpoint.`);
          console.error(`Completed runs saved: ${results.length}/${totalRuns}\n`);
        }
      } else {
        // Non-permanent error (transient 429, 5xx, network) — reset counter
        // since the next call might succeed.
        consecutivePermanentErrors = 0;
      }

      const runResult: RunResult = {
        taskId: task.taskId,
        condition,
        success: false,
        score: 0,
        steps: 0,
        durationMs,
        executorError,
        derivedAnswer: "",
        goldCandidates: [],
        reason: `executor_error: ${message}`,
      };
      results.push(runResult);
      completedKeys.add(key);

      await session.logger.write({
        level: "error",
        type: "executor_error",
        rq: "rq1",
        taskId: task.taskId,
        source: task.source,
        method: METHOD,
        payload: { condition, message, durationMs },
      });
    } finally {
      sinceLastCheckpoint += 1;
    }
  }

  async function worker(_workerId: number): Promise<void> {
    while (true) {
      // Circuit breaker: if tripped, stop taking new work.
      if (circuitTripped) return;
      const idx = queueCursor++;
      if (idx >= workItems.length) return;
      await runOne(workItems[idx]);
      if (circuitTripped) return;
      if (sinceLastCheckpoint >= CONFIG.checkpointEvery) {
        sinceLastCheckpoint = 0;
        await saveCheckpoint(runDir, {
          runDir,
          tasksPath: CONFIG.tasksPath,
          configHash: configHash(),
          completed: results,
        });
        console.log(`[checkpoint] saved ${results.length}/${totalRuns} completed runs`);
      }
    }
  }

  const workers = Array.from(
    { length: Math.min(CONFIG.runConcurrency, totalRuns) },
    (_, i) => worker(i),
  );
  await Promise.all(workers);

  await saveCheckpoint(runDir, {
    runDir,
    tasksPath: CONFIG.tasksPath,
    configHash: configHash(),
    completed: results,
  });

  // If circuit breaker tripped, print a clear diagnostic and exit non-zero.
  // The checkpoint is saved, so the user can fix the API and re-run to resume.
  if (circuitTripped) {
    console.log("\n" + "=".repeat(80));
    console.log("=== CIRCUIT BREAKER TRIPPED — batch aborted ===");
    console.log("=".repeat(80));
    console.log(`reason: ${circuitTripped.reason}`);
    console.log(`completed runs: ${results.length}/${totalRuns}`);
    console.log(`\nThe checkpoint has been saved. To resume after fixing the API issue:`);
    console.log(`  1. Check your dashscope account quota / billing at https://dashscope.console.aliyun.com/`);
    console.log(`  2. Re-run this script — it will resume from ${results.length} completed runs.`);
    console.log(`\nsession: ${session.runDir}`);
    console.log(`checkpoint: ${checkpointPath(runDir)}`);

    await session.logger.write({
      level: "error",
      type: "circuit_breaker_tripped",
      rq: "rq1",
      method: METHOD,
      payload: {
        reason: circuitTripped.reason,
        completedRuns: results.length,
        totalRuns,
      },
    });
    await session.finish("failed");
    process.exit(1);
  }

  // === Summary ===
  console.log("\n" + "=".repeat(80));
  console.log(`=== SUMMARY: BFCL V4 Memory RQ1 (LLM, ${CONFIG.llmModel}, ${sample.length} tasks × ${RQ1_CONDITIONS.length} conditions) ===`);
  console.log("=".repeat(80));

  const byCondition: Record<string, { total: number; success: number; executorError: number; totalSteps: number; totalMs: number }> = {};
  for (const r of results) {
    if (!byCondition[r.condition]) {
      byCondition[r.condition] = { total: 0, success: 0, executorError: 0, totalSteps: 0, totalMs: 0 };
    }
    byCondition[r.condition].total += 1;
    if (r.success) byCondition[r.condition].success += 1;
    if (r.executorError) byCondition[r.condition].executorError += 1;
    byCondition[r.condition].totalSteps += r.steps;
    byCondition[r.condition].totalMs += r.durationMs;
  }

  console.log("\n=== by condition ===");
  console.log("condition                     success  total   rate   avg_steps  avg_dur");
  console.log("-".repeat(80));
  for (const cond of RQ1_CONDITIONS) {
    const s = byCondition[cond] ?? { total: 0, success: 0, executorError: 0, totalSteps: 0, totalMs: 0 };
    const rate = s.total > 0 ? ((s.success / s.total) * 100).toFixed(1) : "0.0";
    const avgSteps = s.total > 0 ? (s.totalSteps / s.total).toFixed(1) : "0.0";
    const avgDur = s.total > 0 ? (s.totalMs / s.total / 1000).toFixed(1) + "s" : "0.0s";
    const errStr = s.executorError > 0 ? ` [${s.executorError} err]` : "";
    console.log(
      `  ${cond.padEnd(28)} ${String(s.success).padStart(4)}/${String(s.total).padStart(2)}  ${rate.padStart(5)}%  ${avgSteps.padStart(8)}  ${avgDur.padStart(7)}${errStr}`,
    );
  }

  console.log("\n=== by task ===");
  const byTask: Record<string, { total: number; success: number; executorError: number }> = {};
  for (const r of results) {
    if (!byTask[r.taskId]) byTask[r.taskId] = { total: 0, success: 0, executorError: 0 };
    byTask[r.taskId].total += 1;
    if (r.success) byTask[r.taskId].success += 1;
    if (r.executorError) byTask[r.taskId].executorError += 1;
  }
  for (const [tid, s] of Object.entries(byTask).sort()) {
    const rate = ((s.success / s.total) * 100).toFixed(0);
    const errStr = s.executorError > 0 ? ` [${s.executorError} err]` : "";
    console.log(`  ${tid.padEnd(40)} ${s.success}/${s.total} (${rate}%)${errStr}`);
  }

  console.log("\n=== per-task detail (first task) ===");
  const firstTaskId = sample[0].taskId;
  for (const r of results) {
    if (r.taskId !== firstTaskId) continue;
    const marker = r.success ? "PASS" : "FAIL";
    console.log(
      `  [${marker}] ${r.condition.padEnd(28)} | answer=${JSON.stringify(r.derivedAnswer.slice(0, 80))} ` +
        `gold=${JSON.stringify(r.goldCandidates.slice(0, 3))}`,
    );
    console.log(`         reason: ${r.reason}`);
  }

  // === Dual-indicator attribution verification ===
  // Under RQ1 direction A design, attribution has TWO dimensions:
  //   1. Success rate: oracle_memory conditions should have >= baseline success
  //      rate (pre-staging context in prompt makes answer reachable without
  //      tool retrieval). Baseline may also succeed if LLM diligently calls
  //      tools — that's fine, it's a real LLM capability signal.
  //   2. Efficiency: oracle_memory conditions should use FEWER steps than
  //      baseline (direct answer from pre-staged prompt vs tool retrieval
  //      loop). This is the cleaner attribution signal when success rates
  //      are close.
  console.log("\n" + "=".repeat(80));
  console.log("=== Dual-indicator attribution verification ===");
  console.log("=".repeat(80));

  // Indicator 1: success rate — oracle_memory group >= baseline group
  const baselineSuccessRate = byCondition["baseline"] && byCondition["baseline"].total > 0
    ? byCondition["baseline"].success / byCondition["baseline"].total
    : 0;
  const oracleMemoryConditions = ["oracle_memory", "oracle_intent_memory", "oracle_memory_tool", "oracle_all"] as const;
  const oracleMemorySuccessRates = oracleMemoryConditions.map((c) => {
    const s = byCondition[c];
    return s && s.total > 0 ? s.success / s.total : 0;
  });
  const oracleMemoryAvgSuccessRate = oracleMemorySuccessRates.reduce((a, b) => a + b, 0) / oracleMemorySuccessRates.length;

  console.log("\n--- Indicator 1: success rate ---");
  console.log(`  baseline success rate:        ${(baselineSuccessRate * 100).toFixed(0)}% (${byCondition["baseline"]?.success ?? 0}/${byCondition["baseline"]?.total ?? 0})`);
  console.log(`  oracle_memory group avg rate: ${(oracleMemoryAvgSuccessRate * 100).toFixed(0)}% (across ${oracleMemoryConditions.length} conditions)`);
  const successGap = oracleMemoryAvgSuccessRate - baselineSuccessRate;
  const successCheckOk = successGap >= 0;
  console.log(`  gap (oracle_memory - baseline): ${(successGap * 100).toFixed(0)}% — ${successCheckOk ? "OK (oracle_memory >= baseline)" : "DEVIATION (oracle_memory < baseline)"}`);

  // Indicator 2: efficiency — oracle_memory should use fewer steps than baseline
  const baselineAvgSteps = byCondition["baseline"] && byCondition["baseline"].total > 0
    ? byCondition["baseline"].totalSteps / byCondition["baseline"].total
    : 0;
  const oracleMemoryAvgSteps = oracleMemoryConditions.map((c) => {
    const s = byCondition[c];
    return s && s.total > 0 ? s.totalSteps / s.total : 0;
  });
  const oracleMemoryGroupAvgSteps = oracleMemoryAvgSteps.reduce((a, b) => a + b, 0) / oracleMemoryAvgSteps.length;

  console.log("\n--- Indicator 2: efficiency (avg steps per run) ---");
  console.log(`  baseline avg steps:           ${baselineAvgSteps.toFixed(1)}`);
  console.log(`  oracle_memory group avg:      ${oracleMemoryGroupAvgSteps.toFixed(1)}`);
  const stepGap = baselineAvgSteps - oracleMemoryGroupAvgSteps;
  const efficiencyCheckOk = stepGap > 0;
  console.log(`  gap (baseline - oracle_memory): ${stepGap.toFixed(1)} steps — ${efficiencyCheckOk ? "OK (oracle_memory more efficient)" : "DEVIATION (no efficiency gain)"}`);

  // Per-condition breakdown for the efficiency dimension
  console.log("\n--- Per-condition step counts (lower = more efficient) ---");
  for (const cond of RQ1_CONDITIONS) {
    const s = byCondition[cond] ?? { total: 0, success: 0, executorError: 0, totalSteps: 0, totalMs: 0 };
    const avgSteps = s.total > 0 ? (s.totalSteps / s.total).toFixed(1) : "n/a";
    const hasOracleMem = cond === "oracle_memory" || cond === "oracle_intent_memory" || cond === "oracle_memory_tool" || cond === "oracle_all";
    const tag = hasOracleMem ? "[M]" : "   ";
    console.log(`  ${tag} ${cond.padEnd(28)} avg_steps=${avgSteps}`);
  }

  const allPassed = successCheckOk && efficiencyCheckOk;

  const totalSuccess = results.filter((r) => r.success).length;
  const totalExecutorErrors = results.filter((r) => r.executorError).length;
  const totalDurationMin = results.reduce((s, r) => s + r.durationMs, 0) / 1000 / 60;
  console.log(`\ntotal: ${totalSuccess}/${results.length} (${((totalSuccess / results.length) * 100).toFixed(0)}%)`);
  console.log(`executor errors: ${totalExecutorErrors}/${results.length}`);
  console.log(`total wall-time-equivalent: ${totalDurationMin.toFixed(1)} min (sum of run durations)`);

  await session.logger.write({
    level: "info",
    type: "rq1_llm_bfcl_summary",
    rq: "rq1",
    method: METHOD,
    payload: {
      taskCount: sample.length,
      runCount: results.length,
      successCount: totalSuccess,
      executorErrorCount: totalExecutorErrors,
      byCondition,
      byTask,
      attributionChecksPassed: allPassed,
      indicators: {
        successGap,
        stepGap,
        baselineSuccessRate,
        oracleMemoryAvgSuccessRate,
        baselineAvgSteps,
        oracleMemoryGroupAvgSteps,
      },
    },
  });

  await session.finish("completed");
  console.log(`\nsession: ${session.runDir}`);
  console.log(`checkpoint: ${checkpointPath(runDir)}`);
  console.log(allPassed ? "\nALL DUAL-INDICATOR CHECKS PASSED" : "\nSOME CHECKS DEVIATED (see indicators above)");
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
