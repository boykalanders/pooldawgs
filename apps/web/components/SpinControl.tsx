"use client";

import { useRef } from "react";

export interface SpinValue {
  /** Hit point on the cue ball, screen coords (-1..1, y grows downward). */
  x: number;
  y: number;
}

interface SpinControlProps {
  value: SpinValue;
  onChange: (value: SpinValue) => void;
  disabled?: boolean;
}

/** The cue-ball hit-point picker (bottom-left widget in the design): drag
 *  the red dot — above centre = follow, below = draw, sides = english. */
export default function SpinControl({ value, onChange, disabled }: SpinControlProps) {
  const ballRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);

  function set(e: React.PointerEvent) {
    const rect = ballRef.current!.getBoundingClientRect();
    let dx = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    let dy = ((e.clientY - rect.top) / rect.height) * 2 - 1;
    const len = Math.sqrt(dx * dx + dy * dy);
    if (len > 1) {
      dx /= len;
      dy /= len;
    }
    onChange({ x: dx, y: dy });
  }

  return (
    <div
      className="flex h-[72px] w-[72px] items-center justify-center rounded-full border-2 border-gold-dim/60 bg-black/80 shadow-[inset_0_2px_8px_rgba(0,0,0,0.8),0_0_10px_rgba(201,162,39,0.25)] touch:h-12 touch:w-12"
      data-testid="spin-control"
      title="Cue-ball spin — drag the dot: top = follow, bottom = draw, sides = english"
    >
      <div
        ref={ballRef}
        className={`relative h-12 w-12 rounded-full shadow-inner touch:h-9 touch:w-9 ${
          disabled ? "opacity-40" : "cursor-pointer"
        }`}
        style={{
          background: "radial-gradient(circle at 35% 30%, #ffffff, #f5efe0 60%, #d8d2c0)",
          touchAction: "none",
        }}
        onPointerDown={(e) => {
          if (disabled) return;
          dragging.current = true;
          (e.target as HTMLElement).setPointerCapture(e.pointerId);
          set(e);
        }}
        onPointerMove={(e) => {
          if (dragging.current && !disabled) set(e);
        }}
        onPointerUp={() => (dragging.current = false)}
        onPointerCancel={() => (dragging.current = false)}
      >
        {/* Crosshair */}
        <span className="absolute left-1/2 top-1 h-[calc(100%-8px)] w-px -translate-x-1/2 bg-black/10" />
        <span className="absolute left-1 top-1/2 h-px w-[calc(100%-8px)] -translate-y-1/2 bg-black/10" />
        {/* Hit point */}
        <span
          data-testid="spin-dot"
          className="absolute h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border border-red-800 bg-red-600 shadow"
          style={{
            left: `${50 + value.x * 38}%`,
            top: `${50 + value.y * 38}%`,
          }}
        />
      </div>
    </div>
  );
}
