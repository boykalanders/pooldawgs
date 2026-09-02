"use client";

import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
} from "react";
import {
  MAX_POWER,
  STEP_MS,
  cloneState,
  cueBallId,
  geomFor,
  isInsideHole,
  isOutsideBorder,
  simulateShot,
  type BallState,
  type Frame,
  type GameType,
  type ShotInput,
  type TableState,
} from "@pooldawgs/engine";
import { ballAssetPath, ballStyle, type BallLike } from "@/lib/balls";

// Geometry is per-variant (snooker's table is bigger / balls smaller). These
// module-level values are refreshed from the active variant on every render via
// setRenderGeom2(); all the draw helpers below read them, so the 2D table,
// pockets and ball sizes follow the variant automatically. Only one PoolCanvas
// is mounted at a time, so a shared singleton is safe.
let TABLE_WIDTH = geomFor("8ball").TABLE_WIDTH;
let TABLE_HEIGHT = geomFor("8ball").TABLE_HEIGHT;
let BORDER_SIZE = geomFor("8ball").BORDER_SIZE;
let BALL_SIZE = geomFor("8ball").BALL_SIZE;
let BALL_RADIUS = geomFor("8ball").BALL_RADIUS;
let HOLES = geomFor("8ball").HOLES;
// Full branded table photo (wood rails, green cushions, gold pockets, crest).
// Drawn as the whole table surface; the transform below scales/positions the
// image so its corner pockets land exactly on the engine's corner holes — so
// the felt, cushion noses and pockets all line up with the physics. The insets
// were fitted from the pockets in each image (see scratchpad/measure_pockets).
interface TableSkin {
  src: string;
  // ctx.drawImage transform (engine px) placing the photo so its corner pockets
  // land on the engine corner holes.
  dx: number;
  dy: number;
  dw: number;
  dh: number;
  // Decorative margin (engine px) around the play area, revealing the wooden
  // rails that sit just outside the table bounds. Sized to the photo's wood
  // outer edge (see scratchpad/measure_wood).
  ml: number;
  mr: number;
  mt: number;
  mb: number;
}
// Fitted so the image's CUSHION NOSES (the felt/cushion boundary — where a ball
// actually bounces) land on the engine play boundary (BORDER_SIZE inset), not
// the pockets. Aligning pockets left a ~1-ball gap at the rails. Noses + wood
// margins measured per image (scratchpad/fit_nose3, measure_wood).
const POOL_SKIN: TableSkin = {
  src: "/assets/tables/pool_table.png",
  dx: -88,
  dy: -160,
  dw: 1670,
  dh: 1187,
  ml: 33,
  mr: 39,
  mt: 26,
  mb: 64,
};
const SNOOKER_SKIN: TableSkin = {
  src: "/assets/tables/snooker_table.png",
  dx: -96,
  dy: -262,
  dw: 2252,
  dh: 1687,
  ml: 27,
  mr: 34,
  mt: 19,
  mb: 53,
};
let TABLE_SKIN = POOL_SKIN;
// The visible canvas window in engine coords: the play area plus the skin's
// rail margin. Everything is drawn in engine space, shifted by (-x0,-y0).
let VIEW = { x0: 0, y0: 0, w: geomFor("8ball").TABLE_WIDTH, h: geomFor("8ball").TABLE_HEIGHT };
function setRenderGeom2(gameType: GameType): void {
  const g = geomFor(gameType);
  TABLE_WIDTH = g.TABLE_WIDTH;
  TABLE_HEIGHT = g.TABLE_HEIGHT;
  BORDER_SIZE = g.BORDER_SIZE;
  BALL_SIZE = g.BALL_SIZE;
  BALL_RADIUS = g.BALL_RADIUS;
  HOLES = g.HOLES;
  TABLE_SKIN = gameType === "snooker" ? SNOOKER_SKIN : POOL_SKIN;
  const s = TABLE_SKIN;
  VIEW = {
    x0: -s.ml,
    y0: -s.mt,
    w: TABLE_WIDTH + s.ml + s.mr,
    h: TABLE_HEIGHT + s.mt + s.mb,
  };
}

// Sounds from the forked game's assets, cloned per play like the fork does.
const audioCache = new Map<string, HTMLAudioElement>();
function playSound(src: string, volume: number, muted: boolean | undefined): void {
  if (muted || typeof window === "undefined") return;
  let base = audioCache.get(src);
  if (!base) {
    base = new Audio(src);
    base.preload = "auto";
    audioCache.set(src, base);
  }
  const node = base.cloneNode(true) as HTMLAudioElement;
  node.volume = Math.max(0, Math.min(1, volume));
  void node.play().catch(() => {});
}

// Lazy image cache for the PNG ball/table assets; drawing falls back to
// vector rendering until an asset has loaded (or if it fails to).
const imageCache = new Map<string, HTMLImageElement>();
function getImage(src: string): HTMLImageElement | null {
  if (typeof window === "undefined") return null;
  let img = imageCache.get(src);
  if (!img) {
    img = new Image();
    img.src = src;
    imageCache.set(src, img);
  }
  return img.complete && img.naturalWidth > 0 ? img : null;
}

/** Replay frame stride (sim steps per recorded frame) and the real-time ms it
 *  represents — derived from the engine's step rate so replays stay in sync
 *  whatever PHYSICS_FPS is set to. */
const FRAME_STRIDE = 2;
const FRAME_MS = STEP_MS * FRAME_STRIDE;

export interface ShotAnimation {
  fromState: TableState;
  shot: ShotInput;
  /** Changes whenever a new animation should play. */
  key: string;
  /** Pre-simulated replay from the SAME simulation that produced the applied
   *  end state. Provided so the replay can't diverge from where the balls
   *  actually settle (the Havok backend isn't bit-identical run-to-run on its
   *  reused world, so re-simulating here would make balls jump at the end).
   *  When omitted the renderer simulates the shot itself. */
  frames?: Frame[];
  events?: import("@pooldawgs/engine").ShotEvent[];
}

export interface PoolCanvasHandle {
  /** Fire at the current aim with the given power. Returns false if refused. */
  shootNow(power: number): boolean;
}

interface PoolCanvasProps {
  state: TableState;
  /** True when this client may aim/place right now. */
  interactive: boolean;
  /** Live power (shared with the slider; drawn as cue pull-back). */
  power: number;
  /** Canvas inputs (hold-click, W/S keys) report power changes here so the
   *  slider knob mirrors them. */
  onPowerChange?: (power: number) => void;
  /** Cue-ball hit point from the spin control: screen coords, -1..1, y down. */
  spin?: { x: number; y: number };
  muted?: boolean;
  /** Show the aim line + ghost ball (the AIM rail button toggles this). */
  showGuide: boolean;
  animation?: ShotAnimation | null;
  onShoot?: (shot: ShotInput) => void;
  onPlaceCueBall?: (x: number, y: number) => void;
  onAnimationEnd?: () => void;
}

/** Hold-to-charge rate: full power in ~1.6 s. */
const CHARGE_PER_MS = MAX_POWER / 1600;
/** W/S keys: full power sweep in ~1.2 s (mirrors the fork's feel). */
const KEY_POWER_PER_MS = MAX_POWER / 1200;

const PoolCanvas = forwardRef<PoolCanvasHandle, PoolCanvasProps>(function PoolCanvas(
  {
    state,
    interactive,
    power,
    onPowerChange,
    spin,
    muted,
    showGuide,
    animation,
    onShoot,
    onPlaceCueBall,
    onAnimationEnd,
  },
  ref
) {
  // Refresh the per-variant geometry before any draw/layout/pointer math runs.
  setRenderGeom2(state.gameType);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const mouse = useRef({ x: TABLE_WIDTH / 2, y: TABLE_HEIGHT / 2 });
  const charging = useRef(false);
  /** Touch ball-in-hand: dragging a ghost cue ball, dropped on release. */
  const placingBall = useRef(false);
  const keysDown = useRef(new Set<string>());
  const lastTick = useRef(0);
  const playing = useRef<{
    frames: Frame[];
    index: number;
    startedAt: number;
    key: string;
    events: import("@pooldawgs/engine").ShotEvent[];
    eventIdx: number;
    frameStride: number;
  } | null>(null);

  // Pocket FX: when a ball is potted it scales down and drifts toward the table
  // centre, then vanishes (instead of snapping away). `lastVisible` tracks each
  // ball's last on-table spot so the drop starts from the pocket it fell into.
  const pocketFx = useRef<{
    drops: Map<number, { startedAt: number; x0: number; y0: number }>;
    lastVisible: Map<number, { x: number; y: number }>;
  }>({ drops: new Map(), lastVisible: new Map() });

  // Keep latest props in refs so the single rAF loop sees fresh values.
  const propsRef = useRef({
    state,
    interactive,
    power,
    onPowerChange,
    spin,
    muted,
    showGuide,
    onShoot,
    onPlaceCueBall,
    onAnimationEnd,
  });
  propsRef.current = {
    state,
    interactive,
    power,
    onPowerChange,
    spin,
    muted,
    showGuide,
    onShoot,
    onPlaceCueBall,
    onAnimationEnd,
  };

  // Fire at the current aim. Stable ref so window key handlers can call it.
  const shootAtAim = useRef<(shotPower: number) => boolean>(() => false);
  shootAtAim.current = (shotPower: number): boolean => {
    const {
      state: s,
      interactive: canAct,
      onShoot: shoot,
      onPowerChange: setPower,
      spin: hitPoint,
      muted: isMuted,
    } = propsRef.current;
    if (!canAct || playing.current || !shoot) return false;
    if (s.gameOver || s.ballInHand) return false;
    const cue = s.balls[cueBallId(s)];
    if (cue.inHole || shotPower <= 1) return false;
    const angle = Math.atan2(mouse.current.y - cue.y, mouse.current.x - cue.x);
    charging.current = false;
    keysDown.current.clear();
    playSound("/assets/sounds/strike.wav", shotPower / 10, isMuted);
    shoot({
      angle,
      power: shotPower,
      // Widget y grows downward; hitting BELOW centre is draw (negative spinY).
      spinX: hitPoint?.x ?? 0,
      spinY: -(hitPoint?.y ?? 0),
    });
    setPower?.(0);
    return true;
  };

  useImperativeHandle(ref, () => ({
    shootNow(shotPower: number): boolean {
      return shootAtAim.current(shotPower);
    },
  }));

  // Keyboard: W/S adjust power (handled per-frame), Space/Enter fire.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      const key = e.key.toLowerCase();
      if (key === "w" || key === "s") {
        keysDown.current.add(key);
        e.preventDefault();
      } else if (key === " " || key === "enter") {
        if (shootAtAim.current(propsRef.current.power)) e.preventDefault();
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      keysDown.current.delete(e.key.toLowerCase());
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, []);

  // Start replaying when a new animation arrives.
  useEffect(() => {
    if (!animation) return;
    if (playing.current?.key === animation.key) return;
    try {
      // Prefer the frames carried with the animation (single source of truth);
      // only simulate here if a caller didn't supply them.
      let frames = animation.frames;
      let events = animation.events;
      if (!frames) {
        const result = simulateShot(cloneState(animation.fromState), animation.shot, {
          recordFrames: true,
          frameStride: FRAME_STRIDE,
        });
        frames = result.frames ?? [];
        events = result.events;
      }
      playing.current = {
        frames: frames ?? [],
        index: 0,
        startedAt: performance.now(),
        key: animation.key,
        events: events ?? [],
        eventIdx: 0,
        frameStride: FRAME_STRIDE,
      };
      pocketFx.current.drops.clear();
      pocketFx.current.lastVisible.clear();
    } catch {
      playing.current = null; // bad animation input — just draw the end state
      propsRef.current.onAnimationEnd?.();
    }
  }, [animation]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let raf = 0;
    const loop = (now: number) => {
      updateInputPower(now);
      drawScene(ctx, propsRef.current, mouse.current, playing, pocketFx);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Apply hold-click charging and W/S power keys once per frame. */
  function updateInputPower(now: number) {
    const dt = lastTick.current ? Math.min(now - lastTick.current, 100) : 16;
    lastTick.current = now;
    const { state: s, interactive: canAct, power: current, onPowerChange: setPower } =
      propsRef.current;
    if (!setPower || !canAct || s.gameOver || s.ballInHand || playing.current) {
      charging.current = false;
      return;
    }
    let next = current;
    if (charging.current) next += dt * CHARGE_PER_MS;
    if (keysDown.current.has("w")) next += dt * KEY_POWER_PER_MS;
    if (keysDown.current.has("s")) next -= dt * KEY_POWER_PER_MS;
    next = Math.max(0, Math.min(MAX_POWER, next));
    if (next !== current) setPower(next);
  }

  function toTable(e: { clientX: number; clientY: number }): { x: number; y: number } {
    const canvas = canvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    return {
      x: VIEW.x0 + ((e.clientX - rect.left) / rect.width) * VIEW.w,
      y: VIEW.y0 + ((e.clientY - rect.top) / rect.height) * VIEW.h,
    };
  }

  function legalCuePlacement(s: TableState, x: number, y: number): boolean {
    return !isOutsideBorder(x, y) && !isInsideHole(x, y) && !overlapsBall(s, x, y);
  }

  function handlePointerDown(e: React.PointerEvent) {
    const { state: s, interactive: canAct, power: current, onPlaceCueBall: place } =
      propsRef.current;
    mouse.current = toTable(e);
    if (!canAct || playing.current) return;

    if (s.ballInHand && place) {
      if (e.pointerType === "touch") {
        // Touch: grab the ghost cue ball and DRAG it into position (a moving
        // ghost with a legal/illegal ring); it's dropped on release. Tapping a
        // precise legal spot on a small screen was the problem.
        placingBall.current = true;
        e.currentTarget.setPointerCapture(e.pointerId);
        return;
      }
      // Mouse: hover shows the ghost, a click drops it at the cursor.
      const { x, y } = mouse.current;
      if (legalCuePlacement(s, x, y)) place(x, y);
      return;
    }
    if (s.balls[cueBallId(s)].inHole || s.gameOver) return;

    if (e.pointerType === "touch") {
      // Touch: dragging the table ONLY aims — charging power with the same
      // finger you aim with is what made phone play fiddly. Shooting on touch
      // is the deliberate power-slider gesture (drag up, release). Capture so
      // aim keeps tracking even if the finger slides past the canvas edge.
      e.currentTarget.setPointerCapture(e.pointerId);
      return;
    }

    if (current > 1) {
      // Mouse with power already set (W/S or slider): a click fires.
      shootAtAim.current(current);
    } else {
      // Otherwise press-and-hold charges; release fires.
      charging.current = true;
      e.currentTarget.setPointerCapture(e.pointerId);
    }
  }

  function handlePointerUp() {
    // Touch ball-in-hand: drop the dragged cue ball at the released position
    // if it's legal (otherwise keep it in hand so the player can re-drag).
    if (placingBall.current) {
      placingBall.current = false;
      const { state: s, onPlaceCueBall: place } = propsRef.current;
      const { x, y } = mouse.current;
      if (s.ballInHand && place && legalCuePlacement(s, x, y)) place(x, y);
      return;
    }
    // Touch never charges from the canvas, so there's nothing to release here.
    if (!charging.current) return;
    charging.current = false;
    const current = propsRef.current.power;
    if (current > 1) {
      shootAtAim.current(current);
    } else {
      propsRef.current.onPowerChange?.(0);
    }
  }

  function handlePointerMove(e: React.PointerEvent) {
    // Mouse updates aim/ghost on hover; touch updates it while a finger is
    // down (aiming, or dragging the ball-in-hand ghost).
    if (e.pointerType === "touch" && e.buttons === 0 && !placingBall.current) return;
    mouse.current = toTable(e);
  }

  return (
    <canvas
      ref={canvasRef}
      width={VIEW.w}
      height={VIEW.h}
      // Scales to fit BOTH the available width and height, keeping the
      // table's aspect ratio (play area + rail margin) — no page scrolling.
      className="max-h-full max-w-full rounded-xl"
      style={{
        width: "auto",
        height: "auto",
        aspectRatio: `${VIEW.w} / ${VIEW.h}`,
        touchAction: "none",
      }}
      onPointerDown={handlePointerDown}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
      onPointerMove={handlePointerMove}
    />
  );
});

export default PoolCanvas;

// ───────────────────────────── helpers ─────────────────────────────

function overlapsBall(state: TableState, x: number, y: number): boolean {
  const cue = cueBallId(state);
  for (const ball of state.balls) {
    if (ball.id === cue || ball.inHole) continue;
    const dx = x - ball.x;
    const dy = y - ball.y;
    if (Math.sqrt(dx * dx + dy * dy) < BALL_SIZE) return true;
  }
  return false;
}

interface SceneProps {
  state: TableState;
  interactive: boolean;
  power: number;
  muted?: boolean;
  showGuide: boolean;
  onAnimationEnd?: () => void;
}

function drawScene(
  ctx: CanvasRenderingContext2D,
  props: SceneProps,
  mouse: { x: number; y: number },
  playing: React.MutableRefObject<{
    frames: Frame[];
    index: number;
    startedAt: number;
    key: string;
    events: import("@pooldawgs/engine").ShotEvent[];
    eventIdx: number;
    frameStride: number;
  } | null>,
  pocketFx: React.MutableRefObject<{
    drops: Map<number, { startedAt: number; x0: number; y0: number }>;
    lastVisible: Map<number, { x: number; y: number }>;
  }>
) {
  const { state } = props;
  // Absolute transform each frame (drawScene has early returns, so avoid
  // cumulative translate). Clear the whole canvas, then shift into engine space
  // so the rail margin around the play area is drawn.
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = "#04050a";
  ctx.fillRect(0, 0, VIEW.w, VIEW.h);
  ctx.setTransform(1, 0, 0, 1, -VIEW.x0, -VIEW.y0);
  drawTable(ctx);

  const now = performance.now();
  const POCKET_FX_MS = 300; // scale-down + drift to centre (client spec)
  const cx = TABLE_WIDTH / 2;
  const cy = TABLE_HEIGHT / 2;
  // Render the in-flight pocket drops: each potted ball scales toward nothing
  // while drifting toward the table centre, then is removed.
  const drawDrops = () => {
    for (const [id, d] of pocketFx.current.drops) {
      const age = now - d.startedAt;
      if (age >= POCKET_FX_MS) {
        pocketFx.current.drops.delete(id);
        continue;
      }
      const f = age / POCKET_FX_MS;
      const e = 1 - (1 - f) * (1 - f); // ease-out
      const x = d.x0 + (cx - d.x0) * e * 0.5; // drift up to halfway to centre
      const y = d.y0 + (cy - d.y0) * e * 0.5;
      const sc = Math.max(0.001, 1 - e); // shrink to (almost) nothing
      ctx.save();
      ctx.translate(x, y);
      ctx.scale(sc, sc);
      drawBall(ctx, 0, 0, state.balls[id]);
      ctx.restore();
    }
  };

  const anim = playing.current;
  if (anim) {
    anim.index = Math.min(anim.frames.length - 1, Math.floor((now - anim.startedAt) / FRAME_MS));

    // Fire the fork's sounds as the replay crosses each simulation event.
    const simStep = anim.index * anim.frameStride;
    while (anim.eventIdx < anim.events.length && anim.events[anim.eventIdx].step <= simStep) {
      const event = anim.events[anim.eventIdx++];
      if (event.type === "ballsCollide") {
        playSound("/assets/sounds/balls-collide.wav", 0.35, props.muted);
      } else if (event.type === "pocket") {
        playSound("/assets/sounds/hole.wav", 0.5, props.muted);
        // Kick off the scale-down/drift drop from the ball's last on-table spot.
        const lv = pocketFx.current.lastVisible.get(event.ballId);
        if (lv && !pocketFx.current.drops.has(event.ballId)) {
          pocketFx.current.drops.set(event.ballId, { startedAt: now, x0: lv.x, y0: lv.y });
        }
      } else if (event.type === "cushion") {
        playSound("/assets/sounds/side.wav", 0.15, props.muted);
      }
    }

    const frame = anim.frames[anim.index];
    if (frame) {
      for (const fb of frame.balls) {
        if (!fb.visible) continue;
        pocketFx.current.lastVisible.set(fb.id, { x: fb.x, y: fb.y });
        drawBall(ctx, fb.x, fb.y, state.balls[fb.id]);
      }
    }
    drawDrops();
    if (anim.index >= anim.frames.length - 1) {
      playing.current = null;
      props.onAnimationEnd?.();
    }
    return;
  }

  const cueIdx = cueBallId(state);
  for (const ball of state.balls) {
    if (ball.inHole) continue;
    // Ball in hand: the cue ball is lifted off the table — only the
    // placement ghost (drawn in the overlay) is visible.
    if (ball.id === cueIdx && state.ballInHand) continue;
    drawBall(ctx, ball.x, ball.y, ball);
  }
  drawDrops(); // finish any pocket FX still running after the replay ended

  drawOverlay(ctx, props, mouse);
}

function drawOverlay(
  ctx: CanvasRenderingContext2D,
  { state, interactive, power, showGuide }: SceneProps,
  mouse: { x: number; y: number }
) {
  if (!interactive || state.gameOver) return;

  const cue = state.balls[cueBallId(state)];

  if (state.ballInHand) {
    const { x, y } = mouse;
    const legal =
      !isOutsideBorder(x, y) && !isInsideHole(x, y) && !overlapsBall(state, x, y);
    ctx.save();
    ctx.globalAlpha = 0.65;
    drawBall(ctx, x, y, cue);
    ctx.globalAlpha = 1;
    ctx.beginPath();
    ctx.arc(x, y, BALL_RADIUS + 6, 0, Math.PI * 2);
    ctx.strokeStyle = legal ? "#e8c547" : "#cc2936";
    ctx.lineWidth = 3;
    ctx.stroke();
    ctx.restore();
    return;
  }

  if (cue.inHole) return;
  const angle = Math.atan2(mouse.y - cue.y, mouse.x - cue.x);

  if (showGuide) drawAimGuide(ctx, state, cue.x, cue.y, angle);
  drawCueStick(ctx, cue.x, cue.y, angle, power);
}

/** Aim line to the first contact, ghost ball there, and the object-ball tick. */
function drawAimGuide(
  ctx: CanvasRenderingContext2D,
  state: TableState,
  cx: number,
  cy: number,
  angle: number
) {
  const dx = Math.cos(angle);
  const dy = Math.sin(angle);

  // Sweep the cue ball along the aim ray; first t where it kisses a ball.
  const cueIdx = cueBallId(state);
  let bestT = Infinity;
  let hitBall: { x: number; y: number } | null = null;
  for (const ball of state.balls) {
    if (ball.id === cueIdx || ball.inHole) continue;
    const ox = ball.x - cx;
    const oy = ball.y - cy;
    const proj = ox * dx + oy * dy;
    if (proj <= 0) continue;
    const perp2 = ox * ox + oy * oy - proj * proj;
    const r = BALL_SIZE; // contact when centres are one diameter apart
    if (perp2 > r * r) continue;
    const t = proj - Math.sqrt(r * r - perp2);
    if (t > 0 && t < bestT) {
      bestT = t;
      hitBall = ball;
    }
  }

  // No ball on the line: extend to the cushion.
  let endT = bestT;
  if (!hitBall) {
    endT = Infinity;
    const minX = BORDER_SIZE + BALL_RADIUS;
    const maxX = TABLE_WIDTH - BORDER_SIZE - BALL_RADIUS;
    const minY = BORDER_SIZE + BALL_RADIUS;
    const maxY = TABLE_HEIGHT - BORDER_SIZE - BALL_RADIUS;
    if (dx > 1e-6) endT = Math.min(endT, (maxX - cx) / dx);
    if (dx < -1e-6) endT = Math.min(endT, (minX - cx) / dx);
    if (dy > 1e-6) endT = Math.min(endT, (maxY - cy) / dy);
    if (dy < -1e-6) endT = Math.min(endT, (minY - cy) / dy);
    if (!Number.isFinite(endT)) return;
  }

  const gx = cx + dx * endT;
  const gy = cy + dy * endT;

  ctx.save();
  ctx.setLineDash([8, 10]);
  ctx.strokeStyle = "rgba(245, 239, 224, 0.55)";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(cx + dx * (BALL_RADIUS + 2), cy + dy * (BALL_RADIUS + 2));
  ctx.lineTo(gx, gy);
  ctx.stroke();
  ctx.setLineDash([]);

  // Ghost cue ball at the contact point.
  ctx.beginPath();
  ctx.arc(gx, gy, BALL_RADIUS, 0, Math.PI * 2);
  ctx.strokeStyle = "rgba(232, 197, 71, 0.8)";
  ctx.lineWidth = 2;
  ctx.stroke();

  // Object ball travels along ghost-centre → ball-centre.
  if (hitBall) {
    const ox = hitBall.x - gx;
    const oy = hitBall.y - gy;
    const len = Math.sqrt(ox * ox + oy * oy) || 1;
    ctx.setLineDash([4, 8]);
    ctx.strokeStyle = "rgba(232, 197, 71, 0.5)";
    ctx.beginPath();
    ctx.moveTo(hitBall.x, hitBall.y);
    ctx.lineTo(hitBall.x + (ox / len) * 90, hitBall.y + (oy / len) * 90);
    ctx.stroke();
    ctx.setLineDash([]);
  }
  ctx.restore();
}

// stick.svg is a clean, straight cue centred on its viewBox (centreline at
// y=18 of 36), so its axis is the vertical middle and it needs no tilt.
// CUE_AXIS = fraction of the image height that lands on the aim line (raise to
// lift the cue, lower to drop it). CUE_TILT = anti-clockwise tilt in radians.
const CUE_AXIS = 0.5;
const CUE_TILT = 0;

/** The client's cue stick photo (stick.png, trimmed to its content box — see
 *  scripts/crop-stick.mjs), laid along the aim and centred on the aim line;
 *  a vector cue is drawn as a fallback until it's loaded. */
function drawCueStick(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  angle: number,
  power: number
) {
  const pullback = 26 + power * 2.4;
  const stickLen = 430;
  const tipX = cx - Math.cos(angle) * pullback;
  const tipY = cy - Math.sin(angle) * pullback;

  const stickImg = getImage("/assets/pooldawgs_ico/stick-trim.png");
  if (stickImg) {
    // Image points butt→tip left-to-right; lay it along the aim behind the cue
    // ball, offset vertically so the cue's axis (CUE_AXIS) lands on the aim line.
    const h = stickLen * (stickImg.naturalHeight / stickImg.naturalWidth);
    ctx.save();
    ctx.translate(cx, cy);
    // angle − CUE_TILT rotates the cue a touch anti-clockwise (canvas rotation
    // is clockwise-positive), aligning the head with the cue-ball centre.
    ctx.rotate(angle - CUE_TILT);
    ctx.drawImage(stickImg, -(pullback + stickLen), -CUE_AXIS * h, stickLen, h);
    ctx.restore();
    return;
  }

  const buttX = cx - Math.cos(angle) * (pullback + stickLen);
  const buttY = cy - Math.sin(angle) * (pullback + stickLen);

  ctx.save();
  ctx.lineCap = "round";

  // Shaft: near-black with a subtle sheen.
  const shaft = ctx.createLinearGradient(tipX, tipY, buttX, buttY);
  shaft.addColorStop(0, "#2b211a");
  shaft.addColorStop(0.5, "#15100c");
  shaft.addColorStop(1, "#0c0806");
  ctx.strokeStyle = shaft;
  ctx.lineWidth = 11;
  ctx.beginPath();
  ctx.moveTo(tipX, tipY);
  ctx.lineTo(buttX, buttY);
  ctx.stroke();

  // Gold ferrule at the tip and butt cap.
  ctx.strokeStyle = "#c9a227";
  ctx.lineWidth = 11;
  ctx.beginPath();
  ctx.moveTo(tipX, tipY);
  ctx.lineTo(tipX - Math.cos(angle) * 16, tipY - Math.sin(angle) * 16);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(buttX, buttY);
  ctx.lineTo(buttX + Math.cos(angle) * 22, buttY + Math.sin(angle) * 22);
  ctx.stroke();

  // Brand label along the shaft.
  const midX = (tipX + buttX) / 2;
  const midY = (tipY + buttY) / 2;
  ctx.translate(midX, midY);
  let textAngle = angle + Math.PI; // butt → tip reading direction
  if (Math.cos(textAngle) < 0) textAngle += Math.PI; // keep upright
  ctx.rotate(textAngle);
  ctx.fillStyle = "rgba(232, 197, 71, 0.9)";
  ctx.font = "bold 13px Georgia";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("POOL DAWGS", 0, 0);
  ctx.restore();
}

// ───────────────────────────── table ─────────────────────────────

function drawTable(ctx: CanvasRenderingContext2D) {
  const skin = TABLE_SKIN;
  const img = getImage(skin.src);
  if (img) {
    // The full branded photo IS the table surface — wood rails, green cushion
    // walls, gold pockets and crest — scaled/placed so its pockets sit on the
    // engine holes, so felt, cushions and pockets all match the physics.
    ctx.drawImage(img, skin.dx, skin.dy, skin.dw, skin.dh);
    return;
  }
  // Fallback until the photo loads: emerald felt + a dark hint at each pocket.
  const cloth = ctx.createRadialGradient(
    TABLE_WIDTH / 2,
    TABLE_HEIGHT / 2,
    100,
    TABLE_WIDTH / 2,
    TABLE_HEIGHT / 2,
    Math.max(TABLE_WIDTH, TABLE_HEIGHT)
  );
  cloth.addColorStop(0, "#0e4a38");
  cloth.addColorStop(1, "#0a382b");
  ctx.fillStyle = cloth;
  ctx.fillRect(0, 0, TABLE_WIDTH, TABLE_HEIGHT);
  for (const hole of HOLES) {
    ctx.beginPath();
    ctx.arc(hole.x, hole.y, hole.radius - 8, 0, Math.PI * 2);
    ctx.fillStyle = "#06060a";
    ctx.fill();
  }
}

// ───────────────────────────── balls ─────────────────────────────

function drawBall(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  ball: BallLike | BallState
) {
  const style = ballStyle(ball);
  const r = BALL_RADIUS;

  ctx.save();

  // Drop shadow.
  ctx.beginPath();
  ctx.arc(x + 2, y + 3, r, 0, Math.PI * 2);
  ctx.fillStyle = "rgba(0, 0, 0, 0.28)";
  ctx.fill();

  // Prefer the photoreal PNG ball art; any ball with no PNG falls through to
  // the vector path below, as do balls while their PNG is still loading.
  const path = ballAssetPath(ball);
  const img = path ? getImage(path) : null;
  if (img) {
    ctx.drawImage(img, x - r, y - r, r * 2, r * 2);
    ctx.restore();
    return;
  }

  // Base sphere.
  const baseColor = style.kind === "stripe" || style.kind === "cue" ? "#f5efe0" : style.color;
  const grad = ctx.createRadialGradient(x - r * 0.35, y - r * 0.4, r * 0.15, x, y, r);
  grad.addColorStop(0, lighten(baseColor));
  grad.addColorStop(1, baseColor);
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fillStyle = grad;
  ctx.fill();

  // Stripe band.
  if (style.kind === "stripe") {
    ctx.save();
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.clip();
    ctx.fillStyle = style.color;
    ctx.fillRect(x - r, y - r * 0.52, r * 2, r * 1.04);
    ctx.restore();
  }

  // Number circle.
  if (style.number !== null) {
    ctx.beginPath();
    ctx.arc(x, y, r * 0.46, 0, Math.PI * 2);
    ctx.fillStyle = "#f5efe0";
    ctx.fill();
    ctx.fillStyle = "#16120e";
    ctx.font = `bold ${Math.round(r * 0.62)}px Georgia`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(String(style.number), x, y + 0.5);
  }

  // Gloss highlight.
  ctx.beginPath();
  ctx.ellipse(x - r * 0.3, y - r * 0.45, r * 0.32, r * 0.18, -0.6, 0, Math.PI * 2);
  ctx.fillStyle = "rgba(255, 255, 255, 0.55)";
  ctx.fill();

  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.strokeStyle = "rgba(0, 0, 0, 0.35)";
  ctx.lineWidth = 1;
  ctx.stroke();

  ctx.restore();
}

function lighten(hex: string): string {
  const n = parseInt(hex.slice(1), 16);
  const r = Math.min(255, ((n >> 16) & 0xff) + 70);
  const g = Math.min(255, ((n >> 8) & 0xff) + 70);
  const b = Math.min(255, (n & 0xff) + 70);
  return `rgb(${r}, ${g}, ${b})`;
}
