"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { useAccountModal, useConnectModal } from "@rainbow-me/rainbowkit";
import { useAccount } from "wagmi";
import type { BallColor, ShotInput, TableState } from "@pooldawgs/engine";
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

  function releasePower(value: number) {
    canvasRef.current?.shootNow(value);
    setPower(0);
  }

  function handleShoot(shot: ShotInput) {
    onShoot(shot);
    setSpin({ x: 0, y: 0 });
  }

  const canShoot =
    interactive && !state.gameOver && !state.ballInHand && !state.balls[15].inHole;

  return (
    <div className="relative mx-auto flex h-[calc(100dvh-9.5rem)] min-h-[520px] w-full max-w-[1480px] select-none flex-col rounded-3xl border border-gold-dim/40 bg-black/70 p-3 shadow-2xl touch:h-[calc(100dvh-2rem)] touch:min-h-0">
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
          <RailButton label="" icon="☰" onClick={() => setMenuOpen((v) => !v)} />
          {menuOpen && (
            <div className="absolute left-0 top-14 z-30 w-48 overflow-hidden rounded-xl border border-gold-dim/50 bg-gunmetal-dark shadow-2xl">
              <button
                className="block w-full px-4 py-2.5 text-left text-sm text-amber-50 transition hover:bg-mahogany-dark"
                onClick={() => {
                  setMenuOpen(false);
                  setMuted((v) => !v);
                }}
              >
                {muted ? "🔇 Sound: off" : "🔊 Sound: on"}
              </button>
              {menuItems.map((item) => (
                <button
                  key={item.label}
                  className={`block w-full px-4 py-2.5 text-left text-sm transition hover:bg-mahogany-dark ${
                    item.danger ? "text-red-300" : "text-amber-50"
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
          group={state.playerColors[0] as BallColor | null}
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
          group={state.playerColors[1] as BallColor | null}
          state={state}
          isTurn={!state.gameOver && state.turn === 1}
          connected={players[1].connected ?? true}
          flip
        />

        <div className="relative">
          <RailButton
            label=""
            icon="💬"
            onClick={() => setChatOpen((v) => !v)}
            disabled={!chat}
          />
          {unread > 0 && !chatOpen && (
            <span className="absolute -right-1 -top-1 flex h-5 w-5 items-center justify-center rounded-full bg-burn text-[10px] font-bold text-white">
              {unread}
            </span>
          )}
        </div>
      </div>

      {/* ── main row: rails + table ── */}
      <div className="flex min-h-0 flex-1 items-stretch gap-3">
        <div className="flex w-[72px] flex-col gap-2">
          <RailButton label="Cues" icon="🎯" disabled title="Cue skins — coming soon" />
          <RailButton label="Shop" icon="🛒" disabled title="Shop — coming soon" />
          <RailButton
            label="Spin"
            icon="🌀"
            active={spinActive}
            onClick={() => setSpin({ x: 0, y: 0 })}
            title="Reset cue-ball spin (drag the white ball below to set it)"
          />
          <RailButton
            label="Aim"
            icon="✛"
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

          {chat && chatOpen && (
            <div className="absolute bottom-2 right-2 top-2 z-20 w-80 max-w-[70%]">
              <Chat
                messages={chat.messages}
                myAddress={chat.myAddress}
                onSend={chat.onSend}
              />
            </div>
          )}
        </div>

        <div className="flex w-[72px] flex-col gap-2">
          <div className="min-h-0 flex-1 rounded-xl border border-gold-dim/40 bg-gunmetal-dark/70 p-2">
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
        <ModeChip label="8 BALL" ballSrc="/assets/balls/ball-8.svg" active />
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
                Pool Dawgs 8-ball
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
        <ModeChip label="9 BALL" ballSrc="/assets/balls/ball-9.svg" />
        <ModeChip label="SNOOKER" ballSrc="/assets/balls/ball-3.svg" />
        <MoneyPanel title="Current pot" value={potLabel ?? "—"} icon={<TokenIcon />} />
      </div>

      {/* ── bottom nav: redundant with the site header on PCs, so it only
            shows on touch devices (where the header is hidden instead). ── */}
      <nav
        data-testid="shell-nav"
        className="mt-2 flex items-center justify-center gap-5 border-t border-gold-dim/20 pt-2 text-xs uppercase tracking-widest text-amber-100/70 desktop:hidden"
      >
        <Link href="/lobby" className="flex items-center gap-2 transition hover:text-gold-bright">
          🏠 Lobby
        </Link>
        <NavDivider />
        <Link href="/leaderboard" className="flex items-center gap-2 transition hover:text-gold-bright">
          🏆 Leaderboard
        </Link>
        <NavDivider />
        <span className="flex h-11 w-11 items-center justify-center rounded-full border-2 border-gold bg-mahogany-deep shadow-gold-glow">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/assets/token.svg" alt="" className="h-8 w-8" draggable={false} />
        </span>
        <NavDivider />
        <span className="flex cursor-not-allowed items-center gap-2 opacity-50" title="Rewards — coming soon">
          🎁 Rewards
        </span>
        <NavDivider />
        <button
          className="flex items-center gap-2 uppercase tracking-widest transition hover:text-gold-bright"
          onClick={() => (isConnected ? openAccountModal?.() : openConnectModal?.())}
        >
          👛 Wallet
        </button>
      </nav>
    </div>
  );
}

function NavDivider() {
  return <span className="text-gold-dim/40">|</span>;
}

function CueBallIcon() {
  return (
    <span className="relative inline-block h-5 w-5 rounded-full bg-[#f5efe0] shadow-inner">
      <span className="absolute left-1/2 top-1/2 h-1.5 w-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full border border-red-800 bg-red-600" />
    </span>
  );
}

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
      className={`flex h-12 w-full flex-col items-center justify-center rounded-xl border text-lg transition touch:h-9 touch:text-base ${
        active
          ? "border-gold bg-mahogany-dark text-gold-bright shadow-gold-glow"
          : "border-gold-dim/40 bg-gunmetal-dark/70 text-amber-100/80"
      } ${disabled ? "cursor-not-allowed opacity-40" : "hover:border-gold hover:text-gold-bright"}`}
      onClick={onClick}
      disabled={disabled}
      title={title}
    >
      <span className="leading-none">{icon}</span>
      {label && (
        <span className="mt-0.5 text-[8px] font-semibold uppercase tracking-widest touch:hidden">
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
    <div className="flex items-center gap-2 rounded-xl border border-gold-dim/40 bg-gunmetal-dark/70 px-4 py-2 touch:px-2.5 touch:py-1">
      <span className="text-xl">{icon}</span>
      <div className="leading-tight">
        <p className="text-[9px] uppercase tracking-widest text-amber-100/50">{title}</p>
        <p className="font-mono text-sm font-semibold text-gold-bright">{value}</p>
      </div>
      {plus && (
        <button
          className="ml-1 flex h-6 w-6 cursor-not-allowed items-center justify-center rounded-full border border-gold-dim/50 text-gold opacity-60"
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
}: {
  label: string;
  ballSrc: string;
  active?: boolean;
}) {
  return (
    <span
      className={`flex items-center gap-2 whitespace-nowrap rounded-xl border px-4 py-2 font-display text-sm font-bold tracking-wider touch:hidden ${
        active
          ? "gold-frame bg-black/80 text-amber-50"
          : "cursor-not-allowed border-gold-dim/30 bg-black/50 text-amber-100/40"
      }`}
      title={active ? undefined : `${label} — coming soon`}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={ballSrc}
        alt=""
        className={`h-5 w-5 ${active ? "" : "opacity-50 grayscale"}`}
        draggable={false}
      />
      {label}
    </span>
  );
}
