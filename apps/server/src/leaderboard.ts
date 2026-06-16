import type { Address, LeaderboardEntry, PlatformStats, WonGame } from "@pooldawgs/shared";

/** In-memory win/loss ledger; swap for a DB alongside the lobby store. */
export class LeaderboardStore {
  private entries = new Map<Address, LeaderboardEntry>();
  // winner → (gameId → reward). Keyed by gameId so the same finish recorded
  // from both the live socket path and the chain backfill is counted once.
  private won = new Map<Address, Map<string, string>>();
  // gameIds already counted into wins/losses, so the socket path and the chain
  // backfill (which both report a finish) don't double-count.
  private counted = new Set<string>();
  // Sum of winner shares (80% of each pot) across counted games — used to
  // derive platform totals (burn = share/8, wagered = share*10/8).
  private totalWonWei = 0n;

  /** Record a finished game's win/loss. Idempotent per gameId. */
  record(gameId: string, winner: Address, loser: Address, wonAmountWei: string): void {
    if (this.counted.has(gameId)) return;
    this.counted.add(gameId);
    this.totalWonWei += BigInt(wonAmountWei);
    const w = this.getOrCreate(winner);
    w.wins += 1;
    w.wonAmount = (BigInt(w.wonAmount) + BigInt(wonAmountWei)).toString();
    const l = this.getOrCreate(loser);
    l.losses += 1;
  }

  /** Platform totals. Winner share is 80% of the pot, so burn (10%) = share/8
   *  and total wagered (both stakes = the pot) = share * 10/8. */
  stats(): PlatformStats {
    return {
      games: this.counted.size,
      totalBurned: (this.totalWonWei / 8n).toString(),
      totalWagered: ((this.totalWonWei * 10n) / 8n).toString(),
    };
  }

  /** Record a game this wallet won, for the "unclaimed rewards" list. Idempotent. */
  recordWonGame(winner: Address, gameId: string, rewardWei: string): void {
    const key = winner.toLowerCase() as Address;
    let games = this.won.get(key);
    if (!games) {
      games = new Map();
      this.won.set(key, games);
    }
    games.set(gameId, rewardWei);
  }

  /** Games a wallet has won (for the unclaimed-rewards check). */
  wonGames(address: Address): WonGame[] {
    const games = this.won.get(address.toLowerCase() as Address);
    if (!games) return [];
    return [...games.entries()].map(([gameId, reward]) => ({ gameId, reward }));
  }

  /** A single wallet's stats (zeroed if unseen). */
  entry(address: Address): LeaderboardEntry {
    const key = address.toLowerCase() as Address;
    return this.entries.get(key) ?? { address: key, wins: 0, losses: 0, wonAmount: "0" };
  }

  top(limit = 50): LeaderboardEntry[] {
    return [...this.entries.values()]
      .sort((a, b) => b.wins - a.wins || Number(BigInt(b.wonAmount) - BigInt(a.wonAmount)))
      .slice(0, limit);
  }

  private getOrCreate(address: Address): LeaderboardEntry {
    const key = address.toLowerCase() as Address;
    let entry = this.entries.get(key);
    if (!entry) {
      entry = { address: key, wins: 0, losses: 0, wonAmount: "0" };
      this.entries.set(key, entry);
    }
    return entry;
  }
}
