"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  createInitialState,
  simulateShot,
  placeCueBall as enginePlaceCueBall,
  stateHash,
  type GameType,
  type ShotInput,
  type TableState,
} from "@pooldawgs/engine";
import GameShell from "@/components/GameShell";
import type { ShotAnimation } from "@/components/PoolCanvas";
import WinnerPopup from "@/components/WinnerPopup";

const PLAYERS = [
  { name: "Deputy Dawg", avatarSrc: "/assets/avatar-deputy.png" },
  { name: "Outlaw Dawg", avatarSrc: "/assets/avatar-outlaw.png" },
] as const;

const GAME_NAME: Record<GameType, string> = {
  "8ball": "8-Ball",
  "9ball": "9-Ball",
  snooker: "Snooker",
};

/**
 * Hot-seat practice table — runs the full deterministic engine locally with
 * no wallet, server, or chain. Supports all three variants (the mode chips
 * switch them) and mirrors the client design with demo balances and pot.
 */
export default function PracticePage() {
  const router = useRouter();
  const [gameType, setGameType] = useState<GameType>("8ball");
  const [state, setState] = useState<TableState>(() => createInitialState("8ball"));
  const [animation, setAnimation] = useState<ShotAnimation | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  // Frames won across re-racks.
  const [frames, setFrames] = useState<[number, number]>([0, 0]);
  const pendingEndState = useRef<TableState | null>(null);

  const reRack = useCallback(
    (type: GameType = gameType) => {
      setState(createInitialState(type));
      setAnimation(null);
      pendingEndState.current = null;
      setMessage(null);
    },
    [gameType]
  );

  const selectGameType = useCallback(
    (type: GameType) => {
      if (type === gameType) return;
      setGameType(type);
      setFrames([0, 0]);
      reRack(type);
    },
    [gameType, reRack]
  );

  // Dev/design preview: /practice?preview=win shows the winner popup.
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get("preview") === "win") {
      const won = createInitialState("8ball");
      won.gameOver = true;
      won.winner = 0;
      setState(won);
    }
  }, []);

  const shoot = useCallback(
    (shot: ShotInput) => {
      try {
        const result = simulateShot(state, shot);
        pendingEndState.current = result.endState;
        setAnimation({
          fromState: state,
          shot,
          key: stateHash(result.endState) + result.steps,
        });
        if (result.outcome.gameOver) {
          setMessage(null);
          if (result.outcome.winner !== null) {
            const winner = result.outcome.winner;
            setFrames((f) => (winner === 0 ? [f[0] + 1, f[1]] : [f[0], f[1] + 1]));
          }
        } else {
          setMessage(result.outcome.note ?? null);
        }
      } catch (e) {
        setMessage(e instanceof Error ? e.message : "Illegal shot");
      }
    },
    [state]
  );

  const place = useCallback(
    (x: number, y: number) => {
      const result = enginePlaceCueBall(state, x, y);
      if (result.ok) {
        setState(result.state);
        setMessage(null);
      }
    },
    [state]
  );

  const handleAnimationEnd = useCallback(() => {
    if (pendingEndState.current) {
      setState(pendingEndState.current);
      pendingEndState.current = null;
    }
    setAnimation(null);
  }, []);

  const turnLabel = (() => {
    if (state.gameOver) return `🏆 Player ${state.winner! + 1} wins!`;
    if (state.gameType === "snooker") {
      return `Player ${state.turn + 1} — on ${state.onColor ? "a colour" : "a red"}`;
    }
    if (state.gameType === "9ball") return `Player ${state.turn + 1} — lowest first`;
    return `Player ${state.turn + 1}`;
  })();

  const winMessage =
    state.gameType === "snooker"
      ? `wins ${state.scores[0]}–${state.scores[1]}`
      : `wins the frame (${frames[0]}–${frames[1]})`;

  return (
    <GameShell
      state={state}
      players={[
        { ...PLAYERS[0], detail: `2,450.00 $DDAWGS · 🏆 ${frames[0]}`, badge: "42" },
        { ...PLAYERS[1], detail: `1,980.50 $DDAWGS · 🏆 ${frames[1]}`, badge: "38" },
      ]}
      interactive={!state.gameOver}
      potLabel="250.00 $DDAWGS"
      balanceLabel="10,250.75"
      clockExpiresAt={null}
      statusText={turnLabel}
      banner={
        state.ballInHand && !state.gameOver
          ? "Ball in hand — tap the cloth to place the cue ball"
          : message
      }
      centerAction={state.gameOver ? { label: "PLAY AGAIN", onClick: () => reRack() } : null}
      onSelectGameType={selectGameType}
      menuItems={[
        { label: `Re-rack (${GAME_NAME[gameType]})`, onClick: () => reRack() },
        { label: "Exit to lobby", onClick: () => router.push("/lobby") },
      ]}
      animation={animation}
      onShoot={shoot}
      onPlaceCueBall={place}
      onAnimationEnd={handleAnimationEnd}
      overlay={
        state.gameOver && state.winner !== null ? (
          <WinnerPopup
            winnerName={PLAYERS[state.winner].name}
            avatarSrc={PLAYERS[state.winner].avatarSrc}
            message={winMessage}
            amountLabel="+200.00 $DDAWGS"
            actions={
              <>
                <button className="btn-gold" onClick={() => reRack()}>
                  Play again
                </button>
                <button className="btn-outline" onClick={() => router.push("/lobby")}>
                  Lobby
                </button>
              </>
            }
          />
        ) : null
      }
    />
  );
}
