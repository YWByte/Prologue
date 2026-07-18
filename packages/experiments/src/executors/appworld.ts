import { randomUUID } from "node:crypto";
import type { Executor, ExecutorInput, ExecutorResult } from "@prologue/prologue";
import { AppWorldServerManager } from "./appworld_server.js";
import { AppWorldToolExecutor } from "./appworld_http.js";
import { StubAppWorldAgent } from "./appworld_stub_agent.js";
import {
  initAppWorldTask,
  runAppWorldEval,
  type AppWorldPythonRunnerConfig,
} from "./appworld_python.js";

export type AppWorldExecutorConfig = {
  appworldRoot: string;
  pythonPath: string;
  pythonScriptsDir: string;
  basePort: number;
  serverReadyTimeoutMs: number;
  serverReadyPollMs: number;
  serverShutdownTimeoutMs: number;
  evalTimeoutMs: number;
  experimentNamePrefix: string;
};

const DEFAULT_CONFIG: Omit<AppWorldExecutorConfig, "appworldRoot" | "pythonPath" | "pythonScriptsDir"> = {
  basePort: 9000,
  serverReadyTimeoutMs: 30_000,
  serverReadyPollMs: 500,
  serverShutdownTimeoutMs: 15_000,
  evalTimeoutMs: 120_000,
  experimentNamePrefix: "prologue_rq1",
};

export function makeAppWorldExecutorConfig(
  partial: Pick<AppWorldExecutorConfig, "appworldRoot" | "pythonPath" | "pythonScriptsDir"> &
    Partial<Omit<AppWorldExecutorConfig, "appworldRoot" | "pythonPath" | "pythonScriptsDir">>,
): AppWorldExecutorConfig {
  return { ...DEFAULT_CONFIG, ...partial };
}

let portCounter = 0;

function nextPort(basePort: number): number {
  // Per-condition port allocation. Sequential conditions in a single run
  // will never collide (each takes basePort + N). 8 conditions per task;
  // the % 8 keeps the port range tight.
  portCounter = (portCounter + 1) % 8;
  return basePort + portCounter;
}

function experimentNameFor(prefix: string, taskId: string, condition?: string): string {
  // AppWorld's apply_db_changes rejects paths containing the substring
  // "memory" (it assumes those are in-memory connection strings). Our
  // condition names like "oracle_memory" would therefore break the
  // evaluator. Substitute "memory" -> "mem" in the experiment name only;
  // the condition label itself is preserved in trajectory metadata.
  const safeCondition = (condition ?? "unknown").replace(/memory/g, "mem");
  return `${prefix}_${taskId}_${safeCondition}`;
}

/**
 * Real AppWorld executor: starts a REST API server, initializes the task
 * DB, runs the stub agent, persists mutations, and runs the official
 * `evaluate_task`. Per-condition server lifecycle.
 *
 * Failures are captured into trajectory `error` steps and returned as
 * `{ success: false }`; `execute` never throws for expected failures.
 */
export class AppWorldExecutor implements Executor {
  constructor(private readonly config: AppWorldExecutorConfig) {}

  async execute(input: ExecutorInput): Promise<ExecutorResult> {
    const steps: import("@prologue/schemas").TrajectoryStep[] = [];
    const port = nextPort(this.config.basePort);
    const experimentName = experimentNameFor(
      this.config.experimentNamePrefix,
      input.taskId,
      input.condition,
    );
    const metadata: Record<string, unknown> = { experimentName, port };

    const pythonConfig: AppWorldPythonRunnerConfig = {
      pythonPath: this.config.pythonPath,
      scriptsDir: this.config.pythonScriptsDir,
      timeoutMs: this.config.evalTimeoutMs,
    };

    const server = new AppWorldServerManager({
      pythonPath: this.config.pythonPath,
      appworldRoot: this.config.appworldRoot,
      port,
      scriptsDir: this.config.pythonScriptsDir,
      readyTimeoutMs: this.config.serverReadyTimeoutMs,
      readyPollMs: this.config.serverReadyPollMs,
      shutdownTimeoutMs: this.config.serverShutdownTimeoutMs,
    });

    try {
      await server.start();
      metadata.serverStartMs = server.startDurationMs;

      const remoteApisUrl = server.baseUrl;
      const initResult = await initAppWorldTask(
        {
          task_id: input.taskId,
          experiment_name: experimentName,
          root: this.config.appworldRoot,
          remote_apis_url: remoteApisUrl,
          mode: "init",
        },
        pythonConfig,
      );
      if (!initResult.ok) {
        steps.push(errorStep(`init failed: ${initResult.error}`));
        return fail(`init_failed: ${initResult.error}`, steps, metadata);
      }

      const toolExecutor = new AppWorldToolExecutor({ baseUrl: remoteApisUrl });
      const agent = new StubAppWorldAgent({ toolExecutor, input });
      const agentResult = await agent.run();
      steps.push(...agentResult.steps);

      const saveResult = await initAppWorldTask(
        {
          task_id: input.taskId,
          experiment_name: experimentName,
          root: this.config.appworldRoot,
          remote_apis_url: remoteApisUrl,
          mode: "save",
        },
        pythonConfig,
      );
      if (!saveResult.ok) {
        steps.push(errorStep(`save failed: ${saveResult.error}`));
        // Continue to eval anyway — the initial save from init may still
        // produce a (failing) eval result, which is more informative than
        // aborting here.
      }

      const evalResult = await runAppWorldEval(
        {
          task_id: input.taskId,
          experiment_name: experimentName,
          root: this.config.appworldRoot,
        },
        pythonConfig,
      );

      if (!evalResult.ok) {
        steps.push({
          stepId: randomUUID(),
          type: "eval",
          timestamp: new Date().toISOString(),
          output: { ok: false, error: evalResult.error },
          metadata: {},
        });
        return fail(`eval_failed: ${evalResult.error}`, steps, metadata);
      }

      const { result } = evalResult;
      steps.push({
        stepId: randomUUID(),
        type: "eval",
        timestamp: new Date().toISOString(),
        output: result,
        metadata: {},
      });

      const score = result.num_tests > 0 ? result.passes.length / result.num_tests : 0;
      return {
        success: result.success,
        score,
        reason: result.success
          ? "appworld: all tests passed"
          : `appworld: ${result.failures.length}/${result.num_tests} tests failed`,
        steps,
        metadata,
      };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      steps.push(errorStep(`executor_error: ${message}`));
      return fail(`executor_error: ${message}`, steps, metadata);
    } finally {
      await server.stop();
    }
  }
}

function errorStep(message: string): import("@prologue/schemas").TrajectoryStep {
  return {
    stepId: randomUUID(),
    type: "error",
    timestamp: new Date().toISOString(),
    output: { message },
    metadata: {},
  };
}

function fail(
  reason: string,
  steps: import("@prologue/schemas").TrajectoryStep[],
  metadata: Record<string, unknown>,
): ExecutorResult {
  return { success: false, score: 0, reason, steps, metadata };
}
