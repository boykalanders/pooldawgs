"use client";

import { useEffect, useState } from "react";
import type { LeaderboardEntry, PlatformStats } from "@pooldawgs/shared";
import { SERVER_URL } from "@/lib/env";
import { formatStake, shortAddress } from "@/lib/format";

export default function LeaderboardPage() {
  const [entries, setEntries] = useState<LeaderboardEntry[] | null>(null);
  const [stats, setStats] = useState<PlatformStats | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    fetch(`${SERVER_URL}/leaderboard`)
      .then((r) => r.json())
      .then((data) => {
        setEntries(data.entries ?? []);
        setStats(data.stats ?? null);
      })
      .catch(() => setError(true));
  }, []);

  return (
    <div className="mx-auto max-w-3xl py-2">
      <div className="mb-6 flex items-center gap-3">
        <span className="text-3xl">👑</span>
        <h1 className="heading-display text-3xl">Top Dawgs</h1>
      </div>

      {/* Platform totals */}
      <div className="mb-6 grid grid-cols-3 gap-4">
        <StatCard label="Games played" value={stats ? stats.games.toLocaleString() : "—"} />
        <StatCard
          label="Total wagered"
          value={stats ? formatStake(stats.totalWagered).replace(" $DDawgs", "") : "—"}
          icon
        />
        <StatCard
          label="🔥 Burned"
          value={stats ? formatStake(stats.totalBurned).replace(" $DDawgs", "") : "—"}
          icon
          burn
        />
      </div>
      {error && (
        <div className="panel p-10 text-center text-cream/50">
          Leaderboard unavailable — is the game server running?
        </div>
      )}
      {entries && entries.length === 0 && (
        <div className="panel p-10 text-center text-cream/50">
          No games settled yet. The first pot is up for grabs.
        </div>
      )}
      {entries && entries.length > 0 && (
        <div className="panel panel-gilt overflow-hidden">
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
                <tr
                  key={entry.address}
                  className="border-b border-gold-dim/10 transition hover:bg-emerald-felt/30"
                >
                  <td className="px-5 py-3 text-lg">{rankBadge(i)}</td>
                  <td className="px-5 py-3 font-mono text-cream/90">{shortAddress(entry.address)}</td>
                  <td className="px-5 py-3 text-right font-semibold text-emerald-300">{entry.wins}</td>
                  <td className="px-5 py-3 text-right text-red-300/80">{entry.losses}</td>
                  <td className="px-5 py-3 text-right font-semibold text-gold-bright">
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

function rankBadge(i: number): string {
  return ["🥇", "🥈", "🥉"][i] ?? `${i + 1}`;
}

function StatCard({
  label,
  value,
  icon = false,
  burn = false,
}: {
  label: string;
  value: string;
  icon?: boolean;
  burn?: boolean;
}) {
  return (
    <div className="panel panel-gilt p-4 text-center">
      <p
        className={`flex items-center justify-center gap-1 text-2xl font-bold ${
          burn ? "text-burn" : "text-gold-bright"
        }`}
      >
        {icon && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src="/assets/token.svg" alt="" className="h-5 w-5" draggable={false} />
        )}
        {value}
      </p>
      <p className="mt-1 text-[11px] uppercase tracking-widest text-cream/50">{label}</p>
    </div>
  );
}
