"use client";

import type { ReactNode } from "react";

const CONFETTI_COLORS = ["#e8c547", "#c9a227", "#0b3d2e", "#8e1626", "#f5efe0"];

interface WinnerPopupProps {
  /** Big line under CONGRATULATIONS — the winner's name. */
  winnerName: string;
  avatarSrc?: string;
  /** e.g. "wins the frame" / "wins by resign". */
  message: string;
  /** Winnings pill, e.g. "+160 $DDAWGS" (omit when not applicable). */
  amountLabel?: string | null;
  actions?: ReactNode;
}

/** Celebration popup shown over the table once a frame is decided. */
export default function WinnerPopup({
  winnerName,
  avatarSrc,
  message,
  amountLabel,
  actions,
}: WinnerPopupProps) {
  return (
    <div
      data-testid="winner-popup"
      className="relative max-w-md overflow-hidden rounded-2xl border-2 border-gold bg-gradient-to-b from-mahogany-dark via-black/95 to-black px-10 py-7 text-center shadow-[0_0_45px_rgba(201,162,39,0.5)]"
    >
      {/* Confetti (index-seeded so SSR and client agree) */}
      {Array.from({ length: 26 }).map((_, i) => (
        <span
          key={i}
          className="confetti"
          style={{
            left: `${(i * 37 + 11) % 100}%`,
            background: CONFETTI_COLORS[i % CONFETTI_COLORS.length],
            animationDelay: `${(i % 9) * 0.3}s`,
            animationDuration: `${2.4 + (i % 5) * 0.45}s`,
            width: i % 3 === 0 ? "6px" : "9px",
          }}
        />
      ))}

      <div className="animate-bounce text-5xl drop-shadow-[0_0_18px_rgba(232,197,71,0.8)]">
        🏆
      </div>

      <h2 className="heading-display mt-2 text-3xl font-extrabold tracking-[0.18em]">
        CONGRATULATIONS
      </h2>

      <div className="mt-3 flex items-center justify-center gap-3">
        {avatarSrc && (
          <span className="h-12 w-11 overflow-hidden rounded-lg border-2 border-gold shadow-gold-glow">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={avatarSrc}
              alt={winnerName}
              className="h-full w-full object-cover"
              draggable={false}
            />
          </span>
        )}
        <span className="font-display text-2xl font-bold text-gold-bright">
          {winnerName}
        </span>
      </div>

      <p className="mt-1 text-sm uppercase tracking-widest text-amber-100/70">{message}</p>

      {amountLabel && (
        <p className="mx-auto mt-3 flex w-fit items-center gap-2 rounded-full border border-gold/60 bg-black/70 px-4 py-1.5 font-mono text-lg font-bold text-gold-bright shadow-gold-glow">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/assets/token.svg" alt="" className="h-5 w-5" draggable={false} />
          {amountLabel}
        </p>
      )}

      {actions && <div className="mt-5 flex justify-center gap-3">{actions}</div>}
    </div>
  );
}
