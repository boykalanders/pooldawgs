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
import { ballAssetByNumber, ballStyle } from "@/lib/balls";
import { targetBall, targetLabel, type Target } from "@/lib/target";
import dynamic from "next/dynamic";
import PoolCanvas, {
  type PoolCanvasHandle,
  type ShotAnimation,
} from "@/components/PoolCanvas";
// Babylon is heavy + browser-only — load the 3D table on demand.
const PoolTable3D = dynamic(() => import("@/components/PoolTable3D"), { ssr: false });
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
  /** "3d" swaps the 2D canvas for the Babylon 3D table (same controls). */
  renderer?: "2d" | "3d";
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
  renderer = "2d",
  animation,
  onShoot,
  onPlaceCueBall,
  onAnimationEnd,
  chat,
  overlay,
}: GameShellProps) {
  // One handle for both renderers (PoolCanvasHandle and PoolTable3DHandle are
  // the same shape): PoolCanvas takes it as `ref`, PoolTable3D as `apiRef`.
  const canvasRef = useRef<PoolCanvasHandle | null>(null);
  const [power, setPower] = useState(0);
  const [spin, setSpin] = useState<SpinValue>({ x: 0, y: 0 });
  const [muted, setMuted] = useState(false);
  const [showGuide, setShowGuide] = useState(true);
  const [menuOpen, setMenuOpen] = useState(false);
  // Mobile-only game-type picker (the desktop bottom-bar chips are hidden on
  // phones), anchored to a rail button below Aim.
  const [gameMenuOpen, setGameMenuOpen] = useState(false);
  // Collapse the desktop bottom bar (balance / mode chips / status / pot) to
  // give the pool table more room — toggled from the top-left menu.
  const [barCollapsed, setBarCollapsed] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  const [unread, setUnread] = useState(0);
  const seenCount = useRef(0);
  const spinActive = spin.x !== 0 || spin.y !== 0;

  // Fullscreen (Golden Spec: "feels like an app" in fullscreen mobile browsers).
  const [isFullscreen, setIsFullscreen] = useState(false);
  useEffect(() => {
    const onFs = () => setIsFullscreen(typeof document !== "undefined" && !!document.fullscreenElement);
    document.addEventListener("fullscreenchange", onFs);
    return () => document.removeEventListener("fullscreenchange", onFs);
  }, []);
  const toggleFullscreen = () => {
    if (typeof document === "undefined") return;
    if (document.fullscreenElement) void document.exitFullscreen?.();
    else void document.documentElement.requestFullscreen?.().catch(() => {});
  };

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
    <div
      className="relative mx-auto flex h-[calc(100dvh-9.5rem)] min-h-[520px] w-full max-w-[1480px] select-none flex-col rounded-3xl border border-gold-dim/40 bg-emerald-deep/85 shadow-2xl shadow-felt-inset touch:h-[calc(100dvh-2rem)] touch:min-h-0"
      style={{
        // Safe-area aware padding so the UI clears notches in fullscreen /
        // landscape (Golden Spec), and falls back to the normal 0.75rem inset.
        paddingTop: "max(0.75rem, env(safe-area-inset-top))",
        paddingRight: "max(0.75rem, env(safe-area-inset-right))",
        paddingBottom: "max(0.75rem, env(safe-area-inset-bottom))",
        paddingLeft: "max(0.75rem, env(safe-area-inset-left))",
      }}
    >
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
            <>
              {/* Mobile: dim, near-transparent backdrop so the menu reads as a
                  popup; tap anywhere outside to dismiss. (Desktop keeps the
                  plain anchored dropdown.) */}
              <div
                className="fixed inset-0 z-20 hidden bg-black/30 backdrop-blur-[1px] touch:block"
                onClick={() => setMenuOpen(false)}
                aria-hidden
              />
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
              <button
                className="flex w-full items-center gap-2.5 px-4 py-2.5 text-left text-sm text-cream transition hover:bg-gold/10"
                onClick={() => {
                  setMenuOpen(false);
                  toggleFullscreen();
                }}
              >
                <span className="inline-flex h-4 w-4 items-center justify-center text-gold">⛶</span>
                {isFullscreen ? "Exit fullscreen" : "Fullscreen"}
              </button>
              {/* Desktop only: phones already drop the bottom bar. */}
              <button
                className="hidden w-full items-center gap-2.5 px-4 py-2.5 text-left text-sm text-cream transition hover:bg-gold/10 desktop:flex"
                onClick={() => {
                  setMenuOpen(false);
                  setBarCollapsed((v) => !v);
                }}
              >
                <span className="inline-flex h-4 w-4 items-center justify-center text-gold">
                  {barCollapsed ? "▴" : "▾"}
                </span>
                {barCollapsed ? "Show bottom bar" : "Hide bottom bar (bigger table)"}
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

              {/* Touch only: the bottom nav is hidden on phones to give the
                  table the whole screen, so its destinations live here. */}
              <div className="hidden border-t border-gold-dim/20 touch:block">
                <Link
                  href="/lobby"
                  className="flex w-full items-center gap-2.5 px-4 py-2.5 text-left text-sm text-cream transition hover:bg-gold/10"
                  onClick={() => setMenuOpen(false)}
                >
                  <IconHome className="h-4 w-4" /> Lobby
                </Link>
                <Link
                  href="/leaderboard"
                  className="flex w-full items-center gap-2.5 px-4 py-2.5 text-left text-sm text-cream transition hover:bg-gold/10"
                  onClick={() => setMenuOpen(false)}
                >
                  <IconTrophy className="h-4 w-4" /> Leaderboard
                </Link>
                <span className="flex w-full cursor-not-allowed items-center gap-2.5 px-4 py-2.5 text-left text-sm text-cream/40">
                  <IconGift className="h-4 w-4" /> Rewards — soon
                </span>
                <button
                  className="flex w-full items-center gap-2.5 px-4 py-2.5 text-left text-sm text-cream transition hover:bg-gold/10"
                  onClick={() => {
                    setMenuOpen(false);
                    isConnected ? openAccountModal?.() : openConnectModal?.();
                  }}
                >
                  <IconWallet className="h-4 w-4" /> Wallet
                </button>
              </div>
              </div>
            </>
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
          {/* Game-type switch — phones only (desktop uses the bottom-bar chips,
              which are hidden on touch). Tapping opens a small picker. */}
          {onSelectGameType && (
            <div className="relative hidden touch:block">
              <RailButton
                label="Game"
                icon={
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={GAME_BALL[state.gameType]} alt="" className="h-5 w-5" draggable={false} />
                }
                active={gameMenuOpen}
                onClick={() => setGameMenuOpen((v) => !v)}
                title="Change game type"
              />
              {gameMenuOpen && (
                <div className="absolute left-full top-0 z-30 ml-2 w-36 overflow-hidden rounded-xl border border-gold-dim/40 bg-emerald-panel shadow-2xl">
                  {(
                    [
                      ["8ball", "8 Ball"],
                      ["9ball", "9 Ball"],
                      ["snooker", "Snooker"],
                    ] as const
                  ).map(([type, label]) => (
                    <button
                      key={type}
                      className={`flex w-full items-center gap-2.5 px-3 py-2.5 text-left text-sm transition hover:bg-gold/10 ${
                        state.gameType === type ? "bg-gold/10 text-gold-bright" : "text-cream"
                      }`}
                      onClick={() => {
                        setGameMenuOpen(false);
                        onSelectGameType(type);
                      }}
                    >
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={GAME_BALL[type]} alt="" className="h-4 w-4" draggable={false} />
                      {label}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
          <div className="mt-auto">
            <SpinControl value={spin} onChange={setSpin} disabled={!interactive} />
          </div>
        </div>

        <div className="relative flex min-h-0 min-w-0 flex-1 items-center justify-center">
          {renderer === "3d" ? (
            <PoolTable3D
              key={`3d-${state.gameType}`} // remount to rebuild for the variant's table size
              apiRef={canvasRef}
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
          ) : (
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
          )}

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

      {/* ── controls hint (desktop only — touch declutters to the nav; also
            hidden when the bottom bar is collapsed for a bigger table) ── */}
      <p
        className={`mt-1.5 text-center text-[10px] uppercase tracking-widest text-amber-100/40 touch:hidden ${
          barCollapsed ? "hidden" : ""
        }`}
      >
        Aim: mouse · Power: hold click, W/S, or slider · Shoot: release, click, or Space · Spin: drag the white ball
      </p>

      {/* ── bottom bar — hidden on touch (phones use the compact nav below);
            collapsible on desktop from the top-left menu to grow the table. ── */}
      <div className={`mt-2 items-center gap-3 touch:hidden ${barCollapsed ? "hidden" : "flex"}`}>
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
            <div
              className={`flex max-w-full items-center gap-3 rounded-xl border-2 px-6 py-1.5 text-center transition touch:gap-2 touch:px-3 ${
                interactive
                  ? "border-gold bg-gold/15 shadow-gold-glow"
                  : "border-gold/40 bg-black/70"
              }`}
            >
              {!state.gameOver && <TargetBadge target={targetBall(state)} />}
              <div className="min-w-0">
                <span className="block truncate font-display text-base font-bold tracking-widest text-gold-bright">
                  {statusText}
                </span>
                {!state.gameOver && targetBall(state) && (
                  <span className="block text-[10px] font-semibold uppercase tracking-[0.18em] text-amber-100/70">
                    {targetLabel(targetBall(state))}
                  </span>
                )}
              </div>
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

      {/* On phones there is NO bottom nav — it lived here and is now in the
          top-left menu, so the table gets the whole screen. Whose turn it is
          stays clear from the glowing player card up top. The shell-nav marker
          is kept (hidden) so existing checks can assert it's not shown. */}
      <span data-testid="shell-nav" className="hidden" />
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

/** Visual of the ball the shooter must hit first — numbered ball (9-ball) or a
 *  coloured disc (snooker). Renders nothing for 8-ball (player cards show it). */
function TargetBadge({ target }: { target: Target }) {
  if (!target) return null;
  if (target.kind === "number") {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={ballAssetByNumber(target.number)}
        alt={`${target.number} ball`}
        className="h-9 w-9 shrink-0 drop-shadow-[0_2px_4px_rgba(0,0,0,0.6)] touch:h-7 touch:w-7"
        draggable={false}
      />
    );
  }
  if (target.kind === "colour") {
    return (
      <span
        title="Any colour"
        className="h-7 w-7 shrink-0 rounded-full border-2 border-white/40 shadow touch:h-6 touch:w-6"
        style={{
          background: "conic-gradient(#e8c33a,#1f7a3d,#7a4a1e,#1f4fd8,#e87fa6,#15151a,#e8c33a)",
        }}
      />
    );
  }
  const color = target.kind === "red" ? "#c0202a" : ballStyle({ color: target.color, number: 0 }).color;
  return (
    <span
      className="h-7 w-7 shrink-0 rounded-full border-2 border-white/40 shadow touch:h-6 touch:w-6"
      style={{ background: color }}
    />
  );
}

const GAME_LABEL: Record<GameType, string> = {
  "8ball": "Pool Dawgs 8-ball",
  "9ball": "Pool Dawgs 9-ball",
  snooker: "Pool Dawgs snooker",
};

/** Representative ball icon per variant (matches the bottom-bar mode chips). */
const GAME_BALL: Record<GameType, string> = {
  "8ball": "/assets/balls/ball-8.svg",
  "9ball": "/assets/balls/ball-9.svg",
  snooker: "/assets/balls/ball-3.svg",
};
