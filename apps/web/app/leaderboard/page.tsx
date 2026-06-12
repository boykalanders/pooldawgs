"use client";

import { useEffect, useState } from "react";
import type { LeaderboardEntry } from "@pooldawgs/shared";
import { SERVER_URL } from "@/lib/env";
import { formatStake, shortAddress } from "@/lib/format";

export default function LeaderboardPage() {
  const [entries, setEntries] = useState<LeaderboardEntry[] | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    fetch(`${SERVER_URL}/leaderboard`)
      .then((r) => r.json())
      .then((data) => setEntries(data.entries ?? []))
      .catch(() => setError(true));
  }, []);

  return (
    <div className="mx-auto max-w-3xl">
      <h1 className="heading-display mb-6 text-3xl">Top Dawgs</h1>
      {error && (
        <div className="panel p-10 text-center text-amber-100/50">
          Leaderboard unavailable — is the game server running?
        </div>
      )}
      {entries && entries.length === 0 && (
        <div className="panel p-10 text-center text-amber-100/50">
          No games settled yet. The first pot is up for grabs.
        </div>
      )}
      {entries && entries.length > 0 && (
        <div className="panel overflow-hidden">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-gold-dim/30 text-xs uppercase tracking-widest text-gold">
              <tr>
                <th className="px-5 py-3">#</th>
                <th className="px-5 py-3">Player</th>
                <th className="px-5 py-3 text-right">Wins</th>
                <th className="px-5 py-3 text-right">Losses</th>
                <th className="px-5 py-3 text-right">Won</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((entry, i) => (
                <tr key={entry.address} className="border-b border-gold-dim/10">
                  <td className="px-5 py-3 text-gold-bright">{i + 1}</td>
                  <td className="px-5 py-3 font-mono">{shortAddress(entry.address)}</td>
                  <td className="px-5 py-3 text-right text-emerald-400">{entry.wins}</td>
                  <td className="px-5 py-3 text-right text-red-400">{entry.losses}</td>
                  <td className="px-5 py-3 text-right text-gold-bright">
                    {formatStake(entry.wonAmount)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
