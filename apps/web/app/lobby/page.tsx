"use client";

import { useEffect, useMemo, useState } from "react";
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
import { newGameCode, normalizeCode } from "@/lib/gamecode";
import { log } from "@/lib/log";
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
  const [joinCode, setJoinCode] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const { data: tokenBalance, refetch: refetchBalance } = useReadContract({
    address: DDAWGS_TOKEN_ADDRESS ?? undefined,
    abi: FAUCET_TOKEN_ABI,
    functionName: "balanceOf",
    args: address ? [address] : undefined,
    query: { enabled: Boolean(IS_TESTNET && CONTRACTS_CONFIGURED && address) },
  });

  // Live open-tables list (full/active games are excluded below).
  useEffect(() => {
    const socket = getSocket();
    socket.emit("lobby:subscribe");
    const onState = ({ games }: { games: LobbyGame[] }) => {
      log.info("lobby: state —", games.length, "games");
      setGames(games);
    };
    socket.on("lobby:state", onState);
    return () => {
      socket.off("lobby:state", onState);
      socket.emit("lobby:unsubscribe");
    };
  }, []);

  // ?join=CODE deep link prefills the join box.
  useEffect(() => {
    const j = new URLSearchParams(window.location.search).get("join");
    if (j) setJoinCode(normalizeCode(j));
  }, []);

  const openGames = useMemo(() => games.filter((g) => g.status === "open"), [games]);

  async function createOnChain() {
    if (!POOLDAWGS_ADDRESS || !DDAWGS_TOKEN_ADDRESS || !publicClient || !address) return;
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

      const allowance = (await publicClient.readContract({
        address: DDAWGS_TOKEN_ADDRESS,
        abi: ERC20_ABI,
        functionName: "allowance",
        args: [address, POOLDAWGS_ADDRESS],
      })) as bigint;
      if (allowance < stake) {
        const a = await writeContractAsync({
          address: DDAWGS_TOKEN_ADDRESS,
          abi: ERC20_ABI,
          functionName: "approve",
          args: [POOLDAWGS_ADDRESS, stake],
        });
        await publicClient.waitForTransactionReceipt({ hash: a });
      }
      log.info("lobby: createGame", gameId, "stake", stakeInput);
      const tx = await writeContractAsync({
        address: POOLDAWGS_ADDRESS,
        abi: POOL_DAWGS_ABI,
        functionName: "createGame",
        args: [stake, gameId],
      });
      await publicClient.waitForTransactionReceipt({ hash: tx });
      log.info("lobby: created", gameId, "→ /game/" + gameId);
      // The game page shows the "waiting / share this code" screen.
      router.push(`/game/${gameId}`);
    } catch (e) {
      log.error("lobby: create failed —", e);
      setError(e instanceof Error ? e.message.split("\n")[0] : "Transaction failed");
      setBusy(null);
    }
  }

  // Joining is handled entirely on the game page (it validates the code,
  // offers to join, or alerts if it's full / not yours).
  function go(gameId: string) {
    log.info("lobby: → /game/" + gameId);
    router.push(`/game/${gameId}`);
  }
  function joinByCode() {
    const code = normalizeCode(joinCode);
    log.info("lobby: join by code", JSON.stringify(joinCode), "→", code);
    if (code) go(code);
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
                  <button className="btn-gold" onClick={() => go(game.gameId)}>
                    {mine ? "Resume" : "Join"}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        {openGames.some((g) => g.playerOne !== address?.toLowerCase()) && (
          <button
            className="btn-outline mt-4"
            onClick={() => {
              const t = openGames.find((g) => g.playerOne !== address?.toLowerCase());
              if (t) go(t.gameId);
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
              <button className="btn-gold w-full" disabled={busy !== null} onClick={createOnChain}>
                {busy === "create" ? "Confirm in wallet…" : "Stake & create"}
              </button>
              <p className="mt-3 text-xs text-amber-100/50">
                Generates a shareable game code, escrows your stake, and opens a
                table you can share or cancel any time before someone joins.
              </p>
            </>
          ) : (
            <>
              <p className="mb-4 text-sm text-amber-100/60">
                Contracts aren&rsquo;t configured in this build — spin up a dev
                table instead.
              </p>
              <button
                className="btn-gold w-full"
                onClick={() => go(`dev-${Math.random().toString(36).slice(2, 8)}`)}
              >
                Create dev table
              </button>
            </>
          )}
        </div>

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
              <button className="btn-gold" disabled={!joinCode.trim()} onClick={joinByCode}>
                Join
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
