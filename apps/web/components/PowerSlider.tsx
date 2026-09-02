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

/** Vertical power fader (right rail), styled after the brand "POWER" panel:
 *  a black gold-trimmed case with a tick-marked channel, a gold knob that rides
 *  the value, and an amber glow that charges up from the bottom. Drag up to
 *  charge, release to strike. Reads 0–100% over the engine's MAX_POWER scale. */
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
  const charged = pct > 1;

  return (
    <div
      className="flex h-full w-full select-none flex-col items-center gap-1 rounded-2xl border border-gold-dim/40 px-1 py-2"
      style={{
        background: "linear-gradient(160deg, #1c1c21 0%, #101013 55%, #070708 100%)",
        boxShadow: "inset 0 1px 0 rgba(232,197,71,0.12), 0 6px 16px rgba(0,0,0,0.5)",
      }}
    >
      <span
        className="text-[8px] font-extrabold uppercase tracking-[0.14em] text-gold-bright touch:text-[7px]"
        style={{ textShadow: "0 1px 1px rgba(0,0,0,0.85)" }}
      >
        Power
      </span>

      {/* Channel — pointer target + measurement box. */}
      <div
        ref={trackRef}
        data-testid="power-slider"
        className={`relative w-full min-h-[64px] flex-1 rounded-xl ${
          disabled ? "opacity-40" : "cursor-pointer"
        }`}
        style={{ touchAction: "none" }}
        onPointerDown={handleDown}
        onPointerMove={handleMove}
        onPointerUp={handleUp}
        onPointerCancel={handleUp}
      >
        {/* Recessed track visuals (clipped); the knob rides above, unclipped. */}
        <div
          className="absolute inset-0 overflow-hidden rounded-xl"
          style={{
            background: "linear-gradient(to right, #050506, #0d0d10)",
            boxShadow:
              "inset 0 2px 10px rgba(0,0,0,0.9), inset 0 0 0 1px rgba(201,162,39,0.16)",
          }}
        >
          {/* Tick marks down the right edge. */}
          <div
            className="pointer-events-none absolute right-1.5 top-3 bottom-3 w-1.5"
            style={{
              backgroundImage:
                "repeating-linear-gradient(to bottom, rgba(201,162,39,0.5) 0 2px, transparent 2px 10%)",
            }}
          />

          {/* Neutral centre rail — reads as the metallic needle above the knob. */}
          <div
            className="pointer-events-none absolute left-1/2 top-2 bottom-2 -translate-x-1/2 rounded-full"
            style={{
              width: 3,
              background:
                "linear-gradient(to bottom, rgba(232,232,238,0.85), rgba(150,150,160,0.3))",
            }}
          />

          {/* Amber charge, growing up from the bottom via a scaleY transform.
              Percentage HEIGHTS collapse against this flex-sized track, so the
              fill is a full-height bar scaled by the power fraction instead
              (same trick the original meter used). */}
          <div
            className="pointer-events-none absolute bottom-2 top-2 left-1/2 rounded-full"
            style={{
              width: 6,
              transformOrigin: "bottom center",
              transform: `translateX(-50%) scaleY(${pct / 100})`,
              background: "linear-gradient(to top, #ff8a00, #ffb347 60%, #ffd98a)",
              boxShadow: charged ? "0 0 12px 2px rgba(255,150,40,0.75)" : "none",
            }}
          />
          {/* Glowing droplet at the base of the charge. */}
          {charged && (
            <div
              className="pointer-events-none absolute bottom-1 left-1/2 -translate-x-1/2 rounded-full"
              style={{
                width: 14,
                height: 14,
                background:
                  "radial-gradient(circle, #fff2cc 0%, #ffb347 45%, rgba(255,140,30,0) 72%)",
              }}
            />
          )}
        </div>

        {/* Gold knob riding at the current value. Positioned with flex-grow
            spacers (top grows 100−pct, bottom grows pct) rather than a
            percentage offset — flex distribution needs no definite height, so
            unlike `bottom: %` it tracks the charge live in this flex layout. */}
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center py-2">
          <div style={{ flexGrow: 100 - pct, flexBasis: 0 }} />
          <div
            className="shrink-0 rounded-full border"
            style={{
              width: 20,
              height: 20,
              borderColor: "rgba(90,70,20,0.9)",
              background:
                "radial-gradient(circle at 35% 30%, #ffe9a8 0%, #e8c547 42%, #b8891f 100%)",
              boxShadow: "0 1px 3px rgba(0,0,0,0.7), 0 0 8px rgba(232,197,71,0.5)",
            }}
          />
          <div style={{ flexGrow: pct, flexBasis: 0 }} />
        </div>
      </div>

      <span className="font-mono text-xs font-bold tabular-nums text-gold-bright">{display}</span>
    </div>
  );
}
