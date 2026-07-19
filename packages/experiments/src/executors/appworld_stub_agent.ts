import { randomUUID } from "node:crypto";
import type { ExecutorInput, ToolExecutor } from "@prologue/prologue";
import type { MemoryItem, ToolItem, TrajectoryStep } from "@prologue/schemas";
import { AppWorldToolExecutor } from "./appworld_http.js";

/**
 * Stub agent for AppWorld Spotify top-k genre tasks.
 *
 * Derives the answer from oracle memory (`spotify_user_library_summary`)
 * when `input.usesOracleMemory === true`; otherwise submits an empty answer.
 * Then runs a fixed 7-call API sequence against the AppWorld REST server
 * for trajectory fidelity. No real LLM is invoked.
 *
 * The fixed sequence models the minimum steps a competent agent would take
 * on this task family. Tool steps are recorded even when a tool is missing
 * from the pool, so RQ1 attribution reflects "what the agent could do given
 * the selected context".
 */

type GenreTopSong = {
  title: string;
  genre?: string;
  play_count?: number;
};

type SpotifyLibrarySummary = {
  user?: { email?: string };
  counts?: Record<string, number>;
  songLibrary?: { genreTopSongs?: GenreTopSong[] };
  albumLibrary?: { genreTopSongs?: GenreTopSong[] };
  playlistLibrary?: { genreTopSongs?: GenreTopSong[] };
};

type StubStepResult = {
  steps: TrajectoryStep[];
  derivedAnswer: string;
  hasOracleMemory: boolean;
};

/**
 * Derive the top-k genre song titles by combining genreTopSongs across the
 * three libraries, deduping by title, and sorting by play_count desc.
 *
 * Returns "" when oracle memory is not selected (per RQ1 attribution
 * semantics: the agent only "knows" the answer when oracle memory is in
 * the selected context).
 */
function deriveAnswer(input: ExecutorInput): {
  answer: string;
  hasOracleMemory: boolean;
} {
  const hasOracleMemory = input.usesOracleMemory === true;
  if (!hasOracleMemory) {
    return { answer: "", hasOracleMemory: false };
  }

  const summaryItem = input.memory.find(
    (m) =>
      m.id.endsWith(":memory:spotify_user_library_summary") &&
      m.metadata?.oracle === true,
  );
  if (!summaryItem) {
    return { answer: "", hasOracleMemory: true };
  }

  let data: SpotifyLibrarySummary;
  try {
    data = JSON.parse(summaryItem.content) as SpotifyLibrarySummary;
  } catch {
    return { answer: "", hasOracleMemory: true };
  }

  const publicItem = input.memory.find((m) =>
    m.id.endsWith(":memory:public_data"),
  );
  let topK = 10;
  if (publicItem) {
    try {
      const parsed = JSON.parse(publicItem.content) as { top_k?: number };
      if (typeof parsed.top_k === "number" && parsed.top_k > 0) {
        topK = Math.min(Math.max(parsed.top_k, 1), 50);
      }
    } catch {
      // ignore malformed public_data, fall back to default topK
    }
  }

  const combined: GenreTopSong[] = [
    ...(data.songLibrary?.genreTopSongs ?? []),
    ...(data.albumLibrary?.genreTopSongs ?? []),
    ...(data.playlistLibrary?.genreTopSongs ?? []),
  ];

  const seen = new Set<string>();
  const unique = combined.filter((s) => {
    if (!s?.title || seen.has(s.title)) return false;
    seen.add(s.title);
    return true;
  });

  unique.sort((a, b) => (b.play_count ?? 0) - (a.play_count ?? 0));

  const answer = unique.slice(0, topK).map((s) => s.title).join(",");
  return { answer, hasOracleMemory: true };
}

function findTool(input: ExecutorInput, toolId: string): ToolItem | undefined {
  return input.tools.find((t) => t.id === toolId);
}

function now(): string {
  return new Date().toISOString();
}

function makeLlmStep(input: ExecutorInput, derivedAnswer: string, hasOracleMemory: boolean): TrajectoryStep {
  return {
    stepId: randomUUID(),
    type: "llm",
    timestamp: now(),
    input: { query: input.query, intentSpec: input.intentSpec },
    output: {
      stub: true,
      plan: "fixed_sequence",
      hasOracleMemory,
      derivedAnswer,
    },
    metadata: {},
  };
}

function makeToolStep(
  tool: ToolItem,
  args: Record<string, unknown>,
  result: { ok: boolean; output: unknown; error?: string; status?: number } | { ok: false; error: string },
): TrajectoryStep {
  return {
    stepId: randomUUID(),
    type: "tool",
    timestamp: now(),
    input: { toolId: tool.id, args },
    output: result,
    metadata: {
      app: tool.metadata?.app,
      method: tool.metadata?.method,
      path: tool.metadata?.path,
    },
  };
}

function findSupervisorEmail(input: ExecutorInput): string | undefined {
  const profileItem = input.memory.find((m) =>
    m.id.endsWith(":memory:supervisor_profile"),
  );
  if (!profileItem) return undefined;
  try {
    const parsed = JSON.parse(profileItem.content) as { email?: string };
    return parsed.email;
  } catch {
    return undefined;
  }
}

function extractSpotifyPassword(output: unknown): string | undefined {
  if (!Array.isArray(output)) return undefined;
  for (const entry of output) {
    if (entry && typeof entry === "object") {
      const rec = entry as { account_name?: string; password?: string };
      if (rec.account_name === "spotify" && typeof rec.password === "string") {
        return rec.password;
      }
    }
  }
  return undefined;
}

function extractAccessToken(output: unknown): string | undefined {
  if (!output || typeof output !== "object") return undefined;
  const rec = output as { access_token?: string };
  return typeof rec.access_token === "string" ? rec.access_token : undefined;
}

export type StubAppWorldAgentConfig = {
  toolExecutor: AppWorldToolExecutor;
  input: ExecutorInput;
};

export class StubAppWorldAgent {
  constructor(private readonly config: StubAppWorldAgentConfig) {}

  async run(): Promise<StubStepResult> {
    const { input, toolExecutor } = this.config;
    const steps: TrajectoryStep[] = [];

    const { answer: derivedAnswer, hasOracleMemory } = deriveAnswer(input);
    steps.push(makeLlmStep(input, derivedAnswer, hasOracleMemory));

    const supervisorEmail = findSupervisorEmail(input);

    // 1. supervisor__show_profile
    await this.callTool(steps, "supervisor__show_profile", {}, toolExecutor, input);

    // 2. supervisor__show_account_passwords
    const passwordsResult = await this.callTool(
      steps,
      "supervisor__show_account_passwords",
      {},
      toolExecutor,
      input,
    );
    const spotifyPassword = passwordsResult
      ? extractSpotifyPassword(passwordsResult.output)
      : undefined;

    // 3. spotify__login
    let accessToken: string | undefined;
    if (supervisorEmail && spotifyPassword) {
      const loginResult = await this.callTool(
        steps,
        "spotify__login",
        {
          grant_type: "password",
          username: supervisorEmail,
          password: spotifyPassword,
        },
        toolExecutor,
        input,
      );
      if (loginResult) {
        accessToken = extractAccessToken(loginResult.output);
      }
    } else {
      // Cannot login; record a synthetic failure step so the trajectory
      // reflects that required inputs were missing.
      const tool = findTool(input, "spotify__login");
      if (tool) {
        steps.push(
          makeToolStep(tool, {}, {
            ok: false,
            error: "missing supervisor email or spotify password",
          }),
        );
      }
    }
    toolExecutor.setAccessToken("spotify", accessToken ?? null);

    // 4-6. spotify__show_*_library (page_limit=20 — large enough for the sample)
    await this.callTool(
      steps,
      "spotify__show_song_library",
      { page_limit: 20 },
      toolExecutor,
      input,
    );
    await this.callTool(
      steps,
      "spotify__show_album_library",
      { page_limit: 20 },
      toolExecutor,
      input,
    );
    await this.callTool(
      steps,
      "spotify__show_playlist_library",
      { page_limit: 20 },
      toolExecutor,
      input,
    );

    // 7. supervisor__complete_task
    await this.callTool(
      steps,
      "supervisor__complete_task",
      { answer: derivedAnswer },
      toolExecutor,
      input,
    );

    return { steps, derivedAnswer, hasOracleMemory };
  }

  /**
   * Looks up the tool by id in the input pool; if missing, records a failure
   * step and returns null. Otherwise calls the ToolExecutor and records the
   * result. Never throws.
   */
  private async callTool(
    steps: TrajectoryStep[],
    toolId: string,
    args: Record<string, unknown>,
    toolExecutor: ToolExecutor,
    input: ExecutorInput,
  ): Promise<{ ok: boolean; output: unknown; error?: string; status?: number } | null> {
    const tool = findTool(input, toolId);
    if (!tool) {
      // Synthesize a minimal ToolItem-like record just for the step metadata.
      steps.push({
        stepId: randomUUID(),
        type: "tool",
        timestamp: now(),
        input: { toolId, args },
        output: { ok: false, error: "tool not in pool" },
        metadata: { toolId },
      });
      return null;
    }
    const result = await toolExecutor.call(tool, args);
    steps.push(makeToolStep(tool, args, result));
    return result;
  }
}

// Re-export MemoryItem type for downstream convenience.
export type { MemoryItem };
