/**
 * Stage 2 validation for A-batch: replay ground_truth for selected tasks
 * that exercise multi-path / path+body / various apps not covered by sample_5.
 * Run with: pnpm exec tsx scripts/replay-batch-a-sample.ts
 */
import { loadEnvIntoProcess } from "../packages/common/dist/index.js";
import { AppWorldServerManager } from "../packages/experiments/dist/executors/appworld_server.js";
import { AppWorldToolExecutor } from "../packages/experiments/dist/executors/appworld_http.js";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

type ApiCall = { method: string; url: string; data: Record<string, unknown> };

type ToolIndex = {
  byTemplate: Map<string, any>;
  matchers: Array<{ method: string; regex: RegExp; tool: any }>;
};

function buildToolIndex(tools: any[]): ToolIndex {
  const byTemplate = new Map<string, any>();
  const matchers: Array<{ method: string; regex: RegExp; tool: any }> = [];
  for (const tool of tools) {
    const meta = tool.metadata as any;
    if (!meta?.method || !meta?.path) continue;
    const method = meta.method.toLowerCase();
    byTemplate.set(`${method} ${meta.path}`, tool);
    const regex = meta.path.replace(/[.+*?^$()|[\]\\]/g, "\\$&").replace(/\{[^}]+\}/g, "[^/]+");
    matchers.push({ method, regex: new RegExp(`^${regex}$`), tool });
  }
  return { byTemplate, matchers };
}

function matchCallToTool(call: ApiCall, index: ToolIndex): any | undefined {
  const method = call.method.toLowerCase();
  if (index.byTemplate.has(`${method} ${call.url}`)) return index.byTemplate.get(`${method} ${call.url}`);
  for (const m of index.matchers) {
    if (m.method === method && m.regex.test(call.url)) return m.tool;
  }
  return undefined;
}

function extractPathArgs(concreteUrl: string, tool: any): Record<string, string> {
  const meta = tool.metadata as any;
  const template = meta.path as string;
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
  tools: any[];
  executor: AppWorldToolExecutor;
}): Promise<{ total: number; ok: number; failures: any[] }> {
  const { taskId, apiCalls, tools, executor } = opts;
  const index = buildToolIndex(tools);
  let ok = 0;
  const failures: any[] = [];
  for (const call of apiCalls) {
    const tool = matchCallToTool(call, index);
    if (!tool) {
      failures.push({ call, error: `No tool matched ${call.method} ${call.url}` });
      continue;
    }
    const pathArgs = extractPathArgs(call.url, tool);
    const args = { ...pathArgs, ...call.data };
    const result = await executor.call(tool, args);
    if (result.ok) {
      ok += 1;
      const out = result.output as any;
      if (out?.access_token && typeof out.access_token === "string") {
        const app = typeof tool.metadata?.app === "string" ? tool.metadata.app : undefined;
        if (app) executor.setAccessToken(app, out.access_token);
      }
    } else {
      failures.push({ call, error: `status=${result.status} error=${result.error} out=${JSON.stringify(result.output).slice(0, 200)}` });
    }
  }
  return { total: apiCalls.length, ok, failures };
}

async function loadToolsForTask(taskId: string, appworldRoot: string): Promise<any[]> {
  const { AppWorldAdapter } = await import("../packages/data/dist/index.js");
  const adapter = new AppWorldAdapter();
  const tasks = [];
  for await (const t of adapter.convert(join(appworldRoot, "batch_a"))) {
    if (t.taskId === taskId) tasks.push(t);
  }
  return tasks[0]?.toolPool ?? [];
}

async function main(): Promise<void> {
  loadEnvIntoProcess();
  const workspaceRoot = process.cwd();
  const appworldRoot = "data/raw/appworld";
  const sampleRoot = join(appworldRoot, "data");
  const targets = JSON.parse(await readFile("/tmp/replay-targets.json", "utf8")) as string[];

  let totalOk = 0;
  let totalCalls = 0;
  const allFailures: any[] = [];

  for (const taskId of targets) {
    const taskRoot = join(sampleRoot, "tasks", taskId);
    const apiCallsPath = join(taskRoot, "ground_truth", "api_calls.json");
    let apiCalls: ApiCall[];
    try {
      apiCalls = JSON.parse(await readFile(apiCallsPath, "utf8"));
    } catch (e) {
      console.error(`[${taskId}] SKIP: ${e instanceof Error ? e.message : e}`);
      continue;
    }
    console.log(`\n[${taskId}] replaying ${apiCalls.length} ground truth calls...`);
    const port = 9400 + targets.indexOf(taskId);
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
      const { initAppWorldTask } = await import("../packages/experiments/dist/executors/appworld_python.js");
      const initResult = await initAppWorldTask(
        { task_id: taskId, experiment_name: `replay_a_${taskId}`, root: appworldRoot, remote_apis_url: server.baseUrl, mode: "init" },
        { pythonPath: process.env.PROLOGUE_APPWORLD_PYTHON ?? ".venv-appworld/bin/python", scriptsDir: join(workspaceRoot, "python", "appworld"), timeoutMs: 60_000 },
      );
      if (!initResult.ok) {
        console.error(`  init failed: ${initResult.error}`);
        continue;
      }
      const tools = await loadToolsForTask(taskId, appworldRoot);
      const result = await replayTask({ taskId, apiCalls, tools, executor });
      totalOk += result.ok;
      totalCalls += result.total;
      console.log(`  → ${result.ok}/${result.total} succeeded`);
      for (const f of result.failures) {
        allFailures.push({ taskId, ...f });
        console.log(`    FAIL: ${f.call.method} ${f.call.url} -> ${f.error}`);
      }
    } catch (e) {
      console.error(`  ERROR: ${e instanceof Error ? e.message : e}`);
    } finally {
      await server.stop().catch(() => {});
    }
  }
  console.log("\n" + "=".repeat(80));
  console.log(`TOTAL: ${totalOk}/${totalCalls} calls succeeded (${totalCalls > 0 ? ((totalOk / totalCalls) * 100).toFixed(1) : 0}%)`);
  if (allFailures.length > 0) {
    console.log(`\n${allFailures.length} failures:`);
    for (const f of allFailures) console.log(`  [${f.taskId}] ${f.call.method} ${f.call.url} -> ${f.error}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
