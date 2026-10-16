// Persistent storage. PostgreSQL is used when DATABASE_URL is set and reachable;
// otherwise the server falls back to SQLite (a local file via Node's built-in
// node:sqlite); if neither is available it degrades to an in-memory store (the
// leaderboard is rebuilt from chain on each boot, but results and live tables
// do NOT survive a restart — fine for dev, never for a wagered deployment).
// Drivers are imported dynamically so a missing driver never breaks the build —
// it just falls through to the next option.
//
// Postgres and SQLite share one implementation: every statement is written with
// $1-style placeholders and `ON CONFLICT … excluded.*` upserts, which both accept
// (SQLite gets `?1`-style placeholders substituted in).

import { createRequire } from "node:module";
import type { ServerConfig } from "../config.js";

export interface EntryRow {
  address: string;
  wins: number;
  losses: number;
  wonAmount: string;
}
export interface WonRow {
  winner: string;
  gameId: string;
  reward: string;
}
export interface CountedRow {
  gameId: string;
  wonAmount: string;
}

/** Where a decided game stands on-chain. */
export type OnchainStatus = "pending" | "finished" | "claimed";

/** A decided game. Written BEFORE anyone is told the result, and never rewritten:
 *  once a game has a result, the server never plays it again or signs a voucher
 *  for anyone but this winner. */
export interface ResultRow {
  gameId: string;
  winner: string;
  loser: string;
  reason: string;
  /** Winner's payout in wei (decimal string). */
  reward: string;
  decidedAt: number;
  onchain: OnchainStatus;
  /** Backstop finishGame transaction, if the server had to send one. */
  finishTx: string | null;
  finishTxAt: number | null;
  /** finishGame transactions sent so far (replacements included). */
  finishAttempts: number;
  /** Why the last finishGame attempt failed (send error, or the tx failed /
   *  was dropped); cleared when a new one goes out. Stored, so a "failed"
   *  status survives restarts. */
  finishError: string | null;
}

export interface CursorState {
  block: number;
  hash: string | null;
}

/** Storage backend the server writes through to and loads from on boot. */
export interface Persistence {
  readonly kind: "postgres" | "sqlite" | "memory";
  // leaderboard
  loadEntries(): Promise<EntryRow[]>;
  loadWonGames(): Promise<WonRow[]>;
  loadCounted(): Promise<CountedRow[]>;
  upsertEntry(row: EntryRow): Promise<void>;
  recordCounted(gameId: string, wonAmountWei: string): Promise<void>;
  upsertWonGame(winner: string, gameId: string, reward: string): Promise<void>;
  // chain indexer
  loadCursor(): Promise<number | null>;
  loadCursorState(): Promise<CursorState | null>;
  saveCursor(block: number, hash?: string | null): Promise<void>;
  hasEvent(key: string): Promise<boolean>;
  /** Insert into the processed-event ledger; false if it was already there. */
  recordEvent(key: string, block: number, eventName: string, gameId: string | null): Promise<boolean>;
  // decided games
  loadResults(): Promise<ResultRow[]>;
  /** Insert a result; false (and no change) if the game already has one. */
  insertResult(row: ResultRow): Promise<boolean>;
  updateResult(
    gameId: string,
    patch: Partial<Pick<ResultRow, "onchain" | "finishTx" | "finishTxAt" | "finishAttempts" | "finishError">>
  ): Promise<void>;
  // small key/value settings (e.g. the server's last-alive heartbeat)
  getMeta(key: string): Promise<string | null>;
  setMeta(key: string, value: string): Promise<void>;
  // live tables (serialized room state), deleted once the game is decided
  loadRooms(): Promise<Array<{ gameId: string; data: string }>>;
  saveRoom(gameId: string, data: string): Promise<void>;
  deleteRoom(gameId: string): Promise<void>;
  // lobby mirror of on-chain games
  loadLobby(): Promise<Array<{ gameId: string; data: string }>>;
  saveLobbyGame(gameId: string, data: string): Promise<void>;
}

// ── shared SQL implementation ──────────────────────────────────────────────

interface SqlDriver {
  kind: "postgres" | "sqlite";
  exec(sql: string): Promise<void>;
  all(sql: string, params?: unknown[]): Promise<Record<string, unknown>[]>;
  /** Returns the number of rows changed. */
  run(sql: string, params?: unknown[]): Promise<number>;
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS lb_entries (
    address TEXT PRIMARY KEY, wins INTEGER NOT NULL DEFAULT 0,
    losses INTEGER NOT NULL DEFAULT 0, won_amount TEXT NOT NULL DEFAULT '0');
  CREATE TABLE IF NOT EXISTS lb_won_games (
    winner TEXT NOT NULL, game_id TEXT NOT NULL, reward TEXT NOT NULL,
    PRIMARY KEY (winner, game_id));
  CREATE TABLE IF NOT EXISTS lb_counted (game_id TEXT PRIMARY KEY, won_amount TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS lb_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS pd_results (
    game_id TEXT PRIMARY KEY, winner TEXT NOT NULL, loser TEXT NOT NULL, reason TEXT NOT NULL,
    reward TEXT NOT NULL, decided_at BIGINT NOT NULL, onchain TEXT NOT NULL DEFAULT 'pending',
    finish_tx TEXT, finish_tx_at BIGINT, finish_attempts INTEGER NOT NULL DEFAULT 0, finish_error TEXT);
  CREATE TABLE IF NOT EXISTS pd_rooms (game_id TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at BIGINT NOT NULL);
  CREATE TABLE IF NOT EXISTS pd_lobby (game_id TEXT PRIMARY KEY, data TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS pd_events (
    event_key TEXT PRIMARY KEY, block BIGINT NOT NULL, event_name TEXT NOT NULL,
    game_id TEXT, processed_at BIGINT NOT NULL);
`;

/** Columns added after a table first shipped. Run one by one; "already exists"
 *  is expected on every boot after the first (SQLite has no ADD COLUMN IF NOT
 *  EXISTS), so failures are ignored and the read path tolerates missing data. */
const MIGRATIONS = [
  "ALTER TABLE pd_results ADD COLUMN finish_attempts INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE pd_results ADD COLUMN finish_error TEXT",
];

async function migrate(db: Pick<SqlDriver, "exec">): Promise<void> {
  for (const sql of MIGRATIONS) await db.exec(sql).catch(() => {});
}

const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

function sqlPersistence(db: SqlDriver): Persistence {
  const meta = async (key: string): Promise<string | null> => {
    const rows = await db.all("SELECT value FROM lb_meta WHERE key = $1", [key]);
    return rows.length ? String(rows[0].value) : null;
  };
  const setMeta = (key: string, value: string) =>
    db.run(
      "INSERT INTO lb_meta (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
      [key, value]
    );

  return {
    kind: db.kind,
    async loadEntries() {
      return (await db.all("SELECT address, wins, losses, won_amount FROM lb_entries")).map((r) => ({
        address: String(r.address),
        wins: Number(r.wins),
        losses: Number(r.losses),
        wonAmount: String(r.won_amount),
      }));
    },
    async loadWonGames() {
      return (await db.all("SELECT winner, game_id, reward FROM lb_won_games")).map((r) => ({
        winner: String(r.winner),
        gameId: String(r.game_id),
        reward: String(r.reward),
      }));
    },
    async loadCounted() {
      return (await db.all("SELECT game_id, won_amount FROM lb_counted")).map((r) => ({
        gameId: String(r.game_id),
        wonAmount: String(r.won_amount),
      }));
    },
    async upsertEntry(row) {
      await db.run(
        `INSERT INTO lb_entries (address, wins, losses, won_amount) VALUES ($1, $2, $3, $4)
         ON CONFLICT (address) DO UPDATE SET wins = excluded.wins, losses = excluded.losses, won_amount = excluded.won_amount`,
        [row.address, row.wins, row.losses, row.wonAmount]
      );
    },
    async recordCounted(gameId, wonAmountWei) {
      await db.run("INSERT INTO lb_counted (game_id, won_amount) VALUES ($1, $2) ON CONFLICT (game_id) DO NOTHING", [
        gameId,
        wonAmountWei,
      ]);
    },
    async upsertWonGame(winner, gameId, reward) {
      await db.run(
        `INSERT INTO lb_won_games (winner, game_id, reward) VALUES ($1, $2, $3)
         ON CONFLICT (winner, game_id) DO UPDATE SET reward = excluded.reward`,
        [winner.toLowerCase(), gameId, reward]
      );
    },

    async loadCursor() {
      const v = await meta("cursor");
      return v === null ? null : Number(v);
    },
    async loadCursorState() {
      const v = await meta("cursor");
      if (v === null) return null;
      return { block: Number(v), hash: await meta("cursor_hash") };
    },
    async saveCursor(block, hash = null) {
      await setMeta("cursor", String(block));
      await setMeta("cursor_hash", hash ?? "");
    },
    async hasEvent(key) {
      return (await db.all("SELECT 1 FROM pd_events WHERE event_key = $1", [key])).length > 0;
    },
    async recordEvent(key, block, eventName, gameId) {
      const changed = await db.run(
        `INSERT INTO pd_events (event_key, block, event_name, game_id, processed_at) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (event_key) DO NOTHING`,
        [key, block, eventName, gameId, Date.now()]
      );
      return changed > 0;
    },

    async loadResults() {
      return (await db.all("SELECT * FROM pd_results")).map((r) => ({
        gameId: String(r.game_id),
        winner: String(r.winner),
        loser: String(r.loser),
        reason: String(r.reason),
        reward: String(r.reward),
        decidedAt: Number(r.decided_at),
        onchain: String(r.onchain) as OnchainStatus,
        finishTx: r.finish_tx ? String(r.finish_tx) : null,
        finishTxAt: num(r.finish_tx_at),
        finishAttempts: Number(r.finish_attempts ?? 0),
        finishError: r.finish_error ? String(r.finish_error) : null,
      }));
    },
    async insertResult(row) {
      const changed = await db.run(
        `INSERT INTO pd_results (game_id, winner, loser, reason, reward, decided_at, onchain, finish_tx, finish_tx_at,
           finish_attempts, finish_error)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) ON CONFLICT (game_id) DO NOTHING`,
        [
          row.gameId,
          row.winner.toLowerCase(),
          row.loser.toLowerCase(),
          row.reason,
          row.reward,
          row.decidedAt,
          row.onchain,
          row.finishTx,
          row.finishTxAt,
          row.finishAttempts ?? 0,
          row.finishError ?? null,
        ]
      );
      return changed > 0;
    },
    async updateResult(gameId, patch) {
      const sets: string[] = [];
      const params: unknown[] = [];
      const add = (col: string, v: unknown) => {
        params.push(v);
        sets.push(`${col} = $${params.length}`);
      };
      if (patch.onchain !== undefined) add("onchain", patch.onchain);
      if (patch.finishTx !== undefined) add("finish_tx", patch.finishTx);
      if (patch.finishTxAt !== undefined) add("finish_tx_at", patch.finishTxAt);
      if (patch.finishAttempts !== undefined) add("finish_attempts", patch.finishAttempts);
      if (patch.finishError !== undefined) add("finish_error", patch.finishError);
      if (!sets.length) return;
      params.push(gameId);
      await db.run(`UPDATE pd_results SET ${sets.join(", ")} WHERE game_id = $${params.length}`, params);
    },

    getMeta: meta,
    async setMeta(key, value) {
      await setMeta(key, value);
    },

    async loadRooms() {
      return (await db.all("SELECT game_id, data FROM pd_rooms")).map((r) => ({
        gameId: String(r.game_id),
        data: String(r.data),
      }));
    },
    async saveRoom(gameId, data) {
      await db.run(
        `INSERT INTO pd_rooms (game_id, data, updated_at) VALUES ($1, $2, $3)
         ON CONFLICT (game_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`,
        [gameId, data, Date.now()]
      );
    },
    async deleteRoom(gameId) {
      await db.run("DELETE FROM pd_rooms WHERE game_id = $1", [gameId]);
    },
    async loadLobby() {
      return (await db.all("SELECT game_id, data FROM pd_lobby")).map((r) => ({
        gameId: String(r.game_id),
        data: String(r.data),
      }));
    },
    async saveLobbyGame(gameId, data) {
      await db.run(
        "INSERT INTO pd_lobby (game_id, data) VALUES ($1, $2) ON CONFLICT (game_id) DO UPDATE SET data = excluded.data",
        [gameId, data]
      );
    },
  };
}

// ── PostgreSQL ──────────────────────────────────────────────────────────────
interface PgPool {
  query(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }>;
  end(): Promise<void>;
}

async function tryPostgres(databaseUrl: string): Promise<Persistence | null> {
  let pg: { Pool: new (cfg: { connectionString: string }) => PgPool };
  try {
    // Non-literal specifier so TS treats the optional driver as untyped (we use
    // our own PgPool interface); avoids a hard @types/pg build dependency.
    const mod = (await import("pg" as string)) as { default?: typeof pg } & typeof pg;
    pg = mod.default ?? mod;
  } catch {
    console.warn("[db] 'pg' not installed — skipping Postgres");
    return null;
  }
  const pool = new pg.Pool({ connectionString: databaseUrl });
  const driver: SqlDriver = {
    kind: "postgres",
    async exec(sql) {
      await pool.query(sql);
    },
    async all(sql, params) {
      return (await pool.query(sql, params)).rows;
    },
    async run(sql, params) {
      return (await pool.query(sql, params)).rowCount ?? 0;
    },
  };
  try {
    await pool.query("SELECT 1");
    await driver.exec(SCHEMA);
    await migrate(driver);
  } catch (e) {
    console.warn("[db] Postgres unavailable — falling back to SQLite:", e instanceof Error ? e.message : e);
    await pool.end().catch(() => {});
    return null;
  }
  console.log("[db] persistence: PostgreSQL");
  return sqlPersistence(driver);
}

// ── SQLite (node:sqlite, built-in) ───────────────────────────────────────────
interface SqliteStmt {
  run(...params: unknown[]): { changes: number | bigint };
  all(...params: unknown[]): Record<string, unknown>[];
}
interface SqliteDb {
  exec(sql: string): void;
  prepare(sql: string): SqliteStmt;
}

async function trySqlite(path: string): Promise<Persistence | null> {
  type SqliteModule = { DatabaseSync: new (p: string) => SqliteDb };
  let DatabaseSync: SqliteModule["DatabaseSync"];
  try {
    ({ DatabaseSync } = (await import("node:sqlite" as string)) as SqliteModule);
  } catch {
    try {
      // Some loaders (vitest's) can't resolve newer node: builtins via import().
      ({ DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as SqliteModule);
    } catch {
      console.warn("[db] node:sqlite unavailable");
      return null;
    }
  }
  let db: SqliteDb;
  try {
    db = new DatabaseSync(path);
    db.exec(SCHEMA);
  } catch (e) {
    console.warn("[db] SQLite open failed:", e instanceof Error ? e.message : e);
    return null;
  }
  // $1 → ?1 (SQLite's numbered placeholder).
  const q = (sql: string) => sql.replace(/\$(\d+)/g, "?$1");
  const driver: SqlDriver = {
    kind: "sqlite",
    async exec(sql) {
      db.exec(sql);
    },
    async all(sql, params = []) {
      return db.prepare(q(sql)).all(...params);
    },
    async run(sql, params = []) {
      return Number(db.prepare(q(sql)).run(...params).changes);
    },
  };
  await migrate(driver);
  console.log(`[db] persistence: SQLite (${path})`);
  return sqlPersistence(driver);
}

// ── in-memory (dev / tests) ──────────────────────────────────────────────────

/** Same contract as the SQL backends, held in memory. Survives a server object
 *  being rebuilt in-process (tests share one across "restarts"), not a process exit. */
export function createMemoryPersistence(): Persistence {
  const entries = new Map<string, EntryRow>();
  const won = new Map<string, WonRow>();
  const counted = new Map<string, string>();
  let cursor: CursorState | null = null;
  const events = new Set<string>();
  const results = new Map<string, ResultRow>();
  const rooms = new Map<string, string>();
  const lobby = new Map<string, string>();
  const metaStore = new Map<string, string>();
  return {
    kind: "memory",
    async getMeta(key) {
      return metaStore.get(key) ?? null;
    },
    async setMeta(key, value) {
      metaStore.set(key, value);
    },
    async loadEntries() {
      return [...entries.values()].map((e) => ({ ...e }));
    },
    async loadWonGames() {
      return [...won.values()].map((w) => ({ ...w }));
    },
    async loadCounted() {
      return [...counted.entries()].map(([gameId, wonAmount]) => ({ gameId, wonAmount }));
    },
    async upsertEntry(row) {
      entries.set(row.address, { ...row });
    },
    async recordCounted(gameId, wonAmountWei) {
      if (!counted.has(gameId)) counted.set(gameId, wonAmountWei);
    },
    async upsertWonGame(winner, gameId, reward) {
      won.set(`${winner.toLowerCase()}|${gameId}`, { winner: winner.toLowerCase(), gameId, reward });
    },
    async loadCursor() {
      return cursor?.block ?? null;
    },
    async loadCursorState() {
      return cursor ? { ...cursor } : null;
    },
    async saveCursor(block, hash = null) {
      cursor = { block, hash };
    },
    async hasEvent(key) {
      return events.has(key);
    },
    async recordEvent(key) {
      if (events.has(key)) return false;
      events.add(key);
      return true;
    },
    async loadResults() {
      return [...results.values()].map((r) => ({ ...r }));
    },
    async insertResult(row) {
      if (results.has(row.gameId)) return false;
      results.set(row.gameId, { ...row, winner: row.winner.toLowerCase(), loser: row.loser.toLowerCase() });
      return true;
    },
    async updateResult(gameId, patch) {
      const r = results.get(gameId);
      if (r) Object.assign(r, patch);
    },
    async loadRooms() {
      return [...rooms.entries()].map(([gameId, data]) => ({ gameId, data }));
    },
    async saveRoom(gameId, data) {
      rooms.set(gameId, data);
    },
    async deleteRoom(gameId) {
      rooms.delete(gameId);
    },
    async loadLobby() {
      return [...lobby.entries()].map(([gameId, data]) => ({ gameId, data }));
    },
    async saveLobbyGame(gameId, data) {
      lobby.set(gameId, data);
    },
  };
}

/** Pick the persistence backend: Postgres if configured + reachable, else
 *  SQLite, else in-memory (loudly — results then don't survive a restart).
 *  Never throws. */
export async function createPersistence(config: ServerConfig): Promise<Persistence> {
  if (config.databaseUrl) {
    const pg = await tryPostgres(config.databaseUrl).catch(() => null);
    if (pg) return pg;
  }
  const sqlite = await trySqlite(config.sqlitePath ?? "leaderboard.db").catch(() => null);
  if (sqlite) return sqlite;
  console.error(
    "[db] NO PERSISTENT STORAGE — game results and live tables will be lost on restart. " +
      "Set DATABASE_URL (Postgres) or make node:sqlite available before running wagered games."
  );
  return createMemoryPersistence();
}
