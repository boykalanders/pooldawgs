// Deterministic port of the fork's physics: GameWorld.handleCollision,
// Ball.update / Ball.updatePosition / Ball.handleCollision. The math, the
// constants and crucially the ORDER of operations (pairwise ball collisions
// first, then per-ball integration, ascending index) are preserved so that
// server and client simulations of the same shot produce identical results.

import {
  BALL_COLLISION_DAMPING,
  BALL_ORIGIN,
  BALL_SIZE,
  BOTTOM_BORDER_Y,
  COLLISION_IMPULSE,
  COLLISION_POWER_FACTOR,
  CUSHION_DAMPING,
  DELTA,
  FRICTION_PER_STEP,
  HOLES,
  LEFT_BORDER_X,
  POCKETED_PARK,
  RIGHT_BORDER_X,
  SHOT_VELOCITY_FACTOR,
  STOP_THRESHOLD,
  TOP_BORDER_Y,
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
 * Returns true if any ball is still moving afterwards.
 */
export function stepWorld(
  balls: BallState[],
  step: number,
  events: ShotEvent[],
  hooks: StepHooks = {}
): boolean {
  // Phase 1: pairwise ball-ball collisions (fork: GameWorld.update loop order).
  for (let i = 0; i < balls.length; i++) {
    for (let j = i + 1; j < balls.length; j++) {
      collideBalls(balls[i], balls[j], step, events, hooks);
    }
  }

  // Phase 2: integrate each ball (fork: Ball.update).
  let anyMoving = false;
  for (const ball of balls) {
    updateBall(ball, step, events, hooks);
    if (ball.moving) anyMoving = true;
  }
  return anyMoving;
}

function collideBalls(
  b1: BallState,
  b2: BallState,
  step: number,
  events: ShotEvent[],
  hooks: StepHooks
): void {
  if (b1.inHole || b2.inHole) return;
  if (!b1.moving && !b2.moving) return;

  const n1x = b1.x + b1.vx * DELTA;
  const n1y = b1.y + b1.vy * DELTA;
  const n2x = b2.x + b2.vx * DELTA;
  const n2y = b2.y + b2.vy * DELTA;

  const dx = n1x - n2x;
  const dy = n1y - n2y;
  const dist = Math.sqrt(dx * dx + dy * dy);

  if (dist >= BALL_SIZE) return;

  hooks.onBallsCollide?.(b1, b2);
  events.push({ type: "ballsCollide", a: b1.id, b: b2.id, step });

  let power =
    Math.abs(b1.vx) + Math.abs(b1.vy) + Math.abs(b2.vx) + Math.abs(b2.vy);
  power = power * COLLISION_POWER_FACTOR;

  const rotation = Math.atan2(b1.y - b2.y, b1.x - b2.x);

  b1.moving = true;
  b2.moving = true;

  b2.vx += COLLISION_IMPULSE * Math.cos(rotation + Math.PI) * power;
  b2.vy += COLLISION_IMPULSE * Math.sin(rotation + Math.PI) * power;
  b2.vx *= BALL_COLLISION_DAMPING;
  b2.vy *= BALL_COLLISION_DAMPING;

  b1.vx += COLLISION_IMPULSE * Math.cos(rotation) * power;
  b1.vy += COLLISION_IMPULSE * Math.sin(rotation) * power;
  b1.vx *= BALL_COLLISION_DAMPING;
  b1.vy *= BALL_COLLISION_DAMPING;
}

function updateBall(
  ball: BallState,
  step: number,
  events: ShotEvent[],
  hooks: StepHooks
): void {
  if (ball.moving && !ball.inHole) {
    const newX = ball.x + ball.vx * DELTA;
    const newY = ball.y + ball.vy * DELTA;

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

  ball.vx *= FRICTION_PER_STEP;
  ball.vy *= FRICTION_PER_STEP;

  if (
    ball.moving &&
    Math.abs(ball.vx) < STOP_THRESHOLD &&
    Math.abs(ball.vy) < STOP_THRESHOLD
  ) {
    ball.moving = false;
    ball.vx = 0;
    ball.vy = 0;
  }
}
