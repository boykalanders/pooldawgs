"use client";

import type { ReactNode } from "react";

const CONFETTI_COLORS = ["#e8c547", "#c9a227", "#0b3d2e", "#8e1626", "#f5efe0"];

interface EndGameModalProps {
  /** Big line under the title — the winner's name (or "You" on a win). */
  winnerName: string;
  avatarSrc?: string;
  /** e.g. "wins the frame" / "wins by resign". */
  message: string;
  /** Result pill, e.g. "+160 $DDAWGS" on a win or "-80 $DDAWGS" on a loss. */
  amountLabel?: string | null;
  actions?: ReactNode;
  /** Render the somber Defeat variant (loser's view) instead of Victory. */
  defeated?: boolean;
}

/** End-of-frame modal — celebratory Victory for the winner, somber Defeat for
 *  the loser. Both show who took the pot; only Victory carries the claim. */
export default function WinnerPopup({
  winnerName,
  avatarSrc,
  message,
  amountLabel,
  actions,
  defeated = false,
}: EndGameModalProps) {
  if (defeated) {
    return (
      <div
        data-testid="defeat-popup"
        className="relative max-w-md overflow-hidden rounded-2xl border-2 border-red-900/80 bg-gradient-to-b from-[#2a0d0d] via-black/95 to-black px-10 py-7 text-center shadow-[0_0_45px_rgba(142,22,38,0.5)] touch:max-w-[15rem] touch:px-5 touch:py-4"
      >
        <div className="text-5xl opacity-90 drop-shadow-[0_0_18px_rgba(142,22,38,0.7)] touch:text-3xl">💀</div>

        <h2 className="mt-2 font-display text-3xl font-extrabold tracking-[0.22em] text-red-300 touch:mt-1 touch:text-lg">
          DEFEAT
        </h2>

        <div className="mt-3 flex items-center justify-center gap-3 opacity-90 touch:mt-2 touch:gap-2">
          {avatarSrc && (
            <span className="h-12 w-11 overflow-hidden rounded-lg border-2 border-red-800/70 grayscale touch:h-9 touch:w-8">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={avatarSrc} alt={winnerName} className="h-full w-full object-cover" draggable={false} />
            </span>
          )}
          <span className="font-display text-2xl font-bold text-amber-100/80 touch:text-base">{winnerName}</span>
        </div>

        <p className="mt-1 text-sm uppercase tracking-widest text-amber-100/50 touch:text-[10px]">{message}</p>

        {amountLabel && (
          <p className="mx-auto mt-3 flex w-fit items-center gap-2 rounded-full border border-red-900/70 bg-black/70 px-4 py-1.5 font-mono text-lg font-bold text-red-300 touch:mt-2 touch:px-3 touch:py-1 touch:text-sm">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/assets/token.svg" alt="" className="h-5 w-5 opacity-70 touch:h-4 touch:w-4" draggable={false} />
            {amountLabel}
          </p>
        )}

        <p className="mt-3 text-xs italic text-amber-100/40 touch:mt-2 touch:text-[10px]">Rack &rsquo;em up and run it back.</p>

        {actions && <div className="mt-4 flex justify-center gap-3 touch:mt-3">{actions}</div>}
      </div>
    );
  }

  return (
    <div
      data-testid="winner-popup"
      className="relative max-w-md overflow-hidden rounded-2xl border-2 border-gold bg-gradient-to-b from-mahogany-dark via-black/95 to-black px-10 py-7 text-center shadow-[0_0_45px_rgba(201,162,39,0.5)] touch:max-w-[15rem] touch:px-5 touch:py-4"
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

      <div className="animate-bounce text-5xl drop-shadow-[0_0_18px_rgba(232,197,71,0.8)] touch:text-3xl">🏆</div>

      <h2 className="heading-display mt-2 text-3xl font-extrabold tracking-[0.18em] touch:mt-1 touch:text-lg">
        CONGRATULATIONS
      </h2>

      <div className="mt-3 flex items-center justify-center gap-3 touch:mt-2 touch:gap-2">
        {avatarSrc && (
          <span className="h-12 w-11 overflow-hidden rounded-lg border-2 border-gold shadow-gold-glow touch:h-9 touch:w-8">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={avatarSrc} alt={winnerName} className="h-full w-full object-cover" draggable={false} />
          </span>
        )}
        <span className="font-display text-2xl font-bold text-gold-bright touch:text-base">{winnerName}</span>
      </div>

      <p className="mt-1 text-sm uppercase tracking-widest text-amber-100/70 touch:text-[10px]">{message}</p>

      {amountLabel && (
        <p className="mx-auto mt-3 flex w-fit items-center gap-2 rounded-full border border-gold/60 bg-black/70 px-4 py-1.5 font-mono text-lg font-bold text-gold-bright shadow-gold-glow touch:mt-2 touch:px-3 touch:py-1 touch:text-sm">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/assets/token.svg" alt="" className="h-5 w-5 touch:h-4 touch:w-4" draggable={false} />
          {amountLabel}
        </p>
      )}

      {actions && <div className="mt-5 flex justify-center gap-3 touch:mt-3">{actions}</div>}
    </div>
  );
}
