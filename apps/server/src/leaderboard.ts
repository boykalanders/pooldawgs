import type { Address, LeaderboardEntry } from "@pooldawgs/shared";

/** In-memory win/loss ledger; swap for a DB alongside the lobby store. */
export class LeaderboardStore {
  private entries = new Map<Address, LeaderboardEntry>();

  record(winner: Address, loser: Address, wonAmountWei: string): void {
    const w = this.getOrCreate(winner);
    w.wins += 1;
    w.wonAmount = (BigInt(w.wonAmount) + BigInt(wonAmountWei)).toString();
    const l = this.getOrCreate(loser);
    l.losses += 1;
  }

  top(limit = 50): LeaderboardEntry[] {
    return [...this.entries.values()]
      .sort((a, b) => b.wins - a.wins || Number(BigInt(b.wonAmount) - BigInt(a.wonAmount)))
      .slice(0, limit);
  }

  private getOrCreate(address: Address): LeaderboardEntry {
    let entry = this.entries.get(address);
    if (!entry) {
      entry = { address, wins: 0, losses: 0, wonAmount: "0" };
      this.entries.set(address, entry);
    }
    return entry;
  }
}
