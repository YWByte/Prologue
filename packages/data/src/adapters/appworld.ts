import { execFile } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { CanonicalTask, MemoryItem, ToolItem } from "@prologue/schemas";
import type { DatasetAdapter } from "../index.js";

type AppWorldSpecs = {
  instruction: string;
  supervisor?: Record<string, unknown>;
  datetime?: string;
  db_version?: string;
  canary_string?: string;
};

type ApiCall = {
  method: string;
  url: string;
  data?: Record<string, unknown>;
};

type OpenApiDoc = {
  paths?: Record<string, Record<string, { operationId?: string; summary?: string; description?: string; parameters?: unknown; requestBody?: unknown }>>;
};

type LoadedTools = {
  tools: ToolItem[];
  operationByEndpoint: Map<string, string>;
};

const DEFAULT_DISTRACTOR_APPS = ["gmail", "amazon", "todoist"];
const execFileAsync = promisify(execFile);

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

async function readJsonIfExists<T>(path: string, fallback: T): Promise<T> {
  try {
    return await readJson<T>(path);
  } catch {
    return fallback;
  }
}

async function readTextIfExists(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return undefined;
  }
}

async function querySqliteJson<T>(dbPath: string, sql: string): Promise<T[]> {
  const { stdout } = await execFileAsync("sqlite3", ["-json", dbPath, sql]);
  const trimmed = stdout.trim();
  return trimmed.length > 0 ? (JSON.parse(trimmed) as T[]) : [];
}

function sqlString(value: string): string {
  return value.replaceAll("'", "''");
}

function endpointKey(method: string, path: string): string {
  return `${method.toLowerCase()} ${path}`;
}

async function loadTools(apiDocsRoot: string, apps: string[]): Promise<LoadedTools> {
  const tools: ToolItem[] = [];
  const operationByEndpoint = new Map<string, string>();

  for (const app of apps) {
    const openApiPath = join(apiDocsRoot, "openapi", `${app}.json`);
    const doc = await readJsonIfExists<OpenApiDoc>(openApiPath, {});
    for (const [path, methods] of Object.entries(doc.paths ?? {})) {
      for (const [method, operation] of Object.entries(methods)) {
        if (!operation.operationId) continue;
        operationByEndpoint.set(endpointKey(method, path), operation.operationId);
        tools.push({
          id: operation.operationId,
          name: operation.operationId,
          description: operation.description ?? operation.summary ?? operation.operationId,
          type: "api",
          schema: {
            parameters: operation.parameters ?? [],
            requestBody: operation.requestBody ?? null,
          },
          metadata: {
            app,
            method,
            path,
            summary: operation.summary,
          },
        });
      }
    }
  }

  return { tools, operationByEndpoint };
}

async function querySpotifyLibrarySummary(dbPath: string, user: Record<string, unknown>, genre: string | undefined, limit: number): Promise<Record<string, unknown>> {
  const userId = user.id;
  if (typeof userId !== "number") throw new Error("Spotify user id is missing.");

  const counts = {
    songLibrary: (await querySqliteJson<{ count: number }>(dbPath, `SELECT COUNT(*) AS count FROM user_library_songs WHERE user_id=${userId}`))[0]?.count ?? 0,
    albumLibrary: (await querySqliteJson<{ count: number }>(dbPath, `SELECT COUNT(*) AS count FROM user_library_albums WHERE user_id=${userId}`))[0]?.count ?? 0,
    playlists: (await querySqliteJson<{ count: number }>(dbPath, `SELECT COUNT(*) AS count FROM playlists WHERE user_id=${userId}`))[0]?.count ?? 0,
  };
  const topSongs = await querySqliteJson<Record<string, unknown>>(
    dbPath,
    `SELECT s.title, s.genre, s.play_count FROM user_library_songs uls JOIN songs s ON s.id=uls.song_id WHERE uls.user_id=${userId} ORDER BY s.play_count DESC LIMIT ${limit}`,
  );
  const genreTopSongs = genre
    ? await querySqliteJson<Record<string, unknown>>(
        dbPath,
        `SELECT s.title, s.genre, s.play_count FROM user_library_songs uls JOIN songs s ON s.id=uls.song_id WHERE uls.user_id=${userId} AND lower(s.genre)=lower('${sqlString(genre)}') ORDER BY s.play_count DESC LIMIT ${limit}`,
      )
    : [];
  const albums = await querySqliteJson<Record<string, unknown>>(
    dbPath,
    `SELECT a.id, a.title, a.genre, COUNT(s.id) AS song_count FROM user_library_albums ula JOIN albums a ON a.id=ula.album_id LEFT JOIN songs s ON s.album_id=a.id WHERE ula.user_id=${userId} GROUP BY a.id, a.title, a.genre LIMIT ${limit}`,
  );
  const albumTopSongs = await querySqliteJson<Record<string, unknown>>(
    dbPath,
    `SELECT a.title AS album_title, s.title, s.genre, s.play_count FROM user_library_albums ula JOIN albums a ON a.id=ula.album_id JOIN songs s ON s.album_id=a.id WHERE ula.user_id=${userId} ORDER BY s.play_count DESC LIMIT ${limit}`,
  );
  const albumGenreTopSongs = genre
    ? await querySqliteJson<Record<string, unknown>>(
        dbPath,
        `SELECT a.title AS album_title, s.title, s.genre, s.play_count FROM user_library_albums ula JOIN albums a ON a.id=ula.album_id JOIN songs s ON s.album_id=a.id WHERE ula.user_id=${userId} AND lower(s.genre)=lower('${sqlString(genre)}') ORDER BY s.play_count DESC LIMIT ${limit}`,
      )
    : [];
  const playlists = await querySqliteJson<Record<string, unknown>>(
    dbPath,
    `SELECT p.id, p.title, COUNT(ps.song_id) AS song_count FROM playlists p LEFT JOIN playlist_songs ps ON ps.playlist_id=p.id WHERE p.user_id=${userId} GROUP BY p.id, p.title LIMIT ${limit}`,
  );
  const playlistTopSongs = await querySqliteJson<Record<string, unknown>>(
    dbPath,
    `SELECT p.title AS playlist_title, s.title, s.genre, s.play_count FROM playlists p JOIN playlist_songs ps ON ps.playlist_id=p.id JOIN songs s ON s.id=ps.song_id WHERE p.user_id=${userId} ORDER BY s.play_count DESC LIMIT ${limit}`,
  );
  const playlistGenreTopSongs = genre
    ? await querySqliteJson<Record<string, unknown>>(
        dbPath,
        `SELECT p.title AS playlist_title, s.title, s.genre, s.play_count FROM playlists p JOIN playlist_songs ps ON ps.playlist_id=p.id JOIN songs s ON s.id=ps.song_id WHERE p.user_id=${userId} AND lower(s.genre)=lower('${sqlString(genre)}') ORDER BY s.play_count DESC LIMIT ${limit}`,
      )
    : [];

  return {
    user,
    counts,
    songLibrary: { topSongs, genreTopSongs },
    albumLibrary: { albums, topSongs: albumTopSongs, genreTopSongs: albumGenreTopSongs },
    playlistLibrary: { playlists, topSongs: playlistTopSongs, genreTopSongs: playlistGenreTopSongs },
  };
}

async function buildSpotifyUserLibraryMemory(taskId: string, dataRoot: string, specs: AppWorldSpecs, publicData: unknown): Promise<MemoryItem | undefined> {
  const email = typeof specs.supervisor?.email === "string" ? specs.supervisor.email : undefined;
  if (!email) return undefined;

  const dbPath = join(dataRoot, "base_dbs", "spotify.db");
  const genre = typeof publicData === "object" && publicData !== null && "genre" in publicData ? String((publicData as { genre?: unknown }).genre) : undefined;
  const topK = typeof publicData === "object" && publicData !== null && "top_k" in publicData ? Number((publicData as { top_k?: unknown }).top_k) : 10;
  const limit = Number.isFinite(topK) && topK > 0 ? Math.min(Math.max(topK, 5), 20) : 10;
  const users = await querySqliteJson<Record<string, unknown>>(
    dbPath,
    `SELECT id, first_name, last_name, email FROM users WHERE email='${sqlString(email)}' LIMIT 1`,
  );
  if (!users[0]) return undefined;

  return {
    id: `${taskId}:memory:spotify_user_library_summary`,
    type: "state",
    content: JSON.stringify(await querySpotifyLibrarySummary(dbPath, users[0], genre, limit)),
    source: "appworld.base_dbs.spotify",
    metadata: { oracle: true, app: "spotify", dbPath, genre, limit },
  };
}

async function buildOtherUserSpotifyLibraryMemory(taskId: string, dataRoot: string, specs: AppWorldSpecs, publicData: unknown): Promise<MemoryItem | undefined> {
  const email = typeof specs.supervisor?.email === "string" ? specs.supervisor.email : undefined;
  if (!email) return undefined;

  const dbPath = join(dataRoot, "base_dbs", "spotify.db");
  const genre = typeof publicData === "object" && publicData !== null && "genre" in publicData ? String((publicData as { genre?: unknown }).genre) : undefined;
  const topK = typeof publicData === "object" && publicData !== null && "top_k" in publicData ? Number((publicData as { top_k?: unknown }).top_k) : 10;
  const limit = Number.isFinite(topK) && topK > 0 ? Math.min(Math.max(topK, 5), 20) : 10;
  const users = await querySqliteJson<Record<string, unknown>>(
    dbPath,
    `SELECT id, first_name, last_name, email FROM users WHERE email!='${sqlString(email)}' ORDER BY id LIMIT 1`,
  );
  if (!users[0]) return undefined;

  return {
    id: `${taskId}:memory:distractor:spotify_other_user_library_summary`,
    type: "state",
    content: JSON.stringify(await querySpotifyLibrarySummary(dbPath, users[0], genre, limit)),
    source: "appworld.base_dbs.spotify",
    metadata: { oracle: false, app: "spotify", dbPath, genre, limit, distractorType: "same_domain_wrong_user" },
  };
}

async function buildCrossDomainAppMemory(taskId: string, dataRoot: string, app: string): Promise<MemoryItem | undefined> {
  const dbPath = join(dataRoot, "base_dbs", `${app}.db`);
  const tables = await querySqliteJson<{ name: string }>(
    dbPath,
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE '%_fts%' AND name NOT LIKE 'sqlite_%' ORDER BY name LIMIT 8",
  );
  if (tables.length === 0) return undefined;

  const tableCounts: Record<string, number> = {};
  for (const table of tables) {
    tableCounts[table.name] = (await querySqliteJson<{ count: number }>(dbPath, `SELECT COUNT(*) AS count FROM ${table.name}`))[0]?.count ?? 0;
  }

  return {
    id: `${taskId}:memory:distractor:app_db_summary:${app}`,
    type: "state",
    content: JSON.stringify({ app, tableCounts }),
    source: `appworld.base_dbs.${app}`,
    metadata: { oracle: false, app, dbPath, distractorType: "cross_domain_app_state" },
  };
}

async function buildAppDbMemory(taskId: string, taskRoot: string, app: string, oracle: boolean): Promise<MemoryItem> {
  const dbPatchPath = join(taskRoot, "dbs", `${app}.jsonl`);
  const rawPatch = (await readTextIfExists(dbPatchPath)) ?? "";
  const patchLines = rawPatch.split("\n").filter(Boolean);
  const patchSample = patchLines.slice(0, 3).map((line) => JSON.parse(line) as unknown);

  return {
    id: `${taskId}:memory:app_db:${app}`,
    type: "state",
    content: JSON.stringify({
      app,
      taskDbPatchLineCount: patchLines.length,
      taskDbPatchSample: patchSample,
      note: patchLines.length > 0 ? "Task-specific app DB patch." : "No task-specific patch; app state comes from the AppWorld base DB.",
    }),
    source: `appworld.task.dbs.${app}`,
    metadata: {
      oracle,
      app,
      taskDbPatchPath: dbPatchPath,
      taskDbPatchBytes: rawPatch.length,
    },
  };
}

async function buildMemoryPool(taskId: string, taskRoot: string, dataRoot: string, specs: AppWorldSpecs, publicData: unknown, requiredApps: string[]): Promise<MemoryItem[]> {
  const memory: MemoryItem[] = [];

  if (specs.supervisor) {
    memory.push({
      id: `${taskId}:memory:supervisor_profile`,
      type: "profile",
      content: JSON.stringify(specs.supervisor),
      source: "appworld.specs.supervisor",
      timestamp: specs.datetime,
      metadata: { oracle: false },
    });
  }

  if (publicData && JSON.stringify(publicData) !== "{}") {
    memory.push({
      id: `${taskId}:memory:public_data`,
      type: "evidence",
      content: JSON.stringify(publicData),
      source: "appworld.ground_truth.public_data",
      metadata: { oracle: true },
    });
  }

  if (requiredApps.length > 0) {
    memory.push({
      id: `${taskId}:memory:required_apps`,
      type: "state",
      content: JSON.stringify({ requiredApps }),
      source: "appworld.ground_truth.required_apps",
      metadata: { oracle: false },
    });
  }

  for (const app of requiredApps) {
    memory.push(await buildAppDbMemory(taskId, taskRoot, app, false));
    if (app === "spotify") {
      const spotifySummary = await buildSpotifyUserLibraryMemory(taskId, dataRoot, specs, publicData);
      if (spotifySummary) memory.push(spotifySummary);
      const otherUserSummary = await buildOtherUserSpotifyLibraryMemory(taskId, dataRoot, specs, publicData);
      if (otherUserSummary) memory.push(otherUserSummary);
    }
  }

  for (const app of DEFAULT_DISTRACTOR_APPS.filter((candidate) => !requiredApps.includes(candidate))) {
    const crossDomainMemory = await buildCrossDomainAppMemory(taskId, dataRoot, app);
    if (crossDomainMemory) memory.push(crossDomainMemory);
  }

  return memory;
}

function inferOracleIntent(specs: AppWorldSpecs, publicData: unknown): string {
  const constraints = publicData && JSON.stringify(publicData) !== "{}" ? ` Constraints: ${JSON.stringify(publicData)}.` : "";
  return `${specs.instruction}${constraints}`;
}

export class AppWorldAdapter implements DatasetAdapter {
  readonly source = "appworld";
  readonly version = "0.1.5";

  async *convert(rawRoot: string): AsyncIterable<CanonicalTask> {
    const manifest = await readJsonIfExists<{ split?: string; taskIds?: string[] }>(join(rawRoot, "sample-manifest.json"), {});
    const split = manifest.split ?? "dev";
    const taskIds = manifest.taskIds ?? (await readFile(join(rawRoot, "datasets", `${split}.txt`), "utf8")).split("\n").filter(Boolean);
    const dataRoot = rawRoot.endsWith("sample") ? join(rawRoot, "..", "data") : rawRoot;
    const apiDocsRoot = join(dataRoot, "api_docs");

    for (const taskId of taskIds) {
      const taskRoot = join(rawRoot, "tasks", taskId);
      const specs = await readJson<AppWorldSpecs>(join(taskRoot, "specs.json"));
      const requiredApps = await readJsonIfExists<string[]>(join(taskRoot, "ground_truth", "required_apps.json"), []);
      const apiCalls = await readJsonIfExists<ApiCall[]>(join(taskRoot, "ground_truth", "api_calls.json"), []);
      const publicData = await readJsonIfExists<unknown>(join(taskRoot, "ground_truth", "public_data.json"), {});
      const testData = await readJsonIfExists<unknown>(join(taskRoot, "ground_truth", "test_data.json"), {});
      const metadata = await readJsonIfExists<unknown>(join(taskRoot, "ground_truth", "metadata.json"), {});
      const goldAnswer = await readTextIfExists(join(taskRoot, "ground_truth", "answer.json"));

      const distractorApp = DEFAULT_DISTRACTOR_APPS.find((app) => !requiredApps.includes(app));
      const toolApps = ["supervisor", ...requiredApps, ...(distractorApp ? [distractorApp] : [])];
      const { tools, operationByEndpoint } = await loadTools(apiDocsRoot, toolApps);
      const oracleToolIds = Array.from(
        new Set(
          apiCalls
            .map((call) => operationByEndpoint.get(endpointKey(call.method, call.url)))
            .filter((operationId): operationId is string => Boolean(operationId)),
        ),
      );

      const memoryPool = await buildMemoryPool(taskId, taskRoot, dataRoot, specs, publicData, requiredApps);
      const oracleMemoryIds = memoryPool.filter((item) => item.metadata.oracle === true).map((item) => item.id);
      const domains = requiredApps.length > 0 ? requiredApps.join("+") : "unknown";

      yield {
        taskId,
        source: this.source,
        domain: domains,
        split: split as "train" | "dev" | "test",
        query: specs.instruction,
        oracleIntent: inferOracleIntent(specs, publicData),
        memoryPool,
        oracleMemoryIds,
        toolPool: tools,
        oracleToolIds,
        evaluator: {
          type: "programmatic",
          entrypoint: "appworld:evaluate",
          goldAnswer: goldAnswer ? JSON.stringify(JSON.parse(goldAnswer)) : undefined,
          metadata: {
            taskId,
            evaluationPath: join(taskRoot, "ground_truth", "evaluation.py"),
            answerPath: join(taskRoot, "ground_truth", "answer.json"),
            testData,
          },
        },
        capabilities: {
          hasOracleIntent: true,
          hasOracleMemory: oracleMemoryIds.length > 0,
          hasOracleTool: oracleToolIds.length > 0,
          hasExecutableEval: true,
          supportsInteraction: true,
        },
        metadata: {
          adapterVersion: this.version,
          rawTaskId: taskId,
          requiredApps,
          appCount: requiredApps.length,
          toolAppCount: toolApps.length,
          apiCallCount: apiCalls.length,
          benchmarkMetadata: metadata,
          dbFiles: await readdir(join(taskRoot, "dbs")),
          specs: {
            datetime: specs.datetime,
            dbVersion: specs.db_version,
          },
        },
      };
    }
  }
}
