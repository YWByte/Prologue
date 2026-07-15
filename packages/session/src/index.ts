import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { createLogger, type Logger } from "@prologue/log";
import type { AgentTrajectory, SessionFile } from "@prologue/schemas";

export type StartSessionInput = {
  rq: SessionFile["rq"];
  method: string;
  config?: Record<string, unknown>;
  dataset?: Record<string, unknown>;
  models?: Record<string, unknown>;
  runsRoot?: string;
};

export class Session {
  readonly logger: Logger;
  readonly runDir: string;
  private file: SessionFile;

  private constructor(file: SessionFile, runDir: string) {
    this.file = file;
    this.runDir = runDir;
    this.logger = createLogger(file.sessionId, runDir);
  }

  static async start(input: StartSessionInput): Promise<Session> {
    const sessionId = `${new Date().toISOString().replace(/[:.]/g, "-")}_${input.rq}_${input.method}_${randomUUID().slice(0, 8)}`;
    const runDir = join(input.runsRoot ?? "runs", sessionId);
    const config = input.config ?? {};
    const file: SessionFile = {
      sessionId,
      createdAt: new Date().toISOString(),
      rq: input.rq,
      method: input.method,
      config,
      configHash: createHash("sha256").update(JSON.stringify(config)).digest("hex").slice(0, 12),
      dataset: input.dataset ?? {},
      models: input.models ?? {},
      status: "running",
      trajectories: [],
    };

    await mkdir(runDir, { recursive: true });
    const session = new Session(file, runDir);
    await session.flush();
    await session.logger.info("session_start", { rq: input.rq, method: input.method });
    return session;
  }

  addTrajectory(trajectory: AgentTrajectory): void {
    this.file.trajectories.push(trajectory);
  }

  async flush(): Promise<void> {
    await writeFile(join(this.runDir, "session.json"), JSON.stringify(this.file, null, 2), "utf8");
  }

  async finish(status: "completed" | "failed" = "completed"): Promise<void> {
    this.file.status = status;
    this.file.finishedAt = new Date().toISOString();
    await this.logger.info("session_end", { status });
    await this.flush();
  }
}
