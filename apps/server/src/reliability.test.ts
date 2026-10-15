// Restart / recovery behaviour — the lessons from Chess Dawgs:
//   - a decided game is stored before it's announced, and is never replayed
//     (a restart used to reopen it from the break → a second valid voucher);
//   - a live table survives a restart, with a fresh shot clock;
//   - an RPC outage is "try again", never "game doesn't exist";
//   - a game settled on-chain without a local result takes the chain's winner;
//   - paid-but-unplayed games get a table; unclaimed wins get one finishGame,
//     never a second while the first is pending.
import { afterEach, describe, expect, it } from "vitest";
import { io as ioc, type Socket } from "socket.io-client";
import { Wallet, type AbstractProvider } from "ethers";
import {
  loginMessage,
  type Address,
  type AuthPayload,
  type ClientToServerEvents,
  type ServerToClientEvents,
} from "@pooldawgs/shared";
import { createPoolDawgsServer, type PoolDawgsServer } from "./server.js";
import type { ServerConfig } from "./config.js";
import { createMemoryPersistence, type Persistence } from "./db/persistence.js";
import { ChainUnavailableError, type ChainGame, type ChainReader } from "./chain.js";
import type { Relayer } from "./relayer.js";
import { LeaderboardStore } from "./leaderboard.js";
import { LobbyStore } from "./lobby.js";
import { ResultStore } from "./results.js";
import { startRecovery } from "./recovery.js";
import { GameRoom, type RoomEmitter } from "./room.js";

type TestClient = Socket<ServerToClientEvents, ClientToServerEvents>;

const walletA = Wallet.createRandom();
const walletB = Wallet.createRandom();
const A = walletA.address.toLowerCase() as Address;
const B = walletB.address.toLowerCase() as Address;
const ZERO = "0x0000000000000000000000000000000000000000";

function devConfig(overrides: Partial<ServerConfig> = {}): ServerConfig {
  return {
    port: 0,
    corsOrigins: [],
    rpcUrl: null,
    contractAddress: null,
    ownerPrivateKey: null,
    shotClockMs: 60_000,
    chainEnabled: false,
    ...overrides,
  };
}

function chainConfig(overrides: Partial<ServerConfig> = {}): ServerConfig {
  return devConfig({
    chainEnabled: true,
    rpcUrl: "http://127.0.0.1:1",
    rpcUrls: ["http://127.0.0.1:1"],
    contractAddress: "0x1a0ff1B3B4D20495B12367f291A8639B9B268764",
    ...overrides,
  });
}

/** Deterministic fake relayer: voucher = "v:<gameId>:<winner>". */
function fakeRelayer() {
  const sent: Array<{ gameId: string; winner: string; hash: string }> = [];
  const refunds: Array<{ gameId: string; hash: string }> = [];
  const txStatus = new Map<string, "pending" | "succeeded" | "failed" | "dropped">();
  const relayer: Relayer = {
    async signResult(gameId, winner) {
      return `v:${gameId}:${winner.toLowerCase()}`;
    },
    async finishGame(gameId, winner) {
      const hash = `0x${(sent.length + 1).toString(16).padStart(64, "0")}`;
      sent.push({ gameId, winner, hash });
      txStatus.set(hash, "pending");
      return hash;
    },
    async refundUnstarted(gameId) {
      const hash = `0xr${(refunds.length + 1).toString(16).padStart(63, "0")}`;
      refunds.push({ gameId, hash });
      txStatus.set(hash, "pending");
      return hash;
    },
    async txStatus(hash) {
      return txStatus.get(hash) ?? "dropped";
    },
    async balance() {
      return 10n ** 18n;
    },
  };
  return { relayer, sent, refunds, txStatus };
}

function chainGame(over: Partial<ChainGame> = {}): ChainGame {
  return {
    playerOne: walletA.address,
    playerTwo: walletB.address,
    isCompleted: false,
    winner: ZERO,
    stake: 10n ** 21n,
    rewardClaimed: false,
    drawCompleted: false,
    ...over,
  };
}

function fakeChain(games: Record<string, ChainGame>) {
  let down = false;
  const reader: ChainReader = {
    async getGame(gameId) {
      if (down) throw new ChainUnavailableError(new Error("HTTP 503"));
      return games[gameId] ?? null;
    },
  };
  return { reader, games, setDown: (v: boolean) => (down = v) };
}

async function makeAuth(wallet: Wallet): Promise<AuthPayload> {
  const address = wallet.address as Address;
  const ts = Date.now();
  return { address, ts, signature: await wallet.signMessage(loginMessage(address, ts)) };
}

function waitFor<E extends keyof ServerToClientEvents>(socket: TestClient, event: E, ms = 8000) {
  return new Promise<Parameters<ServerToClientEvents[E]>[0]>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${String(event)}`)), ms);
    socket.once(event as never, ((payload: never) => {
      clearTimeout(timer);
      resolve(payload);
    }) as never);
  });
}

let servers: PoolDawgsServer[] = [];
let clients: TestClient[] = [];

async function start(
  config: ServerConfig,
  persist: Persistence,
  relayer: Relayer = fakeRelayer().relayer,
  reader?: ChainReader
): Promise<{ server: PoolDawgsServer; port: number }> {
  const leaderboard = new LeaderboardStore(persist);
  await leaderboard.load();
  const server = createPoolDawgsServer(config, relayer, reader, leaderboard, {
    persist,
    background: false,
    provider: {} as AbstractProvider,
  });
  await server.ready;
  servers.push(server);
  await new Promise<void>((resolve) => server.httpServer.listen(0, resolve));
  const addr = server.httpServer.address();
  if (typeof addr !== "object" || !addr) throw new Error("no port");
  return { server, port: addr.port };
}

async function stop(server: PoolDawgsServer) {
  for (const c of clients) c.disconnect();
  clients = [];
  await server.close();
  servers = servers.filter((s) => s !== server);
}

function connect(port: number): TestClient {
  const socket: TestClient = ioc(`http://127.0.0.1:${port}`, { transports: ["websocket"] });
  clients.push(socket);
  return socket;
}

async function joinBoth(port: number, gameId: string, dev = true) {
  const a = connect(port);
  const b = connect(port);
  const aState = waitFor(a, "room:state");
  a.emit("room:join", { gameId, auth: await makeAuth(walletA) });
  if (dev) await new Promise((r) => setTimeout(r, 250));
  else await aState;
  const bState = waitFor(b, "room:state");
  b.emit("room:join", { gameId, auth: await makeAuth(walletB) });
  return { a, b, snapshot: await bState };
}

afterEach(async () => {
  for (const c of clients) c.disconnect();
  clients = [];
  for (const s of servers) await s.close();
  servers = [];
});

describe("a decided game is final", () => {
  it("is stored before it is announced, and a restart never replays it", async () => {
    const persist = createMemoryPersistence();
    const first = await start(devConfig(), persist);
    const { a, b } = await joinBoth(first.port, "g1");
    const over = waitFor(b, "game:over");
    a.emit("game:resign", { gameId: "g1" }); // A resigns → B wins
    expect((await over).winner).toBe(B);
    expect((await persist.loadResults()).map((r) => [r.gameId, r.winner])).toEqual([["g1", B]]);

    // Restart (a deploy). Both players come back to the same game.
    await stop(first.server);
    const second = await start(devConfig(), persist);
    const { snapshot } = await joinBoth(second.port, "g1");

    // Still decided, same winner, no fresh frame to play.
    expect(snapshot.over?.winner).toBe(B);
    expect(snapshot.over?.voucher).toBe(`v:g1:${B}`);
    const refusal = waitFor(clients[0], "server:error");
    clients[0].emit("game:shoot", { gameId: "g1", shot: { angle: 0, power: 30 } });
    expect((await refusal).message).toBe("game is over");
  });

  it("only the recorded winner's voucher is ever handed out", async () => {
    const persist = createMemoryPersistence();
    const { port } = await start(devConfig(), persist);
    const { a, b } = await joinBoth(port, "g2");
    const over = waitFor(a, "game:over");
    b.emit("game:resign", { gameId: "g2" }); // B resigns → A wins
    await over;

    for (const [wallet, expected] of [
      [A, `v:g2:${A}`],
      [B, undefined],
    ] as const) {
      const c = connect(port);
      const profile = waitFor(c, "profile:state");
      c.emit("profile:get", { address: wallet });
      const won = (await profile).wonGames.find((g) => g.gameId === "g2");
      expect(won?.voucher ?? undefined).toBe(expected);
    }
  });

  it("if the result can't be stored, the table freezes and retries — nothing is announced unsaved", async () => {
    const persist = createMemoryPersistence();
    let failures = 1;
    const flaky: Persistence = {
      ...persist,
      async insertResult(row) {
        if (failures-- > 0) throw new Error("db down");
        return persist.insertResult(row);
      },
    };
    const { port } = await start(devConfig(), flaky);
    const { a, b } = await joinBoth(port, "g3");
    const over = waitFor(b, "game:over");
    a.emit("game:resign", { gameId: "g3" });

    // While the write is being retried, no shot is accepted.
    const refusal = waitFor(b, "server:error", 900);
    b.emit("game:shoot", { gameId: "g3", shot: { angle: 0, power: 30 } });
    expect((await refusal).message).toBe("game is over");

    expect((await over).winner).toBe(B); // announced after the retry succeeded
    expect((await persist.loadResults()).length).toBe(1);
  });
});

describe("a live table survives a restart", () => {
  it("resumes the exact position with the time that was left (paused until the players are back)", async () => {
    const persist = createMemoryPersistence();
    const first = await start(devConfig(), persist);
    const { a, b } = await joinBoth(first.port, "g4");
    const shot = waitFor(b, "game:shot");
    a.emit("game:shoot", { gameId: "g4", shot: { angle: 0.1, power: 40 } });
    const { endStateHash } = await shot;
    await new Promise((r) => setTimeout(r, 50)); // let the save land
    await stop(first.server);

    const before = Date.now();
    const second = await start(devConfig(), persist);
    expect(second.server.rooms.has("g4")).toBe(true);
    const { snapshot } = await joinBoth(second.port, "g4");
    expect(snapshot.stateHash).toBe(endStateHash);
    expect(snapshot.over).toBeNull();
    // A's shot ended the turn just before the stop, so B has almost the full clock.
    expect(snapshot.turnId).toBe(1);
    expect(snapshot.clockRemainingMs).toBeGreaterThan(55_000);
    expect(snapshot.clockRemainingMs).toBeLessThanOrEqual(60_000);
    expect(snapshot.clockExpiresAt).toBeGreaterThanOrEqual(before + 55_000);
  });
});

describe("chain reads", () => {
  it("an RPC outage is 'try again', not 'game doesn't exist'", async () => {
    const chain = fakeChain({ g5: chainGame() });
    const { port } = await start(chainConfig(), createMemoryPersistence(), undefined, chain.reader);
    chain.setDown(true);
    const c = connect(port);
    const error = waitFor(c, "server:error");
    c.emit("room:join", { gameId: "g5", auth: await makeAuth(walletA) });
    expect((await error).code).toBe("chain-unavailable");

    chain.setDown(false);
    const state = waitFor(c, "room:state");
    c.emit("room:join", { gameId: "g5", auth: await makeAuth(walletA) });
    expect((await state).players.map((p) => p.address)).toEqual([A, B]);
  });

  it("a game settled on-chain without a local result shows the chain's winner, never a new frame", async () => {
    const chain = fakeChain({ g6: chainGame({ isCompleted: true, winner: walletB.address }) });
    const persist = createMemoryPersistence();
    const { port } = await start(chainConfig(), persist, undefined, chain.reader);
    const c = connect(port);
    const state = waitFor(c, "room:state");
    c.emit("room:join", { gameId: "g6", auth: await makeAuth(walletA) });
    const snap = await state;
    expect(snap.over?.winner).toBe(B);
    expect(snap.over?.voucher).toBeUndefined(); // already on-chain: claim with claimReward
    expect((await persist.loadResults())[0]).toMatchObject({ gameId: "g6", winner: B, onchain: "finished" });
  });
});

describe("recovery sweeps", () => {
  async function setup(games: Record<string, ChainGame>, config = chainConfig({ operatorPrivateKey: "0x01" })) {
    const persist = createMemoryPersistence();
    const results = new ResultStore(persist);
    const lobby = new LobbyStore(persist);
    const chain = fakeChain(games);
    const fake = fakeRelayer();
    const opened: string[] = [];
    const recovery = startRecovery(
      {
        config,
        relayer: fake.relayer,
        chainReader: chain.reader,
        results,
        lobby,
        rooms: new Map(),
        ensureLive: async (id) => {
          opened.push(id);
        },
      },
      { timers: false }
    );
    return { persist, results, lobby, chain, fake, opened, recovery };
  }

  it("opens a table for a paid game nobody started", async () => {
    const t = await setup({});
    t.lobby.upsertCreated("g7", A, "1", 0);
    t.lobby.markJoined("g7", B);
    t.lobby.upsertCreated("g8", A, "1", 0); // open, not joined — nothing to do
    await t.recovery.sweepUnplayed();
    expect(t.opened).toEqual(["g7"]);
  });

  it("records an unclaimed win on-chain once — never again while that tx is pending", async () => {
    const t = await setup({ g9: chainGame() });
    await t.results.record({ gameId: "g9", winner: B, loser: A, reason: "pot", reward: "1" });
    const later = Date.now() + 25 * 3_600_000;

    await t.recovery.sweepUnclaimed(Date.now()); // too early
    expect(t.fake.sent).toHaveLength(0);

    await t.recovery.sweepUnclaimed(later);
    expect(t.fake.sent).toEqual([{ gameId: "g9", winner: B, hash: expect.any(String) }]);

    await t.recovery.sweepUnclaimed(later); // still pending → nothing new
    expect(t.fake.sent).toHaveLength(1);

    t.fake.txStatus.set(t.fake.sent[0].hash, "dropped"); // dropped → one replacement
    await t.recovery.sweepUnclaimed(later);
    expect(t.fake.sent).toHaveLength(2);

    t.chain.games.g9 = chainGame({ isCompleted: true, winner: walletB.address }); // mined
    await t.recovery.sweepUnclaimed(later);
    expect(t.fake.sent).toHaveLength(2);
    expect(t.results.get("g9")?.onchain).toBe("finished");
  });

  it("reports what needs a human, and stays quiet when nothing does", async () => {
    const t = await setup({ g10: chainGame() }, chainConfig()); // no relayer key
    expect(await t.recovery.buildReport()).toBeNull();
    await t.results.record({ gameId: "g10", winner: B, loser: A, reason: "pot", reward: "1" });
    const text = await t.recovery.buildReport(Date.now() + 25 * 3_600_000);
    expect(text).toContain("1 win(s) unclaimed");
    expect(text).toContain("no OPERATOR_PRIVATE_KEY");
  });
});

describe("existing data", () => {
  it("wins recorded before results existed are adopted, so they can't be replayed either", async () => {
    const persist = createMemoryPersistence();
    await persist.upsertWonGame(B, "old-1", "800");
    const leaderboard = new LeaderboardStore(persist);
    await leaderboard.load();
    const results = new ResultStore(persist);
    await results.load(leaderboard.allWonGames());
    expect(results.get("old-1")).toMatchObject({ winner: B, onchain: "pending" });
  });
});

describe("waiting room: nothing counts until both players are at the table", () => {
  it("no shot clock while only one player is there; the clock starts when both are", async () => {
    const chain = fakeChain({ w1: chainGame() });
    const { port } = await start(chainConfig({ shotClockMs: 400 }), createMemoryPersistence(), undefined, chain.reader);
    const a = connect(port);
    const first = waitFor(a, "room:state");
    a.emit("room:join", { gameId: "w1", auth: await makeAuth(walletA) });
    const waiting = await first;
    expect(waiting.waiting).toBe(true);
    expect(waiting.clockExpiresAt).toBe(0);

    // Well past the (400 ms) shot clock: nobody forfeits in a waiting room.
    let over = false;
    a.on("game:over", () => (over = true));
    await new Promise((r) => setTimeout(r, 900));
    expect(over).toBe(false);
    const refusal = waitFor(a, "server:error");
    a.emit("game:shoot", { gameId: "w1", shot: { angle: 0, power: 30 } });
    expect((await refusal).message).toMatch(/both players are at the table/);

    // The opponent arrives: the game is live and the clock runs from now.
    const b = connect(port);
    const live = waitFor(b, "room:state");
    b.emit("room:join", { gameId: "w1", auth: await makeAuth(walletB) });
    const snap = await live;
    expect(snap.waiting).toBe(false);
    expect(snap.clockExpiresAt).toBeGreaterThan(Date.now());

    // ...and now being away does cost the game.
    const forfeit = await waitFor(b, "game:over", 3000);
    expect(forfeit.reason).toBe("timeout");
  });

  describe("an expired waiting room refunds both stakes", () => {
    const noop: RoomEmitter = { broadcastShot() {}, broadcastCuePlaced() {}, broadcastState() {}, broadcastOver() {} };

    async function setup(game: ChainGame, config = chainConfig({ operatorPrivateKey: "0x01", waitingRoomTimeoutMs: 1_000 })) {
      const chain = fakeChain({ w2: game });
      const fake = fakeRelayer();
      const rooms = new Map<string, GameRoom>();
      const finished: string[] = [];
      const room = new GameRoom("w2", [A, B], noop, fake.relayer, 60_000, "1", "8ball", () => null, {
        waitingTimeoutMs: 1_000,
      });
      rooms.set("w2", room);
      const recovery = startRecovery(
        {
          config,
          relayer: fake.relayer,
          chainReader: chain.reader,
          results: new ResultStore(createMemoryPersistence()),
          lobby: new LobbyStore(null),
          rooms,
          ensureLive: async () => {},
          finishRefund: async (id) => {
            finished.push(id);
            rooms.delete(id);
          },
        },
        { timers: false }
      );
      return { chain, fake, room, rooms, finished, recovery };
    }

    it("refunds once, never twice while pending, resends if dropped, closes when done", async () => {
      const t = await setup(chainGame());
      await t.recovery.sweepWaitingRooms(Date.now()); // too early
      expect(t.fake.refunds).toHaveLength(0);

      const later = Date.now() + 5_000;
      await t.recovery.sweepWaitingRooms(later);
      expect(t.fake.refunds.map((r) => r.gameId)).toEqual(["w2"]);
      expect(t.room.snapshot().refund).toMatchObject({ done: false });

      // Both players turn up now — too late: the refund is under way, the game can't start.
      t.room.connect(A);
      t.room.connect(B);
      expect(t.room.snapshot().waiting).toBe(true);
      expect(t.room.handleShot(A, { angle: 0, power: 30 }).ok).toBe(false);

      await t.recovery.sweepWaitingRooms(later); // pending → nothing new
      expect(t.fake.refunds).toHaveLength(1);
      t.fake.txStatus.set(t.fake.refunds[0].hash, "dropped"); // dropped → one replacement
      await t.recovery.sweepWaitingRooms(later);
      expect(t.fake.refunds).toHaveLength(2);

      t.chain.games.w2 = chainGame({ isCompleted: true, rewardClaimed: true }); // refunded on-chain
      await t.recovery.sweepWaitingRooms(later);
      expect(t.finished).toEqual(["w2"]);
      expect(t.fake.refunds).toHaveLength(2);
    });

    it("a game that started is never refunded", async () => {
      const t = await setup(chainGame());
      t.room.connect(A);
      t.room.connect(B); // both here → live
      await t.recovery.sweepWaitingRooms(Date.now() + 60 * 60_000);
      expect(t.fake.refunds).toHaveLength(0);
      expect(t.room.snapshot().waiting).toBe(false);
      t.room.dispose();
    });
  });
});
