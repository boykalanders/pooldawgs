"use client";

import type { BallColor, GameType, TableState } from "@pooldawgs/engine";
import { ballAssetByNumber } from "@/lib/balls";

interface PlayerCardProps {
  name: string;
  /** Sub-line under the tracker (balance, address, …). */
  detail?: string;
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

/** Top-bar player cluster. Desktop: framed portrait beside the name / tracker /
 *  balance. Mobile: a compact vertical chip — avatar, then the $DDAWGS amount,
 *  then the score / pocketed-ball tracker — so the cards stay narrow and the
 *  table gets more room. The player on turn gets the design's red glowing frame. */
export default function PlayerCard({
  name,
  detail,
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
      className={`relative h-16 w-[60px] shrink-0 overflow-visible rounded-lg border-2 touch:h-11 touch:w-10 ${
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

  // The score / pocketed-ball tracker (snooker score · 8-ball group balls ·
  // 9-ball note). On mobile this sits UNDER the amount (order-3).
  const tracker =
    gameType === "snooker" ? (
      <span className="rounded-md bg-black/60 px-3 py-0.5 font-mono text-lg font-bold text-gold-bright touch:px-2 touch:text-sm">
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
                className="h-4 w-4 touch:h-3 touch:w-3"
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

  // Info column. Flex so the children can be re-ordered per breakpoint:
  //   desktop → name, tracker, amount   (unchanged design)
  //   mobile  → name, amount, tracker   (amount under avatar; score/balls under amount)
  const info = (
    <div
      className={`flex min-w-0 flex-col touch:items-center touch:text-center ${
        flip ? "desktop:items-end desktop:text-right" : ""
      }`}
    >
      <p className="order-1 truncate font-display text-base font-bold text-amber-50 touch:text-[11px] touch:leading-tight">
        {name}
      </p>
      {detail && (
        <p
          className={`order-3 mt-1 flex items-center gap-1 truncate text-xs font-semibold text-gold-bright touch:order-2 touch:mt-0.5 touch:justify-center touch:text-[10px] ${
            flip ? "desktop:justify-end" : ""
          }`}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/assets/token.svg" alt="" className="h-3.5 w-3.5 touch:h-3 touch:w-3" draggable={false} />
          {detail}
        </p>
      )}
      <div
        className={`order-2 mt-1 flex touch:order-3 touch:mt-0.5 touch:justify-center ${
          flip ? "desktop:justify-end" : ""
        }`}
      >
        {tracker}
      </div>
    </div>
  );

  return (
    <div
      className={`flex items-center gap-3 px-1 py-1 touch:flex-col touch:gap-0.5 ${
        flip ? "justify-end" : ""
      }`}
    >
      {/* Avatar is first in the DOM (so it's on top on the mobile column); the
          desktop flip mirrors it to the right via order. */}
      <div className={flip ? "desktop:order-2" : ""}>{avatar}</div>
      {info}
    </div>
  );
}
