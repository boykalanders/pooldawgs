"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { formatUnits } from "viem";
import { useAccount, usePublicClient, useReadContract, useWriteContract } from "wagmi";
import {
  ERC20_ABI,
  MAX_USERNAME_LENGTH,
  POOL_DAWGS_ABI,
  gameTypeFromId,
  GAME_TYPE_LABEL,
  type WonGame,
} from "@pooldawgs/shared";
import WalletGate from "@/components/WalletGate";
import { CHAIN_ID, CONTRACTS_CONFIGURED, DDAWGS_TOKEN_ADDRESS, POOLDAWGS_ADDRESS } from "@/lib/env";
import { formatStake, shortAddress } from "@/lib/format";
import { log } from "@/lib/log";
import { useNftAvatar } from "@/lib/useNftAvatar";
import { useProfile } from "@/lib/useProfile";

export default function ProfilePage() {
  return (
    <WalletGate>
      <Profile />
    </WalletGate>
  );
}

/** On-chain game tuple: [p1, p2, isCompleted, winner, stake, rewardClaimed, …]. */
type ChainGame = readonly [string, string, boolean, string, bigint, boolean, ...unknown[]];


function Profile() {
  const { address } = useAccount();
  const publicClient = usePublicClient();
  const { writeContractAsync } = useWriteContract();
  const { profile, setUsername, saving, error } = useProfile(address);
  const avatar = useNftAvatar(address);

  const [nameInput, setNameInput] = useState("");
  const [copied, setCopied] = useState(false);
  // gameId currently being claimed, and the set of confirmed-claimed ids.
  const [claiming, setClaiming] = useState<string | null>(null);
  const [claimError, setClaimError] = useState<string | null>(null);
  const [unclaimed, setUnclaimed] = useState<WonGame[]>([]);
  const [checking, setChecking] = useState(false);
  const [refresh, setRefresh] = useState(0);

  // Seed the editable name from the stored profile (once it arrives).
  useEffect(() => {
    if (profile) setNameInput(profile.username ?? "");
  }, [profile?.username]);

  const { data: balance } = useReadContract({
    address: DDAWGS_TOKEN_ADDRESS ?? undefined,
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: address ? [address] : undefined,
    query: { enabled: Boolean(CONTRACTS_CONFIGURED && address), refetchInterval: 15000 },
  });

  const wonGames = useMemo(() => profile?.wonGames ?? [], [profile?.wonGames]);

  // Cross-check each won game on-chain. Anything not yet claimed is listed so
  // the winner always sees it: claimable now if finishGame has settled it, or
  // "finalizing" (claimable later) if the result isn't recorded on-chain yet.
  useEffect(() => {
    if (!publicClient || !address || !POOLDAWGS_ADDRESS || wonGames.length === 0) {
      setUnclaimed([]);
      return;
    }
    let cancelled = false;
    setChecking(true);
    (async () => {
      const open: WonGame[] = [];
      for (const g of wonGames) {
        try {
          const game = (await publicClient.readContract({
            address: POOLDAWGS_ADDRESS,
            abi: POOL_DAWGS_ABI,
            functionName: "games",
            args: [g.gameId],
          })) as unknown as ChainGame;
          if (game[5]) continue; // rewardClaimed — already paid out
          open.push(g); // claimable now if it carries a voucher
        } catch (e) {
          log.info("profile: reward check skipped for", g.gameId, e instanceof Error ? e.message : e);
          open.push(g);
        }
      }
      if (!cancelled) {
        setUnclaimed(open);
        setChecking(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [wonGames, publicClient, address, refresh]);

  const claim = useCallback(
    async (gameId: string, voucher: string) => {
      if (!POOLDAWGS_ADDRESS || !voucher) return;
      setClaimError(null);
      setClaiming(gameId);
      try {
        const tx = await writeContractAsync({
          address: POOLDAWGS_ADDRESS,
          abi: POOL_DAWGS_ABI,
          functionName: "claimRewardSigned",
          args: [gameId, voucher as `0x${string}`],
          chainId: CHAIN_ID,
        });
        if (publicClient) await publicClient.waitForTransactionReceipt({ hash: tx });
        setRefresh((n) => n + 1); // re-check on-chain claimed state
      } catch (e) {
        setClaimError(e instanceof Error ? e.message.split("\n")[0] : "Claim failed");
      } finally {
        setClaiming(null);
      }
    },
    [publicClient, writeContractAsync]
  );

  function copyAddress() {
    if (!address) return;
    void navigator.clipboard?.writeText(address);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  const dirty = profile ? nameInput.trim() !== (profile.username ?? "") : false;
  const wins = profile?.wins ?? 0;
  const losses = profile?.losses ?? 0;
  const total = wins + losses;
  const winRate = total > 0 ? Math.round((wins / total) * 100) : 0;

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      {/* ── Identity ── */}
      <section className="panel panel-gilt flex flex-col items-center gap-5 p-6 sm:flex-row sm:items-start">
        <div className="h-28 w-28 shrink-0 overflow-hidden rounded-2xl border-2 border-gold/70 shadow-gold-glow">
          {avatar ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={avatar} alt="Your avatar" className="h-full w-full object-cover" draggable={false} />
          ) : (
            <span className="flex h-full w-full items-center justify-center bg-wood-grain text-4xl">🐶</span>
          )}
        </div>

        <div className="min-w-0 flex-1 space-y-3">
          <div>
            <label className="mb-1 block text-xs uppercase tracking-widest text-amber-100/60">
              Username
            </label>
            <div className="flex gap-2">
              <input
                value={nameInput}
                maxLength={MAX_USERNAME_LENGTH}
                onChange={(e) => setNameInput(e.target.value)}
                placeholder="Pick a handle"
                className="min-w-0 flex-1 rounded-lg border border-gold-dim/40 bg-mahogany-deep px-3 py-2 outline-none focus:border-gold"
              />
              <button
                className="btn-gold"
                disabled={!dirty || saving}
                onClick={() => setUsername(nameInput.trim())}
              >
                {saving ? "Signing…" : "Save"}
              </button>
            </div>
            <p className="mt-1 text-[11px] text-amber-100/40">
              Shown to opponents in games and on the lobby. Saving signs a message (no gas).
            </p>
            {error && <p className="mt-1 text-sm text-red-300">{error}</p>}
          </div>

          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
            <span className="text-amber-100/60">Wallet</span>
            <button
              onClick={copyAddress}
              title="Copy address"
              className="font-mono text-gold-bright transition hover:text-gold"
            >
              {address ? shortAddress(address) : "—"} {copied ? "✓" : "⧉"}
            </button>
            <span className="text-amber-100/60">Balance</span>
            <span className="flex items-center gap-1 font-semibold text-gold-bright">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src="/assets/token.svg" alt="" className="h-4 w-4" draggable={false} />
              {balance !== undefined
                ? Number(formatUnits(balance as bigint, 18)).toLocaleString()
                : "—"}{" "}
              $DDAWGS
            </span>
          </div>
        </div>
      </section>

      {/* ── Stats ── */}
      <section className="panel panel-gilt p-6">
        <h2 className="heading-display mb-4 text-xl">Game statistics</h2>
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <Stat label="Wins" value={wins.toString()} accent />
          <Stat label="Losses" value={losses.toString()} />
          <Stat label="Win rate" value={total > 0 ? `${winRate}%` : "—"} />
          <Stat
            label="Total won"
            value={profile ? formatStake(profile.wonAmount).replace(" $DDawgs", "") : "0"}
          />
        </div>
      </section>

      {/* ── Unclaimed rewards ── */}
      <section className="panel panel-gilt p-6">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="heading-display text-xl">Unclaimed rewards</h2>
          {checking && <span className="text-xs text-amber-100/50">Checking on-chain…</span>}
        </div>
        {claimError && <p className="mb-3 text-sm text-red-300">{claimError}</p>}
        {unclaimed.length === 0 ? (
          <p className="text-sm text-amber-100/50">
            {checking
              ? "Looking up your wins…"
              : "No rewards waiting to be claimed. Win a wagered game and it shows up here."}
          </p>
        ) : (
          <ul className="space-y-3">
            {unclaimed.map((g) => (
              <li key={g.gameId} className="flex items-center gap-4 rounded-lg border border-gold-dim/30 bg-emerald-deep px-4 py-3">
                <div className="text-2xl">🏆</div>
                <div className="min-w-0 flex-1">
                  <p className="font-mono font-semibold text-cream">{g.gameId}</p>
                  <p className="text-xs text-cream/60">
                    {GAME_TYPE_LABEL[gameTypeFromId(g.gameId)]} · won{" "}
                    <span className="text-gold-bright">{formatStake(g.reward)}</span>
                  </p>
                </div>
                {g.voucher ? (
                  <button
                    className="btn-gold"
                    disabled={claiming === g.gameId}
                    onClick={() => claim(g.gameId, g.voucher!)}
                  >
                    {claiming === g.gameId ? "Claiming…" : "Claim"}
                  </button>
                ) : (
                  <span
                    className="rounded-lg border border-gold-dim/40 px-3 py-2 text-xs text-cream/60"
                    title="The reward voucher isn't available yet — reconnect to the game server and refresh."
                  >
                    Pending…
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
        <p className="mt-3 text-[11px] text-cream/40">
          Wins show here even before they settle on-chain — once the result is recorded you can
          claim them anytime.
        </p>
      </section>
    </div>
  );
}

function Stat({ label, value, accent = false }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="rounded-lg border border-gold-dim/30 bg-mahogany-deep px-4 py-3 text-center">
      <p className={`text-2xl font-bold ${accent ? "text-gold-bright" : "text-amber-50"}`}>{value}</p>
      <p className="mt-1 text-[11px] uppercase tracking-widest text-amber-100/50">{label}</p>
    </div>
  );
}
