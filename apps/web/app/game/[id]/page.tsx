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
  AUTH_TTL_MS,
  ERC20_ABI,
  loginMessage,
  POOL_DAWGS_ABI,
  type Address,
  type AuthPayload,
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
  CHAIN_ID,
  CONTRACTS_CONFIGURED,
  DDAWGS_TOKEN_ADDRESS,
  NETWORK_NAME,
  POOLDAWGS_ADDRESS,
} from "@/lib/env";
import { formatStake, shortAddress } from "@/lib/format";
import { GAME_TYPE_LABEL, gameTypeFromId, inviteLink } from "@/lib/gamecode";
import { useNftAvatar } from "@/lib/useNftAvatar";
import { log } from "@/lib/log";
import { getSocket } from "@/lib/socket";
import { syncServerClock } from "@/lib/serverClock";

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

/** How a frame ended, phrased for the end-game modal. */
const REASON_WORD: Record<GameOverReason, string> = {
  pot: "the frame",
  resign: "resignation",
  timeout: "the shot clock",
};

function GameRoom() {
  const params = useParams<{ id: string }>();
  const gameId = params.id;
  const variantLabel = GAME_TYPE_LABEL[gameTypeFromId(gameId)];
  const router = useRouter();
  const { address } = useAccount();
  const publicClient = usePublicClient();
  const { signMessageAsync } = useSignMessage();
  const { writeContractAsync } = useWriteContract();

  const [snapshot, setSnapshot] = useState<RoomSnapshot | null>(null);
  const [state, setState] = useState<TableState | null>(null);
  const [animation, setAnimation] = useState<ShotAnimation | null>(null);
  const pendingEndState = useRef<TableState | null>(null);
  const seededChat = useRef(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [serverError, setServerError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [claimed, setClaimed] = useState(false);
  const [working, setWorking] = useState<string | null>(null);
  const [copied, setCopied] = useState<"code" | "link" | null>(null);
  const [socketConnected, setSocketConnected] = useState(false);
  const [waitedTooLong, setWaitedTooLong] = useState(false);

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

  // Claimed state: the on-chain rewardClaimed flag (index 5) or our local flag
  // after a successful claim. In the voucher model the winner's claim itself
  // settles the game, so there's no separate "waiting to settle" state.
  const cg = CONTRACTS_CONFIGURED && chainGame ? (chainGame as ChainGame) : null;
  const chainClaimed = cg ? Boolean(cg[5]) : false;
  const rewardClaimed = claimed || chainClaimed;

  // Per-seat avatars: each player's NFT artwork (or a wallet-derived identicon),
  // resolved up here so the hooks run before the pre-game early returns.
  const seat0Address = snapshot?.players.find((p) => p.seat === 0)?.address;
  const seat1Address = snapshot?.players.find((p) => p.seat === 1)?.address;
  const seat0Avatar = useNftAvatar(seat0Address);
  const seat1Avatar = useNftAvatar(seat1Address);

  const mySeat: PlayerIndex | null = (() => {
    if (!snapshot || !address) return null;
    const m = snapshot.players.find((p) => p.address.toLowerCase() === address.toLowerCase());
    return m ? m.seat : null;
  })();

  // Log phase transitions for diagnosis.
  useEffect(() => {
    log.info("game:", gameId, "phase →", effectivePhase);
  }, [gameId, effectivePhase]);

  // Cached login signature so reconnects (which create a brand-new socket and
  // therefore drop our room membership) can re-join WITHOUT popping the wallet
  // on every blip. A signature is valid for AUTH_TTL_MS; we re-sign ~1 min
  // before it lapses.
  const authRef = useRef<{ auth: AuthPayload; signedAt: number } | null>(null);
  const getAuth = useCallback(async (): Promise<AuthPayload | null> => {
    if (!address) return null;
    const cached = authRef.current;
    if (cached && Date.now() - cached.signedAt < AUTH_TTL_MS - 60_000) return cached.auth;
    const ts = Date.now();
    const signature = await signMessageAsync({ message: loginMessage(address as Address, ts) });
    const auth: AuthPayload = { address: address as Address, ts, signature };
    authRef.current = { auth, signedAt: ts };
    return auth;
  }, [address, signMessageAsync]);

  const joinRoom = useCallback(async () => {
    if (!address) return;
    try {
      const auth = await getAuth();
      if (!auth) return;
      log.info("game: emitting room:join", gameId, "as", address);
      getSocket().emit("room:join", { gameId, auth });
    } catch (e) {
      log.error("game: login signature rejected —", e);
      setServerError("Signature rejected — sign in to take your seat.");
    }
  }, [address, gameId, getAuth]);

  const syncRoom = useCallback(() => {
    const s = getSocket();
    if (s.connected) s.emit("room:sync", { gameId });
  }, [gameId]);

  // Take (and re-take) our seat: join on entry, and again on every reconnect.
  // Socket.IO room membership is per-connection and is lost when the transport
  // drops; without re-joining the client silently stops receiving updates and
  // looks frozen until a page refresh.
  useEffect(() => {
    if (!address || effectivePhase !== "play") return;
    const socket = getSocket();
    const onConnect = () => {
      log.info("game: socket (re)connected — re-joining", gameId);
      void joinRoom();
    };
    if (socket.connected) void joinRoom();
    socket.on("connect", onConnect);
    return () => {
      socket.off("connect", onConnect);
    };
  }, [address, effectivePhase, gameId, joinRoom]);

  // Socket subscriptions (always mounted; harmless before we join).
  useEffect(() => {
    const socket = getSocket();
    const onRoomState = (snap: RoomSnapshot) => {
      if (snap.gameId !== gameId) return;
      syncServerClock(snap.serverNow);
      log.info(
        "game: room:state —",
        snap.players.length,
        "players, turn",
        snap.state.turn,
        snap.over ? "(over)" : ""
      );
      setSnapshot(snap);
      if (!pendingEndState.current) setState(snap.state);
      // Seed chat history once on (re)join so a returning player sees past
      // messages; live messages then arrive via chat:message.
      if (!seededChat.current) {
        seededChat.current = true;
        if (snap.messages?.length) setMessages(snap.messages);
      }
    };
    const onShot = (shot: ShotBroadcast) => {
      if (shot.gameId !== gameId) return;
      syncServerClock(shot.serverNow);
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
    const onError = (e: ServerError) => {
      log.error("game: server:error —", e.code, e.message);
      setServerError(e.message);
    };

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

  // Track socket connectivity so the connecting screen can flag a dead server.
  useEffect(() => {
    const s = getSocket();
    setSocketConnected(s.connected);
    const on = () => setSocketConnected(true);
    const off = () => setSocketConnected(false);
    s.on("connect", on);
    s.on("disconnect", off);
    return () => {
      s.off("connect", on);
      s.off("disconnect", off);
    };
  }, []);

  // Reconciliation safety net: pull the authoritative snapshot when the tab is
  // refocused (background tabs throttle timers + sockets) and on a slow
  // interval, so a single missed delta can't leave the board desynced until a
  // refresh. If the socket dropped while hidden, force a reconnect — onConnect
  // then re-joins.
  useEffect(() => {
    if (effectivePhase !== "play" || snapshot?.over) return;
    const onVisible = () => {
      if (document.hidden) return;
      const s = getSocket();
      if (s.connected) syncRoom();
      else s.connect();
    };
    document.addEventListener("visibilitychange", onVisible);
    const interval = setInterval(syncRoom, 15000);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      clearInterval(interval);
    };
  }, [effectivePhase, snapshot?.over, syncRoom]);

  // If we sit in the play phase with no snapshot too long, surface why.
  useEffect(() => {
    if (effectivePhase !== "play" || snapshot) {
      setWaitedTooLong(false);
      return;
    }
    const t = setTimeout(() => setWaitedTooLong(true), 10000);
    return () => clearTimeout(t);
  }, [effectivePhase, snapshot]);

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
    // The winner redeems the backend's voucher: claimRewardSigned settles the
    // game AND pays out in this single winner-paid tx — no settlement wait.
    const voucher = snapshot?.over?.voucher;
    if (!voucher) {
      setActionError("Reward voucher isn't ready yet — you can also claim from your Profile.");
      return;
    }
    setActionError(null);
    setWorking("claim");
    log.info("claim: redeeming voucher for", gameId);
    try {
      const tx = await writeContractAsync({
        address: POOLDAWGS_ADDRESS,
        abi: POOL_DAWGS_ABI,
        functionName: "claimRewardSigned",
        args: [gameId, voucher as `0x${string}`],
        chainId: CHAIN_ID,
      });
      log.info("claim: tx sent", tx);
      if (publicClient) await publicClient.waitForTransactionReceipt({ hash: tx });
      log.info("claim: confirmed");
      setClaimed(true);
      await refetchGame();
    } catch (e) {
      log.error("claim: failed —", e);
      const msg = e instanceof Error ? e.message.split("\n")[0] : "Claim failed";
      setActionError(/already claimed/i.test(msg) ? "Reward already claimed." : msg);
    } finally {
      setWorking(null);
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
          <p className="text-xs uppercase tracking-widest text-gold-bright/80">{variantLabel}</p>
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
          <p className="text-xs uppercase tracking-widest text-gold-bright/80">{variantLabel}</p>
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
          {iWon && !rewardClaimed && (
            <button className="btn-gold w-full" onClick={() => router.push("/profile")}>
              Claim 80% of the pot
            </button>
          )}
          {rewardClaimed && <p className="text-gold-bright">Reward claimed ✓</p>}
          {actionError && <p className="text-sm text-red-300">{actionError}</p>}
          <Back />
        </Card>
      );
    }
  }

  // ── connecting (play phase, awaiting the room snapshot) ──
  if (!snapshot || !state) {
    return (
      <div className="panel mx-auto mt-10 max-w-md space-y-3 p-10 text-center text-amber-100/60">
        {serverError ? (
          <p className="text-red-300">{serverError}</p>
        ) : (
          <p>Taking your seat at table {gameId}…</p>
        )}
        {waitedTooLong && !serverError && (
          <div className="space-y-3 border-t border-gold-dim/20 pt-3 text-sm">
            <p className="text-amber-100/70">
              Still connecting. The game server is{" "}
              {socketConnected ? (
                <span className="text-emerald-400">reachable</span>
              ) : (
                <span className="text-red-400">not reachable</span>
              )}
              .
            </p>
            {!socketConnected && (
              <p className="text-xs text-amber-100/50">
                Make sure the game server is running and you opened the app at the
                same host it allows (try <span className="text-gold">localhost:3000</span>).
              </p>
            )}
            <button className="btn-outline" onClick={() => router.push("/lobby")}>
              Back to lobby
            </button>
          </div>
        )}
      </div>
    );
  }

  const myTurn = mySeat !== null && !state.gameOver && state.turn === mySeat && !snapshot.over;
  const iWon = snapshot.over && address && snapshot.over.winner.toLowerCase() === address.toLowerCase();

  const shellPlayers = snapshot.players.map((p): ShellPlayer => {
    const isMe = address && p.address.toLowerCase() === address.toLowerCase();
    const baseName = p.username?.trim() || shortAddress(p.address);
    return {
      name: isMe ? `${baseName} (you)` : baseName,
      detail:
        isMe && myBalance !== undefined
          ? `${Number(formatUnits(myBalance, 18)).toLocaleString()} $DDAWGS`
          : undefined,
      badge: `P${p.seat + 1}`,
      avatarSrc: p.seat === 0 ? seat0Avatar : seat1Avatar,
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

  // End-of-frame modal data: who won, by what, and the amounts at stake.
  const over = snapshot.over;
  const winnerPlayer = over
    ? snapshot.players.find((p) => p.address.toLowerCase() === over.winner.toLowerCase())
    : undefined;
  const winnerAvatar = winnerPlayer?.seat === 1 ? seat1Avatar : seat0Avatar;
  const winnerDisplay = over
    ? winnerPlayer?.username?.trim() || shortAddress(over.winner)
    : "";
  const reasonWord = over ? REASON_WORD[over.reason] : "";
  const potWin = snapshot.stake
    ? formatStake((BigInt(snapshot.stake) * 2n * 8000n) / 10000n)
    : null;
  const myStake = snapshot.stake ? formatStake(BigInt(snapshot.stake)) : null;

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
        (myTurn && state.ballInHand
          ? "Ball in hand — drag the cue ball to a clear spot to place it"
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
        over && !animation ? (
          iWon ? (
            <WinnerPopup
              winnerName="You"
              avatarSrc={winnerAvatar}
              message={`Won by ${reasonWord}`}
              amountLabel={potWin ? `+${potWin}` : null}
              actions={
                <>
                  {CONTRACTS_CONFIGURED &&
                    !rewardClaimed &&
                    (over.voucher ? (
                      <button className="btn-gold" disabled={working === "claim"} onClick={claim}>
                        {working === "claim" ? "Claiming…" : "Claim 80% of the pot"}
                      </button>
                    ) : (
                      <span className="self-center text-[11px] text-amber-100/60">
                        Preparing your reward voucher…
                      </span>
                    ))}
                  {rewardClaimed && (
                    <span className="self-center text-gold-bright">Reward claimed ✓</span>
                  )}
                  {actionError && (
                    <span className="self-center text-sm text-red-300">{actionError}</span>
                  )}
                  <button className="btn-outline" onClick={() => router.push("/lobby")}>
                    Back to lobby
                  </button>
                </>
              }
            />
          ) : (
            <WinnerPopup
              defeated
              winnerName={winnerDisplay}
              avatarSrc={winnerAvatar}
              message={`Won by ${reasonWord}`}
              amountLabel={myStake ? `−${myStake}` : null}
              actions={
                <button className="btn-outline" onClick={() => router.push("/lobby")}>
                  Back to lobby
                </button>
              }
            />
          )
        ) : null
      }
    />
  );
}
