"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { useAccountModal, useConnectModal } from "@rainbow-me/rainbowkit";
import { useAccount } from "wagmi";
import {
  cueBallId,
  type BallColor,
  type GameType,
  type ShotInput,
  type TableState,
} from "@pooldawgs/engine";
import type { ChatMessage } from "@pooldawgs/shared";
import Chat from "@/components/Chat";
import PlayerCard from "@/components/PlayerCard";
import PoolCanvas, {
  type PoolCanvasHandle,
  type ShotAnimation,
} from "@/components/PoolCanvas";
import PowerSlider from "@/components/PowerSlider";
import ShotClock from "@/components/ShotClock";
import SpinControl, { type SpinValue } from "@/components/SpinControl";
import {
  IconAim,
  IconChat,
  IconCue,
  IconGift,
  IconHome,
  IconMenu,
  IconSoundOff,
  IconSoundOn,
  IconSpin,
  IconTrophy,
  IconWallet,
} from "@/components/icons";

export interface ShellPlayer {
  name: string;
  detail?: string;
  badge?: string;
  avatarSrc?: string;
  connected?: boolean;
}

export interface ShellMenuItem {
  label: string;
  onClick: () => void;
  danger?: boolean;
}

interface GameShellProps {
  state: TableState;
  players: [ShellPlayer, ShellPlayer];
  interactive: boolean;
  potLabel?: string | null;
  balanceLabel?: string | null;
  clockExpiresAt?: number | null;
  statusText: string;
  banner?: string | null;
  centerAction?: { label: string; onClick: () => void } | null;
  menuItems: ShellMenuItem[];
  /** Switch game variant (8-ball / 9-ball / snooker) from the mode chips. */
  onSelectGameType?: (type: GameType) => void;
  animation?: ShotAnimation | null;
  onShoot: (shot: ShotInput) => void;
  onPlaceCueBall: (x: number, y: number) => void;
  onAnimationEnd: () => void;
  chat?: {
    messages: ChatMessage[];
    myAddress: string | null;
    onSend: (text: string) => void;
  };
  overlay?: ReactNode;
}

/** Full game chrome per the client design: player frames + logo top bar,
 *  tool rails, power slider, money panels, mode chips, bottom nav. */
export default function GameShell({
  state,
  players,
  interactive,
  potLabel,
  balanceLabel,
  clockExpiresAt,
  statusText,
  banner,
  centerAction,
  menuItems,
  onSelectGameType,
  animation,
  onShoot,
  onPlaceCueBall,
  onAnimationEnd,
  chat,
  overlay,
}: GameShellProps) {
  const canvasRef = useRef<PoolCanvasHandle>(null);
  const [power, setPower] = useState(0);
  const [spin, setSpin] = useState<SpinValue>({ x: 0, y: 0 });
  const [muted, setMuted] = useState(false);
  const [showGuide, setShowGuide] = useState(true);
  const [menuOpen, setMenuOpen] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  const [unread, setUnread] = useState(0);
  const seenCount = useRef(0);
  const spinActive = spin.x !== 0 || spin.y !== 0;

  const { openConnectModal } = useConnectModal();
  const { openAccountModal } = useAccountModal();
  const { isConnected } = useAccount();

  useEffect(() => {
    const count = chat?.messages.length ?? 0;
    if (chatOpen) {
      seenCount.current = count;
      setUnread(0);
    } else if (count > seenCount.current) {
      setUnread(count - seenCount.current);
    }
  }, [chat?.messages.length, chatOpen]);

  // Open the chat sidebar by default only on screens wide enough that it sits
  // in the page margin (outside the box) rather than over the table/controls.
  useEffect(() => {
    if (typeof window !== "undefined" && window.matchMedia?.("(min-width: 1900px)").matches) {
      setChatOpen(true);
    }
  }, []);

  function releasePower(value: number) {
    canvasRef.current?.shootNow(value);
    setPower(0);
  }

  function handleShoot(shot: ShotInput) {
    onShoot(shot);
    setSpin({ x: 0, y: 0 });
  }

  const canShoot =
    interactive && !state.gameOver && !state.ballInHand && !state.balls[cueBallId(state)].inHole;

  return (
    <>
    <div className="relative mx-auto flex h-[calc(100dvh-9.5rem)] min-h-[520px] w-full max-w-[1480px] select-none flex-col rounded-3xl border border-gold-dim/40 bg-emerald-deep/85 p-3 shadow-2xl shadow-felt-inset touch:h-[calc(100dvh-2rem)] touch:min-h-0">
      {/* Logo floats over the table's top rail, like the design. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src="/assets/logo.svg"
        alt="Pool Dawgs"
        className="pointer-events-none absolute left-1/2 top-2 z-20 h-24 w-auto -translate-x-1/2 drop-shadow-[0_6px_14px_rgba(0,0,0,0.8)] xl:h-28"
        draggable={false}
      />

      {/* ── top bar ── */}
      <div className="grid grid-cols-[auto_1fr_auto_1fr_auto] items-center gap-3 px-1 pb-2">
        <div className="relative">
          <IconButton
            icon={<IconMenu />}
            active={menuOpen}
            onClick={() => setMenuOpen((v) => !v)}
            title="Menu"
          />
          {menuOpen && (
            <div className="absolute left-0 top-[3.25rem] z-30 w-52 overflow-hidden rounded-xl border border-gold-dim/40 bg-emerald-panel shadow-2xl">
              <button
                className="flex w-full items-center gap-2.5 px-4 py-2.5 text-left text-sm text-cream transition hover:bg-gold/10"
                onClick={() => {
                  setMenuOpen(false);
                  setMuted((v) => !v);
                }}
              >
                {muted ? <IconSoundOff className="h-4 w-4" /> : <IconSoundOn className="h-4 w-4" />}
                {muted ? "Sound: off" : "Sound: on"}
              </button>
              {menuItems.map((item) => (
                <button
                  key={item.label}
                  className={`block w-full px-4 py-2.5 text-left text-sm transition hover:bg-gold/10 ${
                    item.danger ? "text-red-300 hover:bg-red-500/10" : "text-cream"
                  }`}
                  onClick={() => {
                    setMenuOpen(false);
                    item.onClick();
                  }}
                >
                  {item.label}
                </button>
              ))}
            </div>
          )}
        </div>

        <PlayerCard
          name={players[0].name}
          detail={players[0].detail}
          badge={players[0].badge}
          avatarSrc={players[0].avatarSrc}
          gameType={state.gameType}
          group={state.playerColors[0] as BallColor | null}
          score={state.scores[0]}
          state={state}
          isTurn={!state.gameOver && state.turn === 0}
          connected={players[0].connected ?? true}
        />

        {/* Spacer the floating logo sits over. */}
        <div className="w-40 xl:w-52" />

        <PlayerCard
          name={players[1].name}
          detail={players[1].detail}
          badge={players[1].badge}
          avatarSrc={players[1].avatarSrc}
          gameType={state.gameType}
          group={state.playerColors[1] as BallColor | null}
          score={state.scores[1]}
          state={state}
          isTurn={!state.gameOver && state.turn === 1}
          connected={players[1].connected ?? true}
          flip
        />

        <div className="relative justify-self-end">
          <IconButton
            icon={<IconChat />}
            active={chatOpen}
            onClick={() => setChatOpen((v) => !v)}
            disabled={!chat}
            title="Table talk"
          />
          {unread > 0 && !chatOpen && (
            <span className="absolute -right-1.5 -top-1.5 flex h-5 min-w-5 items-center justify-center rounded-full border border-emerald-deep bg-burn px-1 text-[10px] font-bold text-white shadow">
              {unread}
            </span>
          )}
        </div>
      </div>

      {/* ── main row: rails + table (+ docked chat) ── */}
      <div className="relative flex min-h-0 flex-1 items-stretch gap-2.5">
        <div className="flex w-[68px] flex-col gap-2 touch:w-[52px]">
          <RailButton label="Cues" icon={<IconCue />} disabled title="Cue skins — coming soon" />
          <RailButton
            label="Spin"
            icon={<IconSpin />}
            active={spinActive}
            onClick={() => setSpin({ x: 0, y: 0 })}
            title="Reset cue-ball spin (drag the white ball below to set it)"
          />
          <RailButton
            label="Aim"
            icon={<IconAim />}
            active={showGuide}
            onClick={() => setShowGuide((v) => !v)}
            title="Toggle the aim guide"
          />
          <div className="mt-auto">
            <SpinControl value={spin} onChange={setSpin} disabled={!interactive} />
          </div>
        </div>

        <div className="relative flex min-h-0 min-w-0 flex-1 items-center justify-center">
          <PoolCanvas
            ref={canvasRef}
            state={state}
            interactive={interactive}
            power={canShoot ? power : 0}
            onPowerChange={setPower}
            spin={spin}
            muted={muted}
            showGuide={showGuide}
            animation={animation}
            onShoot={handleShoot}
            onPlaceCueBall={onPlaceCueBall}
            onAnimationEnd={onAnimationEnd}
          />

          {clockExpiresAt != null && !state.gameOver && (
            <div className="absolute left-1/2 top-2 z-10 -translate-x-1/2">
              <ShotClock expiresAt={clockExpiresAt} />
            </div>
          )}

          {banner && (
            <div className="absolute bottom-3 left-1/2 z-10 -translate-x-1/2 rounded-lg border border-gold/60 bg-black/80 px-4 py-1.5 text-sm text-gold-bright shadow-gold-glow">
              {banner}
            </div>
          )}

          {overlay && (
            <div className="absolute inset-0 z-20 flex items-center justify-center rounded-xl bg-black/60">
              {overlay}
            </div>
          )}
        </div>

        <div className="flex w-[68px] flex-col gap-2 touch:w-[52px]">
          <div className="min-h-0 flex-1 rounded-xl border border-gold-dim/30 bg-emerald-panel/60 p-2">
            <PowerSlider
              value={power}
              disabled={!canShoot}
              onChange={setPower}
              onRelease={releasePower}
            />
          </div>
          <RailButton
            label="English"
            icon={<CueBallIcon />}
            active={spin.x !== 0}
            onClick={() => setSpin((s) => ({ ...s, x: 0 }))}
            title={`Side english: ${spin.x.toFixed(2)} — drag the white ball sideways to set; click to clear`}
          />
        </div>
      </div>

      {/* ── controls hint (pointless on touch — no keyboard/mouse) ── */}
      <p className="mt-1.5 text-center text-[10px] uppercase tracking-widest text-amber-100/40 touch:hidden">
        Aim: mouse · Power: hold click, W/S, or slider · Shoot: release, click, or Space · Spin: drag the white ball
      </p>

      {/* ── bottom bar ── */}
      <div className="mt-2 flex items-center gap-3">
        <MoneyPanel title="$DDAWGS balance" value={balanceLabel ?? "—"} icon={<TokenIcon />} plus />
        <ModeChip
          label="8 BALL"
          ballSrc="/assets/balls/ball-8.svg"
          active={state.gameType === "8ball"}
          onSelect={onSelectGameType ? () => onSelectGameType("8ball") : undefined}
        />
        <div className="flex min-w-0 flex-1 items-center justify-center overflow-hidden">
          {/* Centre plaque (the design's PLAY button frame). */}
          {centerAction ? (
            <button
              className="rounded-xl border-2 border-gold bg-black/80 px-12 py-1.5 text-center shadow-gold-glow transition hover:brightness-125"
              onClick={centerAction.onClick}
            >
              <span className="block bg-gold-sheen bg-clip-text font-display text-2xl font-extrabold tracking-[0.2em] text-transparent">
                {centerAction.label}
              </span>
              <span className="block text-[9px] uppercase tracking-[0.25em] text-gold/80">
                {GAME_LABEL[state.gameType]}
              </span>
            </button>
          ) : (
            <div className="max-w-full rounded-xl border-2 border-gold/60 bg-black/70 px-10 py-2 text-center touch:px-4 touch:py-1">
              <span className="block truncate font-display text-lg font-bold tracking-widest text-gold-bright">
                {statusText}
              </span>
            </div>
          )}
        </div>
        <ModeChip
          label="9 BALL"
          ballSrc="/assets/balls/ball-9.svg"
          active={state.gameType === "9ball"}
          onSelect={onSelectGameType ? () => onSelectGameType("9ball") : undefined}
        />
        <ModeChip
          label="SNOOKER"
          ballSrc="/assets/balls/ball-3.svg"
          active={state.gameType === "snooker"}
          onSelect={onSelectGameType ? () => onSelectGameType("snooker") : undefined}
        />
        <MoneyPanel title="Current pot" value={potLabel ?? "—"} icon={<TokenIcon />} />
      </div>

      {/* ── bottom nav: redundant with the site header on PCs, so it only
            shows on touch devices (where the header is hidden instead). ── */}
      <nav
        data-testid="shell-nav"
        className="mt-2 flex items-end justify-around border-t border-gold-dim/20 px-2 pt-2 text-[10px] uppercase tracking-[0.12em] text-cream/65 desktop:hidden"
      >
        <NavItem href="/lobby" icon={<IconHome className="h-5 w-5" />} label="Lobby" />
        <NavItem href="/leaderboard" icon={<IconTrophy className="h-5 w-5" />} label="Ranks" />
        <span className="-mt-4 flex h-12 w-12 items-center justify-center rounded-full border-2 border-gold bg-emerald-deep shadow-gold-glow">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/assets/token.svg" alt="" className="h-8 w-8" draggable={false} />
        </span>
        <NavItem icon={<IconGift className="h-5 w-5" />} label="Rewards" disabled title="Rewards — coming soon" />
        <NavItem
          icon={<IconWallet className="h-5 w-5" />}
          label="Wallet"
          onClick={() => (isConnected ? openAccountModal?.() : openConnectModal?.())}
        />
      </nav>
    </div>

    {/* Table Talk — a sliding sidebar OUTSIDE the game box, so the cloth keeps
        its full size. On wide screens it sits in the page margin; on phones it
        slides in over the table as an overlay drawer (with a backdrop). */}
    {chat && (
      <>
        {chatOpen && (
          <button
            aria-label="Close chat"
            onClick={() => setChatOpen(false)}
            className="fixed inset-0 z-40 bg-black/50 backdrop-blur-sm desktop:hidden"
          />
        )}
        <aside
          className={`fixed right-0 top-0 bottom-0 z-50 flex w-[min(20rem,88vw)] flex-col p-2 transition-transform duration-200 ease-out desktop:top-[4.25rem] desktop:bottom-4 ${
            chatOpen ? "translate-x-0" : "pointer-events-none translate-x-full"
          }`}
        >
          <Chat
            messages={chat.messages}
            myAddress={chat.myAddress}
            onSend={chat.onSend}
            onClose={() => setChatOpen(false)}
          />
        </aside>
      </>
    )}
    </>
  );
}

function NavItem({
  href,
  icon,
  label,
  onClick,
  disabled,
  title,
}: {
  href?: string;
  icon: ReactNode;
  label: string;
  onClick?: () => void;
  disabled?: boolean;
  title?: string;
}) {
  const inner = (
    <span
      className={`flex flex-col items-center gap-1 px-2 transition ${
        disabled ? "cursor-not-allowed opacity-45" : "hover:text-gold-bright"
      }`}
    >
      {icon}
      {label}
    </span>
  );
  if (href && !disabled) {
    return (
      <Link href={href} className="contents">
        {inner}
      </Link>
    );
  }
  return (
    <button type="button" onClick={disabled ? undefined : onClick} disabled={disabled} title={title}>
      {inner}
    </button>
  );
}

function CueBallIcon() {
  return (
    <span className="relative inline-block h-5 w-5 rounded-full bg-[#f5efe0] shadow-inner">
      <span className="absolute left-1/2 top-1/2 h-1.5 w-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full border border-red-800 bg-red-600" />
    </span>
  );
}

const railBase =
  "flex items-center justify-center rounded-xl border transition disabled:cursor-not-allowed disabled:opacity-40";
const railTone = (active?: boolean) =>
  active
    ? "border-gold/80 bg-gold/10 text-gold-bright shadow-gold-glow"
    : "border-gold-dim/30 bg-emerald-panel/60 text-cream/75 enabled:hover:border-gold/60 enabled:hover:bg-gold/5 enabled:hover:text-gold-bright";

/** Square icon button — top-bar menu / chat. */
function IconButton({
  icon,
  onClick,
  disabled,
  active,
  title,
}: {
  icon: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  active?: boolean;
  title?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={`${railBase} h-11 w-11 touch:h-10 touch:w-10 ${railTone(active)}`}
    >
      {icon}
    </button>
  );
}

/** Vertical rail button — icon over a tiny label. */
function RailButton({
  label,
  icon,
  onClick,
  disabled,
  active,
  title,
}: {
  label: string;
  icon: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  active?: boolean;
  title?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={`${railBase} w-full flex-col gap-1 py-2.5 touch:gap-0.5 touch:py-1.5 ${railTone(active)}`}
    >
      <span className="flex h-5 w-5 items-center justify-center">{icon}</span>
      {label && (
        <span className="text-[8px] font-semibold uppercase leading-none tracking-[0.14em] touch:hidden">
          {label}
        </span>
      )}
    </button>
  );
}

function TokenIcon() {
  // eslint-disable-next-line @next/next/no-img-element
  return <img src="/assets/token.svg" alt="" className="h-7 w-7" draggable={false} />;
}

function MoneyPanel({
  title,
  value,
  icon,
  plus,
}: {
  title: string;
  value: string;
  icon: ReactNode;
  plus?: boolean;
}) {
  return (
    <div className="flex items-center gap-2.5 rounded-xl border border-gold-dim/30 bg-emerald-panel/60 px-3.5 py-2 touch:gap-1.5 touch:px-2.5 touch:py-1.5">
      <span className="flex h-7 w-7 shrink-0 items-center justify-center">{icon}</span>
      <div className="leading-tight">
        <p className="text-[9px] uppercase tracking-[0.14em] text-cream/45">{title}</p>
        <p className="font-mono text-sm font-semibold text-gold-bright">{value}</p>
      </div>
      {plus && (
        <button
          className="ml-0.5 flex h-6 w-6 cursor-not-allowed items-center justify-center rounded-full border border-gold-dim/50 text-gold opacity-60"
          title="Buy $DDawgs — coming soon"
        >
          +
        </button>
      )}
    </div>
  );
}

function ModeChip({
  label,
  ballSrc,
  active,
  onSelect,
}: {
  label: string;
  ballSrc: string;
  active?: boolean;
  onSelect?: () => void;
}) {
  const selectable = Boolean(onSelect);
  return (
    <button
      type="button"
      disabled={!selectable}
      onClick={onSelect}
      className={`flex items-center gap-2 whitespace-nowrap rounded-xl border px-4 py-2 font-display text-sm font-bold tracking-wider transition touch:hidden ${
        active
          ? "border-gold bg-gold/10 text-gold-bright shadow-gold-glow"
          : selectable
            ? "border-gold-dim/30 bg-emerald-panel/60 text-cream/70 hover:border-gold/60 hover:text-gold-bright"
            : "cursor-not-allowed border-gold-dim/25 bg-emerald-panel/40 text-cream/40"
      }`}
      title={selectable ? `Switch to ${label}` : `${label} — coming soon`}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={ballSrc}
        alt=""
        className={`h-5 w-5 ${active ? "" : "opacity-60"}`}
        draggable={false}
      />
      {label}
    </button>
  );
}

const GAME_LABEL: Record<GameType, string> = {
  "8ball": "Pool Dawgs 8-ball",
  "9ball": "Pool Dawgs 9-ball",
  snooker: "Pool Dawgs snooker",
};
