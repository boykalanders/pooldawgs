import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import { Server } from "socket.io";
import {
  MAX_CHAT_LENGTH,
  gameTypeFromId,
  type Address,
  type ClientToServerEvents,
  type LobbyGame,
  type ServerToClientEvents,
} from "@pooldawgs/shared";
import { verifyAuth } from "./auth.js";
import { createChainReader, ZeroAddress, type ChainReader } from "./chain.js";
import { startChainListener } from "./chain-events.js";
import type { ServerConfig } from "./config.js";
import { LeaderboardStore } from "./leaderboard.js";
import { LobbyStore } from "./lobby.js";
import { ProfileStore } from "./profile.js";
import { createRelayer, type Relayer } from "./relayer.js";
import { GameRoom, type RoomEmitter } from "./room.js";

interface SocketData {
  address?: Address;
}

type IoServer = Server<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData>;

export interface PoolDawgsServer {
  httpServer: HttpServer;
  io: IoServer;
  lobby: LobbyStore;
  rooms: Map<string, GameRoom>;
  close(): Promise<void>;
}

const roomChannel = (gameId: string) => `game:${gameId}`;

export function createPoolDawgsServer(
  config: ServerConfig,
  relayer: Relayer = createRelayer(config),
  chainReader: ChainReader = createChainReader(config)
): PoolDawgsServer {
  const leaderboard = new LeaderboardStore();
  const profiles = new ProfileStore(config.dataDir);

  // Accept the configured origins PLUS any localhost / 127.0.0.1 origin (any
  // port). This avoids the common local-testing trap where the page is opened
  // on 127.0.0.1 but CORS only allowed localhost (or vice versa), which
  // silently blocks the WebSocket and leaves the client stuck "connecting".
  const isAllowedOrigin = (origin?: string): boolean => {
    if (!origin) return true; // non-browser clients (curl, node, the e2e)
    if (config.corsOrigins.includes(origin)) return true;
    return /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
  };

  const httpServer = createHttpServer((req, res) => {
    const origin = req.headers.origin;
    const cors = {
      "access-control-allow-origin": isAllowedOrigin(origin) ? origin ?? "*" : "null",
    };
    if (req.url === "/health") {
      res.writeHead(200, { "content-type": "application/json", ...cors });
      res.end(JSON.stringify({ ok: true, chainEnabled: config.chainEnabled }));
      return;
    }
    if (req.url === "/leaderboard") {
      res.writeHead(200, { "content-type": "application/json", ...cors });
      res.end(JSON.stringify({ entries: leaderboard.top(), stats: leaderboard.stats() }));
      return;
    }
    res.writeHead(404);
    res.end();
  });

  const io: IoServer = new Server(httpServer, {
    cors: { origin: (origin, cb) => cb(null, isAllowedOrigin(origin)) },
  });

  const lobby = new LobbyStore();
  const rooms = new Map<string, GameRoom>();
  const stopChainListener = startChainListener(config, lobby, leaderboard);

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
        const room = rooms.get(gameId);
        if (room && !p.txHash) {
          // Record once, on the first (pre-settlement) game:over emit.
          const loser = room.seats.find((s) => s !== p.winner);
          // Winner takes 80% of the 2-stake pot.
          const stake = lobby.get(gameId)?.stake ?? room.stakeWei() ?? "0";
          const winnings = ((BigInt(stake) * 2n * 8000n) / 10000n).toString();
          if (loser) leaderboard.record(gameId, p.winner, loser, winnings);
          // Surface as a claimable win immediately (idempotent with the chain
          // backfill, which also records it once finishGame mines).
          leaderboard.recordWonGame(p.winner, gameId, winnings);
        }
      },
    };
  }

  /**
   * Resolve the two seats (and stake) for a game. With the chain enabled,
   * seats are read straight from the contract — authoritative and immune to
   * event-listener lag. In dev mode the first two distinct authenticated
   * wallets to join an unknown gameId become the players.
   */
  const devSeats = new Map<string, Address[]>();
  async function resolveSeats(
    gameId: string,
    joiner: Address
  ): Promise<{ seats: [Address, Address]; stake: string | null } | null> {
    if (config.chainEnabled) {
      const game = await chainReader.getGame(gameId);
      if (!game || game.isCompleted) return null;
      if (game.playerTwo === ZeroAddress) return null; // no opponent yet
      const seats: [Address, Address] = [
        game.playerOne.toLowerCase() as Address,
        game.playerTwo.toLowerCase() as Address,
      ];
      if (!seats.includes(joiner)) return null;
      return { seats, stake: game.stake.toString() };
    }
    const pending = devSeats.get(gameId) ?? [];
    if (!pending.includes(joiner)) {
      if (pending.length >= 2) return null;
      pending.push(joiner);
      devSeats.set(gameId, pending);
    }
    return pending.length === 2 ? { seats: [pending[0], pending[1]], stake: null } : null;
  }

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

      let room = rooms.get(gameId);
      if (!room) {
        const resolved = await resolveSeats(gameId, address);
        if (!resolved) {
          console.warn(`[room] join ${gameId}: not joinable for ${address}`);
          // Dev mode: first player waits for an opponent before a room exists.
          if (!config.chainEnabled && devSeats.get(gameId)?.includes(address)) {
            void socket.join(roomChannel(gameId));
            return;
          }
          socket.emit("server:error", {
            code: "unknown-game",
            message: "game not joinable (not active on-chain, or not a player)",
          });
          return;
        }
        // Another join may have created the room while we awaited the chain.
        room =
          rooms.get(gameId) ??
          new GameRoom(
            gameId,
            resolved.seats,
            makeEmitter(gameId),
            relayer,
            config.shotClockMs,
            resolved.stake,
            gameTypeFromId(gameId), // variant is encoded in the code's prefix
            (addr) => profiles.getName(addr)
          );
        rooms.set(gameId, room);
      }

      if (room.seatOf(address) === null) {
        console.warn(`[room] join ${gameId}: ${address} is not a seated player`);
        socket.emit("server:error", { code: "not-a-player", message: "spectating not yet supported" });
        return;
      }

      void socket.join(roomChannel(gameId));
      room.connect(address);
      socket.emit("room:state", room.snapshot());
      console.log(`[room] seated ${address} in ${gameId}`);
    });

    socket.on("room:leave", ({ gameId }) => {
      void socket.leave(roomChannel(gameId));
      const room = rooms.get(gameId);
      if (room && socket.data.address) room.disconnect(socket.data.address);
    });

    const withRoom = (
      gameId: string,
      fn: (room: GameRoom, address: Address) => void
    ): void => {
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

    socket.on("game:shoot", ({ gameId, shot }) => {
      withRoom(gameId, (room, address) => {
        const result = room.handleShot(address, shot);
        if (!result.ok) socket.emit("server:error", result.error);
      });
    });

    socket.on("game:placeCueBall", ({ gameId, x, y }) => {
      withRoom(gameId, (room, address) => {
        const result = room.handlePlaceCueBall(address, x, y);
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
      const key = address.toLowerCase() as Address;
      const stats = leaderboard.entry(key);
      // Sign a fresh voucher for each won game so the winner can claim it from
      // the profile (deterministic — re-signing yields the same voucher).
      const wonGames = await Promise.all(
        leaderboard.wonGames(key).map(async (g) => ({
          ...g,
          voucher: (await relayer.signResult(g.gameId, key)) ?? null,
        }))
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
        if (room.seatOf(address) !== null) room.disconnect(address);
      }
    });
  });

  return {
    httpServer,
    io,
    lobby,
    rooms,
    async close() {
      stopChainListener();
      for (const room of rooms.values()) room.dispose();
      rooms.clear();
      await io.close();
    },
  };
}
