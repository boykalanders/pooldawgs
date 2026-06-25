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
import { loadGraphics, saveGraphics, type GraphicsSettings } from "@/lib/graphics";

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
  // Default to the 3D table; ?view=2d forces the classic 2D canvas.
  const [view, setView] = useState<"2d" | "3d">(() =>
    typeof window !== "undefined" &&
    new URLSearchParams(window.location.search).get("view") === "2d"
      ? "2d"
      : "3d"
  );
  const [gameType, setGameType] = useState<GameType>("8ball");
  // Graphics quality — start from a fixed default (no SSR/hydration mismatch),
  // then load the persisted / device-appropriate settings after mount.
  const [graphics, setGraphics] = useState<GraphicsSettings>({
    reflections: true,
    shadows: true,
    highRes: true,
  });
  useEffect(() => setGraphics(loadGraphics()), []);
  const updateGraphics = useCallback((g: GraphicsSettings) => {
    setGraphics(g);
    saveGraphics(g);
  }, []);
  const [state, setState] = useState<TableState>(() => createInitialState("8ball"));
  const [animation, setAnimation] = useState<ShotAnimation | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  // Frames won across re-racks.
  const [frames, setFrames] = useState<[number, number]>([0, 0]);
  const pendingEndState = useRef<TableState | null>(null);
  // The shot's outcome is applied only when the replay (and the ball dropping
  // into the pocket) finishes, so the foul / score message shows AFTER the ball
  // is in the hole, not the instant the shot is taken.
  const pendingOutcome = useRef<{ gameOver: boolean; winner: number | null; foul: boolean; note?: string } | null>(null);

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

  // Route shots through the Havok backend (same physics the old /play3d used,
  // and what the wagered server runs) so the practice feel matches everywhere.
  // Falls back to the deterministic TS engine until Havok finishes loading.
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const { initHavok, simulateShotHavok } = await import("@pooldawgs/engine/havok");
        const { setSimulator } = await import("@pooldawgs/engine");
        await initHavok();
        if (alive) setSimulator(simulateShotHavok);
      } catch (e) {
        console.error("Havok init failed — using TS engine:", e);
      }
    })();
    return () => {
      alive = false;
      // Restore the default TS backend when leaving practice.
      import("@pooldawgs/engine").then(({ setSimulator }) => setSimulator(null));
    };
  }, []);

  // Dev hooks via query param: ?preview=win shows the winner popup;
  // ?preview=ballinhand starts with the cue ball in hand (placement testing).
  useEffect(() => {
    const preview = new URLSearchParams(window.location.search).get("preview");
    if (preview === "win") {
      const won = createInitialState("8ball");
      won.gameOver = true;
      won.winner = 0;
      setState(won);
    } else if (preview === "ballinhand") {
      const s = createInitialState("8ball");
      const cue = s.balls[s.balls.length - 1];
      cue.inHole = true;
      s.ballInHand = true;
      setState(s);
    }
  }, []);

  const shoot = useCallback(
    (shot: ShotInput) => {
      try {
        // Simulate ONCE, recording the replay frames. The renderer replays
        // these exact frames, so the on-screen settle matches the end state we
        // apply at animation end — no post-shot "jump" (the Havok backend isn't
        // bit-identical run-to-run, so a separate replay sim would diverge).
        const result = simulateShot(state, shot, { recordFrames: true, frameStride: 2 });
        pendingEndState.current = result.endState;
        pendingOutcome.current = result.outcome;
        setMessage(null); // clear during the shot; the result shows after it lands
        setAnimation({
          fromState: state,
          shot,
          key: stateHash(result.endState) + result.steps,
          frames: result.frames,
          events: result.events,
        });
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
    // Now that the ball has finished dropping, surface the outcome: the foul /
    // points message, or tally a won frame.
    const outcome = pendingOutcome.current;
    pendingOutcome.current = null;
    if (outcome) {
      if (outcome.gameOver) {
        if (outcome.winner !== null) {
          const winner = outcome.winner;
          setFrames((f) => (winner === 0 ? [f[0] + 1, f[1]] : [f[0], f[1] + 1]));
        }
      } else {
        setMessage(outcome.note ?? null);
      }
    }
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
          ? "Foul! Ball in hand — drag the cue ball to a clear spot to place it"
          : message
      }
      centerAction={state.gameOver ? { label: "PLAY AGAIN", onClick: () => reRack() } : null}
      onSelectGameType={selectGameType}
      renderer={view}
      graphics={graphics}
      onGraphicsChange={updateGraphics}
      menuItems={[
        {
          label: view === "3d" ? "Switch to 2D view" : "Switch to 3D view",
          onClick: () => setView((v) => (v === "3d" ? "2d" : "3d")),
        },
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
