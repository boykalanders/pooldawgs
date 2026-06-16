"use client";

import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
} from "react";
import {
  BALL_SIZE,
  BORDER_SIZE,
  HOLES,
  MAX_POWER,
  TABLE_HEIGHT,
  TABLE_WIDTH,
  cloneState,
  cueBallId,
  isInsideHole,
  isOutsideBorder,
  simulateShot,
  type BallState,
  type Frame,
  type ShotInput,
  type TableState,
} from "@pooldawgs/engine";
import { ballAssetPath, ballStyle, type BallLike } from "@/lib/balls";

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

// Lazy image cache for the SVG assets; drawing falls back to vector
// rendering until an asset has loaded (or if it fails to).
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

const BALL_RADIUS = BALL_SIZE / 2;
/** ms per recorded frame: frameStride 2 at 100 Hz simulation = 20ms. */
const FRAME_MS = 20;

export interface ShotAnimation {
  fromState: TableState;
  shot: ShotInput;
  /** Changes whenever a new animation should play. */
  key: string;
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
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const mouse = useRef({ x: TABLE_WIDTH / 2, y: TABLE_HEIGHT / 2 });
  const charging = useRef(false);
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
      const result = simulateShot(cloneState(animation.fromState), animation.shot, {
        recordFrames: true,
        frameStride: 2,
      });
      playing.current = {
        frames: result.frames ?? [],
        index: 0,
        startedAt: performance.now(),
        key: animation.key,
        events: result.events,
        eventIdx: 0,
        frameStride: 2,
      };
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
      drawScene(ctx, propsRef.current, mouse.current, playing);
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
      x: ((e.clientX - rect.left) / rect.width) * TABLE_WIDTH,
      y: ((e.clientY - rect.top) / rect.height) * TABLE_HEIGHT,
    };
  }

  function handlePointerDown(e: React.PointerEvent) {
    const { state: s, interactive: canAct, power: current, onPlaceCueBall: place } =
      propsRef.current;
    mouse.current = toTable(e);
    if (!canAct || playing.current) return;

    if (s.ballInHand && place) {
      const { x, y } = mouse.current;
      if (!isOutsideBorder(x, y) && !isInsideHole(x, y) && !overlapsBall(s, x, y)) {
        place(x, y);
      }
      return;
    }
    if (s.balls[cueBallId(s)].inHole || s.gameOver) return;

    if (current > 1) {
      // Power already set (W/S or slider): a left click fires, like the fork.
      shootAtAim.current(current);
    } else {
      // Otherwise press-and-hold charges; release fires.
      charging.current = true;
      e.currentTarget.setPointerCapture(e.pointerId);
    }
  }

  function handlePointerUp() {
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
    mouse.current = toTable(e);
  }

  return (
    <canvas
      ref={canvasRef}
      width={TABLE_WIDTH}
      height={TABLE_HEIGHT}
      // Scales to fit BOTH the available width and height, keeping the
      // table's aspect ratio — no page scrolling at any resolution.
      className="max-h-full max-w-full rounded-xl"
      style={{
        width: "auto",
        height: "auto",
        aspectRatio: `${TABLE_WIDTH} / ${TABLE_HEIGHT}`,
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
  } | null>
) {
  const { state } = props;
  drawTable(ctx);

  const anim = playing.current;
  if (anim) {
    const elapsed = performance.now() - anim.startedAt;
    anim.index = Math.min(anim.frames.length - 1, Math.floor(elapsed / FRAME_MS));

    // Fire the fork's sounds as the replay crosses each simulation event.
    const simStep = anim.index * anim.frameStride;
    while (anim.eventIdx < anim.events.length && anim.events[anim.eventIdx].step <= simStep) {
      const event = anim.events[anim.eventIdx++];
      if (event.type === "ballsCollide") {
        playSound("/assets/sounds/balls-collide.wav", 0.35, props.muted);
      } else if (event.type === "pocket") {
        playSound("/assets/sounds/hole.wav", 0.5, props.muted);
      } else if (event.type === "cushion") {
        playSound("/assets/sounds/side.wav", 0.15, props.muted);
      }
    }

    const frame = anim.frames[anim.index];
    if (frame) {
      for (const fb of frame.balls) {
        if (!fb.visible) continue;
        drawBall(ctx, fb.x, fb.y, state.balls[fb.id]);
      }
    }
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

// The traced cue art (stick.svg, 0–100 viewBox) sits ABOVE the image's vertical
// centre — its body spans ~y26–64, centre ≈ y45. Drawing the image box centred
// on the ball therefore lifts the cue ~5% above the aim line. CUE_AXIS is the
// fraction of the image height where the cue's centreline sits, so we offset
// the draw to put the cue ON the aim line. Lower = cue sits higher; raise it
// if the cue still looks low.
const CUE_AXIS = 0.45;

/** The client's traced cue (stick.svg), laid along the aim and centred on the
 *  aim line; a vector cue is drawn as a fallback until the SVG has loaded. */
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

  const stickImg = getImage("/assets/stick.svg");
  if (stickImg) {
    // Image points butt→tip left-to-right; lay it along the aim behind the cue
    // ball, offset vertically so the cue's axis (CUE_AXIS) lands on the aim line.
    const h = stickLen * (stickImg.naturalHeight / stickImg.naturalWidth);
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(angle);
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
  // Dark wood frame.
  const wood = ctx.createLinearGradient(0, 0, TABLE_WIDTH, TABLE_HEIGHT);
  wood.addColorStop(0, "#3b2417");
  wood.addColorStop(0.5, "#2a160c");
  wood.addColorStop(1, "#1a0d06");
  ctx.fillStyle = wood;
  ctx.fillRect(0, 0, TABLE_WIDTH, TABLE_HEIGHT);

  // Wood grain hint: faint long streaks.
  ctx.strokeStyle = "rgba(0, 0, 0, 0.18)";
  ctx.lineWidth = 2;
  for (let i = 0; i < 8; i++) {
    const y = (TABLE_HEIGHT / 8) * i + 12;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.bezierCurveTo(TABLE_WIDTH * 0.3, y + 6, TABLE_WIDTH * 0.7, y - 6, TABLE_WIDTH, y);
    ctx.stroke();
  }

  // Outer + inner gold trim.
  ctx.strokeStyle = "#8a6d1d";
  ctx.lineWidth = 6;
  ctx.strokeRect(3, 3, TABLE_WIDTH - 6, TABLE_HEIGHT - 6);
  ctx.strokeStyle = "#c9a227";
  ctx.lineWidth = 3;
  ctx.strokeRect(
    BORDER_SIZE - 8,
    BORDER_SIZE - 8,
    TABLE_WIDTH - 2 * BORDER_SIZE + 16,
    TABLE_HEIGHT - 2 * BORDER_SIZE + 16
  );

  // Gold filigree corner braces.
  drawCornerBrace(ctx, 8, 8, 1, 1);
  drawCornerBrace(ctx, TABLE_WIDTH - 8, 8, -1, 1);
  drawCornerBrace(ctx, 8, TABLE_HEIGHT - 8, 1, -1);
  drawCornerBrace(ctx, TABLE_WIDTH - 8, TABLE_HEIGHT - 8, -1, -1);

  // Emerald cloth.
  const cloth = ctx.createRadialGradient(
    TABLE_WIDTH / 2,
    TABLE_HEIGHT / 2,
    100,
    TABLE_WIDTH / 2,
    TABLE_HEIGHT / 2,
    900
  );
  cloth.addColorStop(0, "#0e4a38");
  cloth.addColorStop(1, "#0a382b");
  ctx.fillStyle = cloth;
  ctx.fillRect(
    BORDER_SIZE,
    BORDER_SIZE,
    TABLE_WIDTH - 2 * BORDER_SIZE,
    TABLE_HEIGHT - 2 * BORDER_SIZE
  );

  drawWatermark(ctx);

  // Baulk line + head spot, subtle.
  ctx.strokeStyle = "rgba(245, 239, 224, 0.1)";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(413, BORDER_SIZE);
  ctx.lineTo(413, TABLE_HEIGHT - BORDER_SIZE);
  ctx.stroke();

  // Rail sights (gold diamonds).
  ctx.fillStyle = "rgba(232, 197, 71, 0.85)";
  for (let i = 1; i <= 7; i++) {
    const x = (TABLE_WIDTH / 8) * i;
    if (Math.abs(x - 750) > 40) {
      drawDiamond(ctx, x, BORDER_SIZE / 2);
      drawDiamond(ctx, x, TABLE_HEIGHT - BORDER_SIZE / 2);
    }
  }
  for (let i = 1; i <= 3; i++) {
    const y = (TABLE_HEIGHT / 4) * i;
    drawDiamond(ctx, BORDER_SIZE / 2, y);
    drawDiamond(ctx, TABLE_WIDTH - BORDER_SIZE / 2, y);
  }

  // Paw prints walking the rails between the sights (design detail).
  for (let i = 0; i < 8; i++) {
    const x = (TABLE_WIDTH / 8) * i + TABLE_WIDTH / 16;
    drawPaw(ctx, x, BORDER_SIZE / 2, 9, "rgba(201, 162, 39, 0.35)");
    drawPaw(ctx, x, TABLE_HEIGHT - BORDER_SIZE / 2, 9, "rgba(201, 162, 39, 0.35)");
  }

  // Pockets: deep black with double gold rims and a soft glow.
  for (const hole of HOLES) {
    ctx.save();
    ctx.shadowColor = "rgba(232, 197, 71, 0.3)";
    ctx.shadowBlur = 16;
    ctx.beginPath();
    ctx.arc(hole.x, hole.y, hole.radius - 8, 0, Math.PI * 2);
    ctx.fillStyle = "#06060a";
    ctx.fill();
    ctx.restore();
    ctx.beginPath();
    ctx.arc(hole.x, hole.y, hole.radius - 8, 0, Math.PI * 2);
    ctx.strokeStyle = "rgba(201, 162, 39, 0.7)";
    ctx.lineWidth = 3;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(hole.x, hole.y, hole.radius - 2, 0, Math.PI * 2);
    ctx.strokeStyle = "rgba(138, 109, 29, 0.45)";
    ctx.lineWidth = 2;
    ctx.stroke();
  }
}

function drawCornerBrace(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  sx: number,
  sy: number
) {
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(sx, sy);
  ctx.strokeStyle = "rgba(201, 162, 39, 0.8)";
  ctx.lineWidth = 3;
  for (const r of [26, 36]) {
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, Math.PI / 2);
    ctx.stroke();
  }
  // Small scroll curls at the brace ends.
  ctx.beginPath();
  ctx.arc(44, 6, 5, 0, Math.PI * 1.5);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(6, 44, 5, Math.PI / 2, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}

/** The client's dawg-head watermark (watermark.svg), inked low-alpha onto the
 *  cloth; arc-text vector fallback while it loads. */
function drawWatermark(ctx: CanvasRenderingContext2D) {
  const cx = TABLE_WIDTH / 2;
  const cy = TABLE_HEIGHT / 2;

  const img = getImage("/assets/watermark.svg");
  if (img) {
    const w = 700;
    const h = w * (img.naturalHeight / img.naturalWidth);
    ctx.save();
    // Multiply inks the line art into the cloth like a real table stencil.
    ctx.globalAlpha = 0.45;
    ctx.globalCompositeOperation = "multiply";
    ctx.drawImage(img, cx - w / 2, cy - h / 2, w, h);
    ctx.restore();
    return;
  }

  ctx.save();
  ctx.fillStyle = "rgba(6, 48, 36, 0.9)";
  drawArcText(ctx, "★ POOL ★", cx, cy + 40, 200, true, "bold 64px Georgia");
  drawArcText(ctx, "★ DAWGS ★", cx, cy - 40, 200, false, "bold 64px Georgia");
  drawPaw(ctx, cx, cy, 46, "rgba(6, 48, 36, 0.9)");
  ctx.restore();
}

function drawArcText(
  ctx: CanvasRenderingContext2D,
  text: string,
  cx: number,
  cy: number,
  radius: number,
  top: boolean,
  font: string
) {
  ctx.save();
  ctx.font = font;
  ctx.textAlign = "center";
  ctx.textBaseline = top ? "bottom" : "top";
  const total = text.length;
  const arc = Math.PI * 0.55; // total angular spread
  for (let i = 0; i < total; i++) {
    const frac = total === 1 ? 0.5 : i / (total - 1);
    const theta = top
      ? -Math.PI / 2 + (frac - 0.5) * arc
      : Math.PI / 2 - (frac - 0.5) * arc;
    const x = cx + Math.cos(theta) * radius;
    const y = cy + Math.sin(theta) * radius;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(top ? theta + Math.PI / 2 : theta - Math.PI / 2);
    ctx.fillText(text[i], 0, 0);
    ctx.restore();
  }
  ctx.restore();
}

function drawPaw(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  size: number,
  color: string
) {
  ctx.save();
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.ellipse(x, y + size * 0.25, size * 0.62, size * 0.5, 0, 0, Math.PI * 2);
  ctx.fill();
  const toes: Array<[number, number]> = [
    [-0.62, -0.35],
    [-0.22, -0.62],
    [0.22, -0.62],
    [0.62, -0.35],
  ];
  for (const [tx, ty] of toes) {
    ctx.beginPath();
    ctx.arc(x + tx * size, y + ty * size, size * 0.21, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

function drawDiamond(ctx: CanvasRenderingContext2D, x: number, y: number) {
  ctx.beginPath();
  ctx.moveTo(x, y - 7);
  ctx.lineTo(x + 5, y);
  ctx.lineTo(x, y + 7);
  ctx.lineTo(x - 5, y);
  ctx.closePath();
  ctx.fill();
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

  // Prefer the generated SVG ball art; snooker balls (no SVG) fall through
  // to the vector path below, as do pool balls while their SVG loads.
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
