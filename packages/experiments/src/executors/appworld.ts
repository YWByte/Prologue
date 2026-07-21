import { randomUUID } from "node:crypto";
import type { LlmClient } from "@prologue/common";
import type { Executor, ExecutorInput, ExecutorResult } from "@prologue/prologue";
import { AppWorldServerManager } from "./appworld_server.js";
import { AppWorldToolExecutor } from "./appworld_http.js";
import { StubAppWorldAgent } from "./appworld_stub_agent.js";
import { LlmAppWorldAgent } from "./appworld_llm_agent.js";
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
  /** LLM client for real agent mode. If undefined, uses stub agent. */
  llm?: LlmClient;
  /** Model name for LLM calls. */
  llmModel?: string;
  /** Enable Qwen3.5 thinking mode. Default false. */
  enableThinking?: boolean;
  /** Max agent steps. Default 200. */
  maxSteps?: number;
  /** Max tokens for LLM response. Default 1024. */
  maxTokens?: number;
};

const DEFAULT_CONFIG: Omit<AppWorldExecutorConfig, "appworldRoot" | "pythonPath" | "pythonScriptsDir"> = {
  basePort: 9000,
  serverReadyTimeoutMs: 60_000,
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
  // Concurrent-safe port allocation: each call gets a unique increasing port.
  // Uses a wide range so parallel runs in a worker pool won't collide.
  // Range: basePort .. basePort + 1000 (supports up to 1000 concurrent runs).
  portCounter = (portCounter + 1) % 1000;
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

      let agentSteps: import("@prologue/schemas").TrajectoryStep[];
      if (this.config.llm && this.config.llmModel) {
        const agent = new LlmAppWorldAgent({
          llm: this.config.llm,
          model: this.config.llmModel,
          toolExecutor,
          input,
          maxSteps: this.config.maxSteps,
          maxTokens: this.config.maxTokens,
          enableThinking: this.config.enableThinking,
        });
        const agentResult = await agent.run();
        agentSteps = agentResult.steps;
        metadata.agentMode = "llm";
        metadata.agentModel = this.config.llmModel;
        metadata.agentSuccess = agentResult.success;
      } else {
        const agent = new StubAppWorldAgent({ toolExecutor, input });
        const agentResult = await agent.run();
        agentSteps = agentResult.steps;
        metadata.agentMode = "stub";
      }
      steps.push(...agentSteps);

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
