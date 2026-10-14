import type { Address } from "@pooldawgs/shared";
import type { OnchainStatus, Persistence, ResultRow } from "./db/persistence.js";

/**
 * Decided games — the server's record of who won, kept so a result can never be
 * lost or replayed.
 *
 * A result is stored (and the write awaited) BEFORE anyone is told the game is
 * over. Once a game has one, it is final: the server never opens a fresh table
 * for it — even after a restart, when the chain still shows the game as open
 * because the winner hasn't claimed yet — and never signs a voucher for anyone
 * but the recorded winner. Without this, a restart between "game over" and the
 * winner's claim reopened the game from the break, and a replay won by the other
 * player produced a second valid voucher for the same pot.
 */
export class ResultStore {
  private results = new Map<string, ResultRow>();

  constructor(private readonly persist: Persistence) {}

  /** Load stored results, and adopt any win the leaderboard recorded before the
   *  results table existed, so those games can't be replayed either. */
  async load(legacyWins: Array<{ winner: string; gameId: string; reward: string }> = []): Promise<void> {
    for (const r of await this.persist.loadResults()) this.results.set(r.gameId, r);
    let adopted = 0;
    for (const w of legacyWins) {
      if (this.results.has(w.gameId)) continue;
      const row: ResultRow = {
        gameId: w.gameId,
        winner: w.winner.toLowerCase(),
        loser: "",
        reason: "recorded",
        reward: w.reward,
        decidedAt: Date.now(),
        onchain: "pending",
        finishTx: null,
        finishTxAt: null,
      };
      await this.persist.insertResult(row);
      this.results.set(row.gameId, row);
      adopted++;
    }
    if (adopted) console.log(`[results] adopted ${adopted} earlier win(s) from the leaderboard`);
  }

  get(gameId: string): ResultRow | undefined {
    return this.results.get(gameId);
  }

  all(): ResultRow[] {
    return [...this.results.values()];
  }

  /**
   * Record a decided game. The first result always stands: if the game already
   * has one, that one is returned unchanged. Throws if it can't be stored — the
   * caller must not announce a result that isn't saved.
   */
  async record(input: {
    gameId: string;
    winner: Address | string;
    loser: Address | string;
    reason: string;
    reward: string;
    onchain?: OnchainStatus;
  }): Promise<ResultRow> {
    const existing = this.results.get(input.gameId);
    if (existing) return existing;
    const row: ResultRow = {
      gameId: input.gameId,
      winner: input.winner.toLowerCase(),
      loser: input.loser.toLowerCase(),
      reason: input.reason,
      reward: input.reward,
      decidedAt: Date.now(),
      onchain: input.onchain ?? "pending",
      finishTx: null,
      finishTxAt: null,
    };
    const inserted = await this.persist.insertResult(row);
    if (!inserted) {
      // Stored by another path in the meantime — reload so the first one stands.
      const stored = (await this.persist.loadResults()).find((r) => r.gameId === input.gameId);
      if (stored) {
        this.results.set(stored.gameId, stored);
        return stored;
      }
    }
    this.results.set(row.gameId, row);
    return row;
  }

  /** Move a result forward on-chain (pending → finished → claimed); never back. */
  async markOnchain(gameId: string, status: OnchainStatus): Promise<void> {
    const r = this.results.get(gameId);
    if (!r) return;
    const rank: Record<OnchainStatus, number> = { pending: 0, finished: 1, claimed: 2 };
    if (rank[status] <= rank[r.onchain]) return;
    r.onchain = status;
    await this.persist.updateResult(gameId, { onchain: status });
  }

  async setFinishTx(gameId: string, hash: string): Promise<void> {
    const r = this.results.get(gameId);
    if (!r) return;
    r.finishTx = hash;
    r.finishTxAt = Date.now();
    await this.persist.updateResult(gameId, { finishTx: hash, finishTxAt: r.finishTxAt });
  }
}
