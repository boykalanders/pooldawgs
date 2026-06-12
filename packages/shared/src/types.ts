import type { PlayerIndex, ShotInput, TableState } from "@pooldawgs/engine";

export type Address = `0x${string}`;

export type LobbyGameStatus = "open" | "active" | "finished" | "cancelled";

/** A game as listed in the lobby — mirrors on-chain state via the event listener. */
export interface LobbyGame {
  gameId: string;
  playerOne: Address;
  playerTwo: Address | null;
  /** Stake per player, as a decimal string of wei. */
  stake: string;
  status: LobbyGameStatus;
  createdAt: number;
}

export type GameOverReason = "pot" | "resign" | "timeout";

export interface RoomPlayer {
  address: Address;
  seat: PlayerIndex;
  connected: boolean;
}

/** Authoritative room snapshot pushed to clients on join and on every turn. */
export interface RoomSnapshot {
  gameId: string;
  players: RoomPlayer[];
  /** Per-player stake in wei (decimal string); null for chain-less dev tables. */
  stake: string | null;
  state: TableState;
  /** Server hash of `state` for desync detection. */
  stateHash: string;
  /** Epoch ms when the current player's 4-minute shot clock expires. */
  clockExpiresAt: number;
  /** Set once settled on-chain. */
  over: { winner: Address; reason: GameOverReason; txHash?: string } | null;
}

/** Broadcast after the server has validated and simulated a shot. Clients
 *  re-run the same deterministic engine to animate it. */
export interface ShotBroadcast {
  gameId: string;
  bySeat: PlayerIndex;
  shot: ShotInput;
  /** Hash of the state the shot was simulated FROM (clients verify sync). */
  preStateHash: string;
  /** Authoritative post-shot state — clients adopt it after animating. */
  endState: TableState;
  endStateHash: string;
  clockExpiresAt: number;
}

export interface ChatMessage {
  gameId: string;
  from: Address;
  text: string;
  ts: number;
}

export interface LeaderboardEntry {
  address: Address;
  wins: number;
  losses: number;
  /** Total winnings in wei (decimal string). */
  wonAmount: string;
}

/** 4-minute shot clock, enforced off-chain by the server (never on-chain). */
export const SHOT_CLOCK_MS = 4 * 60 * 1000;

export const MAX_CHAT_LENGTH = 280;
