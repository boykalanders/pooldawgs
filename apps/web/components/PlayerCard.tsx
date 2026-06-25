"use client";

interface PlayerCardProps {
  name: string;
  /** Token balance line (e.g. "2,450.00 $DDAWGS") — shown without an icon. */
  detail?: string;
  /** Frames/games won — shown as 🏆 N next to the name. */
  wins?: number;
  badge?: string;
  /** Portrait image (cropped from the client's UI kit / NFT art later). */
  avatarSrc?: string;
  isTurn: boolean;
  connected?: boolean;
  /** Mirror the layout for the right-hand player like the design. */
  flip?: boolean;
}

/** Top-bar player cluster: a framed portrait beside the name (with 🏆 wins) and
 *  the $DDAWGS balance. The group / score tag lives on the table's side rails,
 *  not here. The player on turn gets the design's red glowing frame. */
export default function PlayerCard({
  name,
  detail,
  wins,
  badge,
  avatarSrc,
  isTurn,
  connected = true,
  flip = false,
}: PlayerCardProps) {
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
        <p className="truncate text-xs font-semibold leading-tight text-gold-bright touch:text-[9px]">{detail}</p>
      )}
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
