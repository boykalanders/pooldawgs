"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { parseEther, zeroAddress } from "viem";
import {
  useAccount,
  usePublicClient,
  useReadContract,
  useWriteContract,
} from "wagmi";
import {
  ERC20_ABI,
  FAUCET_TOKEN_ABI,
  POOL_DAWGS_ABI,
  type LobbyGame,
} from "@pooldawgs/shared";
import WalletGate from "@/components/WalletGate";
import {
  CONTRACTS_CONFIGURED,
  DDAWGS_TOKEN_ADDRESS,
  IS_TESTNET,
  POOLDAWGS_ADDRESS,
} from "@/lib/env";
import { formatStake, shortAddress } from "@/lib/format";
import { inviteLink, newGameCode, normalizeCode } from "@/lib/gamecode";
import { getSocket } from "@/lib/socket";

interface CreatedGame {
  gameId: string;
  stake: string; // wei
}

const CREATED_KEY = "pooldawgs:created";

export default function LobbyPage() {
  return (
    <WalletGate>
      <Lobby />
    </WalletGate>
  );
}

function Lobby() {
  const router = useRouter();
  const { address } = useAccount();
  const publicClient = usePublicClient();
  const { writeContractAsync } = useWriteContract();

  const [games, setGames] = useState<LobbyGame[]>([]);
  const [stakeInput, setStakeInput] = useState("100");
  const [joinCode, setJoinCode] = useState("");
  const [created, setCreated] = useState<CreatedGame | null>(null);
  const [copied, setCopied] = useState<"code" | "link" | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Test-token balance for the faucet panel (testnet only).
  const { data: tokenBalance, refetch: refetchBalance } = useReadContract({
    address: DDAWGS_TOKEN_ADDRESS ?? undefined,
    abi: FAUCET_TOKEN_ABI,
    functionName: "balanceOf",
    args: address ? [address] : undefined,
    query: { enabled: Boolean(IS_TESTNET && CONTRACTS_CONFIGURED && address) },
  });

  // Live open-tables list.
  useEffect(() => {
    const socket = getSocket();
    socket.emit("lobby:subscribe");
    const onState = ({ games }: { games: LobbyGame[] }) => setGames(games);
    socket.on("lobby:state", onState);
    return () => {
      socket.off("lobby:state", onState);
      socket.emit("lobby:unsubscribe");
    };
  }, []);

  // Restore a pending created game (survives refresh) and any ?join= deep link.
  useEffect(() => {
    try {
      const raw = sessionStorage.getItem(CREATED_KEY);
      if (raw) setCreated(JSON.parse(raw));
    } catch {
      /* ignore */
    }
    const j = new URLSearchParams(window.location.search).get("join");
    if (j) setJoinCode(normalizeCode(j));
  }, []);

  useEffect(() => {
    if (created) sessionStorage.setItem(CREATED_KEY, JSON.stringify(created));
    else sessionStorage.removeItem(CREATED_KEY);
  }, [created]);

  const clearCreated = useCallback(() => setCreated(null), []);

  // When my open game gets an opponent, drop straight into the table.
  useEffect(() => {
    if (!created) return;
    const g = games.find((x) => x.gameId === created.gameId);
    if (g && g.status === "active") {
      const id = created.gameId;
      clearCreated();
      router.push(`/game/${id}`);
    }
  }, [games, created, clearCreated, router]);

  const openGames = useMemo(() => games.filter((g) => g.status === "open"), [games]);

  async function ensureApproved(stake: bigint) {
    if (!POOLDAWGS_ADDRESS || !DDAWGS_TOKEN_ADDRESS || !publicClient || !address) return;
    const allowance = (await publicClient.readContract({
      address: DDAWGS_TOKEN_ADDRESS,
      abi: ERC20_ABI,
      functionName: "allowance",
      args: [address, POOLDAWGS_ADDRESS],
    })) as bigint;
    if (allowance < stake) {
      const tx = await writeContractAsync({
        address: DDAWGS_TOKEN_ADDRESS,
        abi: ERC20_ABI,
        functionName: "approve",
        args: [POOLDAWGS_ADDRESS, stake],
      });
      await publicClient.waitForTransactionReceipt({ hash: tx });
    }
  }

  async function createOnChain() {
    if (!POOLDAWGS_ADDRESS || !publicClient || !address) return;
    setError(null);
    setBusy("create");
    try {
      const stake = parseEther(stakeInput || "0");
      if (stake <= 0n) throw new Error("Enter a stake");

      // Pick a code that isn't already taken on-chain.
      let gameId = newGameCode();
      for (let i = 0; i < 5; i++) {
        const g = (await publicClient.readContract({
          address: POOLDAWGS_ADDRESS,
          abi: POOL_DAWGS_ABI,
          functionName: "games",
          args: [gameId],
        })) as unknown as readonly [string, ...unknown[]];
        if (g[0] === zeroAddress) break;
        gameId = newGameCode();
      }

      await ensureApproved(stake);
      const createTx = await writeContractAsync({
        address: POOLDAWGS_ADDRESS,
        abi: POOL_DAWGS_ABI,
        functionName: "createGame",
        args: [stake, gameId],
      });
      await publicClient.waitForTransactionReceipt({ hash: createTx });
      // Stay in the lobby on a "waiting / share this code" card; we drop into
      // the table automatically once an opponent joins.
      setCreated({ gameId, stake: stake.toString() });
    } catch (e) {
      setError(e instanceof Error ? e.message.split("\n")[0] : "Transaction failed");
    } finally {
      setBusy(null);
    }
  }

  async function cancelCreated() {
    if (!created || !POOLDAWGS_ADDRESS || !publicClient) return;
    setError(null);
    setBusy("cancel");
    try {
      const tx = await writeContractAsync({
        address: POOLDAWGS_ADDRESS,
        abi: POOL_DAWGS_ABI,
        functionName: "cancelGame",
        args: [created.gameId],
      });
      await publicClient.waitForTransactionReceipt({ hash: tx });
      clearCreated();
    } catch (e) {
      setError(e instanceof Error ? e.message.split("\n")[0] : "Cancel failed");
    } finally {
      setBusy(null);
    }
  }

  async function doJoin(gameId: string, stake: bigint, busyKey: string) {
    if (!POOLDAWGS_ADDRESS || !publicClient || !address) return;
    setError(null);
    setBusy(busyKey);
    try {
      await ensureApproved(stake);
      const tx = await writeContractAsync({
        address: POOLDAWGS_ADDRESS,
        abi: POOL_DAWGS_ABI,
        functionName: "joinGame",
        args: [gameId],
      });
      await publicClient.waitForTransactionReceipt({ hash: tx });
      router.push(`/game/${gameId}`);
    } catch (e) {
      setError(e instanceof Error ? e.message.split("\n")[0] : "Transaction failed");
    } finally {
      setBusy(null);
    }
  }

  async function joinByCode() {
    if (!POOLDAWGS_ADDRESS || !publicClient || !address) return;
    const code = normalizeCode(joinCode);
    if (!code) return;
    setError(null);
    setBusy("joincode");
    try {
      const g = (await publicClient.readContract({
        address: POOLDAWGS_ADDRESS,
        abi: POOL_DAWGS_ABI,
        functionName: "games",
        args: [code],
      })) as unknown as readonly [string, string, boolean, string, bigint, ...unknown[]];
      const [playerOne, playerTwo, isCompleted, , stake] = g;
      if (playerOne === zeroAddress) throw new Error(`No game with code ${code}`);
      if (isCompleted) throw new Error("That game is already over");
      if (playerTwo !== zeroAddress) throw new Error("That game is already full");
      if (playerOne.toLowerCase() === address.toLowerCase()) {
        // It's your own open game — just go wait in it.
        router.push(`/game/${code}`);
        return;
      }
      await doJoin(code, stake, "joincode");
    } catch (e) {
      setError(e instanceof Error ? e.message.split("\n")[0] : "Could not join");
      setBusy(null);
    }
  }

  async function faucet() {
    if (!DDAWGS_TOKEN_ADDRESS || !publicClient || !address) return;
    setError(null);
    setBusy("faucet");
    try {
      const tx = await writeContractAsync({
        address: DDAWGS_TOKEN_ADDRESS,
        abi: FAUCET_TOKEN_ABI,
        functionName: "mint",
        args: [address, parseEther("1000")],
      });
      await publicClient.waitForTransactionReceipt({ hash: tx });
      await refetchBalance();
    } catch (e) {
      setError(e instanceof Error ? e.message.split("\n")[0] : "Faucet failed");
    } finally {
      setBusy(null);
    }
  }

  function copy(kind: "code" | "link", text: string) {
    void navigator.clipboard?.writeText(text);
    setCopied(kind);
    setTimeout(() => setCopied(null), 1500);
  }

  function createDevTable() {
    router.push(`/game/dev-${Math.random().toString(36).slice(2, 8)}`);
  }

  return (
    <div className="grid gap-8 lg:grid-cols-[1fr_360px]">
      <section>
        <h1 className="heading-display mb-6 text-3xl">Open tables</h1>
        {error && (
          <p className="mb-4 rounded-lg border border-red-800 bg-red-950/50 px-4 py-2 text-sm text-red-300">
            {error}
          </p>
        )}
        {openGames.length === 0 ? (
          <div className="panel p-10 text-center text-amber-100/50">
            No open tables right now — create one, or join with a code on the right.
          </div>
        ) : (
          <ul className="space-y-3">
            {openGames.map((game) => {
              const mine = game.playerOne === address?.toLowerCase();
              return (
                <li key={game.gameId} className="panel flex items-center gap-4 px-5 py-4">
                  <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-wood-grain text-lg">
                    🎱
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="font-mono font-semibold text-amber-50">{game.gameId}</p>
                    <p className="text-xs text-amber-100/60">
                      {shortAddress(game.playerOne)}
                      {mine ? " · your table" : " · waiting for an opponent"}
                    </p>
                  </div>
                  <span className="font-semibold text-gold-bright">
                    {formatStake(game.stake)}
                  </span>
                  <button
                    className="btn-gold"
                    disabled={busy !== null || mine}
                    onClick={() => doJoin(game.gameId, BigInt(game.stake), game.gameId)}
                  >
                    {busy === game.gameId ? "Joining…" : mine ? "Yours" : "Join"}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        {openGames.some((g) => g.playerOne !== address?.toLowerCase()) && (
          <button
            className="btn-outline mt-4"
            disabled={busy !== null}
            onClick={() => {
              const t = openGames.find((g) => g.playerOne !== address?.toLowerCase());
              if (t) void doJoin(t.gameId, BigInt(t.stake), t.gameId);
            }}
          >
            ⚡ Quick match — join the first open table
          </button>
        )}
      </section>

      <aside className="space-y-6">
        {created ? (
          <div className="panel gold-frame p-6 text-center">
            <h2 className="heading-display mb-1 text-xl">Waiting for an opponent…</h2>
            <p className="mb-4 text-xs text-amber-100/60">
              Share this code (or the link) to challenge someone directly.
            </p>
            <div className="mb-3 rounded-lg border border-gold/50 bg-mahogany-deep px-4 py-3 font-mono text-2xl font-bold tracking-widest text-gold-bright">
              {created.gameId}
            </div>
            <div className="mb-4 flex gap-2">
              <button className="btn-outline flex-1" onClick={() => copy("code", created.gameId)}>
                {copied === "code" ? "Copied ✓" : "Copy code"}
              </button>
              <button
                className="btn-outline flex-1"
                onClick={() => copy("link", inviteLink(created.gameId))}
              >
                {copied === "link" ? "Copied ✓" : "Copy link"}
              </button>
            </div>
            <p className="mb-4 text-xs text-amber-100/50">
              Stake {formatStake(created.stake)} escrowed. You&rsquo;ll drop into the
              table the moment someone joins.
            </p>
            <button
              className="btn-outline w-full border-red-900/60 text-red-300 hover:border-red-500"
              disabled={busy !== null}
              onClick={cancelCreated}
            >
              {busy === "cancel" ? "Cancelling…" : "Cancel & refund"}
            </button>
          </div>
        ) : (
          <div className="panel p-6">
            <h2 className="heading-display mb-4 text-xl">Create a table</h2>
            {CONTRACTS_CONFIGURED ? (
              <>
                <label className="mb-1 block text-xs uppercase tracking-widest text-amber-100/60">
                  Stake ($DDawgs)
                </label>
                <input
                  value={stakeInput}
                  onChange={(e) => setStakeInput(e.target.value)}
                  inputMode="decimal"
                  className="mb-4 w-full rounded-lg border border-gold-dim/40 bg-mahogany-deep px-3 py-2 outline-none focus:border-gold"
                />
                <button className="btn-gold w-full" disabled={busy !== null} onClick={createOnChain}>
                  {busy === "create" ? "Confirm in wallet…" : "Stake & create"}
                </button>
                <p className="mt-3 text-xs text-amber-100/50">
                  Generates a shareable game code. Approves $DDawgs, escrows your
                  stake, and lists the table publicly — cancel any time before
                  someone joins.
                </p>
              </>
            ) : (
              <>
                <p className="mb-4 text-sm text-amber-100/60">
                  Contracts aren&rsquo;t configured in this build — spin up a dev
                  table instead. First two wallets to open it get the seats.
                </p>
                <button className="btn-gold w-full" onClick={createDevTable}>
                  Create dev table
                </button>
              </>
            )}
          </div>
        )}

        {CONTRACTS_CONFIGURED && (
          <div className="panel p-6">
            <h2 className="heading-display mb-3 text-xl">Join by code</h2>
            <p className="mb-3 text-xs text-amber-100/60">
              Got a code (or invite link) from a friend? Drop it in.
            </p>
            <div className="flex gap-2">
              <input
                value={joinCode}
                onChange={(e) => setJoinCode(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && joinByCode()}
                placeholder="POOL-XXXXX"
                className="min-w-0 flex-1 rounded-lg border border-gold-dim/40 bg-mahogany-deep px-3 py-2 font-mono uppercase outline-none focus:border-gold"
              />
              <button
                className="btn-gold"
                disabled={busy !== null || !joinCode.trim()}
                onClick={joinByCode}
              >
                {busy === "joincode" ? "…" : "Join"}
              </button>
            </div>
          </div>
        )}

        {IS_TESTNET && CONTRACTS_CONFIGURED && (
          <div className="panel p-6">
            <h2 className="heading-display mb-1 text-xl">Test faucet</h2>
            <p className="mb-3 text-xs text-amber-100/60">
              Sepolia testnet — grab free $DDawgs to wager with.
            </p>
            <div className="mb-3 flex items-center gap-2 text-sm">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src="/assets/token.svg" alt="" className="h-5 w-5" draggable={false} />
              <span className="font-mono text-gold-bright">
                {tokenBalance !== undefined ? formatStake(tokenBalance) : "—"}
              </span>
            </div>
            <button className="btn-gold w-full" disabled={busy !== null} onClick={faucet}>
              {busy === "faucet" ? "Minting…" : "Get 1,000 test $DDawgs"}
            </button>
          </div>
        )}

        <div className="panel p-6 text-sm text-amber-100/60">
          <h3 className="mb-2 font-semibold text-gold">House rules</h3>
          <ul className="list-inside list-disc space-y-1">
            <li>Win/loss only — no draws on a pool table.</li>
            <li>Resigning is a loss.</li>
            <li>4-minute shot clock; timeout forfeits.</li>
            <li>Winner claims 80% of the pot. 10% house, 10% burned.</li>
          </ul>
        </div>
      </aside>
    </div>
  );
}
