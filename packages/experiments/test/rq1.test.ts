import { describe, expect, it } from "vitest";
import type { CanonicalTask } from "@prologue/schemas";
import { buildRq1Input } from "../src/rq1.js";

function makeTask(overrides: Partial<CanonicalTask> = {}): CanonicalTask {
  return {
    taskId: "task_1",
    source: "appworld",
    domain: "test",
    split: "dev",
    query: "Do the task",
    oracleIntent: "Do the task with oracle intent",
    memoryPool: [
      {
        id: "m_common",
        type: "profile",
        content: "common",
        metadata: { oracle: false, memoryRole: "common" },
      },
      {
        id: "m_oracle",
        type: "evidence",
        content: "oracle",
        metadata: { oracle: true, memoryRole: "oracle" },
      },
      {
        id: "m_distractor",
        type: "state",
        content: "distractor",
        metadata: { oracle: false, memoryRole: "distractor", distractorType: "noise" },
      },
    ],
    commonMemoryIds: ["m_common"],
    oracleMemoryIds: ["m_oracle"],
    distractorMemoryIds: ["m_distractor"],
    toolPool: [
      { id: "t_common", name: "t_common", description: "common", type: "api", metadata: {} },
      { id: "t_oracle", name: "t_oracle", description: "oracle", type: "api", metadata: {} },
    ],
    oracleToolIds: ["t_oracle"],
    evaluator: { type: "programmatic", metadata: {} },
    capabilities: {
      hasOracleIntent: true,
      hasOracleMemory: true,
      hasOracleTool: true,
      hasExecutableEval: true,
      supportsInteraction: true,
    },
    metadata: {},
    ...overrides,
  };
}

describe("buildRq1Input", () => {
  it("keeps baseline memory limited to common memory", () => {
    const input = buildRq1Input(makeTask(), "baseline");

    expect(input.memory.map((item) => item.id)).toEqual(["m_common"]);
    expect(input.tools.map((item) => item.id)).toEqual(["t_common", "t_oracle"]);
  });

  it("adds oracle memory on top of common memory", () => {
    const input = buildRq1Input(makeTask(), "oracle_memory");

    expect(input.memory.map((item) => item.id)).toEqual(["m_common", "m_oracle"]);
  });

  it("falls back to non-oracle non-distractor memory for old canonical tasks", () => {
    const task = makeTask({ commonMemoryIds: [] });
    const input = buildRq1Input(task, "baseline");

    expect(input.memory.map((item) => item.id)).toEqual(["m_common"]);
  });
});
