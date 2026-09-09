import {
  BACK_SPIN,
  MAX_POWER,
  MAX_STEPS,
  MAX_SUBSTEPS,
  PHYSICS_VERSION,
  SIDE_ENGLISH,
  SPIN_DECAY,
  SPIN_SIDE_DECAY,
  SPIN_TRANSFER,
  STATIC_STOP_STEPS,
  STEP_MS,
  TOP_SPIN,
} from "./constants.js";
import { G, setActiveGeometry } from "./geometry.js";
import { isInsideHole, isOutsideBorder, shootBall, stepWorld } from "./physics.js";
import { getRules } from "./variants/index.js";
import type {
  BallColor,
  BallState,
  Frame,
  GameRules,
  GameType,
  ShotEvent,
  ShotInput,
  ShotResult,
  TableState,
} from "./types.js";

/**
 * The cue ball is always the LAST ball in the rack, across every variant.
 * Use cueBallId(state) rather than a fixed constant.
 */
export function cueBallId(state: TableState): number {
  return state.balls.length - 1;
}

/** Back-compat: the 8-ball cue id. Prefer cueBallId(state). */
export const CUE_BALL_ID = 15;

export function createInitialState(gameType: GameType = "8ball"): TableState {
  return getRules(gameType).createInitialState();
}

export function cloneState(state: TableState): TableState {
  return {
    gameType: state.gameType,
    balls: state.balls.map((b) => ({ ...b })),
    turn: state.turn,
    ballInHand: state.ballInHand,
    gameOver: state.gameOver,
    winner: state.winner,
    playerColors: [state.playerColors[0], state.playerColors[1]],
    scores: [state.scores[0], state.scores[1]],
    onColor: state.onColor,
    broken: state.broken,
  };
}

export function cueBall(state: TableState): BallState {
  return state.balls[cueBallId(state)];
}

export interface SimulateOptions {
  /** Record animation frames every `frameStride` steps (default 2 = 50 fps). */
  recordFrames?: boolean;
  frameStride?: number;
}

export interface ShotValidation {
  ok: boolean;
  reason?: string;
}

export function validateShot(state: TableState, shot: ShotInput): ShotValidation {
  if (state.gameOver) return { ok: false, reason: "game over" };
  if (!Number.isFinite(shot.angle) || !Number.isFinite(shot.power)) {
    return { ok: false, reason: "invalid input" };
  }
  if (shot.power <= 0 || shot.power > MAX_POWER) {
    return { ok: false, reason: `power must be in (0, ${MAX_POWER}]` };
  }
  for (const spin of [shot.spinX, shot.spinY]) {
    if (spin !== undefined && (!Number.isFinite(spin) || Math.abs(spin) > 1)) {
      return { ok: false, reason: "spin must be within [-1, 1]" };
    }
  }
  // After ANY foul the cue ball is in hand (off the table) — it must be
  // placed before the next shot.
  if (state.ballInHand || cueBall(state).inHole) {
    return { ok: false, reason: "ball in hand — place the cue ball first" };
  }
  return { ok: true };
}

/**
 * Pluggable physics backend. By default `simulateShot` runs the built-in
 * deterministic TS engine (below). The server (and the web in practice mode)
 * can inject the Havok backend via setSimulator(simulateShotHavok) AFTER
 * awaiting initHavok(). Keeping the injection here means this module never
 * imports Babylon/Havok, so consumers that stay on the TS engine don't pay
 * the bundle cost.
 */
export type SimulatorFn = (
  state: TableState,
  shot: ShotInput,
  opts?: SimulateOptions
) => ShotResult;

let injectedSimulator: SimulatorFn | null = null;

export function setSimulator(fn: SimulatorFn | null): void {
  injectedSimulator = fn;
}

export function activeBackend(): "ts" | "custom" {
  return injectedSimulator ? "custom" : "ts";
}

/**
 * Authoritatively simulate one shot to settle. Pure: the input state is not
 * mutated. Dispatches to the injected backend (Havok) when set, else the
 * built-in deterministic TS engine.
 */
export function simulateShot(
  state: TableState,
  shot: ShotInput,
  opts: SimulateOptions = {}
): ShotResult {
  if (injectedSimulator) return injectedSimulator(state, shot, opts);
  const valid = validateShot(state, shot);
  if (!valid.ok) throw new Error(`illegal shot: ${valid.reason}`);

  const next = cloneState(state);
  setActiveGeometry(next.gameType); // select this variant's table/ball geometry
  const rules: GameRules<unknown> = getRules(next.gameType);
  const turnAcc = rules.createTurn();
  const events: ShotEvent[] = [];
  const frames: Frame[] | undefined = opts.recordFrames ? [] : undefined;
  const frameStride = opts.frameStride ?? 2;
  const cueIdx = cueBallId(next);

  // Spin context (deterministic; runs identically on server and client).
  const spinCtx: {
    followSpin: number;
    sideSpin: number;
    firstContactDone: boolean;
    pendingFollow: { dx: number; dy: number; speed: number } | null;
  } = {
    followSpin: shot.spinY ?? 0,
    sideSpin: shot.spinX ?? 0,
    firstContactDone: false,
    pendingFollow: null,
  };

  const hooks = {
    onBallsCollide: (a: BallState, b: BallState) => {
      if (!spinCtx.firstContactDone && (a.id === cueIdx || b.id === cueIdx)) {
        spinCtx.firstContactDone = true;
        const cue = a.id === cueIdx ? a : b;
        const obj = a.id === cueIdx ? b : a;
        const speed = Math.sqrt(cue.vx * cue.vx + cue.vy * cue.vy);
        if (spinCtx.followSpin !== 0 && speed > 1e-9) {
          spinCtx.pendingFollow = { dx: cue.vx / speed, dy: cue.vy / speed, speed };
        }
        // Spin transfer / "throw": side english nudges the object ball
        // sideways off the contact tangent (spec §8 SPIN_TRANSFER).
        if (spinCtx.sideSpin !== 0 && speed > 1e-9) {
          const ndx = obj.x - cue.x;
          const ndy = obj.y - cue.y;
          const nd = Math.sqrt(ndx * ndx + ndy * ndy) || 1;
          const tx = -ndy / nd;
          const ty = ndx / nd;
          const throwMag = SPIN_TRANSFER * spinCtx.sideSpin * speed;
          obj.vx += tx * throwMag;
          obj.vy += ty * throwMag;
          obj.moving = true;
        }
      }
      rules.onBallsCollide(next, turnAcc, a, b);
    },
    onPocket: (ball: BallState) => rules.onPocket(next, turnAcc, ball),
  };

  shootBall(cueBall(next), shot.power, shot.angle);

  let steps = 0;
  let anyMoving = true;
  /** Per-ball slow-step counters backing the static stop (spec §4.3). */
  const stopCounts: number[] = new Array(next.balls.length).fill(0);
  // telemetry (spec §13)
  let maxSpeed = 0;
  let maxPenetration = 0;
  while (anyMoving && steps < MAX_STEPS) {
    const cue = cueBall(next);
    const preVx = cue.vx;
    const preVy = cue.vy;
    const eventsBefore = events.length;

    anyMoving = stepWorld(next.balls, steps, events, hooks, stopCounts);

    for (const b of next.balls) {
      if (b.inHole) continue;
      const s = Math.sqrt(b.vx * b.vx + b.vy * b.vy);
      if (s > maxSpeed) maxSpeed = s;
    }
    for (let i = 0; i < next.balls.length; i++) {
      const a = next.balls[i];
      if (a.inHole) continue;
      for (let j = i + 1; j < next.balls.length; j++) {
        const b = next.balls[j];
        if (b.inHole) continue;
        const pen = G.BALL_SIZE - Math.hypot(a.x - b.x, a.y - b.y);
        if (pen > maxPenetration) maxPenetration = pen;
      }
    }

    // Follow/draw: one-shot impulse along the pre-contact direction. Follow
    // (top) and draw (back) have distinct authority (spec §8).
    const follow = spinCtx.pendingFollow;
    if (follow && !cue.inHole) {
      const factor = spinCtx.followSpin >= 0 ? TOP_SPIN : BACK_SPIN;
      const boost = spinCtx.followSpin * factor * follow.speed;
      cue.vx += follow.dx * boost;
      cue.vy += follow.dy * boost;
      if (Math.abs(cue.vx) >= 1 || Math.abs(cue.vy) >= 1) {
        cue.moving = true;
        anyMoving = true;
      }
      spinCtx.pendingFollow = null;
      spinCtx.followSpin = 0;
    }

    // Side english: bend the cue ball's cushion rebounds, decaying per bounce.
    if (spinCtx.sideSpin !== 0 && !cue.inHole) {
      for (let i = eventsBefore; i < events.length; i++) {
        const event = events[i];
        if (event.type !== "cushion" || event.ballId !== cueIdx) continue;
        const flippedX = preVx !== 0 && Math.sign(cue.vx) !== Math.sign(preVx);
        const flippedY = preVy !== 0 && Math.sign(cue.vy) !== Math.sign(preVy);
        if (flippedX) cue.vy += spinCtx.sideSpin * SIDE_ENGLISH * Math.abs(preVx);
        if (flippedY) cue.vx -= spinCtx.sideSpin * SIDE_ENGLISH * Math.abs(preVy);
        if (flippedX || flippedY) spinCtx.sideSpin *= SPIN_SIDE_DECAY;
        break;
      }
    }

    // Spin dissipates as the cue rolls (spec §8: spin *= 0.985 per frame).
    spinCtx.followSpin *= SPIN_DECAY;
    spinCtx.sideSpin *= SPIN_DECAY;

    steps++;
    if (frames && steps % frameStride === 0) {
      frames.push(snapshotFrame(next, steps));
    }
  }
  if (frames) frames.push(snapshotFrame(next, steps));

  const resolution = rules.resolve(next, turnAcc);

  next.gameOver = resolution.gameOver;
  next.winner = resolution.winner;
  next.turn = resolution.nextTurn;
  next.ballInHand = resolution.ballInHand;

  const settleCapped = steps >= MAX_STEPS;
  const flags: string[] = [];
  if (maxPenetration > 0.1 * G.BALL_SIZE) flags.push("deep-penetration");
  if (settleCapped) flags.push("settle-cap-reached");

  return {
    endState: next,
    events,
    outcome: resolution,
    frames,
    steps,
    physicsVersion: PHYSICS_VERSION,
    diagnostics: {
      physicsVersion: PHYSICS_VERSION,
      backend: "ts",
      gameType: next.gameType,
      maxSpeed,
      maxPenetration: Math.max(0, maxPenetration),
      ballCollisions: events.filter((e) => e.type === "ballsCollide").length,
      cushionContacts: events.filter((e) => e.type === "cushion").length,
      pockets: events.filter((e) => e.type === "pocket").length,
      maxSubsteps: MAX_SUBSTEPS,
      steps,
      settleSeconds: (steps * STEP_MS) / 1000,
      staticStops: stopCounts.filter((c) => c >= STATIC_STOP_STEPS).length,
      settleCapped,
      flags,
    },
  };
}

/**
 * Ball-in-hand placement, validated server-side. Mutates and returns a clone.
 */
export function placeCueBall(
  state: TableState,
  x: number,
  y: number
): { ok: true; state: TableState } | { ok: false; reason: string } {
  if (state.gameOver) return { ok: false, reason: "game over" };
  if (!state.ballInHand) return { ok: false, reason: "no ball in hand" };
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    return { ok: false, reason: "invalid position" };
  }
  setActiveGeometry(state.gameType); // border/hole/overlap checks are per-variant
  if (isOutsideBorder(x, y)) return { ok: false, reason: "outside borders" };
  if (isInsideHole(x, y)) return { ok: false, reason: "inside a pocket" };

  const cueIdx = cueBallId(state);
  for (const ball of state.balls) {
    if (ball.id === cueIdx || ball.inHole) continue;
    const dx = x - ball.x;
    const dy = y - ball.y;
    if (Math.sqrt(dx * dx + dy * dy) < G.BALL_SIZE) {
      return { ok: false, reason: "overlaps another ball" };
    }
  }

  const next = cloneState(state);
  const cue = cueBall(next);
  cue.x = x;
  cue.y = y;
  cue.vx = 0;
  cue.vy = 0;
  cue.moving = false;
  cue.inHole = false;
  next.ballInHand = false;
  return { ok: true, state: next };
}

function snapshotFrame(state: TableState, step: number): Frame {
  return {
    step,
    balls: state.balls.map((b) => ({
      id: b.id,
      x: b.x,
      y: b.y,
      visible: !b.inHole,
    })),
  };
}

/** FNV-1a over quantised state — cheap desync check between client and server. */
export function stateHash(state: TableState): string {
  let h = 0x811c9dc5;
  const mix = (n: number) => {
    h ^= n & 0xff;
    h = Math.imul(h, 0x01000193);
    h ^= (n >>> 8) & 0xff;
    h = Math.imul(h, 0x01000193);
    h ^= (n >>> 16) & 0xff;
    h = Math.imul(h, 0x01000193);
    h ^= (n >>> 24) & 0xff;
    h = Math.imul(h, 0x01000193);
  };
  for (const b of state.balls) {
    mix(Math.round(b.x * 1000));
    mix(Math.round(b.y * 1000));
    mix(b.inHole ? 1 : 0);
  }
  mix(state.turn);
  mix(state.ballInHand ? 1 : 0);
  mix(state.gameOver ? 1 : 0);
  mix(state.winner === null ? 2 : state.winner);
  mix(state.scores[0]);
  mix(state.scores[1]);
  mix(state.onColor ? 1 : 0);
  const colorCode = (c: BallColor | null) => (c === null ? 0 : c === "red" ? 1 : 2);
  mix(colorCode(state.playerColors[0]) * 4 + colorCode(state.playerColors[1]));
  return (h >>> 0).toString(16).padStart(8, "0");
}
