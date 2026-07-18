import { spawn, type ChildProcess } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

export type AppWorldServerManagerConfig = {
  pythonPath: string;
  appworldRoot: string;
  port: number;
  scriptsDir: string;
  readyTimeoutMs: number;
  readyPollMs: number;
  shutdownTimeoutMs: number;
};

/**
 * Manages the lifecycle of a single `appworld serve apis` subprocess.
 *
 * One manager per (task, condition) run, per the per-condition lifecycle
 * decision. `start()` polls `GET /` for readiness; `stop()` SIGTERMs the
 * child and SIGKILLs after `shutdownTimeoutMs`.
 */
export class AppWorldServerManager {
  private child: ChildProcess | null = null;
  startDurationMs?: number;

  constructor(private readonly config: AppWorldServerManagerConfig) {}

  get baseUrl(): string {
    return `http://localhost:${this.config.port}`;
  }

  async start(): Promise<void> {
    const { pythonPath, appworldRoot, port, scriptsDir } = this.config;

    // Pre-start orphan check: if something already responds on the port,
    // refuse to start (don't auto-kill — that's a user decision).
    try {
      const res = await fetch(this.baseUrl, { signal: AbortSignal.timeout(250) });
      if (res.ok || res.status < 500) {
        throw new Error(
          `port ${port} already has a server (status ${res.status}). ` +
            `Kill it first: lsof -ti :${port} | xargs kill -9`,
        );
      }
    } catch (e) {
      if (e instanceof Error && /already has a server/.test(e.message)) {
        throw e;
      }
      // ECONNREFUSED / timeout = port is free, proceed.
    }

    const scriptPath = `${scriptsDir}/serve_apis.py`;
    this.child = spawn(
      pythonPath,
      [scriptPath, "--root", appworldRoot, "--port", String(port)],
      { stdio: ["ignore", "pipe", "pipe"] },
    );

    this.child.stdout?.on("data", () => {
      // Drain; could log in debug mode.
    });
    this.child.stderr?.on("data", () => {
      // Drain.
    });

    const t0 = Date.now();
    try {
      await this.waitForReady();
      this.startDurationMs = Date.now() - t0;
    } catch (err) {
      await this.stop();
      throw err;
    }
  }

  private async waitForReady(): Promise<void> {
    const { port, readyTimeoutMs, readyPollMs } = this.config;
    const deadline = Date.now() + readyTimeoutMs;
    while (Date.now() < deadline) {
      if (this.child?.exitCode !== null && this.child?.exitCode !== undefined) {
        throw new Error(
          `appworld server exited before ready (code=${this.child.exitCode})`,
        );
      }
      try {
        const res = await fetch(`http://localhost:${port}/`, {
          signal: AbortSignal.timeout(500),
        });
        if (res.ok) {
          await res.json();
          return;
        }
      } catch {
        // not ready yet
      }
      await sleep(readyPollMs);
    }
    throw new Error(
      `appworld server not ready after ${readyTimeoutMs}ms on port ${port}`,
    );
  }

  async stop(): Promise<void> {
    const child = this.child;
    if (!child || child.exitCode !== null) {
      this.child = null;
      return;
    }
    const exited = new Promise<void>((resolve) => {
      child.once("exit", () => resolve());
      setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          // ignore
        }
        resolve();
      }, this.config.shutdownTimeoutMs);
    });
    try {
      child.kill("SIGTERM");
    } catch {
      // ignore
    }
    await exited;
    this.child = null;
  }
}
