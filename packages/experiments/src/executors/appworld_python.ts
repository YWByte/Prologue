import { spawn } from "node:child_process";
import { join } from "node:path";

export type AppWorldEvalRequest = {
  task_id: string;
  experiment_name: string;
  root: string;
};

export type AppWorldInitRequest = {
  task_id: string;
  experiment_name: string;
  root: string;
  remote_apis_url: string;
  mode: "init" | "save";
};

export type AppWorldEvalResult = {
  success: boolean;
  difficulty: number;
  num_tests: number;
  passes: Array<{ requirement: string; label: string | null }>;
  failures: Array<{ requirement: string; trace: string; label: string | null }>;
};

export type AppWorldPythonRunnerConfig = {
  pythonPath: string;
  scriptsDir: string;
  timeoutMs: number;
};

/**
 * Run `python/appworld/eval_task.py` in a fresh subprocess and parse the
 * JSON object it prints to stdout. Returns a normalized result or an
 * error-tagged result on failure; never throws.
 */
export async function runAppWorldEval(
  request: AppWorldEvalRequest,
  config: AppWorldPythonRunnerConfig,
): Promise<{ ok: true; result: AppWorldEvalResult } | { ok: false; error: string; raw?: unknown }> {
  try {
    const stdout = await runPythonScript(
      config,
      "eval_task.py",
      JSON.stringify(request),
    );
    const parsed = JSON.parse(stdout) as Partial<AppWorldEvalResult> & { error?: string };
    if (parsed.error !== undefined) {
      return { ok: false, error: String(parsed.error) };
    }
    if (
      typeof parsed.success !== "boolean" ||
      typeof parsed.num_tests !== "number"
    ) {
      return { ok: false, error: `unexpected eval output: ${stdout}`, raw: parsed };
    }
    return {
      ok: true,
      result: {
        success: parsed.success,
        difficulty: parsed.difficulty ?? 0,
        num_tests: parsed.num_tests,
        passes: parsed.passes ?? [],
        failures: parsed.failures ?? [],
      },
    };
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

/**
 * Run `python/appworld/init_task.py` in a fresh subprocess with mode=init
 * or mode=save. Never throws; returns `{ ok, error? }`.
 */
export async function initAppWorldTask(
  request: AppWorldInitRequest,
  config: AppWorldPythonRunnerConfig,
): Promise<{ ok: true; output?: unknown } | { ok: false; error: string; raw?: unknown }> {
  try {
    const stdout = await runPythonScript(
      config,
      "init_task.py",
      JSON.stringify(request),
    );
    const parsed = JSON.parse(stdout) as { ok?: boolean; error?: string } & Record<string, unknown>;
    if (parsed.error !== undefined) {
      return { ok: false, error: String(parsed.error), raw: parsed };
    }
    return { ok: true, output: parsed };
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

function runPythonScript(
  config: AppWorldPythonRunnerConfig,
  scriptName: string,
  stdinPayload: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const scriptPath = join(config.scriptsDir, scriptName);
    const child = spawn(
      config.pythonPath,
      [scriptPath],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    let settled = false;

    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        child.kill("SIGKILL");
      } catch {
        // ignore
      }
      reject(new Error(`python ${scriptName} timed out after ${config.timeoutMs}ms`));
    }, config.timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(new Error(`failed to spawn python ${scriptName}: ${err.message}`));
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (code === 0) {
        resolve(stdout);
      } else {
        reject(
          new Error(
            `python ${scriptName} exited with code ${code}\nstdout: ${stdout}\nstderr: ${stderr}`,
          ),
        );
      }
    });

    child.stdin?.write(stdinPayload);
    child.stdin?.end();
  });
}
