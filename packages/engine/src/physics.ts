// Deterministic physics — PHYSICS SPEC V0.1 (see constants.ts for the mapping
// from the SI spec to the fork's pixel geometry). Upgrades over the fork:
//   • non-linear cue power (input^1.4);
//   • real elastic ball-ball collisions with a min-speed jitter gate;
//   • cushions with separate normal restitution + tangential friction
//     (natural banks, "no pinball");
//   • directional pocket capture (acceptance cone + min inward speed) plus
//     pocket magnetism for on-line shots.
// The fixed timestep and the ORDER of operations (pairwise collisions first,
// then per-ball integration, ascending index) are preserved so server and
// client simulations stay bit-identical.

import {
  BALL_RESTITUTION,
  CUSHION_FRICTION,
  CUSHION_RESTITUTION,
  DELTA,
  type Hole,
  MAX_POWER,
  MAX_SHOT_SPEED,
  MAX_SUBSTEPS,
  MIN_COLLISION_SPEED,
  POCKET_MAGNET_RANGE,
  POCKET_MAGNETISM,
  POCKET_MIN_INWARD,
  POWER_EXPONENT,
  ROLL_DECEL,
  STOP_THRESHOLD,
  SUBSTEP_TRAVEL,
  VISCOUS_DRAG,
} from "./constants.js";
// Geometry (table size, ball size, pockets) is per-variant; read it from the
// active-geometry singleton, which the simulator sets per shot.
import { G } from "./geometry.js";
import type { BallState, ShotEvent } from "./types.js";

/** Geometric "is this point inside any pocket mouth" — for placement / UI. */
export function isInsideHole(x: number, y: number): boolean {
  for (const hole of G.HOLES) {
    const dx = x - hole.x;
    const dy = y - hole.y;
    if (Math.sqrt(dx * dx + dy * dy) < hole.radius) return true;
  }
  return false;
}

export function isOutsideBorder(x: number, y: number): boolean {
  return (
    x - G.BALL_ORIGIN < G.LEFT_BORDER_X ||
    x + G.BALL_ORIGIN > G.RIGHT_BORDER_X ||
    y - G.BALL_ORIGIN < G.TOP_BORDER_Y ||
    y + G.BALL_ORIGIN > G.BOTTOM_BORDER_Y
  );
}

/**
 * Launch the cue ball. Power is non-linear (spec §7): the 0–MAX_POWER input is
 * normalised and raised to POWER_EXPONENT, so soft shots stay precise and only
 * the top of the range delivers real pace.
 */
export function shootBall(ball: BallState, power: number, angle: number): void {
  if (power <= 0) return;
  const p = Math.min(1, power / MAX_POWER);
  const speed = MAX_SHOT_SPEED * Math.pow(p, POWER_EXPONENT);
  ball.moving = true;
  ball.vx = speed * Math.cos(angle);
  ball.vy = speed * Math.sin(angle);
}

export interface StepHooks {
  /** Fired the moment two balls collide (fork: GamePolicy.checkColisionValidity). */
  onBallsCollide?(a: BallState, b: BallState): void;
  /** Fired the moment a ball drops (fork: GamePolicy.handleBallInHole). */
  onPocket?(ball: BallState): void;
}

/**
 * Advance the world by one fixed DELTA step, internally subdivided so the
 * fastest ball never travels more than SUBSTEP_TRAVEL px between collision
 * checks. Friction + the stop threshold apply once per OUTER step.
 * Returns true if any ball is still moving afterwards.
 */
export function stepWorld(
  balls: BallState[],
  step: number,
  events: ShotEvent[],
  hooks: StepHooks = {}
): boolean {
  let maxSpeed = 0;
  for (const ball of balls) {
    if (ball.inHole || !ball.moving) continue;
    const speed = Math.sqrt(ball.vx * ball.vx + ball.vy * ball.vy);
    if (speed > maxSpeed) maxSpeed = speed;
  }
  const substeps = Math.min(
    MAX_SUBSTEPS,
    Math.max(1, Math.ceil((maxSpeed * DELTA) / SUBSTEP_TRAVEL))
  );
  const dt = DELTA / substeps;

  for (let sub = 0; sub < substeps; sub++) {
    for (let i = 0; i < balls.length; i++) {
      for (let j = i + 1; j < balls.length; j++) {
        collideBalls(balls[i], balls[j], dt, step, events, hooks);
      }
    }
    for (const ball of balls) {
      integrateBall(ball, dt, step, events, hooks);
    }
  }

  let anyMoving = false;
  for (const ball of balls) {
    applyFriction(ball);
    if (ball.moving) anyMoving = true;
  }
  return anyMoving;
}

/**
 * Elastic equal-mass collision: normal-component velocities are exchanged
 * (scaled by restitution), tangential components kept. A min-speed gate
 * resolves near-resting contacts inelastically to prevent jitter (spec §5).
 */
function collideBalls(
  b1: BallState,
  b2: BallState,
  dt: number,
  step: number,
  events: ShotEvent[],
  hooks: StepHooks
): void {
  if (b1.inHole || b2.inHole) return;
  if (!b1.moving && !b2.moving) return;

  const n1x = b1.x + b1.vx * dt;
  const n1y = b1.y + b1.vy * dt;
  const n2x = b2.x + b2.vx * dt;
  const n2y = b2.y + b2.vy * dt;

  const dx = n1x - n2x;
  const dy = n1y - n2y;
  const dist = Math.sqrt(dx * dx + dy * dy);

  if (dist >= G.BALL_SIZE || dist < 1e-9) return;

  const nx = dx / dist;
  const ny = dy / dist;

  const rel = (b1.vx - b2.vx) * nx + (b1.vy - b2.vy) * ny;
  if (rel >= 0) return; // not approaching

  hooks.onBallsCollide?.(b1, b2);
  events.push({ type: "ballsCollide", a: b1.id, b: b2.id, step });

  const approach = -rel;
  const restitution = approach < MIN_COLLISION_SPEED ? 0 : BALL_RESTITUTION;
  const impulse = ((1 + restitution) * approach) / 2;
  b1.vx += impulse * nx;
  b1.vy += impulse * ny;
  b2.vx -= impulse * nx;
  b2.vy -= impulse * ny;

  // Separate interpenetration so balls never sink into each other.
  const cdx = b1.x - b2.x;
  const cdy = b1.y - b2.y;
  const cdist = Math.sqrt(cdx * cdx + cdy * cdy);
  if (cdist > 1e-9 && cdist < G.BALL_SIZE) {
    const push = (G.BALL_SIZE - cdist) / 2;
    b1.x += (cdx / cdist) * push;
    b1.y += (cdy / cdist) * push;
    b2.x -= (cdx / cdist) * push;
    b2.y -= (cdy / cdist) * push;
  }

  b1.moving = true;
  b2.moving = true;
}

/** Inward speed of a ball toward a pocket throat (negative = moving away). */
function inwardSpeed(ball: BallState, hole: Hole): number {
  return ball.vx * hole.tx + ball.vy * hole.ty;
}

/**
 * Directional pocket capture (spec §6): a ball drops only if it is inside the
 * mouth AND travelling into the throat — within the acceptance cone and above
 * a minimum inward speed. This rejects balls skimming a rail past a centre
 * pocket, which the fork's plain circular hole wrongly swallowed.
 */
function capturingHole(ball: BallState, x: number, y: number): Hole | null {
  for (const hole of G.HOLES) {
    const dx = x - hole.x;
    const dy = y - hole.y;
    if (Math.sqrt(dx * dx + dy * dy) >= hole.radius) continue;
    const vIn = inwardSpeed(ball, hole);
    if (vIn < POCKET_MIN_INWARD) continue;
    const speed = Math.sqrt(ball.vx * ball.vx + ball.vy * ball.vy);
    if (speed < 1e-9 || vIn / speed < hole.acceptCos) continue;
    return hole;
  }
  return null;
}

/**
 * Pocket magnetism (spec §10): for an on-line ball approaching the mouth, steer
 * its velocity gently toward the pocket centre so near-perfect shots drop.
 * Subtle by design — players shouldn't notice the assist.
 */
function applyMagnetism(ball: BallState): void {
  for (const hole of G.HOLES) {
    const dx = hole.x - ball.x;
    const dy = hole.y - ball.y;
    const d = Math.sqrt(dx * dx + dy * dy);
    if (d >= hole.radius * POCKET_MAGNET_RANGE || d < 1e-9) continue;
    const vIn = inwardSpeed(ball, hole);
    if (vIn <= 0) continue;
    const speed = Math.sqrt(ball.vx * ball.vx + ball.vy * ball.vy);
    if (speed < 1e-9 || vIn / speed < hole.acceptCos) continue;
    ball.vx += (dx / d) * POCKET_MAGNETISM * speed;
    ball.vy += (dy / d) * POCKET_MAGNETISM * speed;
    return;
  }
}

function integrateBall(
  ball: BallState,
  dt: number,
  step: number,
  events: ShotEvent[],
  hooks: StepHooks
): void {
  if (!ball.moving || ball.inHole) return;

  applyMagnetism(ball);

  const newX = ball.x + ball.vx * dt;
  const newY = ball.y + ball.vy * dt;

  const hole = capturingHole(ball, newX, newY);
  if (hole) {
    ball.x = G.POCKETED_PARK.x;
    ball.y = G.POCKETED_PARK.y;
    ball.inHole = true;
    ball.vx = 0;
    ball.vy = 0;
    ball.moving = false;
    events.push({ type: "pocket", ballId: ball.id, color: ball.color, step });
    hooks.onPocket?.(ball);
    return;
  }

  // Cushions: normal restitution + tangential friction (spec §3).
  let collision = false;
  if (newX - G.BALL_ORIGIN < G.LEFT_BORDER_X) {
    ball.vx = -ball.vx * CUSHION_RESTITUTION;
    ball.vy *= 1 - CUSHION_FRICTION;
    ball.x = G.LEFT_BORDER_X + G.BALL_ORIGIN;
    collision = true;
  } else if (newX + G.BALL_ORIGIN > G.RIGHT_BORDER_X) {
    ball.vx = -ball.vx * CUSHION_RESTITUTION;
    ball.vy *= 1 - CUSHION_FRICTION;
    ball.x = G.RIGHT_BORDER_X - G.BALL_ORIGIN;
    collision = true;
  }
  if (newY - G.BALL_ORIGIN < G.TOP_BORDER_Y) {
    ball.vy = -ball.vy * CUSHION_RESTITUTION;
    ball.vx *= 1 - CUSHION_FRICTION;
    ball.y = G.TOP_BORDER_Y + G.BALL_ORIGIN;
    collision = true;
  } else if (newY + G.BALL_ORIGIN > G.BOTTOM_BORDER_Y) {
    ball.vy = -ball.vy * CUSHION_RESTITUTION;
    ball.vx *= 1 - CUSHION_FRICTION;
    ball.y = G.BOTTOM_BORDER_Y - G.BALL_ORIGIN;
    collision = true;
  }

  if (collision) {
    events.push({ type: "cushion", ballId: ball.id, step });
  } else {
    ball.x = newX;
    ball.y = newY;
  }
}

/**
 * Cloth friction — once per outer DELTA step. Constant-deceleration rolling
 * model (real pool): a fixed speed loss per second plus a slight viscous term,
 * calibrated so a full-power shot rolls ≈3–4 table lengths (spec §4).
 */
function applyFriction(ball: BallState): void {
  if (!ball.moving) return;
  const speed = Math.sqrt(ball.vx * ball.vx + ball.vy * ball.vy);
  const next = speed * VISCOUS_DRAG - ROLL_DECEL * DELTA;
  if (next <= STOP_THRESHOLD) {
    ball.moving = false;
    ball.vx = 0;
    ball.vy = 0;
    return;
  }
  const scale = next / speed;
  ball.vx *= scale;
  ball.vy *= scale;
}
