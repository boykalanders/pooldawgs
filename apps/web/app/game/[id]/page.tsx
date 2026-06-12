"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { formatUnits } from "viem";
import { useAccount, useReadContract, useSignMessage, useWriteContract } from "wagmi";
import {
  cloneState,
  CUE_BALL_ID,
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
import { getSocket } from "@/lib/socket";

export default function GamePage() {
  return (
    <WalletGate>
      <GameRoom />
    </WalletGate>
  );
}

function GameRoom() {
  const params = useParams<{ id: string }>();
  const gameId = params.id;
  const router = useRouter();
  const { address } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const { writeContractAsync } = useWriteContract();

  const [snapshot, setSnapshot] = useState<RoomSnapshot | null>(null);
  const [state, setState] = useState<TableState | null>(null);
  const [animation, setAnimation] = useState<ShotAnimation | null>(null);
  const pendingEndState = useRef<TableState | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [serverError, setServerError] = useState<string | null>(null);
  const [joined, setJoined] = useState(false);
  const [claimed, setClaimed] = useState(false);

  const { data: myBalance } = useReadContract({
    address: DDAWGS_TOKEN_ADDRESS ?? undefined,
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: address ? [address] : undefined,
    query: { enabled: Boolean(CONTRACTS_CONFIGURED && address) },
  });

  const mySeat: PlayerIndex | null = (() => {
    if (!snapshot || !address) return null;
    const me = snapshot.players.find(
      (p) => p.address.toLowerCase() === address.toLowerCase()
    );
    return me ? me.seat : null;
  })();

  // Join the room with a wallet-signature login.
  useEffect(() => {
    if (!address || joined) return;
    const socket = getSocket();
    let cancelled = false;

    (async () => {
      try {
        const ts = Date.now();
        const signature = await signMessageAsync({
          message: loginMessage(address as Address, ts),
        });
        if (cancelled) return;
        socket.emit("room:join", {
          gameId,
          auth: { address: address as Address, ts, signature },
        });
        setJoined(true);
      } catch {
        setServerError("Signature rejected — sign in to take your seat.");
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [address, gameId, joined, signMessageAsync]);

  // Socket subscriptions.
  useEffect(() => {
    const socket = getSocket();

    const onRoomState = (snap: RoomSnapshot) => {
      if (snap.gameId !== gameId) return;
      setSnapshot(snap);
      // Don't clobber an in-flight shot animation with the settled state.
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
        const cue = next.balls[CUE_BALL_ID];
        cue.x = p.x;
        cue.y = p.y;
        cue.inHole = false;
        cue.vx = 0;
        cue.vy = 0;
        next.ballInHand = false;
        return next;
      });
    };

    const onOver = (p: {
      gameId: string;
      winner: Address;
      reason: GameOverReason;
      txHash?: string;
    }) => {
      if (p.gameId !== gameId) return;
      setSnapshot((s) =>
        s
          ? { ...s, over: { winner: p.winner, reason: p.reason, txHash: p.txHash } }
          : s
      );
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
      setServerError(e instanceof Error ? e.message : "Claim failed");
    }
  }

  if (!snapshot || !state) {
    return (
      <div className="panel mx-auto max-w-md p-10 text-center text-amber-100/60">
        {serverError ? (
          <span className="text-red-300">{serverError}</span>
        ) : (
          <>Taking your seat at table #{gameId}…</>
        )}
      </div>
    );
  }

  const myTurn =
    mySeat !== null && !state.gameOver && state.turn === mySeat && !snapshot.over;

  const iWon =
    snapshot.over &&
    address &&
    snapshot.over.winner.toLowerCase() === address.toLowerCase();

  const shellPlayers = snapshot.players.map((p): ShellPlayer => {
    const isMe = address && p.address.toLowerCase() === address.toLowerCase();
    return {
      name: isMe ? `${shortAddress(p.address)} (you)` : shortAddress(p.address),
      detail:
        isMe && myBalance !== undefined
          ? `${Number(formatUnits(myBalance, 18)).toLocaleString()} $DDAWGS`
          : undefined,
      badge: `P${p.seat + 1}`,
      // Placeholder Dawg portraits until per-player NFT avatars are wired.
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
      balanceLabel={
        myBalance !== undefined
          ? Number(formatUnits(myBalance, 18)).toLocaleString()
          : null
      }
      clockExpiresAt={snapshot.over ? null : snapshot.clockExpiresAt}
      statusText={statusText}
      banner={
        serverError ??
        (myTurn && state.ballInHand
          ? "Ball in hand — tap the cloth to place the cue ball"
          : null)
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
        // Let the final shot animation finish before celebrating.
        snapshot.over && !animation ? (
          <WinnerPopup
            winnerName={
              iWon ? "You" : shortAddress(snapshot.over.winner)
            }
            avatarSrc={
              snapshot.players.find(
                (p) => p.address.toLowerCase() === snapshot.over!.winner.toLowerCase()
              )?.seat === 1
                ? "/assets/avatar-outlaw.png"
                : "/assets/avatar-deputy.png"
            }
            message={`wins by ${snapshot.over.reason}${
              snapshot.over.txHash
                ? ` · settled on-chain ${shortAddress(snapshot.over.txHash)}`
                : ""
            }`}
            amountLabel={
              snapshot.stake
                ? `+${formatStake((BigInt(snapshot.stake) * 2n * 8000n) / 10000n)}`
                : null
            }
            actions={
              <>
                {iWon && CONTRACTS_CONFIGURED && !claimed && (
                  <button className="btn-gold" onClick={claim}>
                    Claim 80% of the pot
                  </button>
                )}
                {claimed && (
                  <span className="self-center text-gold-bright">Reward claimed ✓</span>
                )}
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
