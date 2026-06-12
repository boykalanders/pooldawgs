import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import { Server } from "socket.io";
import {
  MAX_CHAT_LENGTH,
  type Address,
  type ClientToServerEvents,
  type ServerToClientEvents,
} from "@pooldawgs/shared";
import { verifyAuth } from "./auth.js";
import { startChainListener } from "./chain-events.js";
import type { ServerConfig } from "./config.js";
import { LeaderboardStore } from "./leaderboard.js";
import { LobbyStore } from "./lobby.js";
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
  relayer: Relayer = createRelayer(config)
): PoolDawgsServer {
  const leaderboard = new LeaderboardStore();

  const httpServer = createHttpServer((req, res) => {
    const cors = {
      "access-control-allow-origin": config.corsOrigins[0] ?? "*",
    };
    if (req.url === "/health") {
      res.writeHead(200, { "content-type": "application/json", ...cors });
      res.end(JSON.stringify({ ok: true, chainEnabled: config.chainEnabled }));
      return;
    }
    if (req.url === "/leaderboard") {
      res.writeHead(200, { "content-type": "application/json", ...cors });
      res.end(JSON.stringify({ entries: leaderboard.top() }));
      return;
    }
    res.writeHead(404);
    res.end();
  });

  const io: IoServer = new Server(httpServer, {
    cors: { origin: config.corsOrigins },
  });

  const lobby = new LobbyStore();
  const rooms = new Map<string, GameRoom>();
  const stopChainListener = startChainListener(config, lobby);

  lobby.onChange(() => {
    io.to("lobby").emit("lobby:state", { games: lobby.list() });
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
          if (loser) {
            // Winner takes 80% of the 2-stake pot.
            const stake = lobby.get(gameId)?.stake ?? "0";
            const winnings = ((BigInt(stake) * 2n * 8000n) / 10000n).toString();
            leaderboard.record(p.winner, loser, winnings);
          }
        }
      },
    };
  }

  /**
   * Resolve the two seats for a game. With the chain enabled, seats come from
   * the on-chain lobby mirror. In dev mode the first two distinct
   * authenticated wallets to join an unknown gameId become the players.
   */
  const devSeats = new Map<string, Address[]>();
  function resolveSeats(gameId: string, joiner: Address): [Address, Address] | null {
    if (config.chainEnabled) {
      const game = lobby.get(gameId);
      if (!game || game.status !== "active" || !game.playerTwo) return null;
      const seats: [Address, Address] = [game.playerOne, game.playerTwo];
      return seats.includes(joiner) ? seats : null;
    }
    const pending = devSeats.get(gameId) ?? [];
    if (!pending.includes(joiner)) {
      if (pending.length >= 2) return null;
      pending.push(joiner);
      devSeats.set(gameId, pending);
    }
    return pending.length === 2 ? [pending[0], pending[1]] : null;
  }

  io.on("connection", (socket) => {
    socket.on("lobby:subscribe", () => {
      void socket.join("lobby");
      socket.emit("lobby:state", { games: lobby.list() });
    });

    socket.on("lobby:unsubscribe", () => {
      void socket.leave("lobby");
    });

    socket.on("room:join", ({ gameId, auth }) => {
      const address = verifyAuth(auth);
      if (!address) {
        socket.emit("server:error", { code: "unauthorized", message: "bad signature" });
        return;
      }
      socket.data.address = address;

      let room = rooms.get(gameId);
      if (!room) {
        const seats = resolveSeats(gameId, address);
        if (!seats) {
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
        room = new GameRoom(
          gameId,
          seats,
          makeEmitter(gameId),
          relayer,
          config.shotClockMs,
          lobby.get(gameId)?.stake ?? null
        );
        rooms.set(gameId, room);
      }

      if (room.seatOf(address) === null) {
        socket.emit("server:error", { code: "not-a-player", message: "spectating not yet supported" });
        return;
      }

      void socket.join(roomChannel(gameId));
      room.connect(address);
      socket.emit("room:state", room.snapshot());
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
        io.to(roomChannel(gameId)).emit("chat:message", {
          gameId,
          from: address,
          text: trimmed,
          ts: Date.now(),
        });
      });
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
