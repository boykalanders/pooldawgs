"use client";

import { io, type Socket } from "socket.io-client";
import type { ClientToServerEvents, ServerToClientEvents } from "@pooldawgs/shared";
import { SERVER_URL } from "./env";

export type GameSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

let socket: GameSocket | null = null;

/** Lazily-created singleton socket shared by lobby and game views. */
export function getSocket(): GameSocket {
  if (!socket) {
    socket = io(SERVER_URL, { transports: ["websocket"], autoConnect: true });
  }
  return socket;
}
