import { z } from "zod";

export const rqSchema = z.enum(["rq1", "rq2", "rq3", "rq4"]);

export type Rq = z.infer<typeof rqSchema>;

export const splitSchema = z.enum(["train", "dev", "test"]);

export type Split = z.infer<typeof splitSchema>;

export const missingTypeSchema = z.enum(["intent", "memory", "tool", "multiple", "none"]);

export type MissingType = z.infer<typeof missingTypeSchema>;

export const memoryItemSchema = z.object({
  id: z.string(),
  type: z.enum(["profile", "history", "state", "evidence", "document", "other"]),
  content: z.string(),
  source: z.string().optional(),
  timestamp: z.string().optional(),
  metadata: z.record(z.unknown()).default({}),
});

export type MemoryItem = z.infer<typeof memoryItemSchema>;

export const toolItemSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  schema: z.record(z.unknown()).optional(),
  type: z.enum(["api", "function", "browser", "shell", "editor", "retrieval", "other"]),
  metadata: z.record(z.unknown()).default({}),
});

export type ToolItem = z.infer<typeof toolItemSchema>;

export const evaluatorSpecSchema = z.object({
  type: z.enum(["programmatic", "exact_match", "unit_test", "llm_judge", "external"]),
  entrypoint: z.string().optional(),
  goldAnswer: z.string().optional(),
  metadata: z.record(z.unknown()).default({}),
});

export type EvaluatorSpec = z.infer<typeof evaluatorSpecSchema>;

export const datasetCapabilitySchema = z.object({
  hasOracleIntent: z.boolean().default(false),
  hasOracleMemory: z.boolean().default(false),
  hasOracleTool: z.boolean().default(false),
  hasExecutableEval: z.boolean().default(false),
  supportsInteraction: z.boolean().default(false),
});

export type DatasetCapability = z.infer<typeof datasetCapabilitySchema>;

export const canonicalTaskSchema = z.object({
  taskId: z.string(),
  source: z.string(),
  domain: z.string(),
  split: splitSchema,
  query: z.string(),
  oracleIntent: z.string().optional(),
  memoryPool: z.array(memoryItemSchema),
  oracleMemoryIds: z.array(z.string()).default([]),
  toolPool: z.array(toolItemSchema),
  oracleToolIds: z.array(z.string()).default([]),
  evaluator: evaluatorSpecSchema,
  capabilities: datasetCapabilitySchema.default({}),
  metadata: z.record(z.unknown()).default({}),
});

export type CanonicalTask = z.infer<typeof canonicalTaskSchema>;

export const datasetManifestSchema = z.object({
  suiteVersion: z.string(),
  schemaVersion: z.string(),
  createdAt: z.string(),
  sources: z.array(z.string()),
  taskCount: z.number().int().nonnegative(),
  splits: z.record(z.number().int().nonnegative()).default({}),
  adapterVersions: z.record(z.string()).default({}),
  metadata: z.record(z.unknown()).default({}),
});

export type DatasetManifest = z.infer<typeof datasetManifestSchema>;

export const verifierExampleSchema = z.object({
  exampleId: z.string(),
  taskId: z.string(),
  source: z.string(),
  split: splitSchema,
  query: z.string(),
  context: z.object({
    intent: z.string().optional(),
    memoryIds: z.array(z.string()).default([]),
    toolIds: z.array(z.string()).default([]),
  }),
  ySuccess: z.boolean(),
  yMissing: missingTypeSchema,
  groupId: z.string(),
  metadata: z.record(z.unknown()).default({}),
});

export type VerifierExample = z.infer<typeof verifierExampleSchema>;

export const logEventSchema = z.object({
  eventId: z.string(),
  sessionId: z.string(),
  timestamp: z.string(),
  level: z.enum(["debug", "info", "warn", "error"]),
  type: z.string(),
  rq: rqSchema.optional(),
  taskId: z.string().optional(),
  source: z.string().optional(),
  method: z.string().optional(),
  payload: z.unknown(),
});

export type LogEvent = z.infer<typeof logEventSchema>;

export const trajectoryStepSchema = z.object({
  stepId: z.string(),
  type: z.enum(["system", "prologue", "llm", "tool", "verifier", "eval", "error"]),
  timestamp: z.string(),
  input: z.unknown().optional(),
  output: z.unknown().optional(),
  metadata: z.record(z.unknown()).default({}),
});

export type TrajectoryStep = z.infer<typeof trajectoryStepSchema>;

export const agentTrajectorySchema = z.object({
  taskId: z.string(),
  source: z.string(),
  method: z.string(),
  input: z.record(z.unknown()),
  prologue: z.record(z.unknown()).optional(),
  steps: z.array(trajectoryStepSchema).default([]),
  result: z.object({
    success: z.boolean(),
    score: z.number().optional(),
    error: z.string().optional(),
  }),
});

export type AgentTrajectory = z.infer<typeof agentTrajectorySchema>;

export const sessionFileSchema = z.object({
  sessionId: z.string(),
  createdAt: z.string(),
  finishedAt: z.string().optional(),
  rq: z.union([rqSchema, z.literal("data")]),
  method: z.string(),
  config: z.record(z.unknown()),
  configHash: z.string(),
  dataset: z.record(z.unknown()),
  models: z.record(z.unknown()).default({}),
  status: z.enum(["running", "completed", "failed"]),
  trajectories: z.array(agentTrajectorySchema).default([]),
});

export type SessionFile = z.infer<typeof sessionFileSchema>;
