#!/usr/bin/env node

import { dirname, join } from "node:path";
import { mkdir } from "node:fs/promises";
import { AppWorldAdapter, buildDatasetManifest, writeCanonicalTasks, writeDatasetManifest } from "@prologue/data";
import { Session } from "@prologue/session";

type Args = Record<string, string | boolean>;

function parseArgs(argv: string[]): { command: string; args: Args } {
  const [command = "help", ...rest] = argv;
  const args: Args = {};
  for (let index = 0; index < rest.length; index += 1) {
    const item = rest[index];
    if (!item.startsWith("--")) continue;
    const key = item.slice(2);
    const next = rest[index + 1];
    if (!next || next.startsWith("--")) {
      args[key] = true;
    } else {
      args[key] = next;
      index += 1;
    }
  }
  return { command, args };
}

function requiredString(args: Args, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Missing required argument --${key}`);
  }
  return value;
}

function printHelp(): void {
  console.log([
    "Usage: prologue <command>",
    "",
    "Commands:",
    "  data:build --source appworld --raw <path> --out <path> [--manifest <path>]",
  ].join("\n"));
}

async function buildData(args: Args): Promise<void> {
  const source = requiredString(args, "source");
  const rawRoot = requiredString(args, "raw");
  const outPath = requiredString(args, "out");
  const manifestPath = typeof args.manifest === "string" ? args.manifest : join(dirname(outPath), "manifest.json");

  const adapter = source === "appworld" ? new AppWorldAdapter() : undefined;
  if (!adapter) throw new Error(`Unsupported source: ${source}`);

  await mkdir(dirname(outPath), { recursive: true });
  const workspaceRoot = process.env.INIT_CWD ?? process.cwd();
  const session = await Session.start({
    rq: "data",
    method: "data_build",
    config: { source, rawRoot, outPath, manifestPath },
    dataset: { source },
    runsRoot: join(workspaceRoot, "runs"),
  });

  try {
    await session.logger.info("adapter_start", { source, rawRoot });
    const count = await writeCanonicalTasks(adapter.convert(rawRoot), outPath);
    const manifest = buildDatasetManifest({
      suiteVersion: "0.1.0",
      schemaVersion: "0.1.0",
      sources: [source],
      taskCount: count,
      splits: { dev: count },
      adapterVersions: { [source]: adapter.version },
      metadata: { outPath },
    });
    await writeDatasetManifest(manifest, manifestPath);
    await session.logger.info("adapter_end", { source, count, outPath, manifestPath });
    await session.finish("completed");
  } catch (error) {
    await session.logger.error("adapter_failed", { message: error instanceof Error ? error.message : String(error) });
    await session.finish("failed");
    throw error;
  }
}

const { command, args } = parseArgs(process.argv.slice(2));

try {
  if (command === "help" || command === "--help" || command === "-h") {
    printHelp();
  } else if (command === "data:build") {
    await buildData(args);
  } else {
    throw new Error(`Unknown command: ${command}`);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
