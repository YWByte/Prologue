import { loadEnvIntoProcess, createClientFromEnv } from "../packages/common/dist/index.js";
import { readCanonicalTasks, writeCanonicalTasks } from "../packages/data/dist/index.js";
import { buildRq1Input, RQ1_CONDITIONS, type Rq1Condition } from "../packages/experiments/dist/rq1.js";
import { AppWorldExecutor, makeAppWorldExecutorConfig } from "../packages/experiments/dist/index.js";
import { Session } from "../packages/session/dist/index.js";
import { join, dirname } from "node:path";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";

/**
 * RQ1 main experiment: A-batch (train only) x 8 conditions.
 *
 * Configuration:
 *   - model: qwen3.5-27b (dashscope)
 *   - RPM: 1000, API maxConcurrency: 50
 *   - RUN_CONCURRENCY: 20 (parallel runs)
 *   - maxSteps: 800, maxTokens: 8192, enableThinking: false
 *   - Checkpoint: flush intermediate results every 50 runs; resumable.
 *
 * Checkpoint files (in session dir):
 *   - checkpoint.json: { completed: RunResult[], runDir, tasksPath, config }
 *   - On restart, loads completed runs and skips them.
 */

type RunResult = {
  taskId: string;
  condition: Rq1Condition;
  success: boolean;
  score: number;
  steps: number;
  durationMs: number;
  executorError: boolean;
  providerError: boolean;
};

type Checkpoint = {
  runDir: string;
  tasksPath: string;
  configHash: string;
  completed: RunResult[];
};

// Load .env early so PROLOGUE_APPWORLD_* / API keys are visible to CONFIG below.
loadEnvIntoProcess();

const CONFIG = {
  tasksPath: "data/canonical/appworld-batch_a.jsonl",
  appworldRoot: process.env.PROLOGUE_APPWORLD_ROOT ?? "data/raw/appworld",
  rawManifest: "data/raw/appworld/batch_a",
  pythonPath: process.env.PROLOGUE_APPWORLD_PYTHON ?? ".venv-appworld/bin/python",
  basePort: 9100,
  experimentNamePrefix: "prologue_rq1_a_train",
  llmProvider: "vllm",
  llmModel: "qwen3.5-27b",
  enableThinking: false,
  maxSteps: 800,
  maxTokens: 4096,
  rpm: 1000,
  apiMaxConcurrency: 50,
  runConcurrency: 10,
  llmTimeoutMs: 600_000,
  checkpointEvery: 50,
  // If set, load valid (non-executor_error) results from this session dir as "already completed",
  // and rerun all executor_error runs in a NEW session. Leave empty for fresh run.
  resumeValidFrom: "runs/2026-07-20T11-05-16-754Z_rq1_oracle_attribution_llm_a_train_c355edbd",
};

function configHash(): string {
  // NOTE: maxTokens intentionally excluded — token limit changes should not
  // invalidate previously-completed valid runs.
  return [CONFIG.llmModel, CONFIG.maxSteps, CONFIG.rpm, CONFIG.runConcurrency].join("|");
}

/**
 * Match a checkpoint's configHash against the current config, tolerating the
 * legacy 5-field format (llmModel|maxSteps|maxTokens|rpm|runConcurrency) by
 * dropping the maxTokens field before comparison.
 */
function matchesConfigHash(cpHash: string): boolean {
  const current = configHash();
  if (cpHash === current) return true;
  const parts = cpHash.split("|");
  if (parts.length === 5) {
    // Legacy: llmModel|maxSteps|maxTokens|rpm|runConcurrency → drop index 2
    return [parts[0], parts[1], parts[3], parts[4]].join("|") === current;
  }
  return false;
}

function checkpointPath(runDir: string): string {
  return join(runDir, "checkpoint.json");
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

async function saveCheckpoint(runDir: string, cp: Checkpoint): Promise<void> {
  await mkdir(runDir, { recursive: true });
  await writeFile(checkpointPath(runDir), JSON.stringify(cp), "utf8");
}

/**
 * Reconstruct RunResult[] from log.jsonl when a session has no checkpoint.json
 * yet (e.g. crashed before the first checkpointEvery threshold).
 */
async function loadValidFromLog(runDir: string): Promise<RunResult[]> {
  const logPath = join(runDir, "log.jsonl");
  if (!existsSync(logPath)) return [];
  const content = await readFile(logPath, "utf8");
  const results: RunResult[] = [];
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const event = JSON.parse(trimmed);
      if (!["eval_result", "provider_error", "executor_error"].includes(event.type)) continue;
      const p = event.payload;
      if (!p?.condition) continue;
      results.push({
        taskId: event.taskId,
        condition: p.condition,
        success: p.success ?? false,
        score: p.score ?? 0,
        steps: p.steps ?? 0,
        durationMs: p.durationMs ?? 0,
        executorError: p.executorError ?? event.type === "executor_error",
        providerError: p.providerError ?? event.type === "provider_error",
      });
    } catch {
      // skip unparseable line
    }
  }
  return results;
}

/**
 * Load only valid (non-error) RunResults from a session directory.
 * Prefers checkpoint.json; falls back to log.jsonl reconstruction.
 */
async function loadValidResults(runDir: string): Promise<RunResult[]> {
  const cp = await loadCheckpoint(runDir);
  const all = cp ? cp.completed : await loadValidFromLog(runDir);
  return all.filter((r) => !r.executorError && !r.providerError);
}

async function findResumableSession(runsRoot: string, totalRuns: number): Promise<string | null> {
  // Look for the most recent session dir that has a checkpoint with matching config.
  try {
    const { readdir } = await import("node:fs/promises");
    const dirs = (await readdir(runsRoot))
      .filter((d) => d.includes("rq1_oracle_attribution_llm_a_train"))
      .sort()
      .reverse();
    for (const d of dirs) {
      const cp = await loadCheckpoint(join(runsRoot, d));
      if (cp && matchesConfigHash(cp.configHash) && cp.completed.length < totalRuns) {
        return join(runsRoot, d);
      }
    }
  } catch {
    // ignore
  }
  return null;
}

/**
 * Find ALL session dirs with run data (log.jsonl or checkpoint.json),
 * excluding a specific path. Returns paths in ascending order (oldest first)
 * so callers can merge with newer sessions overriding older ones.
 * Does NOT check configHash — used for merging valid results across sessions.
 */
async function findRecentSessionsForMerge(
  runsRoot: string,
  exclude?: string,
): Promise<string[]> {
  const { readdir } = await import("node:fs/promises");
  const dirs = (await readdir(runsRoot))
    .filter((d) => d.includes("rq1_oracle_attribution_llm_a_train"))
    .sort(); // ascending: oldest first, newest last (newest overrides)
  const result: string[] = [];
  for (const d of dirs) {
    const full = join(runsRoot, d);
    if (exclude && full === exclude) continue;
    if (existsSync(join(full, "log.jsonl")) || existsSync(join(full, "checkpoint.json"))) {
      result.push(full);
    }
  }
  return result;
}

async function buildCanonicalIfMissing(): Promise<void> {
  if (existsSync(CONFIG.tasksPath)) return;
  console.log(`canonical tasks not found at ${CONFIG.tasksPath}, building...`);
  const { AppWorldAdapter, buildDatasetManifest, writeDatasetManifest } = await import("../packages/data/dist/index.js");
  const adapter = new AppWorldAdapter();
  const manifestPath = CONFIG.tasksPath.replace(/\.jsonl$/, ".manifest.json");
  const tasks: any[] = [];
  const count = await (async () => {
    let n = 0;
    for await (const t of adapter.convert(CONFIG.rawManifest)) {
      tasks.push(t);
      n += 1;
    }
    return n;
  })();
  await writeCanonicalTasks(tasks, CONFIG.tasksPath);
  const splits: Record<string, number> = {};
  for (const t of tasks) splits[t.split] = (splits[t.split] ?? 0) + 1;
  const manifest = buildDatasetManifest({
    suiteVersion: "0.1.0",
    schemaVersion: "0.1.0",
    sources: ["appworld"],
    taskCount: count,
    splits,
    adapterVersions: { appworld: adapter.version },
    metadata: { outPath: CONFIG.tasksPath, batch: "A_train" },
  });
  await writeDatasetManifest(manifest, manifestPath);
  console.log(`built ${count} canonical tasks`);
}

async function main(): Promise<void> {
  loadEnvIntoProcess();
  await buildCanonicalIfMissing();

  const tasks = await readCanonicalTasks(CONFIG.tasksPath);
  console.log(`loaded ${tasks.length} tasks`);

  const workspaceRoot = process.cwd();
  const runsRoot = join(workspaceRoot, "runs");

  // Total runs = tasks × 8 conditions
  const totalRuns = tasks.length * RQ1_CONDITIONS.length;

  // Resume logic: merge valid results from up to two sources, then rerun all
  // errors in a NEW session. maxTokens changes are tolerated (excluded from
  // configHash); other config changes (llmModel/maxSteps/rpm/runConcurrency)
  // still prevent findResumableSession from matching.
  const validByKey = new Map<string, RunResult>();
  let resumedFrom: string | undefined;

  // Source 1: resumeValidFrom (e.g. c355edbd — historical valid baseline)
  if (CONFIG.resumeValidFrom) {
    const valid = await loadValidResults(CONFIG.resumeValidFrom);
    for (const r of valid) validByKey.set(`${r.taskId}::${r.condition}`, r);
    console.log(`resumeValidFrom: ${CONFIG.resumeValidFrom} -> ${valid.length} valid`);
    resumedFrom = CONFIG.resumeValidFrom;
  }

  // Source 2: ALL sessions with run data (oldest→newest, newer overrides older).
  // Merges valid results across multiple restarts so no valid run is lost.
  const recentSessions = await findRecentSessionsForMerge(runsRoot, CONFIG.resumeValidFrom || undefined);
  for (const sessionDir of recentSessions) {
    const valid = await loadValidResults(sessionDir);
    let added = 0;
    for (const r of valid) {
      const key = `${r.taskId}::${r.condition}`;
      if (!validByKey.has(key)) added++;
      validByKey.set(key, r); // newer session overrides older (processed last)
    }
    console.log(`recent session: ${sessionDir} -> ${valid.length} valid (${added} new)`);
    if (!resumedFrom) resumedFrom = sessionDir;
  }

  // Source 3 (fallback only): if neither source produced data, try checkpoint match.
  if (validByKey.size === 0) {
    const resumable = await findResumableSession(runsRoot, totalRuns);
    if (resumable) {
      const valid = await loadValidResults(resumable);
      for (const r of valid) validByKey.set(`${r.taskId}::${r.condition}`, r);
      console.log(`resumable session: ${resumable} -> ${valid.length} valid`);
      resumedFrom = resumable;
    }
  }

  const results: RunResult[] = Array.from(validByKey.values());
  console.log(`merged valid: ${results.length}/${totalRuns}, rerun: ${totalRuns - results.length}`);

  const session = await Session.start({
    rq: "rq1",
    method: "oracle_attribution_llm_a_train",
    config: { ...CONFIG, ...(resumedFrom ? { resumedFrom } : {}) },
    dataset: {
      taskCount: tasks.length,
      sources: Array.from(new Set(tasks.map((t) => t.source))),
    },
    models: {
      executor: "appworld_llm",
      agent: "llm_react",
      llmProvider: CONFIG.llmProvider,
      llmModel: CONFIG.llmModel,
    },
    runsRoot,
  });
  const resumedRunDir: string = session.runDir;

  const llm = createClientFromEnv(CONFIG.llmProvider, {
    rpm: CONFIG.rpm,
    maxConcurrency: CONFIG.apiMaxConcurrency,
    timeoutMs: CONFIG.llmTimeoutMs,
  });

  const executor = new AppWorldExecutor(
    makeAppWorldExecutorConfig({
      appworldRoot: CONFIG.appworldRoot,
      pythonPath: CONFIG.pythonPath,
      pythonScriptsDir: join(workspaceRoot, "python", "appworld"),
      basePort: CONFIG.basePort,
      experimentNamePrefix: CONFIG.experimentNamePrefix,
      llm,
      llmModel: CONFIG.llmModel,
      enableThinking: CONFIG.enableThinking,
      maxSteps: CONFIG.maxSteps,
      maxTokens: CONFIG.maxTokens,
    }),
  );

  // Build all (task, condition) work items
  const workItems: Array<{ task: typeof tasks[number]; condition: Rq1Condition; runIndex: number }> = [];
  let runIndex = 0;
  for (const task of tasks) {
    for (const condition of RQ1_CONDITIONS) {
      workItems.push({ task, condition, runIndex: ++runIndex });
    }
  }
  // totalRuns already computed above (before resume logic)

  // Skip already-completed runs (from merged valid results)
  const completedKeys = new Set(results.map((r) => `${r.taskId}::${r.condition}`));
  let queueCursor = 0;

  console.log(`\nrunning ${totalRuns} runs with concurrency=${CONFIG.runConcurrency}`);
  console.log(`already completed: ${completedKeys.size}, remaining: ${totalRuns - completedKeys.size}\n`);

  let completedCount = results.length;
  let sinceLastCheckpoint = 0;

  async function runOne(item: { task: typeof tasks[number]; condition: Rq1Condition; runIndex: number }): Promise<void> {
    const { task, condition, runIndex } = item;
    const key = `${task.taskId}::${condition}`;
    if (completedKeys.has(key)) return;

    const input = buildRq1Input(task, condition);
    const startedAt = Date.now();

    console.log(
      `[${runIndex}/${totalRuns}] START task=${task.taskId} condition=${condition} ` +
        `memory=${input.memory.length} tools=${input.tools.length}`,
    );

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
      };
      results.push(runResult);
      completedKeys.add(key);

      console.log(
        `[${runIndex}/${totalRuns}] DONE  task=${task.taskId} cond=${condition} ` +
          `success=${result.success} score=${result.score?.toFixed(2) ?? 0} ` +
          `steps=${stepCount} dur=${(durationMs / 1000).toFixed(1)}s` +
          (executorError ? " [EXECUTOR_ERROR]" : "") +
          (providerError ? " [PROVIDER_ERROR]" : ""),
      );

      await session.logger.write({
        level: executorError || providerError ? "error" : result.success ? "info" : "warn",
        type: executorError ? "executor_error" : providerError ? "provider_error" : "eval_result",
        rq: "rq1",
        taskId: task.taskId,
        source: task.source,
        method: "oracle_attribution_llm_a_train",
        payload: {
          condition,
          success: result.success,
          score: result.score,
          steps: stepCount,
          durationMs,
          executorError,
          providerError,
          experimentName: result.metadata?.experimentName,
          reason: result.reason,
        },
      });

      session.addTrajectory({
        taskId: task.taskId,
        source: task.source,
        method: "oracle_attribution_llm_a_train",
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
      const runResult: RunResult = {
        taskId: task.taskId,
        condition,
        success: false,
        score: 0,
        steps: 0,
        durationMs,
        executorError,
        providerError: false,
      };
      results.push(runResult);
      completedKeys.add(key);

      await session.logger.write({
        level: "error",
        type: "executor_error",
        rq: "rq1",
        taskId: task.taskId,
        source: task.source,
        method: "oracle_attribution_llm_a_train",
        payload: { condition, message, durationMs },
      });
    } finally {
      completedCount += 1;
      sinceLastCheckpoint += 1;
    }
  }

  // Worker pool
  async function worker(workerId: number): Promise<void> {
    while (true) {
      const idx = queueCursor++;
      if (idx >= workItems.length) return;
      await runOne(workItems[idx]);
      if (sinceLastCheckpoint >= CONFIG.checkpointEvery) {
        sinceLastCheckpoint = 0;
        await saveCheckpoint(resumedRunDir!, {
          runDir: resumedRunDir!,
          tasksPath: CONFIG.tasksPath,
          configHash: configHash(),
          completed: results,
        });
        console.log(`[checkpoint] saved ${results.length}/${totalRuns} completed runs`);
      }
    }
  }

  const workers = Array.from({ length: Math.min(CONFIG.runConcurrency, totalRuns) }, (_, i) => worker(i));
  await Promise.all(workers);

  // Final checkpoint
  await saveCheckpoint(resumedRunDir!, {
    runDir: resumedRunDir!,
    tasksPath: CONFIG.tasksPath,
    configHash: configHash(),
    completed: results,
  });

  // Summary
  console.log("\n" + "=".repeat(80));
  console.log("=== SUMMARY ===");
  console.log("=".repeat(80));

  const byCondition: Record<string, { total: number; success: number; executorError: number; providerError: number }> = {};
  for (const r of results) {
    if (!byCondition[r.condition]) byCondition[r.condition] = { total: 0, success: 0, executorError: 0, providerError: 0 };
    byCondition[r.condition].total += 1;
    if (r.success) byCondition[r.condition].success += 1;
    if (r.executorError) byCondition[r.condition].executorError += 1;
    if (r.providerError) byCondition[r.condition].providerError += 1;
  }

  console.log("\n=== by condition ===");
  for (const cond of RQ1_CONDITIONS) {
    const s = byCondition[cond] ?? { total: 0, success: 0, executorError: 0, providerError: 0 };
    const rate = s.total > 0 ? ((s.success / s.total) * 100).toFixed(0) : "0";
    const errStr = s.executorError > 0 || s.providerError > 0 ? ` [${s.executorError} exec, ${s.providerError} provider]` : "";
    console.log(`  ${cond.padEnd(25)} ${s.success}/${s.total} (${rate}%)${errStr}`);
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
    console.log(`  ${tid}  ${s.success}/${s.total} (${rate}%)${errStr}`);
  }

  const totalSuccess = results.filter((r) => r.success).length;
  const totalExecutorErrors = results.filter((r) => r.executorError).length;
  const totalProviderErrors = results.filter((r) => r.providerError).length;
  console.log(`\ntotal: ${totalSuccess}/${results.length} (${((totalSuccess / results.length) * 100).toFixed(0)}%)`);
  console.log(`executor errors: ${totalExecutorErrors}/${results.length}`);
  console.log(`provider errors: ${totalProviderErrors}/${results.length}`);
  console.log(`total duration: ${(results.reduce((s, r) => s + r.durationMs, 0) / 1000 / 60).toFixed(1)} min`);

  await session.logger.write({
    level: "info",
    type: "rq1_llm_summary",
    rq: "rq1",
    method: "oracle_attribution_llm_a_train",
    payload: {
      taskCount: tasks.length,
      runCount: results.length,
      successCount: totalSuccess,
      executorErrorCount: totalExecutorErrors,
      byCondition,
      byTask,
    },
  });

  await session.finish("completed");
  console.log(`\nsession: ${session.runDir}`);
  console.log(`checkpoint: ${checkpointPath(resumedRunDir!)}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
