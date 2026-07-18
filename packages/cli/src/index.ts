#!/usr/bin/env node

import { dirname, join, isAbsolute } from "node:path";
import { mkdir, stat } from "node:fs/promises";
import { AppWorldAdapter, buildDatasetManifest, readCanonicalTasks, writeCanonicalTasks, writeDatasetManifest } from "@prologue/data";
import { AppWorldExecutor, makeAppWorldExecutorConfig, runRq1Mock, runRq1Real } from "@prologue/experiments";
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
    "  rq1:mock --tasks <canonical-task-jsonl>",
    "  rq1:run  --tasks <canonical-task-jsonl> [--appworld-root <path>] [--python <path>] [--base-port <n>]",
    "           [--experiment-name-prefix <str>]",
  ].join("\n"));
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function dirExists(path: string): Promise<boolean> {
  try {
    const s = await stat(path);
    return s.isDirectory();
  } catch {
    return false;
  }
}

/**
 * Resolve a path that the user passed on the CLI. Relative paths are
 * resolved against the workspace root (INIT_CWD) so that `pnpm cli` works
 * regardless of which package the script runs from.
 */
function resolveWorkspacePath(path: string): string {
  if (isAbsolute(path)) return path;
  const workspaceRoot = process.env.INIT_CWD ?? process.cwd();
  return join(workspaceRoot, path);
}

async function runRq1MockCommand(args: Args): Promise<void> {
  const tasksPath = resolveWorkspacePath(requiredString(args, "tasks"));
  const tasks = await readCanonicalTasks(tasksPath);
  const workspaceRoot = process.env.INIT_CWD ?? process.cwd();
  const session = await Session.start({
    rq: "rq1",
    method: "oracle_attribution_mock",
    config: {
      tasksPath,
      conditions: "all",
      mockSuccessPolicy: "requires_oracle_memory_and_tool",
    },
    dataset: {
      taskCount: tasks.length,
      sources: Array.from(new Set(tasks.map((task) => task.source))),
    },
    models: { executor: "mock" },
    runsRoot: join(workspaceRoot, "runs"),
  });

  try {
    const summary = await runRq1Mock(tasks, session);
    await session.logger.write({
      level: "info",
      type: "rq1_mock_summary",
      rq: "rq1",
      method: "oracle_attribution_mock",
      payload: summary,
    });
    await session.finish("completed");
  } catch (error) {
    await session.logger.write({
      level: "error",
      type: "rq1_mock_failed",
      rq: "rq1",
      method: "oracle_attribution_mock",
      payload: { message: error instanceof Error ? error.message : String(error) },
    });
    await session.finish("failed");
    throw error;
  }
}

async function runRq1RunCommand(args: Args): Promise<void> {
  const tasksPath = resolveWorkspacePath(requiredString(args, "tasks"));
  const appworldRoot =
    (typeof args.appworldRoot === "string" ? args.appworldRoot : undefined) ??
    process.env.PROLOGUE_APPWORLD_ROOT ??
    "/Users/wondery/paper/Prologue/data/raw/appworld";
  const pythonPath =
    (typeof args.python === "string" ? args.python : undefined) ??
    process.env.PROLOGUE_APPWORLD_PYTHON ??
    "/Users/wondery/paper/Prologue/.venv-appworld/bin/python";
  const basePort = Number(args.basePort ?? 9000);
  const experimentNamePrefix =
    (typeof args.experimentNamePrefix === "string" ? args.experimentNamePrefix : undefined) ??
    "prologue_rq1";

  const workspaceRoot = process.env.INIT_CWD ?? process.cwd();
  const pythonScriptsDir = join(workspaceRoot, "python", "appworld");

  if (!(await fileExists(pythonPath))) {
    throw new Error(
      `AppWorld python not found at ${pythonPath}. Set --python or PROLOGUE_APPWORLD_PYTHON.`,
    );
  }
  if (!(await dirExists(join(appworldRoot, "data", "base_dbs")))) {
    throw new Error(
      `AppWorld base_dbs not found at ${join(appworldRoot, "data", "base_dbs")}. Set --appworld-root.`,
    );
  }
  if (!(await fileExists(join(pythonScriptsDir, "serve_apis.py")))) {
    throw new Error(`AppWorld python scripts not found at ${pythonScriptsDir}/serve_apis.py.`);
  }

  const tasks = await readCanonicalTasks(tasksPath);

  const session = await Session.start({
    rq: "rq1",
    method: "oracle_attribution_real",
    config: { tasksPath, appworldRoot, pythonPath, basePort, experimentNamePrefix, pythonScriptsDir },
    dataset: {
      taskCount: tasks.length,
      sources: Array.from(new Set(tasks.map((task) => task.source))),
    },
    models: { executor: "appworld_stub", agent: "stub_fixed_sequence" },
    runsRoot: join(workspaceRoot, "runs"),
  });

  const executor = new AppWorldExecutor(
    makeAppWorldExecutorConfig({
      appworldRoot,
      pythonPath,
      pythonScriptsDir,
      basePort,
      experimentNamePrefix,
    }),
  );

  try {
    const summary = await runRq1Real(tasks, session, executor);
    await session.logger.write({
      level: "info",
      type: "rq1_real_summary",
      rq: "rq1",
      method: "oracle_attribution_real",
      payload: summary,
    });
    await session.finish("completed");
  } catch (error) {
    await session.logger.write({
      level: "error",
      type: "rq1_real_failed",
      rq: "rq1",
      method: "oracle_attribution_real",
      payload: { message: error instanceof Error ? error.message : String(error) },
    });
    await session.finish("failed");
    throw error;
  }
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
  } else if (command === "rq1:mock") {
    await runRq1MockCommand(args);
  } else if (command === "rq1:run") {
    await runRq1RunCommand(args);
  } else {
    throw new Error(`Unknown command: ${command}`);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
