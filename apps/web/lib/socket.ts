"use client";

import { io, type Socket } from "socket.io-client";
import type { ClientToServerEvents, ServerToClientEvents } from "@pooldawgs/shared";
import { SERVER_URL } from "./env";
import { log } from "./log";

export type GameSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

let socket: GameSocket | null = null;

/** Lazily-created singleton socket shared by lobby and game views. */
export function getSocket(): GameSocket {
  if (!socket) {
    log.info("socket: connecting to", SERVER_URL);
    // Allow polling fallback — some hosts/proxies block raw WebSocket upgrades.
    socket = io(SERVER_URL, { transports: ["websocket", "polling"], autoConnect: true });
    socket.on("connect", () => log.info("socket: connected", socket?.id));
    socket.on("disconnect", (reason) => log.warn("socket: disconnected —", reason));
    socket.on("connect_error", (err) =>
      log.error("socket: connect_error —", err.message, "(is NEXT_PUBLIC_SERVER_URL reachable + CORS-allowed?)")
    );
  }
  return socket;
}
