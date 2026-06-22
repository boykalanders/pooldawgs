"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  createInitialState,
  simulateShot,
  stateHash,
  MAX_POWER,
  type TableState,
} from "@pooldawgs/engine";
import type { ShotPlayback } from "@/components/PoolTable3D";

// Babylon must only load in the browser.
const PoolTable3D = dynamic(() => import("@/components/PoolTable3D"), { ssr: false });

type Status = "loading" | "ready" | "error";

export default function Play3DPage() {
  const [status, setStatus] = useState<Status>("loading");
  const [state, setState] = useState<TableState>(() => createInitialState("8ball"));
  const [playback, setPlayback] = useState<ShotPlayback | null>(null);
  const [aim, setAim] = useState(0);
  const [power, setPower] = useState(40);
  const [msg, setMsg] = useState<string | null>(null);
  const pendingEnd = useRef<TableState | null>(null);
  const charging = useRef<number | null>(null);

  // Bring up Havok in the browser and route simulateShot through it.
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const { initHavok, simulateShotHavok } = await import("@pooldawgs/engine/havok");
        const { setSimulator } = await import("@pooldawgs/engine");
        await initHavok();
        setSimulator(simulateShotHavok);
        if (alive) setStatus("ready");
      } catch (e) {
        console.error("Havok init failed:", e);
        if (alive) setStatus("error");
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const shoot = useCallback(
    (pwr: number) => {
      if (status !== "ready" || playback) return;
      const cue = state.balls[state.balls.length - 1];
      if (cue.inHole || state.gameOver) return;
      try {
        const r = simulateShot(state, { angle: aim, power: pwr }, { recordFrames: true, frameStride: 2 });
        pendingEnd.current = r.endState;
        setPlayback({ frames: r.frames ?? [], stride: 2, key: stateHash(r.endState) + r.steps });
        setMsg(
          r.outcome.gameOver
            ? `🏆 Player ${(r.outcome.winner ?? 0) + 1} wins`
            : r.outcome.foul
              ? "Foul"
              : null
        );
      } catch (e) {
        setMsg(e instanceof Error ? e.message : "illegal shot");
      }
    },
    [status, playback, state, aim]
  );

  const onPlaybackEnd = useCallback(() => {
    if (pendingEnd.current) setState(pendingEnd.current);
    pendingEnd.current = null;
    setPlayback(null);
  }, []);

  const reRack = () => {
    setState(createInitialState("8ball"));
    setPlayback(null);
    pendingEnd.current = null;
    setMsg(null);
  };

  const power01 = Math.min(1, power / MAX_POWER);

  return (
    <div className="mx-auto flex h-[calc(100dvh-9.5rem)] min-h-[520px] w-full max-w-[1480px] flex-col gap-3">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="heading-display text-2xl">3D Table — Babylon + Havok</h1>
          <p className="text-xs text-amber-100/60">
            Real Havok physics, rendered in 3D. Point to aim · set power · shoot.
          </p>
        </div>
        <div className="flex items-center gap-3 text-sm">
          {msg && <span className="text-gold-bright">{msg}</span>}
          <button className="btn-outline" onClick={reRack}>Re-rack</button>
        </div>
      </div>

      <div className="relative min-h-0 flex-1 overflow-hidden rounded-2xl border border-gold-dim/40 bg-black/70">
        {status !== "ready" && (
          <div className="absolute inset-0 z-10 flex items-center justify-center text-amber-100/70">
            {status === "loading" ? "Loading Havok physics…" : "Failed to load Havok — check console."}
          </div>
        )}
        <PoolTable3D
          state={state}
          playback={playback}
          aimAngle={aim}
          power01={power01}
          showAim={!playback}
          onAim={setAim}
          onPlaybackEnd={onPlaybackEnd}
        />
      </div>

      {/* Controls */}
      <div className="flex items-center gap-4 rounded-xl border border-gold-dim/40 bg-gunmetal-dark/70 px-5 py-3">
        <span className="text-xs uppercase tracking-widest text-gold">Power</span>
        <input
          type="range"
          min={4}
          max={MAX_POWER}
          value={power}
          onChange={(e) => setPower(Number(e.target.value))}
          className="flex-1 accent-gold"
          disabled={!!playback || status !== "ready"}
        />
        <span className="w-10 font-mono text-sm text-amber-100/80">{Math.round(power01 * 100)}%</span>
        <button
          className="btn-gold px-8"
          disabled={!!playback || status !== "ready"}
          onClick={() => shoot(power)}
        >
          Shoot
        </button>
      </div>
    </div>
  );
}
