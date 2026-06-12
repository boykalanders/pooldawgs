"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  createInitialState,
  simulateShot,
  placeCueBall as enginePlaceCueBall,
  stateHash,
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

/**
 * Hot-seat practice table — runs the full deterministic engine locally with
 * no wallet, server, or chain. This is the look-and-feel review slice, so it
 * mirrors the client design with demo balances and pot.
 */
export default function PracticePage() {
  const router = useRouter();
  const [state, setState] = useState<TableState>(() => createInitialState());
  const [animation, setAnimation] = useState<ShotAnimation | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const pendingEndState = useRef<TableState | null>(null);

  const reRack = useCallback(() => {
    setState(createInitialState());
    setAnimation(null);
    pendingEndState.current = null;
    setMessage(null);
  }, []);

  // Dev/design preview: /practice?preview=win shows the winner popup.
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get("preview") === "win") {
      const won = createInitialState();
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
        } else if (result.outcome.foul) {
          setMessage(`Foul! Player ${result.outcome.nextTurn + 1} has ball in hand`);
        } else {
          setMessage(null);
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

  const statusText = state.gameOver
    ? `🏆 Player ${state.winner! + 1} wins the frame!`
    : `Player ${state.turn + 1} to shoot`;

  return (
    <GameShell
      state={state}
      players={[
        { ...PLAYERS[0], detail: "2,450.00 $DDAWGS", badge: "42" },
        { ...PLAYERS[1], detail: "1,980.50 $DDAWGS", badge: "38" },
      ]}
      interactive={!state.gameOver}
      potLabel="250.00 $DDAWGS"
      balanceLabel="10,250.75"
      clockExpiresAt={null}
      statusText={statusText}
      banner={
        state.ballInHand && !state.gameOver
          ? "Ball in hand — tap the cloth to place the cue ball"
          : message
      }
      centerAction={state.gameOver ? { label: "PLAY AGAIN", onClick: reRack } : null}
      menuItems={[
        { label: "Re-rack", onClick: reRack },
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
            message="wins the frame"
            amountLabel="+200.00 $DDAWGS"
            actions={
              <>
                <button className="btn-gold" onClick={reRack}>
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
