import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export function loadEnvFile(envPath?: string): Record<string, string> {
  const paths = envPath
    ? [envPath]
    : [
        join(process.cwd(), ".env"),
        join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", ".env"),
        join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", ".env"),
      ];

  const result: Record<string, string> = {};
  for (const p of paths) {
    try {
      const content = readFileSync(p, "utf8");
      for (const line of content.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const eqIndex = trimmed.indexOf("=");
        if (eqIndex === -1) continue;
        const key = trimmed.slice(0, eqIndex).trim();
        let value = trimmed.slice(eqIndex + 1).trim();
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
          value = value.slice(1, -1);
        }
        result[key] = value;
      }
      return result;
    } catch {
      // try next path
    }
  }
  return result;
}

export function loadEnvIntoProcess(envPath?: string): Record<string, string> {
  const env = loadEnvFile(envPath);
  for (const [key, value] of Object.entries(env)) {
    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
  return env;
}
