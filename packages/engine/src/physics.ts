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
// client simulations stay bit-identical. The contact solve itself is Jacobi
// (order-independent), so the result no longer depends on ball list order.

import {
  BALL_RESTITUTION,
  CUSHION_FRICTION,
  CUSHION_RESTITUTION,
  DELTA,
  type Hole,
  MAX_POWER,
  MAX_SHOT_SPEED,
  MAX_SUBSTEPS,
  BALL_BALL_FRICTION,
  CONTACT_SLOP,
  MIN_COLLISION_SPEED,
  POSITION_ITERATIONS,
  POSITIONAL_CORRECTION,
  VELOCITY_ITERATIONS,
  POCKET_MAGNET_RANGE,
  POCKET_MAGNETISM,
  POCKET_MIN_INWARD,
  POWER_EXPONENT,
  ROLL_DECEL,
  STATIC_STOP_STEPS,
  SUBSTEP_TRAVEL_FRACTION,
  TS_STATIC_STOP_SPEED,
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
    x - G.BALL_RADIUS < G.LEFT_BORDER_X ||
    x + G.BALL_RADIUS > G.RIGHT_BORDER_X ||
    y - G.BALL_RADIUS < G.TOP_BORDER_Y ||
    y + G.BALL_RADIUS > G.BOTTOM_BORDER_Y
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
  hooks: StepHooks = {},
  /** Per-ball consecutive-slow-step counters for the static stop (spec §4.3). */
  stopCounts?: number[]
): boolean {
  let maxSpeed = 0;
  for (const ball of balls) {
    if (ball.inHole || !ball.moving) continue;
    const speed = Math.sqrt(ball.vx * ball.vx + ball.vy * ball.vy);
    if (speed > maxSpeed) maxSpeed = speed;
  }
  const substeps = Math.min(
    MAX_SUBSTEPS,
    Math.max(1, Math.ceil((maxSpeed * DELTA) / (SUBSTEP_TRAVEL_FRACTION * G.BALL_SIZE)))
  );
  const dt = DELTA / substeps;

  // Contacts already reported this OUTER step, so an iterated solve (or a pair
  // resting in contact) emits one event per physical collision, not one per
  // iteration (spec §7.4).
  const reported = new Set<number>();

  // Scratch for the order-independent (Jacobi) solve below.
  const n = balls.length;
  const dv = new Float64Array(2 * n);
  const dp = new Float64Array(2 * n);
  const counts = new Int32Array(n);
  const contacts: number[] = [];

  for (let sub = 0; sub < substeps; sub++) {
    // ── velocity solve, iterated (spec §6.2) ──────────────────────────────
    // JACOBI, not Gauss-Seidel. Every contact in an iteration is computed from
    // the SAME velocity snapshot and the impulses are applied together. The old
    // sequential sweep in fixed index order let whichever ball came first in the
    // list act first; on a frozen rack that dragged the whole break toward one
    // side regardless of aim (measured: pack centre ~60 px off a dead-straight
    // cue line, and it flipped side when the rack was mirrored — i.e. decided by
    // list order, not physics).
    for (let it = 0; it < VELOCITY_ITERATIONS; it++) {
      contacts.length = 0;
      counts.fill(0);
      for (let i = 0; i < n; i++) {
        for (let j = i + 1; j < n; j++) {
          if (!detectContact(balls[i], balls[j], dt)) continue;
          contacts.push(i, j, contactNx, contactNy);
          counts[i]++;
          counts[j]++;
          // Report each physical contact once per outer step (spec §7.4).
          const key = balls[i].id * 64 + balls[j].id;
          if (!reported.has(key)) {
            reported.add(key);
            hooks.onBallsCollide?.(balls[i], balls[j]);
            events.push({ type: "ballsCollide", a: balls[i].id, b: balls[j].id, step });
          }
        }
      }
      if (contacts.length === 0) break; // converged
      dv.fill(0);
      for (let k = 0; k < contacts.length; k += 4) {
        contactImpulse(balls, contacts[k], contacts[k + 1], contacts[k + 2], contacts[k + 3], counts, dv);
      }
      for (let k = 0; k < n; k++) {
        const ix = dv[2 * k];
        const iy = dv[2 * k + 1];
        if (ix !== 0 || iy !== 0) {
          balls[k].vx += ix;
          balls[k].vy += iy;
          balls[k].moving = true;
        }
      }
    }

    for (const ball of balls) {
      integrateBall(ball, dt, step, events, hooks);
    }

    // ── positional correction, iterated (spec §6.3) ───────────────────────
    // Never resolve overlap by adding velocity: push each overlapping pair apart
    // by a fraction of the penetration beyond a small slop. Also Jacobi — every
    // push is computed from the same positions, then all are applied together.
    for (let it = 0; it < POSITION_ITERATIONS; it++) {
      dp.fill(0);
      let movedAny = false;
      for (let i = 0; i < n; i++) {
        for (let j = i + 1; j < n; j++) {
          if (overlapPush(balls[i], balls[j], i, j, dp)) movedAny = true;
        }
      }
      if (!movedAny) break;
      for (let k = 0; k < n; k++) {
        balls[k].x += dp[2 * k];
        balls[k].y += dp[2 * k + 1];
      }
    }
  }

  let anyMoving = false;
  for (let i = 0; i < balls.length; i++) {
    applyFriction(balls[i], stopCounts, i);
    if (balls[i].moving) anyMoving = true;
  }
  return anyMoving;
}

// Contact normal written by detectContact() (b2 → b1, unit length). Module
// scratch rather than an allocated object: this runs in the innermost loop.
let contactNx = 0;
let contactNy = 0;

/**
 * Is the pair touching (at the predicted positions) AND approaching? Pure
 * query — changes nothing, so every pair in a Jacobi pass sees the same state.
 */
function detectContact(b1: BallState, b2: BallState, dt: number): boolean {
  if (b1.inHole || b2.inHole) return false;
  if (!b1.moving && !b2.moving) return false;

  const dx = b1.x + b1.vx * dt - (b2.x + b2.vx * dt);
  const dy = b1.y + b1.vy * dt - (b2.y + b2.vy * dt);
  const dist = Math.sqrt(dx * dx + dy * dy);
  if (dist >= G.BALL_SIZE || dist < 1e-9) return false;

  const nx = dx / dist;
  const ny = dy / dist;
  const vn = (b1.vx - b2.vx) * nx + (b1.vy - b2.vy) * ny;
  if (vn >= 0) return false; // separating
  contactNx = nx;
  contactNy = ny;
  return true;
}

/**
 * Elastic equal-mass collision: normal-component velocities are exchanged
 * (scaled by restitution) plus a Coulomb friction impulse on the tangent. A
 * min-speed gate resolves near-resting contacts inelastically to prevent
 * jitter (spec §5).
 *
 * Reads velocities, never writes them: the impulse is ACCUMULATED into `dv`
 * and applied by the caller once every contact in the pass is computed. When a
 * ball has several contacts in the same pass their impulses would stack from
 * one stale snapshot and overshoot, so each contact is scaled by
 * 1 / max(contacts on either ball). The same scale goes to both balls, so
 * momentum is still conserved exactly; the remainder is picked up by the next
 * iteration.
 */
function contactImpulse(
  balls: BallState[],
  i: number,
  j: number,
  nx: number,
  ny: number,
  counts: Int32Array,
  dv: Float64Array
): void {
  const b1 = balls[i];
  const b2 = balls[j];
  const rvx = b1.vx - b2.vx;
  const rvy = b1.vy - b2.vy;
  const vn = rvx * nx + rvy * ny;
  const share = 1 / Math.max(counts[i], counts[j]);

  // Normal impulse. Equal masses ⇒ effective mass 1/2, so j = -(1+e)·vn / 2.
  const approach = -vn;
  const restitution = approach < MIN_COLLISION_SPEED ? 0 : BALL_RESTITUTION;
  const jn = ((1 + restitution) * approach) / 2;
  let ix = jn * nx;
  let iy = jn * ny;

  // Tangential (Coulomb) friction impulse — what makes cut shots and throw
  // behave.
  const tvx = rvx - vn * nx;
  const tvy = rvy - vn * ny;
  const tv = Math.sqrt(tvx * tvx + tvy * tvy);
  if (tv > 1e-9) {
    const jt = Math.min(tv / 2, BALL_BALL_FRICTION * jn);
    ix -= (jt * tvx) / tv;
    iy -= (jt * tvy) / tv;
  }

  ix *= share;
  iy *= share;
  dv[2 * i] += ix;
  dv[2 * i + 1] += iy;
  dv[2 * j] -= ix;
  dv[2 * j + 1] -= iy;
}

/**
 * Overlap push for one pair (spec §6.3) — position only, never velocity.
 * Accumulated into `dp`; the caller applies every push together.
 */
function overlapPush(b1: BallState, b2: BallState, i: number, j: number, dp: Float64Array): boolean {
  if (b1.inHole || b2.inHole) return false;
  const dx = b1.x - b2.x;
  const dy = b1.y - b2.y;
  const dist = Math.sqrt(dx * dx + dy * dy);
  if (dist < 1e-9) return false;
  const penetration = G.BALL_SIZE - dist - CONTACT_SLOP;
  if (penetration <= 0) return false;
  const push = (penetration * POSITIONAL_CORRECTION) / 2;
  const ux = (dx / dist) * push;
  const uy = (dy / dist) * push;
  dp[2 * i] += ux;
  dp[2 * i + 1] += uy;
  dp[2 * j] -= ux;
  dp[2 * j + 1] -= uy;
  return true;
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
  // Defensive: every comparison below is false for NaN, so a non-finite state
  // would fall through all the rejects and "capture" the ball at the first
  // hole regardless of where it is. Never capture on a bad number.
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
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
function applyMagnetism(ball: BallState, dt: number): void {
  // Scaled by dt/DELTA so the assist is per UNIT TIME, not per substep. It used
  // to be applied once per substep at a fixed strength, so simply making the
  // solver finer multiplied the pocket attraction — a frame-rate-dependent bug
  // (spec: "must use dt"). Tightening the substep travel cap exposed it by
  // vacuuming balls, including the cue, into pockets.
  const scale = dt / DELTA;
  for (const hole of G.HOLES) {
    const dx = hole.x - ball.x;
    const dy = hole.y - ball.y;
    const d = Math.sqrt(dx * dx + dy * dy);
    if (d >= hole.radius * POCKET_MAGNET_RANGE || d < 1e-9) continue;
    const vIn = inwardSpeed(ball, hole);
    if (vIn <= 0) continue;
    const speed = Math.sqrt(ball.vx * ball.vx + ball.vy * ball.vy);
    if (speed < 1e-9 || vIn / speed < hole.acceptCos) continue;
    ball.vx += (dx / d) * POCKET_MAGNETISM * speed * scale;
    ball.vy += (dy / d) * POCKET_MAGNETISM * speed * scale;
    return;
  }
}

/**
 * A middle pocket (tx === 0) opens a real GAP in its rail. Within the mouth the
 * cushion must not bounce the ball — otherwise it rebounds off a phantom wall
 * behind the pocket instead of rolling in, which is exactly the "middle pocket
 * won't take the ball" feel. Returns the middle hole whose mouth spans `x` on
 * the given rail (`ty` = -1 top, +1 bottom), or null. `half` is the clear
 * opening for a ball centre; below the corner jaws the rail is solid as before.
 */
function railMouthHole(x: number, ty: -1 | 1): Hole | null {
  for (const hole of G.HOLES) {
    if (hole.tx !== 0 || hole.ty !== ty) continue;
    const half = hole.radius - G.BALL_RADIUS;
    if (half > 0 && Math.abs(x - hole.x) < half) return hole;
  }
  return null;
}

function integrateBall(
  ball: BallState,
  dt: number,
  step: number,
  events: ShotEvent[],
  hooks: StepHooks
): void {
  if (!ball.moving || ball.inHole) return;

  applyMagnetism(ball, dt);

  const newX = ball.x + ball.vx * dt;
  const newY = ball.y + ball.vy * dt;

  // Directional capture (acceptance cone): on-line pots drop; rail-skims don't.
  let hole = capturingHole(ball, newX, newY);
  // Middle-pocket throat: with the rail gap open (below), a ball that has rolled
  // through the mouth and pushed its centre past the rail line is physically in
  // the pocket, so it drops at any angle — a clean-looking cut no longer clips a
  // phantom cushion. Rail-skimmers travel along the rail and never cross the
  // line, so they are still rejected.
  if (!hole) {
    if (newY <= G.TOP_BORDER_Y) hole = railMouthHole(newX, -1);
    else if (newY >= G.BOTTOM_BORDER_Y) hole = railMouthHole(newX, 1);
  }
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

  // Cushions: normal restitution + tangential friction (spec §3). Clamped to
  // the ball's actual drawn radius, not the old (larger) BALL_ORIGIN — that
  // mismatch left a visible gap of felt between a resting ball and the rail.
  // The top/bottom rails skip the bounce across a middle-pocket mouth so the
  // ball rolls into the throat (captured above) instead of rebounding.
  let collision = false;
  if (newX - G.BALL_RADIUS < G.LEFT_BORDER_X) {
    ball.vx = -ball.vx * CUSHION_RESTITUTION;
    ball.vy *= 1 - CUSHION_FRICTION;
    ball.x = G.LEFT_BORDER_X + G.BALL_RADIUS;
    collision = true;
  } else if (newX + G.BALL_RADIUS > G.RIGHT_BORDER_X) {
    ball.vx = -ball.vx * CUSHION_RESTITUTION;
    ball.vy *= 1 - CUSHION_FRICTION;
    ball.x = G.RIGHT_BORDER_X - G.BALL_RADIUS;
    collision = true;
  }
  if (newY - G.BALL_RADIUS < G.TOP_BORDER_Y && !railMouthHole(newX, -1)) {
    ball.vy = -ball.vy * CUSHION_RESTITUTION;
    ball.vx *= 1 - CUSHION_FRICTION;
    ball.y = G.TOP_BORDER_Y + G.BALL_RADIUS;
    collision = true;
  } else if (newY + G.BALL_RADIUS > G.BOTTOM_BORDER_Y && !railMouthHole(newX, 1)) {
    ball.vy = -ball.vy * CUSHION_RESTITUTION;
    ball.vx *= 1 - CUSHION_FRICTION;
    ball.y = G.BOTTOM_BORDER_Y - G.BALL_RADIUS;
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
function applyFriction(ball: BallState, stopCounts?: number[], idx = -1): void {
  if (!ball.moving) return;
  const speed = Math.sqrt(ball.vx * ball.vx + ball.vy * ball.vy);

  // Already at a dead stop while still waiting out the hysteresis streak.
  // Guard the divide below: 0/0 is NaN, and a NaN velocity makes every
  // comparison in capturingHole() false, which silently "pockets" the ball
  // wherever it stands.
  if (speed < 1e-9) {
    ball.vx = 0;
    ball.vy = 0;
    if (stopCounts !== undefined && idx >= 0) {
      stopCounts[idx] = (stopCounts[idx] ?? 0) + 1;
      if (stopCounts[idx] < STATIC_STOP_STEPS) return;
    }
    ball.moving = false;
    return;
  }

  // Rolling resistance dominates; the viscous term is only a small residual
  // (spec §4.4) — damping alone fades as the ball slows and leaves it creeping.
  const next = speed * VISCOUS_DRAG - ROLL_DECEL * DELTA;
  const track = stopCounts !== undefined && idx >= 0;

  if (next <= TS_STATIC_STOP_SPEED) {
    // Static-stop hysteresis (spec §4.3): a ball is only declared at rest after
    // a streak of slow steps, so one slow frame mid-rebound cannot settle it.
    const clamped = Math.max(0, next);
    if (track) {
      stopCounts![idx] = (stopCounts![idx] ?? 0) + 1;
      if (stopCounts![idx] < STATIC_STOP_STEPS) {
        const scale = clamped / speed;
        ball.vx *= scale;
        ball.vy *= scale;
        return;
      }
    }
    ball.moving = false;
    ball.vx = 0;
    ball.vy = 0;
    return;
  }

  if (track) stopCounts![idx] = 0;
  const scale = next / speed;
  ball.vx *= scale;
  ball.vy *= scale;
}
