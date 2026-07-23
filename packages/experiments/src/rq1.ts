import type { CanonicalTask, MemoryItem, ToolItem } from "@prologue/schemas";
import type { Session } from "@prologue/session";

export const RQ1_CONDITIONS = [
  "baseline",
  "oracle_intent",
  "oracle_memory",
  "oracle_tool",
  "oracle_intent_memory",
  "oracle_intent_tool",
  "oracle_memory_tool",
  "oracle_all",
] as const;

export type Rq1Condition = (typeof RQ1_CONDITIONS)[number];

export type Rq1ExperimentInput = {
  taskId: string;
  source: string;
  condition: Rq1Condition;
  query: string;
  intentSpec?: string;
  memory: MemoryItem[];
  tools: ToolItem[];
  usesOracleIntent: boolean;
  usesOracleMemory: boolean;
  usesOracleTool: boolean;
  evaluatorMetadata?: Record<string, unknown>;
};

export type Rq1MockSummary = {
  taskCount: number;
  runCount: number;
  successCount: number;
};

function hasOracleIntent(condition: Rq1Condition): boolean {
  return condition === "oracle_intent" || condition === "oracle_intent_memory" || condition === "oracle_intent_tool" || condition === "oracle_all";
}

function hasOracleMemory(condition: Rq1Condition): boolean {
  return condition === "oracle_memory" || condition === "oracle_intent_memory" || condition === "oracle_memory_tool" || condition === "oracle_all";
}

function hasOracleTool(condition: Rq1Condition): boolean {
  return condition === "oracle_tool" || condition === "oracle_intent_tool" || condition === "oracle_memory_tool" || condition === "oracle_all";
}

export function getRq1Conditions(task: Pick<CanonicalTask, "capabilities">): Rq1Condition[] {
  const {
    hasOracleIntent: supportsOracleIntent,
    hasOracleMemory: supportsOracleMemory,
    hasOracleTool: supportsOracleTool,
  } = task.capabilities;
  return RQ1_CONDITIONS.filter((condition) => {
    if (hasOracleIntent(condition) && !supportsOracleIntent) return false;
    if (hasOracleMemory(condition) && !supportsOracleMemory) return false;
    if (hasOracleTool(condition) && !supportsOracleTool) return false;
    return true;
  });
}

function selectByIds<T extends { id: string }>(items: T[], ids: string[], label: string, taskId: string): T[] {
  const selected = items.filter((item) => ids.includes(item.id));
  if (selected.length !== ids.length) {
    const found = new Set(selected.map((item) => item.id));
    const missing = ids.filter((id) => !found.has(id));
    throw new Error(`Task ${taskId} has unresolved oracle ${label} IDs: ${missing.join(", ")}`);
  }
  return selected;
}

function uniqueById<T extends { id: string }>(items: T[]): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    if (seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });
}

function fallbackCommonMemory(memoryPool: MemoryItem[]): MemoryItem[] {
  return memoryPool.filter((item) => {
    const metadata = item.metadata as Record<string, unknown>;
    if (metadata.oracle === true) return false;
    if (typeof metadata.distractorType === "string") return false;
    if (item.id.includes(":memory:distractor:")) return false;
    return true;
  });
}

function usesPrestageExistingMemory(task: CanonicalTask): boolean {
  return task.metadata.rq1MemoryOracleMode === "prestage_existing";
}

function markPreStaged(items: MemoryItem[], oracleIds: string[]): MemoryItem[] {
  const selected = new Set(oracleIds);
  return items.map((item) => {
    if (!selected.has(item.id)) return item;
    return {
      ...item,
      metadata: {
        ...item.metadata,
        promptInjected: true,
      },
    };
  });
}

export function buildRq1Input(task: CanonicalTask, condition: Rq1Condition): Rq1ExperimentInput {
  const usesOracleIntent = hasOracleIntent(condition);
  const usesOracleMemory = hasOracleMemory(condition);
  const usesOracleTool = hasOracleTool(condition);

  if (!getRq1Conditions(task).includes(condition)) {
    throw new Error(`Task ${task.taskId} does not support RQ1 condition ${condition}.`);
  }
  if (usesOracleIntent && !task.oracleIntent) {
    throw new Error(`Task ${task.taskId} does not provide oracleIntent.`);
  }
  if (usesOracleMemory && task.oracleMemoryIds.length === 0) {
    throw new Error(`Task ${task.taskId} does not provide oracleMemoryIds.`);
  }
  if (usesOracleTool && task.oracleToolIds.length === 0) {
    throw new Error(`Task ${task.taskId} does not provide oracleToolIds.`);
  }

  const commonMemory = task.commonMemoryIds.length > 0
    ? selectByIds(task.memoryPool, task.commonMemoryIds, "common memory", task.taskId)
    : fallbackCommonMemory(task.memoryPool);
  const oracleMemory = usesOracleMemory
    ? selectByIds(task.memoryPool, task.oracleMemoryIds, "memory", task.taskId)
    : [];
  const memory = usesPrestageExistingMemory(task)
    ? markPreStaged(task.memoryPool, usesOracleMemory ? task.oracleMemoryIds : [])
    : uniqueById([...commonMemory, ...oracleMemory]);

  return {
    taskId: task.taskId,
    source: task.source,
    condition,
    query: task.query,
    intentSpec: usesOracleIntent ? task.oracleIntent : undefined,
    memory,
    tools: usesOracleTool ? selectByIds(task.toolPool, task.oracleToolIds, "tool", task.taskId) : task.toolPool,
    usesOracleIntent,
    usesOracleMemory,
    usesOracleTool,
    evaluatorMetadata: task.evaluator?.metadata,
  };
}

function runMock(input: Rq1ExperimentInput): { success: boolean; reason: string } {
  const success = input.usesOracleMemory && input.usesOracleTool;
  return {
    success,
    reason: success
      ? "Mock policy: oracle memory and oracle tools are both available."
      : "Mock policy: success requires both oracle memory and oracle tools.",
  };
}

export async function runRq1Mock(tasks: CanonicalTask[], session: Session): Promise<Rq1MockSummary> {
  let runCount = 0;
  let successCount = 0;

  for (const task of tasks) {
    for (const condition of getRq1Conditions(task)) {
      const input = buildRq1Input(task, condition);
      const startedAt = new Date().toISOString();
      const mockResult = runMock(input);
      runCount += 1;
      if (mockResult.success) successCount += 1;

      await session.logger.write({
        level: "info",
        type: "task_start",
        rq: "rq1",
        taskId: task.taskId,
        source: task.source,
        method: "oracle_attribution_mock",
        payload: { condition },
      });
      await session.logger.write({
        level: "info",
        type: "oracle_condition",
        rq: "rq1",
        taskId: task.taskId,
        source: task.source,
        method: "oracle_attribution_mock",
        payload: {
          condition,
          usesOracleIntent: input.usesOracleIntent,
          usesOracleMemory: input.usesOracleMemory,
          usesOracleTool: input.usesOracleTool,
        },
      });

      session.addTrajectory({
        taskId: task.taskId,
        source: task.source,
        method: "oracle_attribution_mock",
        input: {
          query: input.query,
          memoryIds: input.memory.map((item) => item.id),
          toolIds: input.tools.map((item) => item.id),
        },
        prologue: {
          condition,
          usesOracleIntent: input.usesOracleIntent,
          usesOracleMemory: input.usesOracleMemory,
          usesOracleTool: input.usesOracleTool,
        },
        steps: [],
        result: {
          success: mockResult.success,
          score: mockResult.success ? 1 : 0,
          error: mockResult.reason,
        },
      });

      await session.logger.write({
        level: mockResult.success ? "info" : "warn",
        type: "eval_result",
        rq: "rq1",
        taskId: task.taskId,
        source: task.source,
        method: "oracle_attribution_mock",
        payload: {
          condition,
          success: mockResult.success,
          reason: mockResult.reason,
          startedAt,
          finishedAt: new Date().toISOString(),
        },
      });
    }
  }

  return { taskCount: tasks.length, runCount, successCount };
}
