import type { Address, LeaderboardEntry, PlatformStats, WonGame } from "@pooldawgs/shared";
import type { Persistence } from "./db/persistence.js";

/** Win/loss ledger. Fast in-memory maps for reads, with write-through to a
 *  persistence backend (Postgres or SQLite) so it survives restarts; on boot it
 *  loads the persisted rows and the indexer resumes from the saved block. */
export class LeaderboardStore {
  private entries = new Map<Address, LeaderboardEntry>();
  // winner → (gameId → reward). Keyed by gameId so the same finish recorded
  // from both the live socket path and the chain backfill is counted once.
  private won = new Map<Address, Map<string, string>>();
  // gameIds already counted into wins/losses, so the socket path and the chain
  // backfill (which both report a finish) don't double-count.
  private counted = new Set<string>();
  // Sum of winner shares (80% of each pot) across counted games — used to
  // derive platform totals when the on-chain figures aren't available.
  private totalWonWei = 0n;
  // Indexer's last fully-scanned block, mirrored from persistence.
  private cursor: number | null = null;
  // Platform totals read straight from the contract (the trusted source); the
  // chain indexer refreshes this each poll. Falls back to the derived figures.
  private chainStatsCache: PlatformStats | null = null;

  constructor(private readonly persist: Persistence | null = null) {}

  /** Cache the on-chain platform totals (from contract.platformStats()). */
  setChainStats(stats: PlatformStats): void {
    this.chainStatsCache = stats;
  }

  /** Load persisted state on boot (no-op without a backend). */
  async load(): Promise<void> {
    if (!this.persist) return;
    for (const e of await this.persist.loadEntries()) {
      this.entries.set(e.address.toLowerCase() as Address, {
        address: e.address.toLowerCase() as Address,
        wins: e.wins,
        losses: e.losses,
        wonAmount: e.wonAmount,
      });
    }
    for (const w of await this.persist.loadWonGames()) {
      const key = w.winner.toLowerCase() as Address;
      let games = this.won.get(key);
      if (!games) {
        games = new Map();
        this.won.set(key, games);
      }
      games.set(w.gameId, w.reward);
    }
    for (const c of await this.persist.loadCounted()) {
      this.counted.add(c.gameId);
      this.totalWonWei += BigInt(c.wonAmount);
    }
    this.cursor = await this.persist.loadCursor();
  }

  /** Last block the chain indexer fully scanned (null = nothing yet). */
  getCursor(): number | null {
    return this.cursor;
  }
  setCursor(block: number): void {
    this.cursor = block;
    void this.persist?.saveCursor(block).catch(() => {});
  }

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
    void this.persist?.recordCounted(gameId, wonAmountWei).catch(() => {});
    void this.persist?.upsertEntry(w).catch(() => {});
    void this.persist?.upsertEntry(l).catch(() => {});
  }

  /** Platform totals. Prefers the on-chain figures (read from the contract's
   *  platformStats() by the indexer); otherwise derives them from counted
   *  games: winner share is 80% of the pot, so burn (10%) = share/8 and total
   *  wagered (the pot) = share * 10/8. */
  stats(): PlatformStats {
    if (this.chainStatsCache) return this.chainStatsCache;
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
    void this.persist?.upsertWonGame(key, gameId, rewardWei).catch(() => {});
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
