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

/**
 * Match a concrete API call URL against OpenAPI template paths.
 * Template paths contain {param} placeholders, e.g. /spotify/following_artists/{artist_id}.
 * Concrete calls have actual values, e.g. /spotify/following_artists/14.
 * We normalize both sides by replacing path segments that look like IDs
 * (numeric, or non-operation keyword) with a wildcard, then return the
 * matching template key.
 */
function matchEndpoint(
  method: string,
  concretePath: string,
  templateKeys: Iterable<string>,
): string | undefined {
  const m = method.toLowerCase();
  // Direct match (no path params)
  const directKey = endpointKey(m, concretePath);
  // Fast path: iterate templates and try matching
  for (const key of templateKeys) {
    if (key === directKey) return key;
    const [keyMethod, template] = key.split(" ");
    if (keyMethod !== m) continue;
    // Convert template /spotify/following_artists/{artist_id} into regex
    const regex = template
      .replace(/[.+*?^$()|[\]\\]/g, "\\$&")
      .replace(/\{[^}]+\}/g, "[^/]+");
    if (new RegExp(`^${regex}$`).test(concretePath)) {
      return key;
    }
  }
  return undefined;
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

const READ_TOOL_PATTERNS = ["show", "search", "list", "get", "current", "profile", "directory"];
const MUTATION_TOOL_PATTERNS = ["create", "update", "delete", "move", "follow", "send", "add", "remove", "like", "unlike"];

function matchesAnyPattern(operationId: string, patterns: string[]): boolean {
  const name = operationId.toLowerCase();
  return patterns.some((pattern) => name.includes(pattern));
}

function buildOracleToolIds(tools: ToolItem[], requiredApps: string[], groundTruthToolIds: string[]): string[] {
  const requiredAppSet = new Set(["supervisor", ...requiredApps]);
  const groundTruthSet = new Set(groundTruthToolIds);
  const selected = new Set<string>();

  for (const tool of tools) {
    const app = typeof tool.metadata?.app === "string" ? tool.metadata.app : undefined;
    if (!app || !requiredAppSet.has(app)) continue;

    if (app === "supervisor") {
      if (
        tool.id === "supervisor__show_profile" ||
        tool.id === "supervisor__show_account_passwords" ||
        tool.id === "supervisor__show_active_task" ||
        tool.id === "supervisor__complete_task"
      ) {
        selected.add(tool.id);
      }
      continue;
    }

    if (tool.id === `${app}__login`) {
      selected.add(tool.id);
      continue;
    }

    if (matchesAnyPattern(tool.id, READ_TOOL_PATTERNS)) {
      selected.add(tool.id);
      continue;
    }

    if (groundTruthSet.has(tool.id) && matchesAnyPattern(tool.id, MUTATION_TOOL_PATTERNS)) {
      selected.add(tool.id);
    }
  }

  for (const id of groundTruthToolIds) selected.add(id);
  return tools.filter((tool) => selected.has(tool.id)).map((tool) => tool.id);
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
    metadata: { oracle: true, memoryRole: "oracle", app: "spotify", dbPath, genre, limit },
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
    metadata: { oracle: false, memoryRole: "distractor", app: "spotify", dbPath, genre, limit, distractorType: "same_domain_wrong_user" },
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
    metadata: { oracle: false, memoryRole: "distractor", app, dbPath, distractorType: "cross_domain_app_state" },
  };
}

function parseSupervisorPatch(patchText: string): {
  supervisor?: Record<string, unknown>;
  accountPasswords: Array<{ account_name: string; password: string }>;
  addresses: Array<Record<string, unknown>>;
  paymentCards: Array<Record<string, unknown>>;
} {
  const result: {
    supervisor?: Record<string, unknown>;
    accountPasswords: Array<{ account_name: string; password: string }>;
    addresses: Array<Record<string, unknown>>;
    paymentCards: Array<Record<string, unknown>>;
  } = { accountPasswords: [], addresses: [], paymentCards: [] };
  if (!patchText.trim()) return result;

  const lines = patchText.split("\n").filter(Boolean);
  const columnsByTable: Record<string, string[]> = {};

  for (const line of lines) {
    const parsed = JSON.parse(line) as [string, unknown[], boolean];
    const sql = parsed[0];
    const values = parsed[1] as unknown[];

    // extract table name
    const tableMatch = sql.match(/INSERT INTO (\w+)/);
    if (!tableMatch) continue;
    const table = tableMatch[1];

    // extract column names
    if (!columnsByTable[table]) {
      const colsMatch = sql.match(/INSERT INTO \w+\s*\(([^)]+)\)/);
      if (colsMatch) columnsByTable[table] = colsMatch[1].split(",").map((c) => c.trim());
    }
    const cols = columnsByTable[table] ?? [];

    // build row object
    const row: Record<string, unknown> = {};
    cols.forEach((col, i) => { row[col] = values[i]; });

    if (table === "supervisors" && !result.supervisor) result.supervisor = row;
    else if (table === "account_passwords") result.accountPasswords.push({ account_name: String(row.account_name), password: String(row.password) });
    else if (table === "addresses") result.addresses.push(row);
    else if (table === "payment_cards") result.paymentCards.push(row);
  }

  return result;
}

async function buildSupervisorAuthMemory(taskId: string, taskRoot: string, specs: AppWorldSpecs): Promise<MemoryItem | undefined> {
  const patchText = await readTextIfExists(join(taskRoot, "dbs", "supervisor.jsonl"));
  if (!patchText) return undefined;
  const patch = parseSupervisorPatch(patchText);
  if (patch.accountPasswords.length === 0) return undefined;

  return {
    id: `${taskId}:memory:auth_account_passwords`,
    type: "profile",
    content: JSON.stringify({ accountPasswords: patch.accountPasswords }),
    source: "appworld.task.dbs.supervisor.account_passwords",
    timestamp: specs.datetime,
    metadata: { oracle: false, memoryRole: "common", auth: true },
  };
}

async function buildAppUserLibraryMemory(taskId: string, dataRoot: string, app: string, supervisorEmail: string | undefined, supervisorPhone: string | undefined): Promise<MemoryItem | undefined> {
  const dbPath = join(dataRoot, "base_dbs", `${app}.db`);

  // Check what columns the users table actually has
  const userCols = await querySqliteJson<{ name: string }>(dbPath, `PRAGMA table_info(users)`);
  const colNames = new Set(userCols.map((c) => c.name));
  const selectCols = ["id", "first_name", "last_name"];
  if (colNames.has("email")) selectCols.push("email");
  if (colNames.has("phone_number")) selectCols.push("phone_number");
  const selectClause = selectCols.join(", ");

  // Find user by email or phone
  let userRecord: Record<string, unknown> | undefined;
  if (supervisorEmail && colNames.has("email")) {
    userRecord = (await querySqliteJson<Record<string, unknown>>(
      dbPath,
      `SELECT ${selectClause} FROM users WHERE email='${sqlString(supervisorEmail)}' LIMIT 1`,
    ))[0];
  }
  if (!userRecord && supervisorPhone && colNames.has("phone_number")) {
    userRecord = (await querySqliteJson<Record<string, unknown>>(
      dbPath,
      `SELECT ${selectClause} FROM users WHERE phone_number='${sqlString(supervisorPhone)}' LIMIT 1`,
    ))[0];
  }
  if (!userRecord) return undefined;

  const userId = userRecord.id;
  if (typeof userId !== "number") return undefined;

  // Get all tables that have user_id column
  const tablesWithUserId = await querySqliteJson<{ name: string }>(
    dbPath,
    `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE '%_fts%' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '%_config%' AND name NOT LIKE '%_data%' AND name NOT LIKE '%_docsize%' AND name NOT LIKE '%_idx%' AND name NOT LIKE '%_content%'`,
  );

  const librarySummary: Record<string, { count: number; sample: unknown[] }> = {};
  for (const { name: table } of tablesWithUserId) {
    // check if this table has user_id column
    const cols = await querySqliteJson<{ name: string }>(dbPath, `PRAGMA table_info(${table})`);
    const hasUserId = cols.some((c) => c.name === "user_id");
    if (!hasUserId) continue;

    const count = (await querySqliteJson<{ count: number }>(dbPath, `SELECT COUNT(*) AS count FROM ${table} WHERE user_id=${userId}`))[0]?.count ?? 0;
    if (count === 0) continue;

    const sample = await querySqliteJson<Record<string, unknown>>(dbPath, `SELECT * FROM ${table} WHERE user_id=${userId} LIMIT 3`);
    librarySummary[table] = { count, sample: sample.slice(0, 3) };
  }

  if (Object.keys(librarySummary).length === 0) return undefined;

  return {
    id: `${taskId}:memory:app_user_library:${app}`,
    type: "state",
    content: JSON.stringify({ app, user: userRecord, library: librarySummary }),
    source: `appworld.base_dbs.${app}`,
    metadata: { oracle: true, memoryRole: "oracle", app, dbPath, userId },
  };
}

function inferOperationalHints(specs: AppWorldSpecs, publicData: unknown): string[] {
  if (!publicData || typeof publicData !== "object") return [];
  const data = publicData as Record<string, unknown>;
  const hints: string[] = [];

  if (typeof data.sent_received === "string") {
    hints.push(`transaction direction = ${data.sent_received}`);
  }

  if (data.threshold_duration === "month" && specs.datetime) {
    const match = specs.datetime.match(/^(\d{4})-(\d{2})/);
    if (match) {
      const year = Number(match[1]);
      const month = Number(match[2]);
      const lastDay = new Date(year, month, 0).getDate();
      const mm = String(month).padStart(2, "0");
      hints.push(`this month date range = ${year}-${mm}-01T00:00:00 to ${year}-${mm}-${String(lastDay).padStart(2, "0")}T23:59:59`);
      hints.push(`when available, use min_created_at=${year}-${mm}-01T00:00:00 and max_created_at=${year}-${mm}-${String(lastDay).padStart(2, "0")}T23:59:59`);
    }
  }

  if (typeof data.genre === "string") hints.push(`genre = ${data.genre}`);
  if (typeof data.min_followers === "number") hints.push(`minimum followers = ${data.min_followers}`);
  if (typeof data.top_k === "number") hints.push(`top_k = ${data.top_k}`);
  if (typeof data.contact_relation === "string") hints.push(`contact relationship = ${data.contact_relation}`);
  if (typeof data.transaction_description === "string") hints.push(`transaction description = ${data.transaction_description}`);

  return hints;
}

function describePublicData(specs: AppWorldSpecs, publicData: unknown): string {
  return JSON.stringify({
    constraints: publicData,
    operationalHints: inferOperationalHints(specs, publicData),
  });
}

async function buildMemoryPool(taskId: string, taskRoot: string, dataRoot: string, specs: AppWorldSpecs, publicData: unknown, requiredApps: string[]): Promise<MemoryItem[]> {
  const memory: MemoryItem[] = [];

  // Keep specs.supervisor as basic profile (non-oracle)
  if (specs.supervisor) {
    memory.push({
      id: `${taskId}:memory:supervisor_profile`,
      type: "profile",
      content: JSON.stringify(specs.supervisor),
      source: "appworld.specs.supervisor",
      timestamp: specs.datetime,
      metadata: { oracle: false, memoryRole: "common" },
    });
  }

  // Add auth-only account passwords as common runtime context.
  const supervisorAuth = await buildSupervisorAuthMemory(taskId, taskRoot, specs);
  if (supervisorAuth) memory.push(supervisorAuth);

  if (publicData && JSON.stringify(publicData) !== "{}") {
    memory.push({
      id: `${taskId}:memory:public_data`,
      type: "evidence",
      content: describePublicData(specs, publicData),
      source: "appworld.ground_truth.public_data",
      metadata: { oracle: true, memoryRole: "oracle" },
    });
  }

  if (requiredApps.length > 0) {
    memory.push({
      id: `${taskId}:memory:required_apps`,
      type: "state",
      content: JSON.stringify({ requiredApps }),
      source: "appworld.ground_truth.required_apps",
      metadata: { oracle: false, memoryRole: "common" },
    });
  }

  // Extract supervisor email/phone for user lookup in each app
  const supervisorEmail = typeof specs.supervisor?.email === "string" ? specs.supervisor.email : undefined;
  const supervisorPhone = typeof specs.supervisor?.phone_number === "string" ? specs.supervisor.phone_number : undefined;

  for (const app of requiredApps) {
    // Spotify: use specialized library summary (genre-aware)
    if (app === "spotify") {
      const spotifySummary = await buildSpotifyUserLibraryMemory(taskId, dataRoot, specs, publicData);
      if (spotifySummary) memory.push(spotifySummary);
      const otherUserSummary = await buildOtherUserSpotifyLibraryMemory(taskId, dataRoot, specs, publicData);
      if (otherUserSummary) memory.push(otherUserSummary);
    } else {
      // Other apps: use generic app user library summary
      const appLibrary = await buildAppUserLibraryMemory(taskId, dataRoot, app, supervisorEmail, supervisorPhone);
      if (appLibrary) memory.push(appLibrary);
    }
  }

  // Add cross-domain distractor memory
  for (const app of DEFAULT_DISTRACTOR_APPS.filter((candidate) => !requiredApps.includes(candidate))) {
    const crossDomainMemory = await buildCrossDomainAppMemory(taskId, dataRoot, app);
    if (crossDomainMemory) memory.push(crossDomainMemory);
  }

  return memory;
}

function inferOracleIntent(specs: AppWorldSpecs, publicData: unknown): string {
  const hasPublicData = publicData && JSON.stringify(publicData) !== "{}";
  if (!hasPublicData) return specs.instruction;

  const hints = inferOperationalHints(specs, publicData);
  const hintText = hints.length > 0
    ? hints.map((hint) => `- ${hint}`).join("\n")
    : `- task constraints = ${JSON.stringify(publicData)}`;
  return `${specs.instruction}\nOperational constraints:\n${hintText}`;
}

export class AppWorldAdapter implements DatasetAdapter {
  readonly source = "appworld";
  readonly version = "0.2.0";

  async *convert(rawRoot: string): AsyncIterable<CanonicalTask> {
    const manifest = await readJsonIfExists<{ split?: string; taskIds?: string[] }>(join(rawRoot, "sample-manifest.json"), {});
    const manifestSplit = manifest.split ?? "dev";
    const taskIds = manifest.taskIds ?? (await readFile(join(rawRoot, "datasets", `${manifestSplit}.txt`), "utf8")).split("\n").filter(Boolean);
    const dataRoot = rawRoot.endsWith("sample") || rawRoot.endsWith("sample_5") ? join(rawRoot, "..", "data") : rawRoot;
    const apiDocsRoot = join(dataRoot, "api_docs");

    // Build taskId -> actual split map from datasets/*.txt
    const splitByTaskId = new Map<string, "train" | "dev" | "test">();
    for (const splitName of ["train", "dev", "test_normal", "test_challenge"] as const) {
      const splitFile = join(dataRoot, "datasets", `${splitName}.txt`);
      const content = await readTextIfExists(splitFile);
      if (!content) continue;
      const normalized = splitName === "test_normal" || splitName === "test_challenge" ? "test" : splitName;
      for (const line of content.split("\n")) {
        const id = line.trim();
        if (id) splitByTaskId.set(id, normalized);
      }
    }

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
      const groundTruthToolIds = Array.from(
        new Set(
          apiCalls
            .map((call) => {
              const key = matchEndpoint(call.method, call.url, operationByEndpoint.keys());
              return key ? operationByEndpoint.get(key) : undefined;
            })
            .filter((operationId): operationId is string => Boolean(operationId)),
        ),
      );
      const oracleToolIds = buildOracleToolIds(tools, requiredApps, groundTruthToolIds);

      const memoryPool = await buildMemoryPool(taskId, taskRoot, dataRoot, specs, publicData, requiredApps);
      const commonMemoryIds = memoryPool.filter((item) => item.metadata.memoryRole === "common").map((item) => item.id);
      const oracleMemoryIds = memoryPool.filter((item) => item.metadata.memoryRole === "oracle").map((item) => item.id);
      const distractorMemoryIds = memoryPool.filter((item) => item.metadata.memoryRole === "distractor").map((item) => item.id);
      const domains = requiredApps.length > 0 ? requiredApps.join("+") : "unknown";

      yield {
        taskId,
        source: this.source,
        domain: domains,
        split: splitByTaskId.get(taskId) ?? (manifestSplit as "train" | "dev" | "test"),
        query: specs.instruction,
        oracleIntent: inferOracleIntent(specs, publicData),
        memoryPool,
        commonMemoryIds,
        oracleMemoryIds,
        distractorMemoryIds,
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
          groundTruthToolIds,
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
