"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { parseEther } from "viem";
import { useAccount, usePublicClient, useWriteContract } from "wagmi";
import {
  ERC20_ABI,
  POOL_DAWGS_ABI,
  type LobbyGame,
} from "@pooldawgs/shared";
import WalletGate from "@/components/WalletGate";
import {
  CONTRACTS_CONFIGURED,
  DDAWGS_TOKEN_ADDRESS,
  POOLDAWGS_ADDRESS,
} from "@/lib/env";
import { formatStake, shortAddress } from "@/lib/format";
import { getSocket } from "@/lib/socket";

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
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

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

  const openGames = useMemo(
    () => games.filter((g) => g.status === "open"),
    [games]
  );

  async function createOnChain() {
    if (!POOLDAWGS_ADDRESS || !DDAWGS_TOKEN_ADDRESS || !publicClient || !address) return;
    setError(null);
    setBusy("create");
    try {
      const stake = parseEther(stakeInput || "0");
      if (stake <= 0n) throw new Error("Enter a stake");

      const allowance = await publicClient.readContract({
        address: DDAWGS_TOKEN_ADDRESS,
        abi: ERC20_ABI,
        functionName: "allowance",
        args: [address, POOLDAWGS_ADDRESS],
      });
      if (allowance < stake) {
        const approveTx = await writeContractAsync({
          address: DDAWGS_TOKEN_ADDRESS,
          abi: ERC20_ABI,
          functionName: "approve",
          args: [POOLDAWGS_ADDRESS, stake],
        });
        await publicClient.waitForTransactionReceipt({ hash: approveTx });
      }

      // gameIds are client-chosen strings in the ChessDawgs template.
      const gameId = crypto.randomUUID();
      const createTx = await writeContractAsync({
        address: POOLDAWGS_ADDRESS,
        abi: POOL_DAWGS_ABI,
        functionName: "createGame",
        args: [stake, gameId],
      });
      await publicClient.waitForTransactionReceipt({ hash: createTx });
      router.push(`/game/${gameId}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Transaction failed");
    } finally {
      setBusy(null);
    }
  }

  async function joinOnChain(game: LobbyGame) {
    if (!POOLDAWGS_ADDRESS || !DDAWGS_TOKEN_ADDRESS || !publicClient || !address) return;
    setError(null);
    setBusy(game.gameId);
    try {
      const stake = BigInt(game.stake);
      const allowance = await publicClient.readContract({
        address: DDAWGS_TOKEN_ADDRESS,
        abi: ERC20_ABI,
        functionName: "allowance",
        args: [address, POOLDAWGS_ADDRESS],
      });
      if (allowance < stake) {
        const approveTx = await writeContractAsync({
          address: DDAWGS_TOKEN_ADDRESS,
          abi: ERC20_ABI,
          functionName: "approve",
          args: [POOLDAWGS_ADDRESS, stake],
        });
        await publicClient.waitForTransactionReceipt({ hash: approveTx });
      }
      const joinTx = await writeContractAsync({
        address: POOLDAWGS_ADDRESS,
        abi: POOL_DAWGS_ABI,
        functionName: "joinGame",
        args: [game.gameId],
      });
      await publicClient.waitForTransactionReceipt({ hash: joinTx });
      router.push(`/game/${game.gameId}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Transaction failed");
    } finally {
      setBusy(null);
    }
  }

  function createDevTable() {
    const id = `dev-${Math.random().toString(36).slice(2, 8)}`;
    router.push(`/game/${id}`);
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
            No open tables right now — rack one up on the right.
          </div>
        ) : (
          <ul className="space-y-3">
            {openGames.map((game) => (
              <li key={game.gameId} className="panel flex items-center gap-4 px-5 py-4">
                <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-wood-grain text-lg">
                  🎱
                </div>
                <div className="min-w-0 flex-1">
                  <p className="font-semibold text-amber-50">
                    Table #{game.gameId}
                  </p>
                  <p className="text-xs text-amber-100/60">
                    {shortAddress(game.playerOne)} · waiting for an opponent
                  </p>
                </div>
                <span className="font-semibold text-gold-bright">
                  {formatStake(game.stake)}
                </span>
                <button
                  className="btn-gold"
                  disabled={busy !== null || game.playerOne === address?.toLowerCase()}
                  onClick={() => joinOnChain(game)}
                >
                  {busy === game.gameId ? "Joining…" : "Join"}
                </button>
              </li>
            ))}
          </ul>
        )}
        {openGames.length > 0 && (
          <button
            className="btn-outline mt-4"
            disabled={busy !== null}
            onClick={() => {
              const target = openGames.find((g) => g.playerOne !== address?.toLowerCase());
              if (target) void joinOnChain(target);
            }}
          >
            ⚡ Quick match — join the first open table
          </button>
        )}
      </section>

      <aside className="space-y-6">
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
              <button
                className="btn-gold w-full"
                disabled={busy !== null}
                onClick={createOnChain}
              >
                {busy === "create" ? "Confirm in wallet…" : "Stake & create"}
              </button>
              <p className="mt-3 text-xs text-amber-100/50">
                Approves $DDawgs then escrows your stake. You can cancel and
                refund any time before someone joins.
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
