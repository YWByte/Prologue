import type { MemoryItem, ToolItem, TrajectoryStep } from "@prologue/schemas";

/**
 * Minimal input contract for an Executor.
 *
 * `Rq1ExperimentInput` from `@prologue/experiments` is a structural superset
 * of this type and can be passed directly. Defining the contract here avoids
 * a dependency cycle (`@prologue/experiments` already depends on this package).
 */
export type ExecutorInput = {
  taskId: string;
  source: string;
  query: string;
  intentSpec?: string;
  memory: MemoryItem[];
  tools: ToolItem[];
  /** RQ1 condition label, e.g. "baseline" or "oracle_memory". For logging only. */
  condition?: string;
  /** Oracle flags. Executors may use these to model "agent uses oracle X only when selected". */
  usesOracleIntent?: boolean;
  usesOracleMemory?: boolean;
  usesOracleTool?: boolean;
};

/**
 * Result of executing one (task, condition) run.
 *
 * `success`/`score`/`reason` align with `EvalResult` from `@prologue/common`;
 * `steps` carries the trajectory for session logging.
 */
export type ExecutorResult = {
  success: boolean;
  /** 0..1, typically passes/num_tests from the evaluator. */
  score: number;
  reason?: string;
  steps: TrajectoryStep[];
  metadata?: Record<string, unknown>;
};

/**
 * Executes a single (task, condition) run against a real backend.
 *
 * Implementations MUST be independent: a failure here must not affect other
 * runs. Throwing is allowed only for programmer errors; expected failures
 * return `{ success: false, ... }`.
 */
export interface Executor {
  execute(input: ExecutorInput): Promise<ExecutorResult>;
}

/**
 * Result of a single tool invocation.
 *
 * Convention: `output` is the parsed JSON response (or `{ raw: text }` when
 * the body is not JSON), `error` is set when `ok` is false.
 */
export type ToolCallResult = {
  ok: boolean;
  output: unknown;
  error?: string;
  status?: number;
};

/**
 * Calls one ToolItem with structured args.
 *
 * AppWorld-specific implementations convert the OpenAPI `schema` on the
 * ToolItem into an HTTP request.
 */
export interface ToolExecutor {
  call(tool: ToolItem, args: Record<string, unknown>): Promise<ToolCallResult>;
}
