import {
  BALL_SIZE,
  MAX_POWER,
  MAX_STEPS,
  SPIN_FOLLOW_FACTOR,
  SPIN_SIDE_DECAY,
  SPIN_SIDE_FACTOR,
} from "./constants.js";
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
 * Authoritatively simulate one shot to settle. Pure: the input state is not
 * mutated. Deterministic: identical (state, shot) always produces an
 * identical result, in Node and in the browser.
 */
export function simulateShot(
  state: TableState,
  shot: ShotInput,
  opts: SimulateOptions = {}
): ShotResult {
  const valid = validateShot(state, shot);
  if (!valid.ok) throw new Error(`illegal shot: ${valid.reason}`);

  const next = cloneState(state);
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
        const speed = Math.sqrt(cue.vx * cue.vx + cue.vy * cue.vy);
        if (spinCtx.followSpin !== 0 && speed > 1e-9) {
          spinCtx.pendingFollow = { dx: cue.vx / speed, dy: cue.vy / speed, speed };
        }
      }
      rules.onBallsCollide(next, turnAcc, a, b);
    },
    onPocket: (ball: BallState) => rules.onPocket(next, turnAcc, ball),
  };

  shootBall(cueBall(next), shot.power, shot.angle);

  let steps = 0;
  let anyMoving = true;
  while (anyMoving && steps < MAX_STEPS) {
    const cue = cueBall(next);
    const preVx = cue.vx;
    const preVy = cue.vy;
    const eventsBefore = events.length;

    anyMoving = stepWorld(next.balls, steps, events, hooks);

    // Follow/draw: one-shot impulse along the pre-contact direction.
    const follow = spinCtx.pendingFollow;
    if (follow && !cue.inHole) {
      const boost = spinCtx.followSpin * SPIN_FOLLOW_FACTOR * follow.speed;
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
        if (flippedX) cue.vy += spinCtx.sideSpin * SPIN_SIDE_FACTOR * Math.abs(preVx);
        if (flippedY) cue.vx -= spinCtx.sideSpin * SPIN_SIDE_FACTOR * Math.abs(preVy);
        if (flippedX || flippedY) spinCtx.sideSpin *= SPIN_SIDE_DECAY;
        break;
      }
    }

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

  return { endState: next, events, outcome: resolution, frames, steps };
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
  if (isOutsideBorder(x, y)) return { ok: false, reason: "outside borders" };
  if (isInsideHole(x, y)) return { ok: false, reason: "inside a pocket" };

  const cueIdx = cueBallId(state);
  for (const ball of state.balls) {
    if (ball.id === cueIdx || ball.inHole) continue;
    const dx = x - ball.x;
    const dy = y - ball.y;
    if (Math.sqrt(dx * dx + dy * dy) < BALL_SIZE) {
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
