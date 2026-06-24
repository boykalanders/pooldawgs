// Persistent storage for the leaderboard. PostgreSQL is used when DATABASE_URL
// is set and reachable; otherwise the server falls back to SQLite (a local
// file via Node's built-in node:sqlite); if neither is available it degrades to
// no persistence (the leaderboard still works in memory, rebuilt from chain on
// each boot). Drivers are imported dynamically so a missing driver never breaks
// the build — it just falls through to the next option.

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

/** Storage backend the leaderboard writes through to and loads from on boot. */
export interface Persistence {
  readonly kind: "postgres" | "sqlite";
  loadEntries(): Promise<EntryRow[]>;
  loadWonGames(): Promise<WonRow[]>;
  loadCounted(): Promise<CountedRow[]>;
  loadCursor(): Promise<number | null>;
  saveCursor(block: number): Promise<void>;
  upsertEntry(row: EntryRow): Promise<void>;
  recordCounted(gameId: string, wonAmountWei: string): Promise<void>;
  upsertWonGame(winner: string, gameId: string, reward: string): Promise<void>;
}

// ── PostgreSQL ──────────────────────────────────────────────────────────────
interface PgPool {
  query(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
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
  try {
    await pool.query("SELECT 1");
    await pool.query(`
      CREATE TABLE IF NOT EXISTS lb_entries (
        address TEXT PRIMARY KEY, wins INTEGER NOT NULL DEFAULT 0,
        losses INTEGER NOT NULL DEFAULT 0, won_amount TEXT NOT NULL DEFAULT '0');
      CREATE TABLE IF NOT EXISTS lb_won_games (
        winner TEXT NOT NULL, game_id TEXT NOT NULL, reward TEXT NOT NULL,
        PRIMARY KEY (winner, game_id));
      CREATE TABLE IF NOT EXISTS lb_counted (
        game_id TEXT PRIMARY KEY, won_amount TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS lb_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `);
  } catch (e) {
    console.warn("[db] Postgres unavailable — falling back to SQLite:", e instanceof Error ? e.message : e);
    await pool.end().catch(() => {});
    return null;
  }
  console.log("[db] leaderboard persistence: PostgreSQL");
  return {
    kind: "postgres",
    async loadEntries() {
      const { rows } = await pool.query("SELECT address, wins, losses, won_amount FROM lb_entries");
      return rows.map((r) => ({
        address: String(r.address),
        wins: Number(r.wins),
        losses: Number(r.losses),
        wonAmount: String(r.won_amount),
      }));
    },
    async loadWonGames() {
      const { rows } = await pool.query("SELECT winner, game_id, reward FROM lb_won_games");
      return rows.map((r) => ({ winner: String(r.winner), gameId: String(r.game_id), reward: String(r.reward) }));
    },
    async loadCounted() {
      const { rows } = await pool.query("SELECT game_id, won_amount FROM lb_counted");
      return rows.map((r) => ({ gameId: String(r.game_id), wonAmount: String(r.won_amount) }));
    },
    async loadCursor() {
      const { rows } = await pool.query("SELECT value FROM lb_meta WHERE key = 'cursor'");
      return rows.length ? Number(rows[0].value) : null;
    },
    async saveCursor(block) {
      await pool.query(
        "INSERT INTO lb_meta (key, value) VALUES ('cursor', $1) ON CONFLICT (key) DO UPDATE SET value = $1",
        [String(block)]
      );
    },
    async upsertEntry(row) {
      await pool.query(
        `INSERT INTO lb_entries (address, wins, losses, won_amount) VALUES ($1, $2, $3, $4)
         ON CONFLICT (address) DO UPDATE SET wins = $2, losses = $3, won_amount = $4`,
        [row.address, row.wins, row.losses, row.wonAmount]
      );
    },
    async recordCounted(gameId, wonAmountWei) {
      await pool.query(
        "INSERT INTO lb_counted (game_id, won_amount) VALUES ($1, $2) ON CONFLICT (game_id) DO NOTHING",
        [gameId, wonAmountWei]
      );
    },
    async upsertWonGame(winner, gameId, reward) {
      await pool.query(
        `INSERT INTO lb_won_games (winner, game_id, reward) VALUES ($1, $2, $3)
         ON CONFLICT (winner, game_id) DO UPDATE SET reward = $3`,
        [winner.toLowerCase(), gameId, reward]
      );
    },
  };
}

// ── SQLite (node:sqlite, built-in) ───────────────────────────────────────────
interface SqliteStmt {
  run(...params: unknown[]): unknown;
  all(...params: unknown[]): Record<string, unknown>[];
  get(...params: unknown[]): Record<string, unknown> | undefined;
}
interface SqliteDb {
  exec(sql: string): void;
  prepare(sql: string): SqliteStmt;
}

async function trySqlite(path: string): Promise<Persistence | null> {
  let DatabaseSync: new (p: string) => SqliteDb;
  try {
    ({ DatabaseSync } = (await import("node:sqlite" as string)) as {
      DatabaseSync: new (p: string) => SqliteDb;
    });
  } catch {
    console.warn("[db] node:sqlite unavailable — leaderboard will be in-memory only");
    return null;
  }
  let db: SqliteDb;
  try {
    db = new DatabaseSync(path);
    db.exec(`
      CREATE TABLE IF NOT EXISTS lb_entries (address TEXT PRIMARY KEY, wins INTEGER NOT NULL DEFAULT 0,
        losses INTEGER NOT NULL DEFAULT 0, won_amount TEXT NOT NULL DEFAULT '0');
      CREATE TABLE IF NOT EXISTS lb_won_games (winner TEXT NOT NULL, game_id TEXT NOT NULL,
        reward TEXT NOT NULL, PRIMARY KEY (winner, game_id));
      CREATE TABLE IF NOT EXISTS lb_counted (game_id TEXT PRIMARY KEY, won_amount TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS lb_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `);
  } catch (e) {
    console.warn("[db] SQLite open failed — in-memory only:", e instanceof Error ? e.message : e);
    return null;
  }
  console.log(`[db] leaderboard persistence: SQLite (${path})`);
  return {
    kind: "sqlite",
    async loadEntries() {
      return db.prepare("SELECT address, wins, losses, won_amount FROM lb_entries").all().map((r) => ({
        address: String(r.address),
        wins: Number(r.wins),
        losses: Number(r.losses),
        wonAmount: String(r.won_amount),
      }));
    },
    async loadWonGames() {
      return db.prepare("SELECT winner, game_id, reward FROM lb_won_games").all().map((r) => ({
        winner: String(r.winner),
        gameId: String(r.game_id),
        reward: String(r.reward),
      }));
    },
    async loadCounted() {
      return db.prepare("SELECT game_id, won_amount FROM lb_counted").all().map((r) => ({
        gameId: String(r.game_id),
        wonAmount: String(r.won_amount),
      }));
    },
    async loadCursor() {
      const row = db.prepare("SELECT value FROM lb_meta WHERE key = 'cursor'").get();
      return row ? Number(row.value) : null;
    },
    async saveCursor(block) {
      db.prepare(
        "INSERT INTO lb_meta (key, value) VALUES ('cursor', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value"
      ).run(String(block));
    },
    async upsertEntry(row) {
      db.prepare(
        `INSERT INTO lb_entries (address, wins, losses, won_amount) VALUES (?, ?, ?, ?)
         ON CONFLICT (address) DO UPDATE SET wins = excluded.wins, losses = excluded.losses, won_amount = excluded.won_amount`
      ).run(row.address, row.wins, row.losses, row.wonAmount);
    },
    async recordCounted(gameId, wonAmountWei) {
      db.prepare("INSERT INTO lb_counted (game_id, won_amount) VALUES (?, ?) ON CONFLICT (game_id) DO NOTHING").run(
        gameId,
        wonAmountWei
      );
    },
    async upsertWonGame(winner, gameId, reward) {
      db.prepare(
        `INSERT INTO lb_won_games (winner, game_id, reward) VALUES (?, ?, ?)
         ON CONFLICT (winner, game_id) DO UPDATE SET reward = excluded.reward`
      ).run(winner.toLowerCase(), gameId, reward);
    },
  };
}

/** Pick the persistence backend: Postgres if configured + reachable, else
 *  SQLite, else null (in-memory only). Never throws. */
export async function createPersistence(config: ServerConfig): Promise<Persistence | null> {
  if (config.databaseUrl) {
    const pg = await tryPostgres(config.databaseUrl).catch(() => null);
    if (pg) return pg;
  }
  return trySqlite(config.sqlitePath).catch(() => null);
}
