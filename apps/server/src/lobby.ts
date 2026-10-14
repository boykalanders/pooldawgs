import type { Address, LobbyGame, LobbyGameStatus } from "@pooldawgs/shared";
import type { Persistence } from "./db/persistence.js";

/**
 * Mirror of on-chain games, kept in sync by the chain event monitor and stored
 * so it survives restarts (the monitor resumes from its saved block, so events
 * from before a restart are not read again).
 */
export class LobbyStore {
  private games = new Map<string, LobbyGame>();
  private listeners = new Set<() => void>();

  constructor(private readonly persist: Persistence | null = null) {}

  async load(): Promise<void> {
    if (!this.persist) return;
    for (const row of await this.persist.loadLobby()) {
      try {
        this.games.set(row.gameId, JSON.parse(row.data) as LobbyGame);
      } catch {
        /* skip a corrupt row */
      }
    }
  }

  upsertCreated(gameId: string, playerOne: Address, stake: string, createdAt: number): void {
    // Never move a game backwards (a GameCreated seen after its GameJoined /
    // GameFinished, e.g. out of order in a backfill, must not reopen it).
    if (this.games.has(gameId)) return;
    this.games.set(gameId, {
      gameId,
      playerOne,
      playerTwo: null,
      stake,
      status: "open",
      createdAt,
    });
    this.changed(gameId);
  }

  markJoined(gameId: string, playerTwo: Address): void {
    const game = this.games.get(gameId);
    if (!game) return;
    game.playerTwo = playerTwo;
    if (game.status === "open") game.status = "active";
    this.changed(gameId);
  }

  markStatus(gameId: string, status: LobbyGameStatus): void {
    const game = this.games.get(gameId);
    if (!game || game.status === status) return;
    game.status = status;
    this.changed(gameId);
  }

  get(gameId: string): LobbyGame | undefined {
    return this.games.get(gameId);
  }

  /** Every mirrored game, any status. */
  all(): LobbyGame[] {
    return [...this.games.values()];
  }

  /** Games shown in the lobby: open ones first, then in-play. */
  list(): LobbyGame[] {
    return [...this.games.values()]
      .filter((g) => g.status === "open" || g.status === "active")
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private changed(gameId: string): void {
    const game = this.games.get(gameId);
    if (game && this.persist) {
      this.persist
        .saveLobbyGame(gameId, JSON.stringify(game))
        .catch((e) => console.error(`[lobby] could not save ${gameId}:`, e instanceof Error ? e.message : e));
    }
    for (const listener of this.listeners) listener();
  }
}
