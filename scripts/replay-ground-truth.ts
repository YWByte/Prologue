/**
 * Stage 2 validation: replay ground_truth api_calls.json against the executor.
 * For each task, load its api_calls.json, start the AppWorld REST server,
 * and execute each call in order. Verify that all calls succeed.
 *
 * This is a deterministic test (no LLM) that exposes executor bugs.
 */
import { loadEnvIntoProcess } from "../packages/common/dist/index.js";
import { readCanonicalTasks } from "../packages/data/dist/index.js";
import type { ToolItem } from "../packages/schemas/dist/index.js";
import { AppWorldServerManager } from "../packages/experiments/dist/executors/appworld_server.js";
import { AppWorldToolExecutor } from "../packages/experiments/dist/executors/appworld_http.js";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

type ApiCall = {
  method: string;
  url: string; // e.g. "/spotify/following_artists/14"
  data: Record<string, unknown>;
};

type ToolIndex = {
  // key: "METHOD /path/template" -> tool
  byTemplate: Map<string, ToolItem>;
  // list of (method, regex) for matching concrete URLs to templates
  matchers: Array<{ method: string; regex: RegExp; tool: ToolItem }>;
};

function buildToolIndex(tools: ToolItem[]): ToolIndex {
  const byTemplate = new Map<string, ToolItem>();
  const matchers: Array<{ method: string; regex: RegExp; tool: ToolItem }> = [];
  for (const tool of tools) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const meta = tool.metadata as any;
    if (!meta?.method || !meta?.path) continue;
    const method = meta.method.toLowerCase();
    const template = meta.path as string;
    byTemplate.set(`${method} ${template}`, tool);
    const regex = template
      .replace(/[.+*?^$()|[\]\\]/g, "\\$&")
      .replace(/\{[^}]+\}/g, "[^/]+");
    matchers.push({ method, regex: new RegExp(`^${regex}$`), tool });
  }
  return { byTemplate, matchers };
}

function matchCallToTool(call: ApiCall, index: ToolIndex): ToolItem | undefined {
  const method = call.method.toLowerCase();
  // Direct template match
  if (index.byTemplate.has(`${method} ${call.url}`)) {
    return index.byTemplate.get(`${method} ${call.url}`);
  }
  // Regex match against path templates
  for (const m of index.matchers) {
    if (m.method === method && m.regex.test(call.url)) {
      return m.tool;
    }
  }
  return undefined;
}

/**
 * Given a concrete call URL like "/spotify/following_artists/14" and the
 * matched template "/spotify/following_artists/{artist_id}", extract path
 * param values and merge them into args.
 */
function extractPathArgs(concreteUrl: string, tool: ToolItem): Record<string, string> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const meta = tool.metadata as any;
  const template = meta.path as string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const schema = (tool.schema ?? {}) as any;
  const pathParams = (schema.parameters ?? []).filter((p: any) => p.in === "path");
  const result: Record<string, string> = {};
  const templateParts = template.split("/");
  const concreteParts = concreteUrl.split("/");
  for (let i = 0; i < templateParts.length; i++) {
    const tp = templateParts[i];
    const cp = concreteParts[i] ?? "";
    if (tp.startsWith("{") && tp.endsWith("}")) {
      const name = tp.slice(1, -1);
      if (pathParams.some((p: any) => p.name === name)) {
        result[name] = decodeURIComponent(cp);
      }
    }
  }
  return result;
}

async function replayTask(opts: {
  taskId: string;
  apiCalls: ApiCall[];
  tools: ToolItem[];
  executor: AppWorldToolExecutor;
}): Promise<{ total: number; ok: number; failures: Array<{ call: ApiCall; error: string }> }> {
  const { taskId, apiCalls, tools, executor } = opts;
  const index = buildToolIndex(tools);
  let ok = 0;
  const failures: Array<{ call: ApiCall; error: string }> = [];

  for (const call of apiCalls) {
    const tool = matchCallToTool(call, index);
    if (!tool) {
      failures.push({ call, error: `No tool matched ${call.method} ${call.url}` });
      continue;
    }
    const pathArgs = extractPathArgs(call.url, tool);
    // Merge: path args from URL + body/query from data
    const args = { ...pathArgs, ...call.data };

    const result = await executor.call(tool, args);
    if (result.ok) {
      ok += 1;
      // Capture access_token from login calls
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const out = result.output as any;
      if (out?.access_token && typeof out.access_token === "string") {
        const app = typeof tool.metadata?.app === "string" ? tool.metadata.app : undefined;
        if (app) executor.setAccessToken(app, out.access_token);
        else executor.setAccessToken(out.access_token);
      }
    } else {
      failures.push({
        call,
        error: `status=${result.status} error=${result.error} output=${JSON.stringify(result.output).slice(0, 200)}`,
      });
    }
  }

  return { total: apiCalls.length, ok, failures };
}

async function main(): Promise<void> {
  loadEnvIntoProcess();
  const workspaceRoot = process.cwd();
  const tasks = await readCanonicalTasks("data/canonical/appworld-sample_5.jsonl");
  const appworldRoot = "data/raw/appworld";
  const sampleRoot = join(appworldRoot, "sample_5");

  let totalOk = 0;
  let totalCalls = 0;
  const taskResults: Array<{ taskId: string; total: number; ok: number; failures: typeof failures }> = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const failures: any[] = [];

  for (const task of tasks) {
    const taskRoot = join(sampleRoot, "tasks", task.taskId);
    const apiCallsPath = join(taskRoot, "ground_truth", "api_calls.json");
    let apiCalls: ApiCall[];
    try {
      apiCalls = JSON.parse(await readFile(apiCallsPath, "utf-8")) as ApiCall[];
    } catch (e) {
      console.error(`[${task.taskId}] SKIP: cannot read api_calls.json: ${e instanceof Error ? e.message : e}`);
      continue;
    }

    console.log(`\n[${task.taskId}] replaying ${apiCalls.length} ground truth calls...`);

    // Start a server for this task
    const port = 9300 + tasks.indexOf(task);
    const server = new AppWorldServerManager({
      pythonPath: process.env.PROLOGUE_APPWORLD_PYTHON ?? ".venv-appworld/bin/python",
      appworldRoot,
      port,
      scriptsDir: join(workspaceRoot, "python", "appworld"),
      readyTimeoutMs: 30_000,
      readyPollMs: 500,
      shutdownTimeoutMs: 10_000,
    });

    try {
      await server.start();
      const executor = new AppWorldToolExecutor({ baseUrl: server.baseUrl });

      // Init task DB (needed before API calls work)
      const { initAppWorldTask } = await import("../packages/experiments/dist/executors/appworld_python.js");
      const initResult = await initAppWorldTask(
        {
          task_id: task.taskId,
          experiment_name: `replay_${task.taskId}`,
          root: appworldRoot,
          remote_apis_url: server.baseUrl,
          mode: "init",
        },
        {
          pythonPath: process.env.PROLOGUE_APPWORLD_PYTHON ?? ".venv-appworld/bin/python",
          scriptsDir: join(workspaceRoot, "python", "appworld"),
          timeoutMs: 60_000,
        },
      );
      if (!initResult.ok) {
        console.error(`  init failed: ${initResult.error}`);
        continue;
      }

      const result = await replayTask({ taskId: task.taskId, apiCalls, tools: task.toolPool, executor });
      totalOk += result.ok;
      totalCalls += result.total;
      taskResults.push({ taskId: task.taskId, ...result });
      for (const f of result.failures) {
        failures.push({ taskId: task.taskId, ...f });
      }
      console.log(`  → ${result.ok}/${result.total} succeeded`);
      for (const f of result.failures) {
        console.log(`    FAIL: ${f.call.method} ${f.call.url} -> ${f.error}`);
      }
    } catch (e) {
      console.error(`  ERROR: ${e instanceof Error ? e.message : e}`);
    } finally {
      await server.stop().catch(() => {});
    }
  }

  console.log("\n" + "=".repeat(80));
  console.log(`TOTAL: ${totalOk}/${totalCalls} calls succeeded (${((totalOk / totalCalls) * 100).toFixed(1)}%)`);
  if (failures.length > 0) {
    console.log(`\n${failures.length} failures:`);
    for (const f of failures) {
      console.log(`  [${f.taskId}] ${f.call.method} ${f.call.url}`);
      console.log(`    -> ${f.error}`);
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
