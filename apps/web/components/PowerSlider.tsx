"use client";

import { useRef } from "react";
import { MAX_POWER } from "@pooldawgs/engine";

interface PowerSliderProps {
  value: number;
  disabled?: boolean;
  onChange: (value: number) => void;
  /** Fired when the player releases the slider — this takes the shot. */
  onRelease: (value: number) => void;
}

/** Vertical power slider (right rail in the design). Drag up to charge,
 *  release to strike. */
export default function PowerSlider({ value, disabled, onChange, onRelease }: PowerSliderProps) {
  const trackRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);

  function valueFromPointer(clientY: number): number {
    const track = trackRef.current!;
    const rect = track.getBoundingClientRect();
    const frac = 1 - (clientY - rect.top) / rect.height;
    return Math.max(0, Math.min(MAX_POWER, frac * MAX_POWER));
  }

  function handleDown(e: React.PointerEvent) {
    if (disabled) return;
    dragging.current = true;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
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

  const pct = (value / MAX_POWER) * 100;

  return (
    <div className="flex h-full select-none flex-col items-center gap-2">
      <span className="text-[10px] font-semibold uppercase tracking-widest text-gold">
        Power
      </span>
      <div
        ref={trackRef}
        className={`relative w-7 flex-1 rounded-full border border-gold-dim/50 bg-black/80 shadow-[inset_0_2px_8px_rgba(0,0,0,0.9)] ${
          disabled ? "opacity-40" : "cursor-pointer"
        }`}
        style={{ touchAction: "none" }}
        onPointerDown={handleDown}
        onPointerMove={handleMove}
        onPointerUp={handleUp}
        onPointerCancel={handleUp}
      >
        {/* Centre guide line, like the design's needle track. */}
        <span className="absolute left-1/2 top-2 h-[calc(100%-16px)] w-px -translate-x-1/2 bg-gold-dim/40" />
        {/* Fill glow rising from the bottom */}
        <div
          className="absolute inset-x-1.5 bottom-1.5 rounded-full"
          style={{
            height: `calc(${pct}% )`,
            background: "linear-gradient(to top, #ff6b35, #e8c547)",
            boxShadow: pct > 1 ? "0 0 12px rgba(232, 197, 71, 0.7)" : "none",
            transition: dragging.current ? "none" : "height 120ms",
          }}
        />
        {/* Knob */}
        <div
          className="absolute left-1/2 h-4 w-4 -translate-x-1/2 translate-y-1/2 rounded-full border border-gold-dim bg-gradient-to-b from-[#f0d77b] to-[#8a6d1d] shadow-gold-glow"
          style={{ bottom: `calc(${pct}% )` }}
        />
      </div>
      <span className="font-mono text-xs text-amber-100/70">{Math.round(value)}</span>
    </div>
  );
}
