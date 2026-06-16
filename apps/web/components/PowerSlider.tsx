"use client";

import { useEffect, useRef, useState } from "react";
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
  // Measure the track in pixels. Percentage heights don't resolve against a
  // flex-1 parent on mobile browsers (the parent is "indefinite"), which left
  // the fill 0px tall on phones — so we size the fill in real pixels instead.
  const [trackH, setTrackH] = useState(0);

  useEffect(() => {
    const el = trackRef.current;
    if (!el) return;
    const measure = () => setTrackH(el.clientHeight);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

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
  const fillH = (pct / 100) * trackH;
  const fillTransition = dragging.current ? "none" : "height 90ms linear, bottom 90ms linear";

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
        {/* Quartile ticks (pixel-positioned for mobile reliability) */}
        {[0.25, 0.5, 0.75].map((t) => (
          <span
            key={t}
            className="pointer-events-none absolute inset-x-0 h-px bg-gold-dim/25"
            style={{ bottom: `${t * trackH}px` }}
          />
        ))}

        {/* Red→gold fill rising from the bottom; sized in px so it always shows. */}
        <div
          className="pointer-events-none absolute inset-x-0 bottom-0"
          style={{
            height: `${fillH}px`,
            background: "linear-gradient(to top, #d11f2a 0%, #ff6b35 55%, #e8c547 100%)",
            boxShadow: pct > 1 ? "0 0 14px rgba(232, 197, 71, 0.6)" : "none",
            transition: fillTransition,
          }}
        />

        {/* Level marker at the current power. */}
        <div
          className="pointer-events-none absolute inset-x-0 h-0.5 bg-amber-50 shadow-[0_0_6px_rgba(255,255,255,0.8)]"
          style={{
            bottom: `${fillH}px`,
            opacity: pct > 1 ? 1 : 0,
            transition: fillTransition,
          }}
        />
      </div>

      <span className="font-mono text-xs font-bold tabular-nums text-gold-bright">{display}</span>
    </div>
  );
}
