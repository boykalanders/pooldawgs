"use client";

import type { BallColor, GameType, TableState } from "@pooldawgs/engine";
import { ballAssetByNumber } from "@/lib/balls";

interface PlayerCardProps {
  name: string;
  /** Token balance line (e.g. "2,450.00 $DDAWGS") — shown without an icon. */
  detail?: string;
  /** Frames/games won — shown as 🏆 N under the balance. */
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

/** Top-bar player cluster: a framed portrait beside a vertical stat column —
 *  name, $DDAWGS balance, frames-won (🏆), and the group / score tracker. The
 *  player on turn gets the design's red glowing frame. */
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

  // Group (8-ball pocketed balls) / Score (snooker) tracker.
  const tracker =
    gameType === "snooker" ? (
      <span className="rounded-md bg-black/60 px-2 py-0.5 font-mono text-base font-bold text-gold-bright touch:text-sm">
        {score}
      </span>
    ) : gameType === "8ball" ? (
      <div className="flex w-fit items-center gap-1 rounded-full bg-black/50 px-1.5 py-0.5">
        {group === null ? (
          <span className="px-1 text-[9px] uppercase tracking-widest text-amber-100/40">no group yet</span>
        ) : (
          groupBalls.map((b) =>
            b.inHole ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                key={b.id}
                src={ballAssetByNumber(b.number)}
                alt={`${b.number} pocketed`}
                title={`${b.number} pocketed`}
                className="h-4 w-4 touch:h-2.5 touch:w-2.5"
                draggable={false}
              />
            ) : (
              <span
                key={b.id}
                className="h-4 w-4 rounded-full border border-black/60 bg-[#16120e] touch:h-3 touch:w-3"
                title="still on the table"
              />
            )
          )
        )}
      </div>
    ) : (
      <span className="text-[9px] uppercase tracking-widest text-amber-100/40">rotation — lowest ball first</span>
    );

  // Vertical stat column beside the avatar: name → balance → 🏆 wins → tracker.
  // Kept very tight on mobile so the whole top bar is short and the table gets
  // the room.
  const info = (
    <div className={`flex min-w-0 flex-col gap-0.5 touch:gap-0 ${flip ? "items-end text-right" : ""}`}>
      <p className="truncate font-display text-base font-bold leading-tight text-amber-50 touch:text-[10px]">
        {name}
      </p>
      {detail && (
        <p className="truncate text-xs font-semibold leading-tight text-gold-bright touch:text-[9px]">
          {detail}
        </p>
      )}
      {wins != null && (
        <p className="text-xs font-semibold leading-tight text-amber-100/80 touch:text-[9px]">🏆 {wins}</p>
      )}
      <div className={`mt-0.5 flex touch:mt-0 ${flip ? "justify-end" : ""}`}>{tracker}</div>
    </div>
  );

  return (
    <div className={`flex items-center gap-3 px-1 py-1 touch:gap-1.5 touch:py-0 ${flip ? "justify-end" : ""}`}>
      {flip ? (
        <>
          {info}
          {avatar}
        </>
      ) : (
        <>
          {avatar}
          {info}
        </>
      )}
    </div>
  );
}
