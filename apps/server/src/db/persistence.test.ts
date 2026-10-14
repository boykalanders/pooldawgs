// The SQL store (SQLite here; Postgres runs the same statements).
import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPersistence, type ResultRow } from "./persistence.js";
import type { ServerConfig } from "../config.js";

const dir = mkdtempSync(join(tmpdir(), "pooldawgs-db-"));
afterAll(() => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // Windows keeps the SQLite files locked until the process exits; the OS temp dir is cleaned anyway.
  }
});

const config = (file: string) =>
  ({ sqlitePath: join(dir, file), databaseUrl: null }) as unknown as ServerConfig;

const result = (over: Partial<ResultRow> = {}): ResultRow => ({
  gameId: "g1",
  winner: "0xAA",
  loser: "0xBB",
  reason: "pot",
  reward: "800",
  decidedAt: 1,
  onchain: "pending",
  finishTx: null,
  finishTxAt: null,
  ...over,
});

describe("SQLite persistence", () => {
  it("keeps the first result for a game; later ones are refused", async () => {
    const db = await createPersistence(config("a.db"));
    expect(db.kind).toBe("sqlite");
    expect(await db.insertResult(result())).toBe(true);
    expect(await db.insertResult(result({ winner: "0xBB", loser: "0xAA" }))).toBe(false);
    await db.updateResult("g1", { onchain: "finished", finishTx: "0xhash", finishTxAt: 5 });
    expect(await db.loadResults()).toEqual([
      result({ winner: "0xaa", loser: "0xbb", onchain: "finished", finishTx: "0xhash", finishTxAt: 5 }),
    ]);
  });

  it("records each chain event once", async () => {
    const db = await createPersistence(config("b.db"));
    expect(await db.recordEvent("1:0xc:0xtx:0", 10, "GameCreated", "g1")).toBe(true);
    expect(await db.recordEvent("1:0xc:0xtx:0", 10, "GameCreated", "g1")).toBe(false);
    expect(await db.hasEvent("1:0xc:0xtx:0")).toBe(true);
    expect(await db.hasEvent("1:0xc:0xtx:1")).toBe(false);
  });

  it("survives a reopen: cursor, live tables, lobby", async () => {
    const first = await createPersistence(config("c.db"));
    await first.saveCursor(1234, "0xblockhash");
    await first.saveRoom("g2", '{"x":1}');
    await first.saveRoom("g2", '{"x":2}');
    await first.saveRoom("g3", '{"x":3}');
    await first.deleteRoom("g3");
    await first.saveLobbyGame("g2", '{"status":"active"}');

    const reopened = await createPersistence(config("c.db"));
    expect(await reopened.loadCursorState()).toEqual({ block: 1234, hash: "0xblockhash" });
    expect(await reopened.loadRooms()).toEqual([{ gameId: "g2", data: '{"x":2}' }]);
    expect(await reopened.loadLobby()).toEqual([{ gameId: "g2", data: '{"status":"active"}' }]);
  });
});
