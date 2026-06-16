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
        className={`relative w-7 min-h-[64px] flex-1 overflow-hidden rounded-full border border-gold-dim/50 bg-emerald-deep shadow-[inset_0_2px_8px_rgba(0,0,0,0.9)] ${
          disabled ? "opacity-40" : "cursor-pointer"
        }`}
        style={{ touchAction: "none" }}
        onPointerDown={handleDown}
        onPointerMove={handleMove}
        onPointerUp={handleUp}
        onPointerCancel={handleUp}
      >
        {/* Red→gold fill that grows from the bottom. Uses a scaleY transform on a
            full-height (inset-0) layer — no percentage height, so it renders the
            same in portrait, landscape, and on mobile (where % heights against a
            flex parent collapse to 0). */}
        <div
          className="pointer-events-none absolute inset-0 origin-bottom"
          style={{
            transform: `scaleY(${pct / 100})`,
            background: "linear-gradient(to top, #d11f2a 0%, #ff6b35 50%, #e8c547 100%)",
            boxShadow: pct > 1 ? "0 0 14px rgba(232, 197, 71, 0.7)" : "none",
            transition: dragging.current ? "none" : "transform 90ms linear",
          }}
        />
      </div>

      <span className="font-mono text-xs font-bold tabular-nums text-gold-bright">{display}</span>
    </div>
  );
}
