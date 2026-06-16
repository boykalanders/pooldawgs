"use client";

import { useRef } from "react";
import { MAX_POWER } from "@pooldawgs/engine";

interface PowerSliderProps {
  /** Live power in engine units (0…MAX_POWER). */
  value: number;
  disabled?: boolean;
  onChange: (value: number) => void;
  /** Fired when the player releases the slider — this takes the shot. */
  onRelease: (value: number) => void;
}

/** Vertical power meter (right rail). Drag up to charge, release to strike.
 *  Reads 0–100% regardless of the engine's internal MAX_POWER scale. */
export default function PowerSlider({ value, disabled, onChange, onRelease }: PowerSliderProps) {
  const trackRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);

  function valueFromPointer(clientY: number): number {
    const rect = trackRef.current!.getBoundingClientRect();
    const frac = 1 - (clientY - rect.top) / rect.height;
    return Math.max(0, Math.min(MAX_POWER, frac * MAX_POWER));
  }

  function handleDown(e: React.PointerEvent) {
    if (disabled) return;
    dragging.current = true;
    e.currentTarget.setPointerCapture(e.pointerId);
    onChange(valueFromPointer(e.clientY));
  }

  function handleMove(e: React.PointerEvent) {
    if (!dragging.current || disabled) return;
    onChange(valueFromPointer(e.clientY));
  }

  function handleUp(e: React.PointerEvent) {
    if (!dragging.current) return;
    dragging.current = false;
    onRelease(valueFromPointer(e.clientY));
  }

  const pct = Math.max(0, Math.min(100, (value / MAX_POWER) * 100));
  const display = Math.round(pct);

  return (
    <div className="flex h-full select-none flex-col items-center gap-1.5">
      <span className="text-[10px] font-semibold uppercase tracking-widest text-gold">Power</span>

      <div
        ref={trackRef}
        className={`relative w-7 flex-1 overflow-hidden rounded-full border border-gold-dim/50 bg-emerald-deep shadow-[inset_0_2px_8px_rgba(0,0,0,0.9)] ${
          disabled ? "opacity-40" : "cursor-pointer"
        }`}
        style={{ touchAction: "none" }}
        onPointerDown={handleDown}
        onPointerMove={handleMove}
        onPointerUp={handleUp}
        onPointerCancel={handleUp}
      >
        {/* Quartile ticks */}
        {[25, 50, 75].map((t) => (
          <span
            key={t}
            className="pointer-events-none absolute inset-x-0 h-px bg-gold-dim/25"
            style={{ bottom: `${t}%` }}
          />
        ))}

        {/* Red→gold fill rising from the bottom; clipped to the rounded track. */}
        <div
          className="pointer-events-none absolute inset-x-0 bottom-0"
          style={{
            height: `${pct}%`,
            background: "linear-gradient(to top, #d11f2a 0%, #ff6b35 55%, #e8c547 100%)",
            boxShadow: pct > 1 ? "0 0 14px rgba(232, 197, 71, 0.6)" : "none",
            transition: dragging.current ? "none" : "height 90ms linear",
          }}
        />

        {/* Level marker at the current power. */}
        <div
          className="pointer-events-none absolute inset-x-0 h-0.5 bg-amber-50 shadow-[0_0_6px_rgba(255,255,255,0.8)]"
          style={{
            bottom: `${pct}%`,
            opacity: pct > 1 ? 1 : 0,
            transition: dragging.current ? "none" : "bottom 90ms linear",
          }}
        />
      </div>

      <span className="font-mono text-xs font-bold tabular-nums text-gold-bright">{display}</span>
    </div>
  );
}
