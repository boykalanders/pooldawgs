import type { Address, LobbyGame, LobbyGameStatus } from "@pooldawgs/shared";

/**
 * In-memory mirror of on-chain games, kept in sync by the event listener.
 * Swap for Postgres/Redis when scaling beyond one server instance.
 */
export class LobbyStore {
  private games = new Map<string, LobbyGame>();
  private listeners = new Set<() => void>();

  upsertCreated(gameId: string, playerOne: Address, stake: string, createdAt: number): void {
    this.games.set(gameId, {
      gameId,
      playerOne,
      playerTwo: null,
      stake,
      status: "open",
      createdAt,
    });
    this.notify();
  }

  markJoined(gameId: string, playerTwo: Address): void {
    const game = this.games.get(gameId);
    if (!game) return;
    game.playerTwo = playerTwo;
    game.status = "active";
    this.notify();
  }

  markStatus(gameId: string, status: LobbyGameStatus): void {
    const game = this.games.get(gameId);
    if (!game) return;
    game.status = status;
    this.notify();
  }

  get(gameId: string): LobbyGame | undefined {
    return this.games.get(gameId);
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

  private notify(): void {
    for (const listener of this.listeners) listener();
  }
}
