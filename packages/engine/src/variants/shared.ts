import { G } from "../geometry.js";
import type { BallState, TableState } from "../types.js";

/** Per-shot facts recorded by the variant-agnostic observers. */
export interface FactsAcc {
  /** First non-cue ball the cue ball touched (null = no contact). */
  firstContactId: number | null;
  /** Ball ids potted this shot, in pocket order. */
  potted: number[];
  /** Cue ball went down (scratch / in-off). */
  cuePotted: boolean;
}

export function createFacts(): FactsAcc {
  return { firstContactId: null, potted: [], cuePotted: false };
}

/** The cue ball is always the last element of the rack. */
export function cueId(state: TableState): number {
  return state.balls.length - 1;
}

export function recordContact(
  state: TableState,
  acc: FactsAcc,
  b1: BallState,
  b2: BallState
): void {
  if (acc.firstContactId !== null) return;
  const cue = cueId(state);
  if (b1.id === cue && b2.id !== cue) acc.firstContactId = b2.id;
  else if (b2.id === cue && b1.id !== cue) acc.firstContactId = b1.id;
}

export function recordPocket(state: TableState, acc: FactsAcc, ball: BallState): void {
  acc.potted.push(ball.id);
  if (ball.id === cueId(state)) acc.cuePotted = true;
}

/** True if the ball was on the table when this shot began. */
export function onTableBefore(acc: FactsAcc, b: BallState): boolean {
  return !b.inHole || acc.potted.includes(b.id);
}

/**
 * Respot a ball onto its home spot, sliding toward the foot (+x) by whole
 * diameters if the spot is occupied. Deterministic — no randomness.
 */
export function respot(state: TableState, ball: BallState): void {
  const hx = ball.homeX ?? ball.x;
  const hy = ball.homeY ?? ball.y;
  let x = hx;
  const occupied = (px: number) =>
    state.balls.some(
      (o) =>
        o.id !== ball.id &&
        !o.inHole &&
        Math.sqrt((o.x - px) ** 2 + (o.y - hy) ** 2) < G.BALL_SIZE
    );
  let guard = 0;
  while (occupied(x) && guard < 40) {
    x += G.BALL_SIZE;
    guard++;
  }
  ball.x = x;
  ball.y = hy;
  ball.vx = 0;
  ball.vy = 0;
  ball.moving = false;
  ball.inHole = false;
}
