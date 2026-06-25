"use client";

import type { BallColor, GameType, TableState } from "@pooldawgs/engine";
import { ballAssetByNumber } from "@/lib/balls";

interface PlayerCardProps {
  name: string;
  /** Token balance line (e.g. "2,450.00 $DDAWGS"). */
  detail?: string;
  /** Frames/games won — shown as 🏆 N next to the name. */
  wins?: number;
  badge?: string;
  /** Portrait image (cropped from the client's UI kit / NFT art later). */
  avatarSrc?: string;
  gameType: GameType;
  group: BallColor | null;
  /** Snooker running score. */
  score: number;
  state: TableState;
  isTurn: boolean;
  connected?: boolean;
  /** Mirror the layout for the right-hand player like the design. */
  flip?: boolean;
}

/** Top-bar player cluster: portrait + name (with 🏆 wins) + $DDAWGS balance.
 *  Snooker's score sits next to the name/balance in a big font. The 8-ball group
 *  tag shows here on DESKTOP, but on mobile it moves to the table's side rails
 *  (rendered by GameShell) to save top-bar height. */
export default function PlayerCard({
  name,
  detail,
  wins,
  badge,
  avatarSrc,
  gameType,
  group,
  score,
  state,
  isTurn,
  connected = true,
  flip = false,
}: PlayerCardProps) {
  // 8-ball: this player's group balls, sorted by printed number.
  const groupBalls =
    gameType === "8ball" && group
      ? state.balls.filter((b) => b.color === group).sort((a, b) => a.number - b.number)
      : [];

  const avatar = (
    <div
      className={`relative h-16 w-[60px] shrink-0 overflow-visible rounded-lg border-2 touch:h-9 touch:w-8 ${
        isTurn
          ? "border-red-600 shadow-[0_0_14px_rgba(220,38,38,0.6)]"
          : "border-gold/70 shadow-gold-glow"
      }`}
    >
      <div className="h-full w-full overflow-hidden rounded-md bg-wood-grain">
        {avatarSrc ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={avatarSrc} alt={name} className="h-full w-full object-cover" draggable={false} />
        ) : (
          <span className="flex h-full w-full items-center justify-center text-2xl">🐶</span>
        )}
      </div>
      {badge && (
        <span
          className={`absolute -top-2 flex h-6 min-w-6 items-center justify-center rounded-full border border-gold bg-gold-sheen px-1 text-[10px] font-bold text-mahogany-deep shadow ${
            flip ? "-left-2" : "-right-2"
          }`}
        >
          {badge}
        </span>
      )}
      {!connected && (
        <span className="absolute -bottom-1 -right-1 h-3 w-3 rounded-full border border-mahogany-deep bg-red-500" />
      )}
    </div>
  );

  const info = (
    <div className={`flex min-w-0 flex-col gap-0.5 touch:gap-0 ${flip ? "items-end text-right" : ""}`}>
      <p
        className={`flex items-center gap-1.5 font-display text-base font-bold leading-tight text-amber-50 touch:text-[10px] ${
          flip ? "flex-row-reverse" : ""
        }`}
      >
        <span className="truncate">{name}</span>
        {wins != null && (
          <span className="shrink-0 text-xs font-semibold text-amber-100/80 touch:text-[9px]">🏆 {wins}</span>
        )}
      </p>
      {detail && (
        <p
          className={`flex items-center gap-1 truncate text-xs font-semibold leading-tight text-gold-bright touch:text-[9px] ${
            flip ? "flex-row-reverse" : ""
          }`}
        >
          {/* Token icon: desktop only (hidden on mobile to save room). */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/assets/token.svg"
            alt=""
            className="hidden h-3.5 w-3.5 shrink-0 desktop:inline-block"
            draggable={false}
          />
          {detail}
        </p>
      )}
      {/* 8-ball group tag — DESKTOP only; on mobile it's on the side rail. */}
      {gameType === "8ball" && (
        <div className={`mt-0.5 hidden desktop:flex ${flip ? "justify-end" : ""}`}>
          {group === null ? (
            <span className="rounded-full bg-black/50 px-2 py-0.5 text-[9px] uppercase tracking-widest text-amber-100/40">
              no group yet
            </span>
          ) : (
            <div className="flex w-fit items-center gap-1 rounded-full bg-black/50 px-1.5 py-0.5">
              {groupBalls.map((b) =>
                b.inHole ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    key={b.id}
                    src={ballAssetByNumber(b.number)}
                    alt={`${b.number} pocketed`}
                    title={`${b.number} pocketed`}
                    className="h-4 w-4"
                    draggable={false}
                  />
                ) : (
                  <span
                    key={b.id}
                    className="h-4 w-4 rounded-full border border-black/60 bg-[#16120e]"
                    title="still on the table"
                  />
                )
              )}
            </div>
          )}
        </div>
      )}
      {gameType === "9ball" && (
        <span className="mt-0.5 hidden text-[9px] uppercase tracking-widest text-amber-100/40 desktop:block">
          rotation — lowest ball first
        </span>
      )}
    </div>
  );

  // Snooker score — next to the name/balance, big font, on every breakpoint.
  const snookerScore =
    gameType === "snooker" ? (
      <span className="shrink-0 rounded-md bg-black/55 px-2.5 py-1 font-mono text-2xl font-bold text-gold-bright shadow touch:px-2 touch:text-xl">
        {score}
      </span>
    ) : null;

  return (
    <div className={`flex items-center gap-3 px-1 py-1 touch:gap-1.5 touch:py-0 ${flip ? "justify-end" : ""}`}>
      {flip ? (
        <>
          {snookerScore}
          {info}
          {avatar}
        </>
      ) : (
        <>
          {avatar}
          {info}
          {snookerScore}
        </>
      )}
    </div>
  );
}
