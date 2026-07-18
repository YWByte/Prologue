export type ExperimentRq = "rq1" | "rq2" | "rq3" | "rq4";

export type ExperimentConfig = {
  rq: ExperimentRq;
  method: string;
  datasetPath: string;
  seed?: number;
};

export {
  RQ1_CONDITIONS,
  buildRq1Input,
  runRq1Mock,
  type Rq1Condition,
  type Rq1ExperimentInput,
  type Rq1MockSummary,
} from "./rq1.js";

export { runRq1Real, type Rq1RealSummary } from "./rq1.real.js";

export {
  AppWorldExecutor,
  makeAppWorldExecutorConfig,
  type AppWorldExecutorConfig,
} from "./executors/appworld.js";
