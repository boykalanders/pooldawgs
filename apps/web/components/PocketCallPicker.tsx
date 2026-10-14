"use client";

import { useState } from "react";
import { POCKET_NAMES } from "@pooldawgs/engine";

/**
 * Call the pocket for the 8-ball (classic rule): a small diagram of the table
 * with its six pockets. The black dropping in any other pocket loses the frame.
 * Pocket indices follow the engine's table pockets (POCKET_NAMES).
 */
const LAYOUT: ReadonlyArray<{ index: number; left: string; top: string }> = [
  { index: 0, left: "0%", top: "0%" }, // top left
  { index: 4, left: "50%", top: "0%" }, // top middle
  { index: 1, left: "100%", top: "0%" }, // top right
  { index: 2, left: "0%", top: "100%" }, // bottom left
  { index: 5, left: "50%", top: "100%" }, // bottom middle
  { index: 3, left: "100%", top: "100%" }, // bottom right
];

export function PocketCallPicker({
  selected,
  onSelect,
}: {
  selected: number | null;
  onSelect: (pocket: number) => void;
}) {
  const [editing, setEditing] = useState(false);
  // Once called, shrink to a small pill so the table corner stays visible for aiming.
  if (selected !== null && !editing) {
    return (
      <button
        type="button"
        onClick={() => setEditing(true)}
        className="rounded-full border border-gold/60 bg-black/85 px-3 py-1 text-[11px] font-semibold text-gold-bright shadow-gold-glow"
        title="Change the called pocket"
      >
        8 → {POCKET_NAMES[selected]} ✎
      </button>
    );
  }
  const pick = (pocket: number) => {
    onSelect(pocket);
    setEditing(false);
  };
  return (
    <div className="rounded-xl border border-gold/60 bg-black/85 px-3 pb-3 pt-2 text-center shadow-gold-glow">
      <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-gold-bright">
        {selected === null ? "Call your pocket for the 8" : `8-ball → ${POCKET_NAMES[selected]}`}
      </p>
      <div className="relative mx-3 my-2 h-14 w-28 rounded-md border-2 border-amber-900 bg-emerald-700/80 touch:h-11 touch:w-24">
        {LAYOUT.map(({ index, left, top }) => (
          <button
            key={index}
            type="button"
            aria-label={`Call the ${POCKET_NAMES[index]} pocket`}
            aria-pressed={selected === index}
            onClick={() => pick(index)}
            className={`absolute h-6 w-6 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 transition ${
              selected === index
                ? "scale-110 border-gold-bright bg-black ring-2 ring-gold-bright"
                : "border-gold-dim/70 bg-black/80 hover:border-gold"
            }`}
            style={{ left, top }}
          >
            {selected === index && <span className="text-[10px] font-bold text-gold-bright">8</span>}
          </button>
        ))}
      </div>
    </div>
  );
}
