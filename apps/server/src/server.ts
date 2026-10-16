import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import { Server } from "socket.io";
import type { AbstractProvider } from "ethers";
import {
  MAX_CHAT_LENGTH,
  gameTypeFromId,
  type Address,
  type ClientToServerEvents,
  type GameOverReason,
  type LobbyGame,
  type ServerError,
  type ServerToClientEvents,
} from "@pooldawgs/shared";
import { verifyAuth } from "./auth.js";
import { ChainUnavailableError, createChainReader, ZeroAddress, type ChainReader } from "./chain.js";
import { startChainListener, type ChainListener } from "./chain-events.js";
import type { ServerConfig } from "./config.js";
import { createMemoryPersistence, type Persistence } from "./db/persistence.js";
import { LeaderboardStore } from "./leaderboard.js";
import { LobbyStore } from "./lobby.js";
import { ProfileStore } from "./profile.js";
import { startRecovery, type Recovery } from "./recovery.js";
import { createRelayer, type Relayer } from "./relayer.js";
import { finalizationStatus, ResultStore, type FinalizationStatus } from "./results.js";
import { GameRoom, type RoomEmitter, type RoomHooks, type SerializedRoom } from "./room.js";
import { createRpcProvider, providerStatus, rpcMetrics } from "./rpc.js";

interface SocketData {
  address?: Address;
}

type IoServer = Server<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData>;

export interface PoolDawgsServer {
  httpServer: HttpServer;
  io: IoServer;
  lobby: LobbyStore;
  results: ResultStore;
  rooms: Map<string, GameRoom>;
  /** Resolves once stored results, the lobby and live tables are loaded. */
  ready: Promise<void>;
  close(): Promise<void>;
}

export interface ServerOptions {
  /** Storage (defaults to in-memory — tests/dev). */
  persist?: Persistence;
  /** HTTP provider for chain reads/backfills (defaults to the failover provider). */
  provider?: AbstractProvider;
  /** Start the chain event listener and recovery sweeps (default: true). */
  background?: boolean;
}

const roomChannel = (gameId: string) => `game:${gameId}`;

/** Server liveness heartbeat (one tiny write per second for the whole server,
 *  not per table): after a crash, running shot clocks are charged up to the
 *  last beat, so at most HEARTBEAT_MS of a player's time is ever in doubt, and
 *  it's given back to them. A clean shutdown records the exact moment. */
const ALIVE_KEY = "server_alive_at";
const HEARTBEAT_MS = 1_000;

/** Winner's payout: 80% of the two-stake pot. */
const winnerShare = (stakeWei: string | null | undefined) =>
  ((BigInt(stakeWei ?? "0") * 2n * 8000n) / 10000n).toString();

export function createPoolDawgsServer(
  config: ServerConfig,
  relayer: Relayer = createRelayer(config),
  chainReaderArg?: ChainReader,
  // Built (with persistence) and pre-loaded by the caller; defaults to an
  // ephemeral in-memory store for tests/dev.
  leaderboard: LeaderboardStore = new LeaderboardStore(),
  options: ServerOptions = {}
): PoolDawgsServer {
  const profiles = new ProfileStore(config.dataDir ?? process.cwd());
  const persist = options.persist ?? createMemoryPersistence();
  const provider =
    options.provider ??
    (config.chainEnabled ? createRpcProvider(config.rpcUrls ?? [config.rpcUrl!], config.chainId) : null);
  const chainReader = chainReaderArg ?? createChainReader(config, provider ?? undefined);
  const results = new ResultStore(persist);
  const lobby = new LobbyStore(persist);
  const rooms = new Map<string, GameRoom>();
  let chainListener: ChainListener | null = null;
  let recovery: Recovery | null = null;

  // Accept the configured origins PLUS any localhost / 127.0.0.1 origin (any
  // port). This avoids the common local-testing trap where the page is opened
  // on 127.0.0.1 but CORS only allowed localhost (or vice versa), which
  // silently blocks the WebSocket and leaves the client stuck "connecting".
  const isAllowedOrigin = (origin?: string): boolean => {
    if (!origin) return true; // non-browser clients (curl, node, the e2e)
    if (config.corsOrigins.includes(origin)) return true;
    return /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
  };

  const json = (res: import("node:http").ServerResponse, cors: Record<string, string>, body: unknown) => {
    res.writeHead(200, { "content-type": "application/json", ...cors });
    res.end(JSON.stringify(body, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
  };

  const httpServer = createHttpServer((req, res) => {
    const origin = req.headers.origin;
    const cors = {
      "access-control-allow-origin": isAllowedOrigin(origin) ? origin ?? "*" : "null",
    };
    if (req.url === "/health") {
      json(res, cors, { ok: true, chainEnabled: config.chainEnabled, storage: persist.kind });
      return;
    }
    if (req.url === "/health/chain") {
      // Monitoring: event stream, RPC usage and recovery backlog. No secrets.
      const pending = results.all().filter((r) => r.onchain === "pending");
      const finalization: Record<FinalizationStatus, number> = { pending: 0, submitted: 0, confirmed: 0, failed: 0 };
      for (const r of results.all()) finalization[finalizationStatus(r)]++;
      json(res, cors, {
        storage: persist.kind,
        events: chainListener?.status() ?? null,
        providers: providerStatus(),
        rpc: rpcMetrics.snapshot(),
        liveTables: [...rooms.values()].filter((r) => !r.isOver()).length,
        unclaimedWins: pending.length,
        backstopFinishesInFlight: pending.filter((r) => r.finishTx).length,
        finalization,
        // Every unsettled win with its transaction details (newest first).
        finalizations: pending
          .sort((x, y) => y.decidedAt - x.decidedAt)
          .slice(0, 50)
          .map((r) => ({
            gameId: r.gameId,
            status: finalizationStatus(r),
            winner: r.winner,
            reward: r.reward,
            decidedAt: r.decidedAt,
            finishTx: r.finishTx,
            finishTxAt: r.finishTxAt,
            attempts: r.finishAttempts,
            error: r.finishError,
          })),
        recovery: recovery?.status() ?? null,
      });
      return;
    }
    if (req.url === "/leaderboard") {
      json(res, cors, { entries: leaderboard.top(), stats: leaderboard.stats() });
      return;
    }
    res.writeHead(404);
    res.end();
  });

  const io: IoServer = new Server(httpServer, {
    cors: { origin: (origin, cb) => cb(null, isAllowedOrigin(origin)) },
    // Heartbeat: a ping every 5 s; a player is disconnected after ~15 s of
    // silence (5 s interval + 10 s timeout), which starts their reconnect grace.
    pingInterval: 5_000,
    pingTimeout: 10_000,
  });

  // Decorate lobby rows with playerOne's display name so the browse list and
  // join screens can show who's hosting.
  const withNames = (games: LobbyGame[]): LobbyGame[] =>
    games.map((g) => ({ ...g, playerOneName: profiles.getName(g.playerOne) }));

  lobby.onChange(() => {
    io.to("lobby").emit("lobby:state", { games: withNames(lobby.list()) });
  });

  function makeEmitter(gameId: string): RoomEmitter {
    const channel = roomChannel(gameId);
    return {
      broadcastShot: (p) => io.to(channel).emit("game:shot", p),
      broadcastCuePlaced: (p) => io.to(channel).emit("game:cueBallPlaced", p),
      broadcastState: (p) => io.to(channel).emit("room:state", p),
      broadcastOver: (p) => {
        io.to(channel).emit("game:over", p);
        lobby.markStatus(gameId, "finished");
      },
    };
  }

  // ── storage hooks for rooms ──
  // Saves for one table are chained so they land in order (and the delete after them).
  const roomWrites = new Map<string, Promise<void>>();
  const queueRoomWrite = (gameId: string, write: () => Promise<void>) => {
    const next = (roomWrites.get(gameId) ?? Promise.resolve())
      .then(write)
      .catch((e) => console.error(`[room] ${gameId}: could not save the table:`, e instanceof Error ? e.message : e));
    roomWrites.set(gameId, next);
    void next.then(() => {
      if (roomWrites.get(gameId) === next) roomWrites.delete(gameId);
    });
  };

  /** Record a decided game in the results store and the leaderboard. Throws if
   *  it can't be stored. The first result for a game always stands. */
  async function recordResult(input: {
    gameId: string;
    winner: Address;
    loser: Address | string;
    reason: string;
    reward?: string;
    onchain?: "pending" | "finished" | "claimed";
  }) {
    const stake = lobby.get(input.gameId)?.stake ?? rooms.get(input.gameId)?.stakeWei() ?? "0";
    const stored = await results.record({
      gameId: input.gameId,
      winner: input.winner,
      loser: input.loser,
      reason: input.reason,
      reward: input.reward ?? winnerShare(stake),
      onchain: input.onchain,
    });
    if (stored.loser) leaderboard.record(input.gameId, stored.winner as Address, stored.loser as Address, stored.reward);
    leaderboard.recordWonGame(stored.winner as Address, input.gameId, stored.reward);
    return stored;
  }

  const hooks: RoomHooks = {
    recordResult: (r) => recordResult(r),
    saveState: (room) => queueRoomWrite(room.gameId, () => persist.saveRoom(room.gameId, JSON.stringify(room.serialize()))),
    ended: (room) => queueRoomWrite(room.gameId, () => persist.deleteRoom(room.gameId)),
  };

  const newRoom = (
    gameId: string,
    seats: [Address, Address],
    stake: string | null,
    opts: ConstructorParameters<typeof GameRoom>[8] = {}
  ) =>
    new GameRoom(
      gameId,
      seats,
      makeEmitter(gameId),
      relayer,
      config.shotClockMs,
      stake,
      gameTypeFromId(gameId), // variant is encoded in the code's prefix
      (addr) => profiles.getName(addr),
      { hooks, waitingTimeoutMs: config.waitingRoomTimeoutMs, graceMs: config.reconnectGraceMs, ...opts }
    );

  /** A room showing an already-decided game: no play, just the result (and the
   *  winner's voucher while the chain still has the game open). */
  async function decidedRoom(gameId: string, seats: [Address, Address], stake: string | null): Promise<GameRoom> {
    const r = results.get(gameId)!;
    const voucher = r.onchain === "pending" ? (await relayer.signResult(gameId, r.winner as Address)) ?? undefined : undefined;
    return newRoom(gameId, seats, stake, {
      decided: { winner: r.winner as Address, reason: r.reason as GameOverReason, voucher },
    });
  }

  /**
   * Open (or return) the room for a game. With the chain enabled, seats are
   * read straight from the contract — authoritative and immune to event lag.
   * A game that already has a result opens as decided: it is never played again.
   */
  const devSeats = new Map<string, Address[]>();
  const opening = new Map<string, Promise<GameRoom | ServerError>>();

  function openRoom(gameId: string, joiner: Address | null): Promise<GameRoom | ServerError> {
    const existing = rooms.get(gameId);
    if (existing) return Promise.resolve(existing);
    let pending = opening.get(gameId);
    if (!pending) {
      pending = resolveRoom(gameId, joiner).finally(() => opening.delete(gameId));
      opening.set(gameId, pending);
    }
    return pending;
  }

  async function resolveRoom(gameId: string, joiner: Address | null): Promise<GameRoom | ServerError> {
    let seats: [Address, Address];
    let stake: string | null;
    if (config.chainEnabled) {
      let game;
      try {
        game = await chainReader.getGame(gameId);
      } catch (e) {
        if (e instanceof ChainUnavailableError) {
          return { code: "chain-unavailable", message: "couldn't reach the chain — retrying shortly" };
        }
        throw e;
      }
      if (!game) return { code: "unknown-game", message: "game not found on-chain" };
      if (game.playerTwo === ZeroAddress) return { code: "unknown-game", message: "waiting for an opponent to join" };
      seats = [game.playerOne.toLowerCase() as Address, game.playerTwo.toLowerCase() as Address];
      stake = game.stake.toString();
      if (!results.get(gameId) && game.isCompleted && !game.drawCompleted && game.winner !== ZeroAddress) {
        // Settled on-chain without a result here (e.g. before results were stored):
        // the chain is the record.
        const winner = game.winner.toLowerCase() as Address;
        await recordResult({
          gameId,
          winner,
          loser: seats.find((s) => s !== winner) ?? "",
          reason: "pot",
          onchain: game.rewardClaimed ? "claimed" : "finished",
        });
      }
      if (game.isCompleted && !results.get(gameId)) {
        return { code: "unknown-game", message: "this game is already settled on-chain" }; // a draw or a refund
      }
    } else {
      const pendingSeats = devSeats.get(gameId) ?? [];
      if (joiner && !pendingSeats.includes(joiner)) {
        if (pendingSeats.length >= 2) return { code: "unknown-game", message: "game is full" };
        pendingSeats.push(joiner);
        devSeats.set(gameId, pendingSeats);
      }
      if (pendingSeats.length < 2) return { code: "unknown-game", message: "waiting for an opponent" };
      seats = [pendingSeats[0], pendingSeats[1]];
      stake = null;
    }
    if (joiner && !seats.includes(joiner)) {
      return { code: "not-a-player", message: "spectating not yet supported" };
    }
    const room = rooms.get(gameId) ?? (results.get(gameId) ? await decidedRoom(gameId, seats, stake) : newRoom(gameId, seats, stake));
    if (!rooms.has(gameId)) {
      rooms.set(gameId, room);
      if (!room.isOver()) hooks.saveState(room);
    }
    return room;
  }

  /** Both seats are paid: open the table as a waiting room (no shot clock until both
   *  players are here), so the server tracks it — and refunds both stakes if the
   *  game never starts — instead of the pot sitting forever. */
  async function ensureLive(gameId: string): Promise<void> {
    if (rooms.has(gameId) || results.get(gameId)) return;
    const outcome = await openRoom(gameId, null);
    if (!(outcome instanceof GameRoom) && outcome.code !== "unknown-game") {
      console.warn(`[room] ${gameId}: could not open the table yet (${outcome.message}); will retry`);
    }
  }

  /** Restore stored live tables (mid-game when the server stopped). */
  async function restoreRooms(): Promise<void> {
    let restored = 0;
    // When the previous process was last alive: running clocks are charged up to
    // then and no further (the outage is paused time).
    const alive = Number(await persist.getMeta(ALIVE_KEY));
    const stoppedAt = Number.isFinite(alive) && alive > 0 ? alive : null;
    for (const row of await persist.loadRooms()) {
      let data: SerializedRoom;
      try {
        data = JSON.parse(row.data) as SerializedRoom;
      } catch {
        continue;
      }
      if (results.get(data.gameId)) {
        await persist.deleteRoom(data.gameId); // decided while we were down
        continue;
      }
      const room = newRoom(data.gameId, data.seats, data.stake, {
        restore: {
          state: data.state,
          messages: data.messages ?? [],
          started: data.started,
          waitingSince: data.waitingSince,
          refund: data.refund ?? null,
          turnId: data.turnId,
          missed: data.missed,
          clockRemainingMs: data.clockRemainingMs,
          clockRunningSince: data.clockRunningSince ?? null,
          calledPocket: data.calledPocket ?? null,
          stoppedAt,
        },
      });
      rooms.set(data.gameId, room);
      restored++;
    }
    if (restored) {
      console.log(`[room] restored ${restored} live table(s): clocks resume from the saved time once the players are back`);
    }
  }

  /** Both stakes are back with the players (seen on-chain): close the waiting room. */
  async function finishRefund(gameId: string): Promise<void> {
    lobby.markStatus(gameId, "cancelled");
    const room = rooms.get(gameId);
    if (!room) return;
    room.refundDone();
    room.dispose();
    rooms.delete(gameId);
    hooks.ended(room);
    console.log(`[room] ${gameId}: never started — both stakes refunded`);
  }

  let heartbeat: ReturnType<typeof setInterval> | null = null;
  const beat = () =>
    persist
      .setMeta(ALIVE_KEY, String(Date.now()))
      .catch((e) => console.warn("[server] heartbeat write failed:", e instanceof Error ? e.message : e));

  const ready = (async () => {
    await results.load(leaderboard.allWonGames());
    await lobby.load();
    await restoreRooms();
    await beat();
    heartbeat = setInterval(() => void beat(), HEARTBEAT_MS);
  })();

  ready
    .then(() => {
      if (options.background === false || !config.chainEnabled || !provider) return;
      chainListener = startChainListener(config, persist, provider, {
        lobby,
        leaderboard,
        onGameJoined: (gameId) => ensureLive(gameId),
        async onGameFinished(gameId, winner, reward) {
          const game = lobby.get(gameId);
          const loser = game?.playerTwo ? (game.playerOne === winner ? game.playerTwo : game.playerOne) : "";
          const existing = results.get(gameId);
          if (existing && existing.winner !== winner) {
            console.error(
              `[results] ${gameId}: CHAIN WINNER ${winner} differs from the recorded winner ${existing.winner} — the chain paid out; investigate`
            );
          }
          await recordResult({ gameId, winner, loser, reason: "pot", reward, onchain: "finished" });
          await results.markOnchain(gameId, "finished");
          const room = rooms.get(gameId);
          if (room && !room.isOver()) {
            // Recorded on-chain while a table was still open (only possible via an
            // admin action): close the table, the chain's result stands.
            room.dispose();
            rooms.delete(gameId);
            hooks.ended(room);
          }
        },
        onPaidOut: (gameId) => results.markOnchain(gameId, "claimed"),
        onRefunded: (gameId) => finishRefund(gameId),
      });
      recovery = startRecovery({ config, relayer, chainReader, results, lobby, rooms, ensureLive, finishRefund });
    })
    .catch((e) => console.error("[server] startup failed:", e));

  io.on("connection", (socket) => {
    socket.on("lobby:subscribe", () => {
      void socket.join("lobby");
      socket.emit("lobby:state", { games: withNames(lobby.list()) });
    });

    socket.on("lobby:unsubscribe", () => {
      void socket.leave("lobby");
    });

    socket.on("room:join", async ({ gameId, auth }) => {
      const address = verifyAuth(auth);
      if (!address) {
        console.warn(`[room] join ${gameId}: bad signature`);
        socket.emit("server:error", { code: "unauthorized", message: "bad signature" });
        return;
      }
      socket.data.address = address;
      console.log(`[room] join ${gameId} by ${address}`);
      await ready;

      let outcome: GameRoom | ServerError;
      try {
        outcome = await openRoom(gameId, address);
      } catch (e) {
        console.error(`[room] join ${gameId} failed:`, e);
        socket.emit("server:error", { code: "internal", message: "could not open the game" });
        return;
      }
      if (!(outcome instanceof GameRoom)) {
        console.warn(`[room] join ${gameId}: ${outcome.message} (${address})`);
        // Dev mode: first player waits for an opponent before a room exists.
        if (!config.chainEnabled && devSeats.get(gameId)?.includes(address)) {
          void socket.join(roomChannel(gameId));
          return;
        }
        socket.emit("server:error", outcome);
        return;
      }
      const room = outcome;
      if (room.seatOf(address) === null) {
        console.warn(`[room] join ${gameId}: ${address} is not a seated player`);
        socket.emit("server:error", { code: "not-a-player", message: "spectating not yet supported" });
        return;
      }

      // A player already waiting on this game's channel (dev mode: before the room
      // existed) is at the table too — the waiting room starts once both are here.
      for (const other of await io.in(roomChannel(gameId)).fetchSockets()) {
        const a = other.data.address;
        if (a && a !== address && room.seatOf(a) !== null) room.connect(a);
      }
      void socket.join(roomChannel(gameId));
      room.connect(address);
      socket.emit("room:state", room.snapshot());
      console.log(`[room] seated ${address} in ${gameId}`);
    });

    /** A player is away only when their LAST connection to the table is gone
     *  (a second tab or a quick reconnect keeps them seated). */
    const leftTable = async (room: GameRoom, address: Address): Promise<void> => {
      const still = await io.in(roomChannel(room.gameId)).fetchSockets();
      if (still.some((s) => s.id !== socket.id && s.data.address === address)) return;
      room.disconnect(address);
    };

    socket.on("room:leave", ({ gameId }) => {
      void socket.leave(roomChannel(gameId));
      const room = rooms.get(gameId);
      if (room && socket.data.address) void leftTable(room, socket.data.address);
    });

    // Reconciliation: hand back the authoritative snapshot so the client can
    // overwrite any state drifted from a missed delta. Only for a socket that
    // already authenticated + seated on THIS connection (set by room:join) —
    // no signature needed. On a fresh reconnect the client re-joins first,
    // which both re-seats the socket and returns a snapshot.
    socket.on("room:sync", ({ gameId }) => {
      const room = rooms.get(gameId);
      if (!room || !socket.data.address) return;
      if (room.seatOf(socket.data.address) === null) return;
      socket.emit("room:state", room.snapshot());
    });

    const withRoom = (gameId: string, fn: (room: GameRoom, address: Address) => void): void => {
      const address = socket.data.address;
      if (!address) {
        socket.emit("server:error", { code: "unauthorized", message: "join the room first" });
        return;
      }
      const room = rooms.get(gameId);
      if (!room) {
        socket.emit("server:error", { code: "unknown-game", message: "no such room" });
        return;
      }
      fn(room, address);
    };

    socket.on("game:shoot", ({ gameId, shot, turnId }) => {
      withRoom(gameId, (room, address) => {
        const result = room.handleShot(address, shot, turnId);
        if (!result.ok) socket.emit("server:error", result.error);
      });
    });

    socket.on("game:placeCueBall", ({ gameId, x, y, turnId }) => {
      withRoom(gameId, (room, address) => {
        const result = room.handlePlaceCueBall(address, x, y, turnId);
        if (!result.ok) socket.emit("server:error", result.error);
      });
    });

    socket.on("game:callPocket", ({ gameId, pocket, turnId }) => {
      withRoom(gameId, (room, address) => {
        const result = room.handleCallPocket(address, pocket, turnId);
        if (!result.ok) socket.emit("server:error", result.error);
      });
    });

    socket.on("game:resign", ({ gameId }) => {
      withRoom(gameId, (room, address) => {
        const result = room.handleResign(address);
        if (!result.ok) socket.emit("server:error", result.error);
      });
    });

    socket.on("chat:send", ({ gameId, text }) => {
      withRoom(gameId, (room, address) => {
        if (room.seatOf(address) === null) {
          socket.emit("server:error", { code: "chat-rejected", message: "players only" });
          return;
        }
        const trimmed = String(text ?? "").trim().slice(0, MAX_CHAT_LENGTH);
        if (!trimmed) return;
        const msg = { gameId, from: address, text: trimmed, ts: Date.now() };
        room.addChat(msg); // persist so a reconnecting player sees it
        io.to(roomChannel(gameId)).emit("chat:message", msg);
      });
    });

    const emitProfile = async (address: Address): Promise<void> => {
      await ready;
      const key = address.toLowerCase() as Address;
      const stats = leaderboard.entry(key);
      // A voucher only for a win that is this wallet's recorded result and still
      // open on-chain (deterministic — re-signing yields the same voucher). Once
      // the chain has the result, the winner claims with plain claimReward.
      const wonGames = await Promise.all(
        leaderboard.wonGames(key).map(async (g) => {
          const r = results.get(g.gameId);
          const signable = r && r.winner === key && r.onchain === "pending";
          return { ...g, voucher: signable ? (await relayer.signResult(g.gameId, key)) ?? null : null };
        })
      );
      socket.emit("profile:state", {
        address: key,
        username: profiles.getName(key),
        wins: stats.wins,
        losses: stats.losses,
        wonAmount: stats.wonAmount,
        wonGames,
      });
    };

    socket.on("profile:get", ({ address }) => {
      if (typeof address === "string" && address) void emitProfile(address as Address);
    });

    socket.on("profile:set", ({ auth, username }) => {
      const address = verifyAuth(auth);
      if (!address) {
        socket.emit("server:error", { code: "unauthorized", message: "bad signature" });
        return;
      }
      const stored = profiles.setName(address, String(username ?? ""));
      console.log(`[profile] ${address} → ${stored ? JSON.stringify(stored) : "(cleared)"}`);
      void emitProfile(address);
      // Reflect the new name in any open rooms + the lobby browse list.
      for (const room of rooms.values()) {
        if (room.seatOf(address) !== null) io.to(roomChannel(room.gameId)).emit("room:state", room.snapshot());
      }
      io.to("lobby").emit("lobby:state", { games: withNames(lobby.list()) });
    });

    socket.on("disconnect", () => {
      const address = socket.data.address;
      if (!address) return;
      for (const room of rooms.values()) {
        if (room.seatOf(address) !== null) void leftTable(room, address);
      }
    });
  });

  return {
    httpServer,
    io,
    lobby,
    results,
    rooms,
    ready,
    async close() {
      chainListener?.stop();
      recovery?.stop();
      if (heartbeat) clearInterval(heartbeat);
      // Pause every live clock at this exact moment and store it (deploys are
      // the usual restart, and they then resume to the millisecond).
      for (const room of rooms.values()) room.suspend();
      for (const room of rooms.values()) room.dispose();
      await beat();
      rooms.clear();
      await Promise.all([...roomWrites.values()]);
      await io.close();
    },
  };
}
