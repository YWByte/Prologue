import { mkdir, appendFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import type { LogEvent } from "@prologue/schemas";

export type LogLevel = LogEvent["level"];

export class Logger {
  constructor(
    private readonly sessionId: string,
    private readonly logPath: string,
  ) {}

  async write(event: Omit<LogEvent, "eventId" | "sessionId" | "timestamp">): Promise<void> {
    await mkdir(dirname(this.logPath), { recursive: true });
    const fullEvent: LogEvent = {
      eventId: randomUUID(),
      sessionId: this.sessionId,
      timestamp: new Date().toISOString(),
      ...event,
    };
    await appendFile(this.logPath, `${JSON.stringify(fullEvent)}\n`, "utf8");
  }

  debug(type: string, payload: unknown = {}) {
    return this.write({ level: "debug", type, payload });
  }

  info(type: string, payload: unknown = {}) {
    return this.write({ level: "info", type, payload });
  }

  warn(type: string, payload: unknown = {}) {
    return this.write({ level: "warn", type, payload });
  }

  error(type: string, payload: unknown = {}) {
    return this.write({ level: "error", type, payload });
  }
}

export function createLogger(sessionId: string, runDir: string): Logger {
  return new Logger(sessionId, join(runDir, "log.jsonl"));
}
