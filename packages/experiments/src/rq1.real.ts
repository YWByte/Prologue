import type { CanonicalTask } from "@prologue/schemas";
import type { Session } from "@prologue/session";
import type { Executor } from "@prologue/prologue";
import {
  RQ1_CONDITIONS,
  buildRq1Input,
  type Rq1Condition,
  type Rq1ExperimentInput,
} from "./rq1.js";

export type Rq1RealSummary = {
  taskCount: number;
  runCount: number;
  successCount: number;
  perCondition: Record<Rq1Condition, { total: number; success: number }>;
};

/**
 * Real RQ1 attribution runner. Mirrors `runRq1Mock` but delegates execution
 * to a real `Executor` instead of the mock success policy.
 *
 * Per (task, condition):
 *   - build input via `buildRq1Input` (same as mock)
 *   - call `executor.execute(input)`
 *   - write `task_start` / `oracle_condition` / `eval_result` log events
 *     (method = "oracle_attribution_real", no mock:true)
 *   - add trajectory with `result.reason` populated
 *
 * Individual (task, condition) failures do not abort the run; only
 * programmer errors (executor throws) propagate to the caller.
 */
export async function runRq1Real(
  tasks: CanonicalTask[],
  session: Session,
  executor: Executor,
): Promise<Rq1RealSummary> {
  let runCount = 0;
  let successCount = 0;
  const perCondition = Object.fromEntries(
    RQ1_CONDITIONS.map((c) => [c, { total: 0, success: 0 }]),
  ) as Rq1RealSummary["perCondition"];

  for (const task of tasks) {
    for (const condition of RQ1_CONDITIONS) {
      const input: Rq1ExperimentInput = buildRq1Input(task, condition);
      const startedAt = new Date().toISOString();

      const result = await executor.execute(input);
      runCount += 1;
      perCondition[condition].total += 1;
      if (result.success) {
        successCount += 1;
        perCondition[condition].success += 1;
      }

      await session.logger.write({
        level: "info",
        type: "task_start",
        rq: "rq1",
        taskId: task.taskId,
        source: task.source,
        method: "oracle_attribution_real",
        payload: { condition },
      });
      await session.logger.write({
        level: "info",
        type: "oracle_condition",
        rq: "rq1",
        taskId: task.taskId,
        source: task.source,
        method: "oracle_attribution_real",
        payload: {
          condition,
          usesOracleIntent: input.usesOracleIntent,
          usesOracleMemory: input.usesOracleMemory,
          usesOracleTool: input.usesOracleTool,
          memoryIds: input.memory.map((m) => m.id),
          toolIds: input.tools.map((t) => t.id),
        },
      });
      await session.logger.write({
        level: result.success ? "info" : "warn",
        type: "eval_result",
        rq: "rq1",
        taskId: task.taskId,
        source: task.source,
        method: "oracle_attribution_real",
        payload: {
          condition,
          success: result.success,
          score: result.score,
          error: result.reason,
          experimentName: result.metadata?.experimentName,
        },
      });

      session.addTrajectory({
        taskId: task.taskId,
        source: task.source,
        method: "oracle_attribution_real",
        input: {
          query: input.query,
          intentSpec: input.intentSpec,
          memoryIds: input.memory.map((m) => m.id),
          toolIds: input.tools.map((t) => t.id),
          oracleCondition: condition,
        },
        prologue: {
          mode: "oracle_attribution",
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
      // startedAt is captured for potential future timing instrumentation.
      void startedAt;
    }
  }

  return { taskCount: tasks.length, runCount, successCount, perCondition };
}
