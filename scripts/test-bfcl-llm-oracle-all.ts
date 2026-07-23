import { loadEnvIntoProcess, createClientFromEnv, LlmCallError } from "../packages/common/dist/index.js";
import { readCanonicalTasks } from "../packages/data/dist/index.js";
import {
  buildRq1Input,
  getRq1Conditions,
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
 *   - "sample5": 5 tasks (first kv-backend task of each scenario) × 4 = 20 runs (smoke test)
 *   - "full":     all eligible tasks × 4 conditions = full BFCL RQ1 experiment
 *
 * Model: qwen3.5-27b via dashscope. Memory tools are simulated in-process
 * (no REST backend). Eval = exact_match against goldAnswerCandidates from
 * task-level evaluator metadata (available in all conditions).
 *
 * Dual-indicator attribution:
 *   1. Success rate — oracle_memory group vs baseline
 *   2. Efficiency (avg steps) — oracle_memory group vs baseline
 */

// Load .env early so API keys are visible to CONFIG below.
loadEnvIntoProcess();

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
  // If set, load valid (non-error) results from this session dir as "already completed",
  // and rerun all executor_error/provider_error runs in a NEW session.
  resumeValidFrom: "" as string,
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
  providerError: boolean;
  derivedAnswer: string;
  goldCandidates: string[];
  failureMode: string;
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

  // Resume from a previous session's checkpoint if configured.
  let results: RunResult[] = [];
  const completedKeys = new Set<string>();
  let resumedRunDir: string | null = null;

  if (CONFIG.resumeValidFrom) {
    const cp = await loadCheckpoint(CONFIG.resumeValidFrom);
    if (cp) {
      const valid = cp.completed.filter((r) => !r.executorError && !r.providerError);
      const errors = cp.completed.filter((r) => r.executorError || r.providerError);
      results = valid.map((result) => ({ ...result, failureMode: result.failureMode ?? "unknown" }));
      for (const r of results) {
        completedKeys.add(`${r.taskId}::${r.condition}`);
      }
      console.log(`resumeValidFrom: ${CONFIG.resumeValidFrom}`);
      console.log(`  valid (skip): ${valid.length}, rerun: ${errors.length} (executor_error: ${errors.filter(r => r.executorError).length}, provider_error: ${errors.filter(r => r.providerError).length})`);
    }
  }

  const session = await Session.start({
    rq: "rq1",
    method: METHOD,
    config: {
      ...CONFIG,
      resumedFrom: CONFIG.resumeValidFrom || undefined,
      sampleSize: sample.length,
      conditions: getRq1Conditions(sample[0] ?? tasks[0]),
      totalRuns: sample.reduce((total, task) => total + getRq1Conditions(task).length, 0),
    },
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

  // Build work items from the RQ1 components each task can identify.
  const workItems: Array<{ task: CanonicalTask; condition: Rq1Condition; runIndex: number }> = [];
  let runIndex = 0;
  for (const task of sample) {
    for (const condition of getRq1Conditions(task)) {
      runIndex += 1;
      workItems.push({ task, condition, runIndex });
    }
  }
  const totalRuns = workItems.length;

  let queueCursor = 0;
  let sinceLastCheckpoint = 0;

  // Note: resumeValidFrom already populated `results` and `completedKeys` above.
  // The old in-place checkpoint resume logic is removed in favor of resumeValidFrom.

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
    let providerError = false;
    try {
      const result = await executor.execute(input);
      const durationMs = Date.now() - startedAt;
      const stepCount = result.steps.length;
      const reason = typeof result.reason === "string" ? result.reason : "";
      executorError = reason.startsWith("executor_error");
      providerError = reason.startsWith("provider_error");

      const runResult: RunResult = {
        taskId: task.taskId,
        condition,
        success: result.success,
        score: result.score ?? 0,
        steps: stepCount,
        durationMs,
        executorError,
        providerError,
        derivedAnswer: (result.metadata?.derivedAnswer as string) ?? "",
        goldCandidates: (result.metadata?.goldCandidates as string[]) ?? [],
        failureMode: (result.metadata?.failureMode as string) ?? "unknown",
        reason: result.reason ?? "",
      };
      results.push(runResult);
      completedKeys.add(key);

      // Successful run (even if eval FAILed, the LLM call itself succeeded) —
      // reset the circuit breaker counter.
      consecutivePermanentErrors = 0;
      const completedSoFar = results.length;
      if (totalRuns <= 40 || completedSoFar % 100 === 0 || completedSoFar === totalRuns || executorError || providerError) {
        console.log(
          `[${completedSoFar}/${totalRuns}] cond=${condition.padEnd(20)} ` +
            `success=${result.success} steps=${stepCount} dur=${(durationMs / 1000).toFixed(1)}s ` +
            `answer=${JSON.stringify(runResult.derivedAnswer.slice(0, 40))}` +
            (executorError ? " [EXECUTOR_ERROR]" : "") +
            (providerError ? " [PROVIDER_ERROR]" : ""),
        );
      }

      await session.logger.write({
        level: executorError || providerError ? "error" : result.success ? "info" : "warn",
        type: executorError ? "executor_error" : providerError ? "provider_error" : "eval_result",
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
          failureMode: runResult.failureMode,
          executorError,
          providerError,
          derivedAnswer: runResult.derivedAnswer,
          goldCandidates: runResult.goldCandidates,
          failureMode: runResult.failureMode,
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
          rq1GoldMemoryIds: (input.evaluatorMetadata?.rq1GoldMemoryIds as string[]) ?? [],
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
      const isProviderError = error instanceof LlmCallError;
      const prefix = isProviderError ? "provider_error" : "executor_error";
      if (isProviderError) {
        providerError = true;
      } else {
        executorError = true;
      }
      console.error(`[${runIndex}/${totalRuns}] ${prefix.toUpperCase()} task=${task.taskId} cond=${condition}: ${message}`);

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
        providerError,
        derivedAnswer: "",
        goldCandidates: [],
        failureMode: prefix,
        reason: `${prefix}: ${message}`,
      };
      results.push(runResult);
      completedKeys.add(key);

      await session.logger.write({
        level: "error",
        type: prefix,
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
    console.log(`  1. Check the configured provider account quota / billing.`);
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
  const conditions = getRq1Conditions(sample[0] ?? tasks[0]);
  console.log("\n" + "=".repeat(80));
  console.log(`=== SUMMARY: BFCL V4 Memory RQ1 (LLM, ${CONFIG.llmModel}, ${sample.length} tasks × ${conditions.length} conditions) ===`);
  console.log("=".repeat(80));

  const byCondition: Record<string, { total: number; success: number; executorError: number; providerError: number; totalSteps: number; totalMs: number }> = {};
  for (const r of results) {
    if (!byCondition[r.condition]) {
      byCondition[r.condition] = { total: 0, success: 0, executorError: 0, providerError: 0, totalSteps: 0, totalMs: 0 };
    }
    byCondition[r.condition].total += 1;
    if (r.success) byCondition[r.condition].success += 1;
    if (r.executorError) byCondition[r.condition].executorError += 1;
    if (r.providerError) byCondition[r.condition].providerError += 1;
    byCondition[r.condition].totalSteps += r.steps;
    byCondition[r.condition].totalMs += r.durationMs;
  }

  console.log("\n=== by condition ===");
  console.log("condition                     success  total   rate   avg_steps  avg_dur");
  console.log("-".repeat(80));
  for (const cond of conditions) {
    const s = byCondition[cond] ?? { total: 0, success: 0, executorError: 0, providerError: 0, totalSteps: 0, totalMs: 0 };
    const rate = s.total > 0 ? ((s.success / s.total) * 100).toFixed(1) : "0.0";
    const avgSteps = s.total > 0 ? (s.totalSteps / s.total).toFixed(1) : "0.0";
    const avgDur = s.total > 0 ? (s.totalMs / s.total / 1000).toFixed(1) + "s" : "0.0s";
    const errStr = s.executorError > 0 || s.providerError > 0 ? ` [${s.executorError} exec, ${s.providerError} provider]` : "";
    console.log(
      `  ${cond.padEnd(28)} ${String(s.success).padStart(4)}/${String(s.total).padStart(2)}  ${rate.padStart(5)}%  ${avgSteps.padStart(8)}  ${avgDur.padStart(7)}${errStr}`,
    );
  }

  console.log("\n=== by task ===");
  const byTask: Record<string, { total: number; success: number; executorError: number; providerError: number }> = {};
  for (const r of results) {
    if (!byTask[r.taskId]) byTask[r.taskId] = { total: 0, success: 0, executorError: 0, providerError: 0 };
    byTask[r.taskId].total += 1;
    if (r.success) byTask[r.taskId].success += 1;
    if (r.executorError) byTask[r.taskId].executorError += 1;
    if (r.providerError) byTask[r.taskId].providerError += 1;
  }
  for (const [tid, s] of Object.entries(byTask).sort()) {
    const rate = ((s.success / s.total) * 100).toFixed(0);
    const errStr = s.executorError > 0 || s.providerError > 0 ? ` [${s.executorError} exec, ${s.providerError} provider]` : "";
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

  console.log("\n" + "=".repeat(80));
  console.log("=== Paired RQ1 attribution summary ===");
  console.log("=".repeat(80));

  const baselineSuccessRate = byCondition["baseline"] && byCondition["baseline"].total > 0
    ? byCondition["baseline"].success / byCondition["baseline"].total
    : 0;
  const oracleMemorySuccessRate = byCondition["oracle_memory"] && byCondition["oracle_memory"].total > 0
    ? byCondition["oracle_memory"].success / byCondition["oracle_memory"].total
    : 0;
  const oracleToolSuccessRate = byCondition["oracle_tool"] && byCondition["oracle_tool"].total > 0
    ? byCondition["oracle_tool"].success / byCondition["oracle_tool"].total
    : 0;
  const oracleAllSuccessRate = byCondition["oracle_memory_tool"] && byCondition["oracle_memory_tool"].total > 0
    ? byCondition["oracle_memory_tool"].success / byCondition["oracle_memory_tool"].total
    : 0;
  const indexed = new Map(results.map((result) => [`${result.taskId}::${result.condition}`, result]));
  const paired = results.filter((result) => result.condition === "baseline").map((baseline) => ({
    baseline,
    memory: indexed.get(`${baseline.taskId}::oracle_memory`),
    tool: indexed.get(`${baseline.taskId}::oracle_tool`),
    all: indexed.get(`${baseline.taskId}::oracle_memory_tool`),
  }));
  const recoveries = (selector: (pair: typeof paired[number]) => RunResult | undefined) => paired.filter((pair) => (
    !pair.baseline.success && selector(pair)?.success
  ));
  const memoryRecoveries = recoveries((pair) => pair.memory);
  const toolRecoveries = recoveries((pair) => pair.tool);
  const jointRecoveries = recoveries((pair) => pair.all);
  const baselineFailures = paired.filter((pair) => !pair.baseline.success);
  const attributableBaselineFailures = baselineFailures.filter((pair) => (
    ["selection_missed", "selection_wrong", "tool_selection_fail"].includes(pair.baseline.failureMode)
  ));
  const failureModeCounts: Record<string, number> = {};
  for (const pair of baselineFailures) {
    failureModeCounts[pair.baseline.failureMode] = (failureModeCounts[pair.baseline.failureMode] ?? 0) + 1;
  }
  const baselineAvgSteps = byCondition["baseline"] && byCondition["baseline"].total > 0
    ? byCondition["baseline"].totalSteps / byCondition["baseline"].total
    : 0;
  const oracleMemoryAvgSteps = byCondition["oracle_memory"] && byCondition["oracle_memory"].total > 0
    ? byCondition["oracle_memory"].totalSteps / byCondition["oracle_memory"].total
    : 0;
  const successGap = oracleMemorySuccessRate - baselineSuccessRate;
  const stepGap = baselineAvgSteps - oracleMemoryAvgSteps;

  console.log(`  baseline success:             ${(baselineSuccessRate * 100).toFixed(1)}%`);
  console.log(`  oracle_memory success:        ${(oracleMemorySuccessRate * 100).toFixed(1)}% (delta ${(oracleMemorySuccessRate - baselineSuccessRate) * 100 >= 0 ? "+" : ""}${((oracleMemorySuccessRate - baselineSuccessRate) * 100).toFixed(1)} pp)`);
  console.log(`  oracle_tool success:          ${(oracleToolSuccessRate * 100).toFixed(1)}% (delta ${(oracleToolSuccessRate - baselineSuccessRate) * 100 >= 0 ? "+" : ""}${((oracleToolSuccessRate - baselineSuccessRate) * 100).toFixed(1)} pp)`);
  console.log(`  oracle_memory_tool success:   ${(oracleAllSuccessRate * 100).toFixed(1)}% (delta ${(oracleAllSuccessRate - baselineSuccessRate) * 100 >= 0 ? "+" : ""}${((oracleAllSuccessRate - baselineSuccessRate) * 100).toFixed(1)} pp)`);
  console.log(`  baseline failures:            ${baselineFailures.length}/${paired.length}`);
  console.log(`  memory paired recoveries:     ${memoryRecoveries.length}/${baselineFailures.length}`);
  console.log(`  tool paired recoveries:       ${toolRecoveries.length}/${baselineFailures.length}`);
  console.log(`  joint paired recoveries:      ${jointRecoveries.length}/${baselineFailures.length}`);
  console.log(`  attributable baseline failures: ${attributableBaselineFailures.length}/${baselineFailures.length}`);
  console.log("  baseline failure modes:", failureModeCounts);
  console.log(`  baseline - memory avg steps:  ${stepGap.toFixed(1)}`);

  const allPassed = results.length === totalRuns && paired.length === sample.length;

  const totalSuccess = results.filter((r) => r.success).length;
  const totalExecutorErrors = results.filter((r) => r.executorError).length;
  const totalProviderErrors = results.filter((r) => r.providerError).length;
  const totalDurationMin = results.reduce((s, r) => s + r.durationMs, 0) / 1000 / 60;
  console.log(`\ntotal: ${totalSuccess}/${results.length} (${((totalSuccess / results.length) * 100).toFixed(0)}%)`);
  console.log(`executor errors: ${totalExecutorErrors}/${results.length}`);
  console.log(`provider errors: ${totalProviderErrors}/${results.length}`);
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
      attribution: {
        baselineSuccessRate,
        oracleMemorySuccessRate,
        oracleToolSuccessRate,
        oracleMemoryToolSuccessRate: oracleAllSuccessRate,
        memoryRecoveries: memoryRecoveries.length,
        toolRecoveries: toolRecoveries.length,
        jointRecoveries: jointRecoveries.length,
        attributableBaselineFailures: attributableBaselineFailures.length,
        baselineFailureModes: failureModeCounts,
        successGap,
        stepGap,
      },
    },
  });

  await session.finish("completed");
  console.log(`\nsession: ${session.runDir}`);
  console.log(`checkpoint: ${checkpointPath(runDir)}`);
  console.log(allPassed ? "\nALL RQ1 COVERAGE CHECKS PASSED" : "\nRQ1 COVERAGE INCOMPLETE (see summary above)");
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
