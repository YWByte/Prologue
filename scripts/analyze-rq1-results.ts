/**
 * Analyze RQ1 oracle attribution results from a merged session.
 * Outputs final.json to the session directory.
 *
 * Usage:
 *   pnpm exec tsx scripts/analyze-rq1-results.ts [session-dir]
 *
 * Defaults to the merged a_train session.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";

interface TrajectoryStep {
  type: string;
  input?: Record<string, unknown>;
  output?: Record<string, unknown>;
}

interface Trajectory {
  taskId: string;
  input: {
    oracleCondition: string;
    query: string;
    toolIds: string[];
    memoryIds: string[];
  };
  prologue: {
    usesOracleIntent: boolean;
    usesOracleMemory: boolean;
    usesOracleTool: boolean;
  };
  steps: TrajectoryStep[];
  result: {
    success: boolean;
    score: number;
    error?: string;
    reason?: string;
  };
  metadata?: Record<string, unknown>;
}

interface SessionData {
  sessionId: string;
  trajectories: Trajectory[];
}

const RQ1_CONDITIONS = [
  "baseline",
  "oracle_intent",
  "oracle_memory",
  "oracle_tool",
  "oracle_intent_memory",
  "oracle_intent_tool",
  "oracle_memory_tool",
  "oracle_all",
] as const;

function loadSession(dir: string): SessionData {
  const path = resolve(dir, "session.json");
  const raw = readFileSync(path, "utf-8");
  return JSON.parse(raw) as SessionData;
}

function isValid(t: Trajectory): boolean {
  const err = t.result?.error ?? t.result?.reason ?? "";
  return !err.startsWith("executor_error") && !err.startsWith("provider_error");
}

interface CondStats {
  n: number;
  mean: number;
  median: number;
  min: number;
  max: number;
  success: number;
  scores: number[];
}

function computeStats(scores: number[], successCount: number): CondStats {
  const sorted = [...scores].sort((a, b) => a - b);
  const n = sorted.length;
  const sum = sorted.reduce((s, v) => s + v, 0);
  return {
    n,
    mean: n > 0 ? sum / n : 0,
    median: n > 0 ? sorted[Math.floor(n / 2)] : 0,
    min: n > 0 ? sorted[0] : 0,
    max: n > 0 ? sorted[n - 1] : 0,
    success: successCount,
    scores: sorted,
  };
}

function fmt(n: number, decimals = 3): string {
  return n.toFixed(decimals);
}

function main(): void {
  const sessionDir = process.argv[2] ?? "runs/2026-07-22T15-00-00-000Z_rq1_oracle_attribution_llm_a_train_merged";
  const session = loadSession(sessionDir);

  const trajs = session.trajectories;
  const valid = trajs.filter(isValid);
  const errored = trajs.length - valid.length;

  console.log("=".repeat(80));
  console.log("=== RQ1 Oracle Attribution Analysis ===");
  console.log("=".repeat(80));
  console.log(`session: ${session.sessionId}`);
  console.log(`total trajectories: ${trajs.length}`);
  console.log(`valid: ${valid.length}, errored: ${errored}`);

  // Group by condition
  const byCondition = new Map<string, { scores: number[]; success: number }>();
  for (const t of valid) {
    const cond = t.input.oracleCondition;
    if (!byCondition.has(cond)) {
      byCondition.set(cond, { scores: [], success: 0 });
    }
    const entry = byCondition.get(cond)!;
    entry.scores.push(t.result.score);
    if (t.result.success) entry.success += 1;
  }

  // Print by condition
  console.log("\n=== By Condition ===");
  console.log(`${"condition".padEnd(22)} ${"n".padStart(4)} ${"mean".padStart(7)} ${"median".padStart(7)} ${"min".padStart(6)} ${"max".padStart(6)} ${"succ".padStart(5)}`);

  const statsByCond = new Map<string, CondStats>();
  for (const cond of RQ1_CONDITIONS) {
    const entry = byCondition.get(cond);
    if (!entry || entry.scores.length === 0) {
      console.log(`${cond.padEnd(22)} ${"0".padStart(4)} ${"-".padStart(7)} ${"-".padStart(7)} ${"-".padStart(6)} ${"-".padStart(6)} ${"0".padStart(5)}`);
      continue;
    }
    const stats = computeStats(entry.scores, entry.success);
    statsByCond.set(cond, stats);
    console.log(
      `${cond.padEnd(22)} ${String(stats.n).padStart(4)} ${fmt(stats.mean).padStart(7)} ${fmt(stats.median).padStart(7)} ${fmt(stats.min).padStart(6)} ${fmt(stats.max).padStart(6)} ${String(stats.success).padStart(5)}`,
    );
  }

  // Delta vs baseline
  const baseline = statsByCond.get("baseline");
  if (baseline) {
    console.log("\n=== Delta vs Baseline ===");
    console.log(`${"condition".padEnd(22)} ${"mean".padStart(7)} ${"delta".padStart(7)} ${"rel%".padStart(7)}`);
    for (const cond of RQ1_CONDITIONS) {
      if (cond === "baseline") continue;
      const s = statsByCond.get(cond);
      if (!s) continue;
      const delta = s.mean - baseline.mean;
      const rel = baseline.mean > 0 ? (delta / baseline.mean) * 100 : 0;
      const marker = delta > 0.01 ? " +" : delta < -0.01 ? " -" : "  ";
      console.log(`${cond.padEnd(22)} ${fmt(s.mean).padStart(7)} ${marker}${fmt(Math.abs(delta)).padStart(6)} ${fmt(rel, 1).padStart(6)}%`);
    }
  }

  // Oracle component effects
  console.log("\n=== Oracle Component Effects ===");
  const intent = statsByCond.get("oracle_intent");
  const memory = statsByCond.get("oracle_memory");
  const tool = statsByCond.get("oracle_tool");
  const all = statsByCond.get("oracle_all");

  if (baseline && intent) {
    console.log(`  Intent alone:  ${fmt(intent.mean - baseline.mean, 3)} (${intent.mean > baseline.mean ? "positive" : "negative"})`);
  }
  if (baseline && memory) {
    console.log(`  Memory alone:  ${fmt(memory.mean - baseline.mean, 3)} (${memory.mean > baseline.mean ? "positive" : "negative"})`);
  }
  if (baseline && tool) {
    console.log(`  Tool alone:    ${fmt(tool.mean - baseline.mean, 3)} (${tool.mean > baseline.mean ? "positive" : "negative"})`);
  }
  if (baseline && all) {
    console.log(`  All combined:  ${fmt(all.mean - baseline.mean, 3)} (${all.mean > baseline.mean ? "positive" : "negative"})`);
  }

  // Interaction effects
  console.log("\n=== Interaction Effects (2-way) ===");
  const interactions: Array<[string, string, string, string]> = [
    ["oracle_intent_memory", "oracle_intent", "oracle_memory", "Intent x Memory"],
    ["oracle_intent_tool", "oracle_intent", "oracle_tool", "Intent x Tool"],
    ["oracle_memory_tool", "oracle_memory", "oracle_tool", "Memory x Tool"],
  ];
  console.log(`${"interaction".padEnd(20)} ${"combined".padStart(8)} ${"expected".padStart(8)} ${"synergy".padStart(8)} ${"verdict".padStart(10)}`);
  for (const [combined, a, b, label] of interactions) {
    const cs = statsByCond.get(combined);
    const as = statsByCond.get(a);
    const bs = statsByCond.get(b);
    if (!cs || !as || !bs || !baseline) continue;
    // Expected = baseline + (a - baseline) + (b - baseline)
    const expected = baseline.mean + (as.mean - baseline.mean) + (bs.mean - baseline.mean);
    const synergy = cs.mean - expected;
    const verdict = synergy > 0.01 ? "synergy" : synergy < -0.01 ? "antagonism" : "additive";
    console.log(
      `${label.padEnd(20)} ${fmt(cs.mean).padStart(8)} ${fmt(expected).padStart(8)} ${fmt(synergy).padStart(8)} ${verdict.padStart(10)}`,
    );
  }

  // Per-task analysis: how many tasks improved/degraded
  console.log("\n=== Per-Task Delta Distribution (vs baseline) ===");
  const taskBaselines = new Map<string, number>();
  for (const t of valid) {
    if (t.input.oracleCondition === "baseline") {
      taskBaselines.set(t.taskId, t.result.score);
    }
  }

  console.log(`${"condition".padEnd(22)} ${"better".padStart(6)} ${"same".padStart(6)} ${"worse".padStart(6)} ${"avg_delta".padStart(10)}`);
  for (const cond of RQ1_CONDITIONS) {
    if (cond === "baseline") continue;
    let better = 0;
    let same = 0;
    let worse = 0;
    let totalDelta = 0;
    let count = 0;
    for (const t of valid) {
      if (t.input.oracleCondition !== cond) continue;
      const baseScore = taskBaselines.get(t.taskId);
      if (baseScore === undefined) continue;
      const delta = t.result.score - baseScore;
      if (delta > 0.01) better++;
      else if (delta < -0.01) worse++;
      else same++;
      totalDelta += delta;
      count++;
    }
    if (count === 0) continue;
    console.log(
      `${cond.padEnd(22)} ${String(better).padStart(6)} ${String(same).padStart(6)} ${String(worse).padStart(6)} ${fmt(totalDelta / count, 3).padStart(10)}`,
    );
  }

  // Step count analysis
  console.log("\n=== Step Count (efficiency) ===");
  const stepStats = new Map<string, number[]>();
  for (const t of valid) {
    const cond = t.input.oracleCondition;
    if (!stepStats.has(cond)) stepStats.set(cond, []);
    stepStats.get(cond)!.push(t.steps.length);
  }
  console.log(`${"condition".padEnd(22)} ${"avg_steps".padStart(9)} ${"min".padStart(5)} ${"max".padStart(5)}`);
  for (const cond of RQ1_CONDITIONS) {
    const steps = stepStats.get(cond);
    if (!steps || steps.length === 0) continue;
    const avg = steps.reduce((s, v) => s + v, 0) / steps.length;
    const min = Math.min(...steps);
    const max = Math.max(...steps);
    console.log(`${cond.padEnd(22)} ${fmt(avg, 1).padStart(9)} ${String(min).padStart(5)} ${String(max).padStart(5)}`);
  }

  console.log("\n" + "=".repeat(80));

  // === Write final.json ===
  const finalReport = {
    session: session.sessionId,
    totalTrajectories: trajs.length,
    validTrajectories: valid.length,
    erroredTrajectories: errored,
    conditions: RQ1_CONDITIONS.map((cond) => {
      const s = statsByCond.get(cond);
      const entry = byCondition.get(cond);
      if (!s || !entry) return null;
      return {
        condition: cond,
        n: s.n,
        mean: Math.round(s.mean * 1000) / 1000,
        median: s.median,
        min: s.min,
        max: s.max,
        success: s.success,
        scores: s.scores,
      };
    }).filter((x): x is NonNullable<typeof x> => x !== null),
    deltaVsBaseline: RQ1_CONDITIONS.filter((c) => c !== "baseline").map((cond) => {
      const s = statsByCond.get(cond);
      if (!s || !baseline) return null;
      return {
        condition: cond,
        mean: Math.round(s.mean * 1000) / 1000,
        delta: Math.round((s.mean - baseline.mean) * 1000) / 1000,
        relativePercent: baseline.mean > 0 ? Math.round(((s.mean - baseline.mean) / baseline.mean) * 1000) / 10 : 0,
      };
    }).filter((x): x is NonNullable<typeof x> => x !== null),
    componentEffects: {
      intent: intent ? Math.round((intent.mean - baseline!.mean) * 1000) / 1000 : null,
      memory: memory ? Math.round((memory.mean - baseline!.mean) * 1000) / 1000 : null,
      tool: tool ? Math.round((tool.mean - baseline!.mean) * 1000) / 1000 : null,
      all: all ? Math.round((all.mean - baseline!.mean) * 1000) / 1000 : null,
    },
    stepCount: RQ1_CONDITIONS.map((cond) => {
      const steps = stepStats.get(cond);
      if (!steps || steps.length === 0) return null;
      return {
        condition: cond,
        avg: Math.round((steps.reduce((s, v) => s + v, 0) / steps.length) * 10) / 10,
        min: Math.min(...steps),
        max: Math.max(...steps),
      };
    }).filter((x): x is NonNullable<typeof x> => x !== null),
  };

  const finalPath = join(sessionDir, "final.json");
  writeFileSync(finalPath, JSON.stringify(finalReport, null, 2), "utf-8");
  console.log(`\n✅ final.json written to: ${finalPath}`);
}

main();
