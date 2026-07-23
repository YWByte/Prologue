import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BfclV4MemoryAdapter,
  buildDatasetManifest,
  writeCanonicalTasks,
  writeDatasetManifest,
} from "../packages/data/dist/index.js";

const __filename = fileURLToPath(import.meta.url);
const WORKSPACE_ROOT = join(dirname(__filename), "..");
const RAW_ROOT = join(WORKSPACE_ROOT, "data/raw/bfcl_v4_memory");
const TASKS_PATH = join(WORKSPACE_ROOT, "data/canonical/bfcl_v4_memory.jsonl");
const MANIFEST_PATH = join(WORKSPACE_ROOT, "data/canonical/bfcl_v4_memory.manifest.json");

async function main(): Promise<void> {
  const adapter = new BfclV4MemoryAdapter();
  const taskCount = await writeCanonicalTasks(adapter.convert(RAW_ROOT), TASKS_PATH);
  await writeDatasetManifest(
    buildDatasetManifest({
      suiteVersion: adapter.version,
      schemaVersion: "0.1.0",
      sources: [adapter.source],
      taskCount,
      splits: { test: taskCount },
      adapterVersions: { [adapter.source]: adapter.version },
      metadata: {
        outPath: TASKS_PATH,
        rq1Protocol: "conversation_selection_memory_tool_2x2",
        excludedTasks: 155 - taskCount / 3,
      },
    }),
    MANIFEST_PATH,
  );
  console.log(`Built ${taskCount} BFCL V4 RQ1 tasks at ${TASKS_PATH}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
