"use client";

import type { BallColor, TableState } from "@pooldawgs/engine";
import { groupBallIds, ballStyle, ballAssetByNumber } from "@/lib/balls";

interface PlayerCardProps {
  name: string;
  /** Sub-line under the tracker (balance, address, …). */
  detail?: string;
  badge?: string;
  /** Portrait image (cropped from the client's UI kit / NFT art later). */
  avatarSrc?: string;
  group: BallColor | null;
  state: TableState;
  isTurn: boolean;
  connected?: boolean;
  /** Mirror the layout for the right-hand player like the design. */
  flip?: boolean;
}

/** Top-bar player cluster per the client design: framed portrait with a
 *  level-star badge, name, pocketed-ball tracker pill, balance line.
 *  The player on turn gets the design's red glowing frame. */
export default function PlayerCard({
  name,
  detail,
  badge,
  avatarSrc,
  group,
  state,
  isTurn,
  connected = true,
  flip = false,
}: PlayerCardProps) {
  const ids = groupBallIds(group);

  const avatar = (
    <div
      className={`relative h-16 w-[60px] shrink-0 overflow-visible rounded-lg border-2 ${
        isTurn
          ? "border-red-600 shadow-[0_0_14px_rgba(220,38,38,0.6)]"
          : "border-gold/70 shadow-gold-glow"
      }`}
    >
      <div className="h-full w-full overflow-hidden rounded-md bg-wood-grain">
        {avatarSrc ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={avatarSrc}
            alt={name}
            className="h-full w-full object-cover"
            draggable={false}
          />
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
    <div className={`min-w-0 ${flip ? "text-right" : ""}`}>
      <p className="truncate font-display text-base font-bold text-amber-50">{name}</p>
      <div
        className={`mt-1 flex w-fit items-center gap-1 rounded-full bg-black/50 px-1.5 py-0.5 ${
          flip ? "ml-auto" : ""
        }`}
      >
        {group === null ? (
          <span className="px-1 text-[9px] uppercase tracking-widest text-amber-100/40">
            no group yet
          </span>
        ) : (
          ids.map((id) => {
            const potted = state.balls[id].inHole;
            const style = ballStyle(id);
            return potted ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                key={id}
                src={ballAssetByNumber(style.number!)}
                alt={`${style.number} pocketed`}
                title={`${style.number} pocketed`}
                className="h-4 w-4"
                draggable={false}
              />
            ) : (
              <span
                key={id}
                className="h-4 w-4 rounded-full border border-black/60 bg-[#16120e]"
                title="still on the table"
              />
            );
          })
        )}
      </div>
      {detail && (
        <p
          className={`mt-1 flex items-center gap-1 truncate text-xs font-semibold text-gold-bright ${
            flip ? "justify-end" : ""
          }`}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/assets/token.svg" alt="" className="h-3.5 w-3.5" draggable={false} />
          {detail}
        </p>
      )}
    </div>
  );

  return (
    <div className={`flex items-center gap-3 px-1 py-1 ${flip ? "justify-end" : ""}`}>
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
