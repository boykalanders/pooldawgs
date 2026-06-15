// Deterministic physics, originally ported from the fork (GameWorld /
// Ball.update / Ball.handleCollision) and then deliberately upgraded:
//   • ball-ball contacts use REAL elastic collisions (normal-component
//     exchange with restitution) instead of the fork's symmetric shove;
//   • centre-pocket capture zones are retuned to match the visual mouths.
// Friction, cushion handling, the fixed timestep and the ORDER of operations
// (pairwise collisions first, then per-ball integration, ascending index)
// are preserved so server and client simulations stay bit-identical.

import {
  BALL_ORIGIN,
  BALL_RESTITUTION,
  BALL_SIZE,
  BOTTOM_BORDER_Y,
  CUSHION_DAMPING,
  DELTA,
  HOLES,
  LEFT_BORDER_X,
  MAX_SUBSTEPS,
  POCKETED_PARK,
  RIGHT_BORDER_X,
  ROLL_DECEL,
  SHOT_VELOCITY_FACTOR,
  STOP_THRESHOLD,
  SUBSTEP_TRAVEL,
  TOP_BORDER_Y,
  VISCOUS_DRAG,
} from "./constants.js";
import type { BallState, ShotEvent } from "./types.js";

export function isInsideHole(x: number, y: number): boolean {
  for (const hole of HOLES) {
    const dx = x - hole.x;
    const dy = y - hole.y;
    if (Math.sqrt(dx * dx + dy * dy) < hole.radius) return true;
  }
  return false;
}

export function isOutsideBorder(x: number, y: number): boolean {
  return (
    x - BALL_ORIGIN < LEFT_BORDER_X ||
    x + BALL_ORIGIN > RIGHT_BORDER_X ||
    y - BALL_ORIGIN < TOP_BORDER_Y ||
    y + BALL_ORIGIN > BOTTOM_BORDER_Y
  );
}

export function shootBall(ball: BallState, power: number, angle: number): void {
  if (power <= 0) return;
  ball.moving = true;
  ball.vx = SHOT_VELOCITY_FACTOR * Math.cos(angle) * power;
  ball.vy = SHOT_VELOCITY_FACTOR * Math.sin(angle) * power;
}

export interface StepHooks {
  /** Fired the moment two balls collide (fork: GamePolicy.checkColisionValidity). */
  onBallsCollide?(a: BallState, b: BallState): void;
  /** Fired the moment a ball drops (fork: GamePolicy.handleBallInHole). */
  onPocket?(ball: BallState): void;
}

/**
 * Advance the world by one fixed DELTA step.
 *
 * Anti-tunneling: the step is internally subdivided so that the fastest
 * ball never travels more than SUBSTEP_TRAVEL px between collision checks
 * (a full-power break moves 75px per step — twice the collision diameter —
 * which would otherwise pass straight through balls). Friction and the
 * stop threshold apply once per OUTER step, preserving the fork's feel.
 *
 * Returns true if any ball is still moving afterwards.
 */
export function stepWorld(
  balls: BallState[],
  step: number,
  events: ShotEvent[],
  hooks: StepHooks = {}
): boolean {
  // Substep count from the fastest ball — deterministic by construction.
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
    // Phase 1: pairwise ball-ball collisions (fork's loop order).
    for (let i = 0; i < balls.length; i++) {
      for (let j = i + 1; j < balls.length; j++) {
        collideBalls(balls[i], balls[j], dt, step, events, hooks);
      }
    }
    // Phase 2: move each ball (pockets + cushions).
    for (const ball of balls) {
      integrateBall(ball, dt, step, events, hooks);
    }
  }

  // Phase 3: friction + stop threshold, once per outer step.
  let anyMoving = false;
  for (const ball of balls) {
    applyFriction(ball);
    if (ball.moving) anyMoving = true;
  }
  return anyMoving;
}

/**
 * Elastic equal-mass collision (real pool physics): the velocity components
 * along the contact normal are exchanged (scaled by restitution), tangential
 * components are kept. Detection looks one step ahead like the fork did, and
 * the approach test (relative normal velocity < 0) prevents the same contact
 * from firing twice while balls overlap.
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

  if (dist >= BALL_SIZE || dist < 1e-9) return;

  const nx = dx / dist;
  const ny = dy / dist;

  // Only resolve approaching contacts.
  const rel = (b1.vx - b2.vx) * nx + (b1.vy - b2.vy) * ny;
  if (rel >= 0) return;

  hooks.onBallsCollide?.(b1, b2);
  events.push({ type: "ballsCollide", a: b1.id, b: b2.id, step });

  // Equal masses: each ball receives half the normal impulse.
  const impulse = (-(1 + BALL_RESTITUTION) * rel) / 2;
  b1.vx += impulse * nx;
  b1.vy += impulse * ny;
  b2.vx -= impulse * nx;
  b2.vy -= impulse * ny;

  // Separate actual interpenetration so balls never sink into each other.
  const cdx = b1.x - b2.x;
  const cdy = b1.y - b2.y;
  const cdist = Math.sqrt(cdx * cdx + cdy * cdy);
  if (cdist > 1e-9 && cdist < BALL_SIZE) {
    const push = (BALL_SIZE - cdist) / 2;
    b1.x += (cdx / cdist) * push;
    b1.y += (cdy / cdist) * push;
    b2.x -= (cdx / cdist) * push;
    b2.y -= (cdy / cdist) * push;
  }

  b1.moving = true;
  b2.moving = true;
}

function integrateBall(
  ball: BallState,
  dt: number,
  step: number,
  events: ShotEvent[],
  hooks: StepHooks
): void {
  if (ball.moving && !ball.inHole) {
    const newX = ball.x + ball.vx * dt;
    const newY = ball.y + ball.vy * dt;

    if (isInsideHole(newX, newY)) {
      // The fork parks the ball off-table after a 100ms timeout; we do it
      // immediately to stay deterministic. Rules see inHole=true either way.
      ball.x = POCKETED_PARK.x;
      ball.y = POCKETED_PARK.y;
      ball.inHole = true;
      ball.vx = 0;
      ball.vy = 0;
      ball.moving = false;
      events.push({ type: "pocket", ballId: ball.id, color: ball.color, step });
      hooks.onPocket?.(ball);
      return;
    }

    let collision = false;
    if (newX - BALL_ORIGIN < LEFT_BORDER_X) {
      ball.vx = -ball.vx;
      ball.x = LEFT_BORDER_X + BALL_ORIGIN;
      collision = true;
    } else if (newX + BALL_ORIGIN > RIGHT_BORDER_X) {
      ball.vx = -ball.vx;
      ball.x = RIGHT_BORDER_X - BALL_ORIGIN;
      collision = true;
    }
    if (newY - BALL_ORIGIN < TOP_BORDER_Y) {
      ball.vy = -ball.vy;
      ball.y = TOP_BORDER_Y + BALL_ORIGIN;
      collision = true;
    } else if (newY + BALL_ORIGIN > BOTTOM_BORDER_Y) {
      ball.vy = -ball.vy;
      ball.y = BOTTOM_BORDER_Y - BALL_ORIGIN;
      collision = true;
    }

    if (collision) {
      ball.vx *= CUSHION_DAMPING;
      ball.vy *= CUSHION_DAMPING;
      events.push({ type: "cushion", ballId: ball.id, step });
    } else {
      ball.x = newX;
      ball.y = newY;
    }
  }
}

/**
 * Cloth friction — once per outer DELTA step. Constant-deceleration rolling
 * model (real pool) rather than the fork's exponential decay: the speed loses
 * a fixed amount per second plus a slight viscous term, so balls roll a long
 * way and then settle rather than gliding indefinitely.
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
