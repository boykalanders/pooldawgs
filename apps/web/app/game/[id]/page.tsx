"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { formatUnits, zeroAddress } from "viem";
import { useAccount, usePublicClient, useReadContract, useSignMessage, useWriteContract } from "wagmi";
import {
  cloneState,
  cueBallId,
  type PlayerIndex,
  type ShotInput,
  type TableState,
} from "@pooldawgs/engine";
import {
  ERC20_ABI,
  loginMessage,
  POOL_DAWGS_ABI,
  type Address,
  type ChatMessage,
  type GameOverReason,
  type RoomSnapshot,
  type ServerError,
  type ShotBroadcast,
} from "@pooldawgs/shared";
import GameShell, { type ShellPlayer } from "@/components/GameShell";
import { type ShotAnimation } from "@/components/PoolCanvas";
import WalletGate from "@/components/WalletGate";
import WinnerPopup from "@/components/WinnerPopup";
import {
  CONTRACTS_CONFIGURED,
  DDAWGS_TOKEN_ADDRESS,
  POOLDAWGS_ADDRESS,
} from "@/lib/env";
import { formatStake, shortAddress } from "@/lib/format";
import { inviteLink } from "@/lib/gamecode";
import { getSocket } from "@/lib/socket";

export default function GamePage() {
  return (
    <WalletGate>
      <GameRoom />
    </WalletGate>
  );
}

type Phase = "loading" | "notfound" | "waiting" | "invite" | "full" | "over" | "play";

/** Decoded on-chain game tuple from PoolDawgs.games(gameId). */
type ChainGame = readonly [string, string, boolean, string, bigint, ...unknown[]];

function GameRoom() {
  const params = useParams<{ id: string }>();
  const gameId = params.id;
  const router = useRouter();
  const { address } = useAccount();
  const publicClient = usePublicClient();
  const { signMessageAsync } = useSignMessage();
  const { writeContractAsync } = useWriteContract();

  const [snapshot, setSnapshot] = useState<RoomSnapshot | null>(null);
  const [state, setState] = useState<TableState | null>(null);
  const [animation, setAnimation] = useState<ShotAnimation | null>(null);
  const pendingEndState = useRef<TableState | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [serverError, setServerError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [joined, setJoined] = useState(false);
  const [claimed, setClaimed] = useState(false);
  const [working, setWorking] = useState<string | null>(null);
  const [copied, setCopied] = useState<"code" | "link" | null>(null);

  const { data: myBalance } = useReadContract({
    address: DDAWGS_TOKEN_ADDRESS ?? undefined,
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: address ? [address] : undefined,
    query: { enabled: Boolean(CONTRACTS_CONFIGURED && address) },
  });

  // On-chain game state drives the pre-game phase. Polled so the creator's
  // "waiting" screen flips to play the moment an opponent joins.
  const { data: chainGame, refetch: refetchGame } = useReadContract({
    address: POOLDAWGS_ADDRESS ?? undefined,
    abi: POOL_DAWGS_ABI,
    functionName: "games",
    args: [gameId],
    query: {
      enabled: Boolean(CONTRACTS_CONFIGURED && gameId),
      refetchInterval: 4000,
    },
  });

  // ── derive phase ──────────────────────────────────────────────────────
  const me = address?.toLowerCase();
  let phase: Phase = "play";
  let onchainStake: bigint | null = null;
  let onchainWinner: string | null = null;
  let amP1 = false;
  let amP2 = false;

  if (CONTRACTS_CONFIGURED) {
    if (!chainGame) {
      phase = "loading";
    } else {
      const [p1, p2, completed, winner, stake] = chainGame as ChainGame;
      onchainStake = stake;
      onchainWinner = winner;
      const open = p2 === zeroAddress;
      amP1 = !!me && p1.toLowerCase() === me;
      amP2 = !open && !!me && p2.toLowerCase() === me;

      if (p1 === zeroAddress) phase = "notfound";
      else if (amP1 || amP2) {
        phase = completed ? "over" : open ? "waiting" : "play";
      } else {
        phase = completed ? "over" : open ? "invite" : "full";
      }
    }
  }
  // Once we're seated in a live room, always render the table (the in-session
  // finish is handled by snapshot.over + the winner popup).
  const effectivePhase: Phase = snapshot ? "play" : phase;

  const mySeat: PlayerIndex | null = (() => {
    if (!snapshot || !address) return null;
    const m = snapshot.players.find((p) => p.address.toLowerCase() === address.toLowerCase());
    return m ? m.seat : null;
  })();

  // Connect to the socket room only once the game is playable for us.
  useEffect(() => {
    if (!address || joined || effectivePhase !== "play") return;
    const socket = getSocket();
    let cancelled = false;
    (async () => {
      try {
        const ts = Date.now();
        const signature = await signMessageAsync({ message: loginMessage(address as Address, ts) });
        if (cancelled) return;
        socket.emit("room:join", { gameId, auth: { address: address as Address, ts, signature } });
        setJoined(true);
      } catch {
        setServerError("Signature rejected — sign in to take your seat.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [address, gameId, joined, effectivePhase, signMessageAsync]);

  // Socket subscriptions (always mounted; harmless before we join).
  useEffect(() => {
    const socket = getSocket();
    const onRoomState = (snap: RoomSnapshot) => {
      if (snap.gameId !== gameId) return;
      setSnapshot(snap);
      if (!pendingEndState.current) setState(snap.state);
    };
    const onShot = (shot: ShotBroadcast) => {
      if (shot.gameId !== gameId) return;
      setState((current) => {
        const from = current ?? shot.endState;
        pendingEndState.current = shot.endState;
        setAnimation({
          fromState: cloneState(from),
          shot: shot.shot,
          key: `${shot.endStateHash}-${shot.clockExpiresAt}`,
        });
        return current;
      });
      setSnapshot((s) => (s ? { ...s, clockExpiresAt: shot.clockExpiresAt } : s));
    };
    const onCuePlaced = (p: { gameId: string; x: number; y: number }) => {
      if (p.gameId !== gameId) return;
      setState((current) => {
        if (!current) return current;
        const next = cloneState(current);
        const cue = next.balls[cueBallId(next)];
        cue.x = p.x;
        cue.y = p.y;
        cue.inHole = false;
        cue.vx = 0;
        cue.vy = 0;
        next.ballInHand = false;
        return next;
      });
    };
    const onOver = (p: { gameId: string; winner: Address; reason: GameOverReason; txHash?: string }) => {
      if (p.gameId !== gameId) return;
      setSnapshot((s) => (s ? { ...s, over: { winner: p.winner, reason: p.reason, txHash: p.txHash } } : s));
    };
    const onChat = (m: ChatMessage) => {
      if (m.gameId === gameId) setMessages((prev) => [...prev, m]);
    };
    const onError = (e: ServerError) => setServerError(e.message);

    socket.on("room:state", onRoomState);
    socket.on("game:shot", onShot);
    socket.on("game:cueBallPlaced", onCuePlaced);
    socket.on("game:over", onOver);
    socket.on("chat:message", onChat);
    socket.on("server:error", onError);
    return () => {
      socket.off("room:state", onRoomState);
      socket.off("game:shot", onShot);
      socket.off("game:cueBallPlaced", onCuePlaced);
      socket.off("game:over", onOver);
      socket.off("chat:message", onChat);
      socket.off("server:error", onError);
      socket.emit("room:leave", { gameId });
    };
  }, [gameId]);

  const handleAnimationEnd = useCallback(() => {
    if (pendingEndState.current) {
      setState(pendingEndState.current);
      pendingEndState.current = null;
    }
    setAnimation(null);
  }, []);

  const shoot = useCallback(
    (shot: ShotInput) => {
      setServerError(null);
      getSocket().emit("game:shoot", { gameId, shot });
    },
    [gameId]
  );
  const placeCueBall = useCallback(
    (x: number, y: number) => {
      setServerError(null);
      getSocket().emit("game:placeCueBall", { gameId, x, y });
    },
    [gameId]
  );

  async function joinThisGame() {
    if (!POOLDAWGS_ADDRESS || !DDAWGS_TOKEN_ADDRESS || !publicClient || !address || onchainStake === null) return;
    setActionError(null);
    setWorking("join");
    try {
      const allowance = (await publicClient.readContract({
        address: DDAWGS_TOKEN_ADDRESS,
        abi: ERC20_ABI,
        functionName: "allowance",
        args: [address, POOLDAWGS_ADDRESS],
      })) as bigint;
      if (allowance < onchainStake) {
        const a = await writeContractAsync({
          address: DDAWGS_TOKEN_ADDRESS,
          abi: ERC20_ABI,
          functionName: "approve",
          args: [POOLDAWGS_ADDRESS, onchainStake],
        });
        await publicClient.waitForTransactionReceipt({ hash: a });
      }
      const tx = await writeContractAsync({
        address: POOLDAWGS_ADDRESS,
        abi: POOL_DAWGS_ABI,
        functionName: "joinGame",
        args: [gameId],
      });
      await publicClient.waitForTransactionReceipt({ hash: tx });
      await refetchGame(); // now active → phase flips to play → socket connects
    } catch (e) {
      setActionError(e instanceof Error ? e.message.split("\n")[0] : "Join failed");
    } finally {
      setWorking(null);
    }
  }

  async function cancelGame() {
    if (!POOLDAWGS_ADDRESS || !publicClient) return;
    setActionError(null);
    setWorking("cancel");
    try {
      const tx = await writeContractAsync({
        address: POOLDAWGS_ADDRESS,
        abi: POOL_DAWGS_ABI,
        functionName: "cancelGame",
        args: [gameId],
      });
      await publicClient.waitForTransactionReceipt({ hash: tx });
      router.push("/lobby");
    } catch (e) {
      setActionError(e instanceof Error ? e.message.split("\n")[0] : "Cancel failed");
    } finally {
      setWorking(null);
    }
  }

  async function claim() {
    if (!POOLDAWGS_ADDRESS) return;
    try {
      await writeContractAsync({
        address: POOLDAWGS_ADDRESS,
        abi: POOL_DAWGS_ABI,
        functionName: "claimReward",
        args: [gameId],
      });
      setClaimed(true);
    } catch (e) {
      setActionError(e instanceof Error ? e.message.split("\n")[0] : "Claim failed");
    }
  }

  function copy(kind: "code" | "link", text: string) {
    void navigator.clipboard?.writeText(text);
    setCopied(kind);
    setTimeout(() => setCopied(null), 1500);
  }

  // ── pre-game screens ────────────────────────────────────────────────────
  if (effectivePhase !== "play") {
    const Card = ({ children }: { children: React.ReactNode }) => (
      <div className="panel mx-auto mt-10 max-w-md space-y-4 p-8 text-center">{children}</div>
    );
    const Back = () => (
      <button className="btn-outline" onClick={() => router.push("/lobby")}>
        Back to lobby
      </button>
    );

    if (effectivePhase === "loading") {
      return <Card>Loading game {gameId}…</Card>;
    }
    if (effectivePhase === "notfound") {
      return (
        <Card>
          <div className="text-4xl">🔍</div>
          <h2 className="heading-display text-2xl">No game with that code</h2>
          <p className="text-sm text-amber-100/60">
            <span className="font-mono text-gold-bright">{gameId}</span> doesn&rsquo;t exist
            (yet). Double-check the code.
          </p>
          <Back />
        </Card>
      );
    }
    if (effectivePhase === "full") {
      return (
        <Card>
          <div className="text-4xl">🚫</div>
          <h2 className="heading-display text-2xl">That table is taken</h2>
          <p className="text-sm text-amber-100/60">
            Game <span className="font-mono text-gold-bright">{gameId}</span> already has two
            players and you aren&rsquo;t one of them.
          </p>
          <Back />
        </Card>
      );
    }
    if (effectivePhase === "waiting") {
      return (
        <Card>
          <h2 className="heading-display text-2xl">Waiting for an opponent…</h2>
          <p className="text-xs text-amber-100/60">Share this code (or link) to challenge someone.</p>
          <div className="rounded-lg border border-gold/50 bg-mahogany-deep px-4 py-3 font-mono text-2xl font-bold tracking-widest text-gold-bright">
            {gameId}
          </div>
          <div className="flex gap-2">
            <button className="btn-outline flex-1" onClick={() => copy("code", gameId)}>
              {copied === "code" ? "Copied ✓" : "Copy code"}
            </button>
            <button className="btn-outline flex-1" onClick={() => copy("link", inviteLink(gameId))}>
              {copied === "link" ? "Copied ✓" : "Copy link"}
            </button>
          </div>
          {onchainStake !== null && (
            <p className="text-xs text-amber-100/50">
              Stake {formatStake(onchainStake)} escrowed — you&rsquo;ll drop in automatically when
              someone joins.
            </p>
          )}
          {actionError && <p className="text-sm text-red-300">{actionError}</p>}
          <button
            className="btn-outline w-full border-red-900/60 text-red-300 hover:border-red-500"
            disabled={working !== null}
            onClick={cancelGame}
          >
            {working === "cancel" ? "Cancelling…" : "Cancel & refund"}
          </button>
        </Card>
      );
    }
    if (effectivePhase === "invite") {
      return (
        <Card>
          <div className="text-4xl">🎱</div>
          <h2 className="heading-display text-2xl">You&rsquo;ve been challenged</h2>
          <p className="text-sm text-amber-100/60">
            Game <span className="font-mono text-gold-bright">{gameId}</span>
            {onchainStake !== null && (
              <>
                {" "}
                — stake <span className="text-gold-bright">{formatStake(onchainStake)}</span>
              </>
            )}
          </p>
          <button className="btn-gold w-full" disabled={working !== null} onClick={joinThisGame}>
            {working === "join" ? "Joining…" : "Stake & join"}
          </button>
          {actionError && <p className="text-sm text-red-300">{actionError}</p>}
          <Back />
        </Card>
      );
    }
    if (effectivePhase === "over") {
      const iWon = !!me && onchainWinner && onchainWinner.toLowerCase() === me;
      return (
        <Card>
          <div className="text-4xl">🏆</div>
          <h2 className="heading-display text-2xl">{iWon ? "You won this one" : "Game over"}</h2>
          {onchainWinner && onchainWinner !== zeroAddress && (
            <p className="text-sm text-amber-100/60">
              Winner: <span className="font-mono text-gold-bright">{shortAddress(onchainWinner)}</span>
            </p>
          )}
          {iWon && !claimed && (
            <button className="btn-gold w-full" onClick={claim}>
              Claim 80% of the pot
            </button>
          )}
          {claimed && <p className="text-gold-bright">Reward claimed ✓</p>}
          {actionError && <p className="text-sm text-red-300">{actionError}</p>}
          <Back />
        </Card>
      );
    }
  }

  // ── connecting (play phase, awaiting the room snapshot) ──
  if (!snapshot || !state) {
    return (
      <div className="panel mx-auto mt-10 max-w-md p-10 text-center text-amber-100/60">
        {serverError ? (
          <span className="text-red-300">{serverError}</span>
        ) : (
          <>Taking your seat at table {gameId}…</>
        )}
      </div>
    );
  }

  const myTurn = mySeat !== null && !state.gameOver && state.turn === mySeat && !snapshot.over;
  const iWon = snapshot.over && address && snapshot.over.winner.toLowerCase() === address.toLowerCase();

  const shellPlayers = snapshot.players.map((p): ShellPlayer => {
    const isMe = address && p.address.toLowerCase() === address.toLowerCase();
    return {
      name: isMe ? `${shortAddress(p.address)} (you)` : shortAddress(p.address),
      detail:
        isMe && myBalance !== undefined
          ? `${Number(formatUnits(myBalance, 18)).toLocaleString()} $DDAWGS`
          : undefined,
      badge: `P${p.seat + 1}`,
      avatarSrc: p.seat === 0 ? "/assets/avatar-deputy.png" : "/assets/avatar-outlaw.png",
      connected: p.connected,
    };
  }) as [ShellPlayer, ShellPlayer];

  const statusText = snapshot.over
    ? `${shortAddress(snapshot.over.winner)} wins by ${snapshot.over.reason}`
    : myTurn
      ? "Your shot"
      : mySeat === null
        ? "Spectating"
        : "Opponent's shot";

  return (
    <GameShell
      state={state}
      players={shellPlayers}
      interactive={Boolean(myTurn)}
      potLabel={snapshot.stake ? formatStake(BigInt(snapshot.stake) * 2n) : null}
      balanceLabel={myBalance !== undefined ? Number(formatUnits(myBalance, 18)).toLocaleString() : null}
      clockExpiresAt={snapshot.over ? null : snapshot.clockExpiresAt}
      statusText={statusText}
      banner={
        serverError ??
        (myTurn && state.ballInHand ? "Ball in hand — tap the cloth to place the cue ball" : null)
      }
      menuItems={[
        ...(mySeat !== null && !snapshot.over
          ? [
              {
                label: "Resign (forfeit the pot)",
                onClick: () => getSocket().emit("game:resign", { gameId }),
                danger: true,
              },
            ]
          : []),
        { label: "Exit to lobby", onClick: () => router.push("/lobby") },
      ]}
      animation={animation}
      onShoot={shoot}
      onPlaceCueBall={placeCueBall}
      onAnimationEnd={handleAnimationEnd}
      chat={{
        messages,
        myAddress: address ?? null,
        onSend: (text) => getSocket().emit("chat:send", { gameId, text }),
      }}
      overlay={
        snapshot.over && !animation ? (
          <WinnerPopup
            winnerName={iWon ? "You" : shortAddress(snapshot.over.winner)}
            avatarSrc={
              snapshot.players.find((p) => p.address.toLowerCase() === snapshot.over!.winner.toLowerCase())
                ?.seat === 1
                ? "/assets/avatar-outlaw.png"
                : "/assets/avatar-deputy.png"
            }
            message={`wins by ${snapshot.over.reason}${
              snapshot.over.txHash ? ` · settled on-chain ${shortAddress(snapshot.over.txHash)}` : ""
            }`}
            amountLabel={
              snapshot.stake ? `+${formatStake((BigInt(snapshot.stake) * 2n * 8000n) / 10000n)}` : null
            }
            actions={
              <>
                {iWon && CONTRACTS_CONFIGURED && !claimed && (
                  <button className="btn-gold" onClick={claim}>
                    Claim 80% of the pot
                  </button>
                )}
                {claimed && <span className="self-center text-gold-bright">Reward claimed ✓</span>}
                <button className="btn-outline" onClick={() => router.push("/lobby")}>
                  Back to lobby
                </button>
              </>
            }
          />
        ) : null
      }
    />
  );
}
