export type ExperimentRq = "rq1" | "rq2" | "rq3" | "rq4";

export type ExperimentConfig = {
  rq: ExperimentRq;
  method: string;
  datasetPath: string;
  seed?: number;
};
