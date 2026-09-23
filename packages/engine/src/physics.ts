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
  cushionRestitution,
  DELTA,
  type Hole,
  MAX_POWER,
  MAX_SHOT_SPEED,
  MAX_SUBSTEPS,
  BALL_BALL_FRICTION,
  CONTACT_SLOP,
  MIN_COLLISION_SPEED,
  POSITION_ITERATIONS,
  MAX_CONTACT_LAYERS,
  PACK_RESTITUTION_SCALE,
  POSITIONAL_CORRECTION,
  SOLVE_TOLERANCE,
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
    const dx = x - hole.mx;
    const dy = y - hole.my;
    const into = dx * hole.tx + dy * hole.ty;
    const along = dx * hole.ux + dy * hole.uy;
    if (into > -G.BALL_RADIUS && Math.abs(along) < hole.mouth / 2) return true;
  }
  return false;
}

/** Radius of the rounded cushion end at a jaw tip (~10 mm on a real table). */
const KNUCKLE_RADIUS = 5.5;

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
  const slot = new Int32Array(n * n);
  const cs: Contact[] = [];

  for (let sub = 0; sub < substeps; sub++) {
    // ── velocity solve, iterated (spec §6.2) ──────────────────────────────
    // JACOBI, not Gauss-Seidel: every contact in an iteration is computed from
    // the SAME velocity snapshot and the impulses are applied together. The old
    // sequential sweep in fixed index order let whichever ball came first in the
    // list act first; on a frozen rack that dragged the whole break toward one
    // side regardless of aim (pack centre ~60 px off a dead-straight cue line,
    // flipping side when the rack was mirrored).
    //
    // The collision travels through the pack in LAYERS, the way it does on a
    // real table: the cue hits the front ball, that ball hits the two behind
    // it, and so on. Each layer is the set of pairs that are approaching right
    // now; every layer is solved on its own with POISSON restitution:
    //   1. compression — converge the layer's pairs to zero approach speed
    //      (accumulated impulse, clamped ≥ 0);
    //   2. restitution — give each pair e × its compression impulse at once;
    //   3. clean-up — the inelastic solve again for pairs the bounce drove
    //      back together.
    // Balls in the same layer are solved together (Jacobi), so the result never
    // depends on ball order and a straight break stays straight.
    //
    // Solving the WHOLE pack as one simultaneous impact instead — which is what
    // this did before — bleeds most of the break away: 57 % of the cue's energy
    // reached the table, against 93 % with the original sequential solver.
    // Layer by layer it keeps ~90 % AND stays symmetric. (Two earlier attempts
    // failed differently: re-deriving the bounce from the approach speed left
    // after each Jacobi pass made the break nearly dead at 13 %, and fixing each
    // pair's bounce speed at impact — Newton's law — CREATED energy, 108–127 %.)
    const onNew = (b1: BallState, b2: BallState) => {
      // Report each physical contact once per outer step (spec §7.4).
      const key = b1.id * 64 + b2.id;
      if (reported.has(key)) return;
      reported.add(key);
      hooks.onBallsCollide?.(b1, b2);
      events.push({ type: "ballsCollide", a: b1.id, b: b2.id, step });
    };
    slot.fill(-1);
    cs.length = 0;
    for (let layer = 0; layer < MAX_CONTACT_LAYERS; layer++) {
      const from = cs.length;
      // A pair may collide again in a later layer — a ball squeezed between two
      // others is struck from both sides — so each layer looks at every pair
      // that is approaching NOW. Restitution is below 1, so a pair cannot keep
      // bouncing: it separates and drops out.
      slot.fill(-1);
      detectContacts(balls, dt, cs, slot, onNew);
      if (cs.length === from) break; // nothing new is approaching
      solveInelastic(balls, dt, cs, from, counts, dv); // 1. compression
      countContacts(cs, from, counts);
      dv.fill(0);
      for (let k = from; k < cs.length; k++) restitutionImpulse(balls, cs[k], counts, dv); // 2. bounce
      applyDv(balls, dv);
      for (let k = from; k < cs.length; k++) cs[k].acc = 0;
      solveInelastic(balls, dt, cs, from, counts, dv); // 3. clean-up
    }
    // Finally settle every pair of this substep together, inelastically, so a
    // ball driven back into one it has already bounced off cannot overlap it.
    if (cs.length > 0) {
      for (const c of cs) c.acc = 0;
      solveInelastic(balls, dt, cs, 0, counts, dv);
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

/** One ball↔ball contact for the current substep's velocity solve. */
interface Contact {
  i: number;
  j: number;
  /** Unit normal, ball j → ball i, frozen at first detection. */
  nx: number;
  ny: number;
  /** Restitution for this contact (0 below the min-speed gate). */
  e: number;
  /** Normal impulse applied so far in the current phase (per unit mass). */
  acc: number;
  /** Compression impulse from phase 1 — the basis of the Poisson bounce. */
  comp: number;
}

/** Contacts per ball WITHIN the layer starting at `from` (for the Jacobi share). */
function countContacts(cs: Contact[], from: number, counts: Int32Array): void {
  counts.fill(0);
  for (let k = from; k < cs.length; k++) {
    counts[cs[k].i]++;
    counts[cs[k].j]++;
  }
}

/**
 * Append every pair that is touching (at the predicted positions) and
 * approaching, and that isn't already in this substep's contact list. `slot`
 * maps a pair to its contact, so a pair is created once per substep.
 */
function detectContacts(
  balls: BallState[],
  dt: number,
  cs: Contact[],
  slot: Int32Array,
  onNew: (a: BallState, b: BallState) => void
): void {
  const n = balls.length;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (slot[i * n + j] >= 0 || !detectContact(balls[i], balls[j], dt)) continue;
      const b1 = balls[i];
      const b2 = balls[j];
      const approach = -((b1.vx - b2.vx) * contactNx + (b1.vy - b2.vy) * contactNy);
      slot[i * n + j] = cs.length;
      cs.push({
        i,
        j,
        nx: contactNx,
        ny: contactNy,
        e: approach < MIN_COLLISION_SPEED ? 0 : BALL_RESTITUTION,
        acc: 0,
        comp: 0,
      });
      onNew(b1, b2);
    }
  }
}

function applyDv(balls: BallState[], dv: Float64Array): void {
  for (let k = 0; k < balls.length; k++) {
    const ix = dv[2 * k];
    const iy = dv[2 * k + 1];
    if (ix !== 0 || iy !== 0) {
      balls[k].vx += ix;
      balls[k].vy += iy;
      balls[k].moving = true;
    }
  }
}

/** Jacobi-iterate the contacts from `from` onward to zero approach speed. */
function solveInelastic(
  balls: BallState[],
  dt: number,
  cs: Contact[],
  from: number,
  counts: Int32Array,
  dv: Float64Array
): void {
  if (cs.length === from) return;
  countContacts(cs, from, counts);
  for (let it = 0; it < VELOCITY_ITERATIONS; it++) {
    dv.fill(0);
    let worst = 0;
    for (let k = from; k < cs.length; k++) {
      worst = Math.max(worst, contactImpulse(balls, cs[k], counts, dv));
    }
    applyDv(balls, dv);
    if (worst < SOLVE_TOLERANCE) return; // converged
  }
}

/** Phase 2: each contact's bounce, e × its compression impulse, plus friction. */
function restitutionImpulse(balls: BallState[], c: Contact, counts: Int32Array, dv: Float64Array): void {
  // Inside a cluster (the rack) the bounce is scaled by PACK_RESTITUTION_SCALE.
  const pack = counts[c.i] > 1 || counts[c.j] > 1 ? PACK_RESTITUTION_SCALE : 1;
  const jn = c.e * pack * c.comp;
  if (jn <= 0) return;
  const b1 = balls[c.i];
  const b2 = balls[c.j];
  const rvx = b1.vx - b2.vx;
  const rvy = b1.vy - b2.vy;
  const vn = rvx * c.nx + rvy * c.ny;
  let ix = jn * c.nx;
  let iy = jn * c.ny;
  const tvx = rvx - vn * c.nx;
  const tvy = rvy - vn * c.ny;
  const tv = Math.sqrt(tvx * tvx + tvy * tvy);
  if (tv > 1e-9) {
    const share = 1 / Math.max(counts[c.i], counts[c.j]);
    const jt = Math.min((tv / 2) * share, BALL_BALL_FRICTION * jn);
    ix -= (jt * tvx) / tv;
    iy -= (jt * tvy) / tv;
  }
  dv[2 * c.i] += ix;
  dv[2 * c.i + 1] += iy;
  dv[2 * c.j] -= ix;
  dv[2 * c.j + 1] -= iy;
}

/**
 * Phase-1/3 contact solve: drive the pair's approach speed to zero, with a
 * Coulomb friction impulse on the tangent (what makes cut shots and throw
 * behave). The bounce itself is added separately (restitutionImpulse).
 *
 * Reads velocities, never writes them: the impulse goes into `dv` and the
 * caller applies every contact of the pass together. Each contact moves by
 * 1 / max(contacts on either ball) of its remaining error, so several contacts
 * on one ball don't all overshoot from the same snapshot. The same impulse
 * goes to both balls, so momentum is conserved exactly. Returns the size of
 * this iteration's normal correction (for the convergence test).
 */
function contactImpulse(balls: BallState[], c: Contact, counts: Int32Array, dv: Float64Array): number {
  const b1 = balls[c.i];
  const b2 = balls[c.j];
  const { nx, ny } = c;
  const rvx = b1.vx - b2.vx;
  const rvy = b1.vy - b2.vy;
  const vn = rvx * nx + rvy * ny;
  const share = 1 / Math.max(counts[c.i], counts[c.j]);

  // Normal, toward zero approach speed: equal masses ⇒ effective mass 1/2.
  // Accumulated and clamped at 0 — a contact can push but never pull.
  const want = (-vn / 2) * share;
  const acc = Math.max(0, c.acc + want);
  const jn = acc - c.acc;
  c.acc = acc;
  c.comp = acc;
  let ix = jn * nx;
  let iy = jn * ny;

  // Tangential (Coulomb) friction — what makes cut shots and throw behave.
  // Bounded by µ × this iteration's normal impulse, so the total stays within
  // µ × the total normal impulse.
  if (jn > 0) {
    const tvx = rvx - vn * nx;
    const tvy = rvy - vn * ny;
    const tv = Math.sqrt(tvx * tvx + tvy * tvy);
    if (tv > 1e-9) {
      const jt = Math.min((tv / 2) * share, BALL_BALL_FRICTION * jn);
      ix -= (jt * tvx) / tv;
      iy -= (jt * tvy) / tv;
    }
  }

  dv[2 * c.i] += ix;
  dv[2 * c.i + 1] += iy;
  dv[2 * c.j] -= ix;
  dv[2 * c.j + 1] -= iy;
  return Math.abs(jn);
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
    // Real geometry: the ball drops once its centre crosses the line between
    // the jaw tips, between those tips. Anything arriving off-line hits a jaw
    // first (bounceOffJaw) instead of being swallowed.
    const dx = x - hole.mx;
    const dy = y - hole.my;
    if (dx * hole.tx + dy * hole.ty <= 0) continue; // not past the mouth yet
    // Clear passage: the ball fits between the jaws only if its centre is
    // within half the mouth MINUS its own radius. Anything wider clips a jaw.
    if (Math.abs(dx * hole.ux + dy * hole.uy) > hole.mouth / 2 - G.BALL_RADIUS) continue;
    if (inwardSpeed(ball, hole) < POCKET_MIN_INWARD) continue; // nudged, not potted
    return hole;
  }
  return null;
}

/**
 * Bounce off a cushion (or a jaw) along the unit normal (nx, ny).
 * The bounce shrinks as the ball arrives harder (cushionRestitution), and
 * friction along the cushion is Coulomb-limited: it can only take µ × the
 * normal impulse, so a shallow ball slides along the rail keeping its pace
 * while a square hit loses more. Both together are what stops the cushion
 * behaving like a mirror.
 */
function cushionBounce(ball: BallState, nx: number, ny: number): void {
  const vn = ball.vx * nx + ball.vy * ny; // negative = into the cushion
  if (vn >= 0) return;
  const e = cushionRestitution(vn);
  const tx = -ny;
  const ty = nx;
  const vtOut = (ball.vx * tx + ball.vy * ty) * (1 - CUSHION_FRICTION);
  const vnOut = -vn * e;
  ball.vx = nx * vnOut + tx * vtOut;
  ball.vy = ny * vnOut + ty * vtOut;
}

/**
 * The cushions stop at the jaw tips, which are rounded. A ball arriving at a
 * mouth off-line clips a tip and rattles instead of dropping — the piece that
 * was missing while pockets were plain capture circles, and the reason cushion
 * shots were being swallowed by the middle pockets.
 * Returns true if a jaw was hit (velocity and position already updated).
 */
function bounceOffJaw(ball: BallState, x: number, y: number): boolean {
  const reach = G.BALL_RADIUS + KNUCKLE_RADIUS;
  for (const hole of G.HOLES) {
    for (const jaw of hole.jaws) {
      const dx = x - jaw.x;
      const dy = y - jaw.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist >= reach || dist < 1e-9) continue;
      const nx = dx / dist;
      const ny = dy / dist;
      if (ball.vx * nx + ball.vy * ny >= 0) continue; // already moving away
      cushionBounce(ball, nx, ny);
      ball.x = jaw.x + nx * reach;
      ball.y = jaw.y + ny * reach;
      return true;
    }
  }
  return false;
}

/** Is the top/bottom cushion open at this x — a pocket mouth, not rubber? */
function railOpenX(x: number, ty: -1 | 1): boolean {
  for (const hole of G.HOLES) {
    if (hole.tx === 0) {
      if (hole.ty === ty && Math.abs(x - hole.mx) < hole.mouth / 2) return true;
    } else if (hole.ty === ty) {
      const tip = hole.jaws[0]; // the tip on this cushion
      if (hole.tx < 0 ? x < tip.x : x > tip.x) return true;
    }
  }
  return false;
}

/** Is the left/right cushion open at this y? */
function railOpenY(y: number, tx: -1 | 1): boolean {
  for (const hole of G.HOLES) {
    if (hole.tx === 0 || Math.sign(hole.tx) !== tx) continue;
    const tip = hole.jaws[1]; // the tip on this cushion
    if (hole.ty < 0 ? y < tip.y : y > tip.y) return true;
  }
  return false;
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

  // Geometric capture: past the mouth line, between the jaw tips.
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

  // Cushions: normal restitution + tangential friction (spec §3). Clamped to
  // the ball's actual drawn radius, not the old (larger) BALL_ORIGIN — that
  // mismatch left a visible gap of felt between a resting ball and the rail.
  // The top/bottom rails skip the bounce across a middle-pocket mouth so the
  // ball rolls into the throat (captured above) instead of rebounding.
  // A jaw tip is hit before any cushion, and ends the step.
  if (bounceOffJaw(ball, newX, newY)) {
    events.push({ type: "cushion", ballId: ball.id, step });
    return;
  }

  let collision = false;
  if (newX - G.BALL_RADIUS < G.LEFT_BORDER_X && !railOpenY(newY, -1)) {
    cushionBounce(ball, 1, 0);
    ball.x = G.LEFT_BORDER_X + G.BALL_RADIUS;
    collision = true;
  } else if (newX + G.BALL_RADIUS > G.RIGHT_BORDER_X && !railOpenY(newY, 1)) {
    cushionBounce(ball, -1, 0);
    ball.x = G.RIGHT_BORDER_X - G.BALL_RADIUS;
    collision = true;
  }
  if (newY - G.BALL_RADIUS < G.TOP_BORDER_Y && !railOpenX(newX, -1)) {
    cushionBounce(ball, 0, 1);
    ball.y = G.TOP_BORDER_Y + G.BALL_RADIUS;
    collision = true;
  } else if (newY + G.BALL_RADIUS > G.BOTTOM_BORDER_Y && !railOpenX(newX, 1)) {
    cushionBounce(ball, 0, -1);
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
