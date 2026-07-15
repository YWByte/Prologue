import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { canonicalTaskSchema, datasetManifestSchema, type CanonicalTask, type DatasetManifest } from "@prologue/schemas";

export interface DatasetAdapter {
  readonly source: string;
  readonly version: string;
  convert(rawRoot: string): AsyncIterable<CanonicalTask> | Iterable<CanonicalTask>;
}

export async function writeCanonicalTasks(tasks: Iterable<CanonicalTask> | AsyncIterable<CanonicalTask>, outPath: string): Promise<number> {
  await mkdir(dirname(outPath), { recursive: true });
  let count = 0;
  let content = "";
  for await (const task of tasks) {
    const parsed = canonicalTaskSchema.parse(task);
    content += `${JSON.stringify(parsed)}\n`;
    count += 1;
  }
  await writeFile(outPath, content, "utf8");
  return count;
}

export async function readCanonicalTasks(path: string): Promise<CanonicalTask[]> {
  const raw = await readFile(path, "utf8");
  return raw
    .split("\n")
    .filter(Boolean)
    .map((line) => canonicalTaskSchema.parse(JSON.parse(line)));
}

export async function writeDatasetManifest(manifest: DatasetManifest, outPath: string): Promise<void> {
  await mkdir(dirname(outPath), { recursive: true });
  const parsed = datasetManifestSchema.parse(manifest);
  await writeFile(outPath, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
}

export function buildDatasetManifest(input: {
  suiteVersion: string;
  schemaVersion: string;
  sources: string[];
  taskCount: number;
  splits?: Record<string, number>;
  adapterVersions?: Record<string, string>;
  metadata?: Record<string, unknown>;
}): DatasetManifest {
  return datasetManifestSchema.parse({
    suiteVersion: input.suiteVersion,
    schemaVersion: input.schemaVersion,
    createdAt: new Date().toISOString(),
    sources: input.sources,
    taskCount: input.taskCount,
    splits: input.splits ?? {},
    adapterVersions: input.adapterVersions ?? {},
    metadata: input.metadata ?? {},
  });
}

export { AppWorldAdapter } from "./adapters/appworld.js";
