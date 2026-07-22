// Havok-backed pool physics (Babylon v2 + Havok WASM), running headless on a
// NullEngine. Produces the SAME ShotResult contract as the deterministic TS
// engine (frames + ordered events + endState), so the variant rules, the
// server room and the renderer are all unchanged — only the physics core is
// swapped. Spin (follow/draw/english) is REAL here: it's initial angular
// velocity on the cue ball, and the cloth-contact friction does the rest.
//
// Determinism note: Havok is deterministic on a single machine with a fixed
// timestep and fixed body-creation order (true here), but NOT bit-identical
// across machines. PoolDawgs stays sound because the SERVER is the sole
// authority — it simulates and broadcasts the trajectory; clients replay it.

import { NullEngine } from "@babylonjs/core/Engines/nullEngine.js";
import { Scene } from "@babylonjs/core/scene.js";
import { Vector3 } from "@babylonjs/core/Maths/math.vector.js";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode.js";
import { HavokPlugin } from "@babylonjs/core/Physics/v2/Plugins/havokPlugin.js";
import { PhysicsBody } from "@babylonjs/core/Physics/v2/physicsBody.js";
import { PhysicsShapeSphere, PhysicsShapeBox } from "@babylonjs/core/Physics/v2/physicsShape.js";
import {
  PhysicsMotionType,
  PhysicsEventType,
} from "@babylonjs/core/Physics/v2/IPhysicsEnginePlugin.js";
import { PhysicsMaterialCombineMode } from "@babylonjs/core/Physics/v2/physicsMaterial.js";
import { Quaternion } from "@babylonjs/core/Maths/math.vector.js";
import "@babylonjs/core/Physics/joinedPhysicsEngineComponent.js";

import {
  MAX_POWER,
  MAX_STEPS,
  POWER_EXPONENT,
  PX_PER_M,
  STEP_MS,
} from "../constants.js";
import { G, geomFor, setActiveGeometry, type TableGeometry } from "../geometry.js";
import { getRules } from "../variants/index.js";
import type {
  BallState,
  Frame,
  GameRules,
  GameType,
  ShotEvent,
  ShotInput,
  ShotResult,
  TableState,
} from "../types.js";

// ── unit helpers: engine works in px; Havok world in metres, Y up ──────────
const M = (px: number) => px / PX_PER_M;
const PX = (m: number) => m * PX_PER_M;
/** Geometry "key" — pool (8/9-ball) and snooker have different table/ball
 *  sizes, so the Havok world is rebuilt when this changes. */
const geomKey = (gameType: GameType): string => (gameType === "snooker" ? "snooker" : "pool");

const DT = 1 / 120; // fixed Havok timestep (matches PHYSICS_FPS)
/** Settle threshold (m/s) — below this a ball is treated as stopped. Kept low
 *  (~1.5 cm/s) so balls EASE to rest instead of snapping to a stop while still
 *  visibly creeping (which read as "stops too soon"). */
const SLEEP_SPEED = M(8);
/** Full-power launch speed (m/s). Real cue-ball break tops out ~7–8 m/s; this
 *  also keeps per-step travel below the rail thickness (no tunnelling). */
const MAX_SPEED_MS = 8.5;
/** Cloth drag — calibrated in scripts/havok-playtest.mjs. Lower = balls carry
 *  further and slow more gently. Kept near the original (0.28) so banks/rebound
 *  stay lively (client liked the rebound); the "heavy/cement" feel was mostly
 *  the cloth FRICTION, eased below. */
const LINEAR_DAMPING = 0.24;
/** Low, so cue-ball spin survives the roll to first contact (draw/follow). */
const ANGULAR_DAMPING = 0.3;
/** Spin authority: multiples of the natural rolling rate (v/R) at full spin. */
const FOLLOW_DRAW_GAIN = 2.0;
const ENGLISH_GAIN = 1.5;

interface BallBody {
  node: TransformNode;
  body: PhysicsBody;
  id: number; // engine ball id, -1 when unused this shot
}

interface HavokWorld {
  scene: Scene;
  step(dt: number): void;
  balls: BallBody[];
  /** body.uniqueId → engine ball id, for the shot in progress. */
  bodyToBall: Map<number, number>;
  /** ordered ball-ball / cushion collisions captured during the current step */
  collisions: Array<{ a: number; b: number } | { rail: number }>;
  /** uniqueIds of the rail bodies for this world (collision tagging). */
  railIds: Set<number>;
  /** "pool" | "snooker" — which geometry this world was built for. */
  geomKey: string;
  /** Ball radius (m) for this world's geometry. */
  R: number;
}

let havokInstance: unknown = null;
let nullEngine: NullEngine | null = null;
let world: HavokWorld | null = null;
let initPromise: Promise<void> | null = null;

/** Where the browser fetches the Havok WASM from (served from /public). */
let browserWasmUrl = "/HavokPhysics.wasm";
export function setHavokWasmUrl(url: string): void {
  browserWasmUrl = url;
}

/** Load the Havok WASM appropriately for Node (file bytes) or the browser. */
async function loadHavok(): Promise<unknown> {
  const factory = (await import("@babylonjs/havok")).default;
  if (typeof window === "undefined") {
    // Node: hand Havok the wasm bytes (Node fetch can't load file://). The
    // webpackIgnore comments keep these node-only imports out of the browser
    // bundle (they're never reached in the browser).
    const { createRequire } = await import(/* webpackIgnore: true */ "node:module");
    const { readFileSync } = await import(/* webpackIgnore: true */ "node:fs");
    const { dirname, join } = await import(/* webpackIgnore: true */ "node:path");
    const require = createRequire(import.meta.url);
    const wasm = join(dirname(require.resolve("@babylonjs/havok")), "HavokPhysics.wasm");
    return factory({ wasmBinary: readFileSync(wasm) as unknown as ArrayBuffer });
  }
  // Browser: fetch the wasm copied into the app's /public.
  return factory({ locateFile: () => browserWasmUrl });
}

/** Build the table + ball pool for one variant's geometry. Replaces `world`. */
function buildWorld(gameType: GameType): void {
  const geom = geomFor(gameType);
  const scene = new Scene(nullEngine!);
  const plugin = new HavokPlugin(true, havokInstance as never);
  scene.enablePhysics(new Vector3(0, -9.81, 0), plugin);

  const railIds = new Set<number>();
  buildFloor(scene, geom);
  buildRails(scene, geom, railIds);

  const collisions: HavokWorld["collisions"] = [];
  const bodyToBall = new Map<number, number>();
  const R = M(geom.BALL_RADIUS);

  // Max balls across variants = snooker's 22.
  const balls: BallBody[] = [];
  for (let i = 0; i < 22; i++) balls.push(makeBall(scene, R));

  plugin.onCollisionObservable.add((ev) => {
    if (ev.type !== PhysicsEventType.COLLISION_STARTED) return;
    const a = bodyToBall.get(ev.collider.transformNode.uniqueId);
    if (a === undefined) return; // collider must be a tracked ball
    const otherId = ev.collidedAgainst.transformNode.uniqueId;
    const b = bodyToBall.get(otherId);
    if (b !== undefined) collisions.push({ a, b });
    else if (railIds.has(otherId)) collisions.push({ rail: a });
  });

  const physicsEngine = scene.getPhysicsEngine()!;
  world = {
    scene,
    step: (dt: number) => physicsEngine._step(dt),
    balls,
    bodyToBall,
    collisions,
    railIds,
    geomKey: geomKey(gameType),
    R,
  };
}

/** Swap the Havok world to the variant's geometry when it changes (e.g. the
 *  bigger snooker table). Rebuilds the scene — cheap and only on a switch. */
function ensureGeometry(gameType: GameType): void {
  if (world && world.geomKey === geomKey(gameType)) return;
  world?.scene.dispose();
  buildWorld(gameType);
}

/** Idempotent — loads the WASM once and builds the default (pool) world. */
export async function initHavok(): Promise<void> {
  if (world) return;
  if (initPromise) return initPromise;
  initPromise = (async () => {
    havokInstance = await loadHavok();
    nullEngine = new NullEngine();
    buildWorld("8ball");
  })();
  return initPromise;
}

export function isHavokReady(): boolean {
  return world !== null;
}

// GEOMETRIC friction combine (√(a·b)): with cloth 0.30 / ball 0.35 the ball↔floor
// coefficient is ≈ 0.32. Eased from 0.8 → 0.45 → 0.38 → 0.30 over three rounds of
// client feedback so balls roll freely (less "cement/heavy" feel); the small
// launch roll (LAUNCH_ROLL) keeps the cue from gliding past object balls without
// needing heavy cloth grip. ball↔rail ≈ 0.15 (clean banks). MINIMUM restitution
// combine: ball↔floor → 0 (no vertical bounce), ball↔rail → 0.88, ball↔ball → 0.93.
const clothMaterial = {
  friction: 0.3,
  restitution: 0,
  frictionCombine: PhysicsMaterialCombineMode.GEOMETRIC_MEAN,
  restitutionCombine: PhysicsMaterialCombineMode.MINIMUM,
};
const railMaterial = {
  friction: 0.1,
  // Real cushions bleed more energy than the spec's 0.88; ~0.72 keeps banks
  // lively but stops the full-power ball ricocheting for ~9 s ("no pinball").
  restitution: 0.72,
  frictionCombine: PhysicsMaterialCombineMode.GEOMETRIC_MEAN,
  restitutionCombine: PhysicsMaterialCombineMode.MINIMUM,
};
const ballMaterial = {
  friction: 0.35,
  restitution: 0.93,
  frictionCombine: PhysicsMaterialCombineMode.GEOMETRIC_MEAN,
  restitutionCombine: PhysicsMaterialCombineMode.MINIMUM,
};

function buildFloor(scene: Scene, geom: TableGeometry): void {
  const node = new TransformNode("floor", scene);
  node.position = new Vector3(M(geom.TABLE_WIDTH) / 2, -0.05, M(geom.TABLE_HEIGHT) / 2);
  const body = new PhysicsBody(node, PhysicsMotionType.STATIC, false, scene);
  const shape = new PhysicsShapeBox(
    new Vector3(0, 0, 0),
    Quaternion.Identity(),
    new Vector3(M(geom.TABLE_WIDTH) + 1, 0.1, M(geom.TABLE_HEIGHT) + 1),
    scene
  );
  shape.material = clothMaterial;
  body.shape = shape;
}

/** Four cushion walls at the inner border lines (pockets are analytic, below). */
function buildRails(scene: Scene, geom: TableGeometry, railIds: Set<number>): void {
  const h = M(geom.BALL_RADIUS) * 10; // wall height — fast balls can't pop over
  const t = M(geom.BORDER_SIZE); // wall thickness
  const left = M(geom.LEFT_BORDER_X);
  const right = M(geom.RIGHT_BORDER_X);
  const top = M(geom.TOP_BORDER_Y);
  const bottom = M(geom.BOTTOM_BORDER_Y);
  const midZ = (top + bottom) / 2;
  const midX = (left + right) / 2;
  const spanZ = bottom - top;
  const spanX = right - left;

  const walls: Array<[number, number, number, number]> = [
    // [centerX, centerZ, extentX, extentZ]
    [left - t / 2, midZ, t, spanZ + t * 2], // left
    [right + t / 2, midZ, t, spanZ + t * 2], // right
    [midX, top - t / 2, spanX + t * 2, t], // top
    [midX, bottom + t / 2, spanX + t * 2, t], // bottom
  ];
  for (const [cx, cz, ex, ez] of walls) {
    const node = new TransformNode("rail", scene);
    node.position = new Vector3(cx, h / 2, cz);
    const body = new PhysicsBody(node, PhysicsMotionType.STATIC, false, scene);
    const shape = new PhysicsShapeBox(
      new Vector3(0, 0, 0),
      Quaternion.Identity(),
      new Vector3(ex, h, ez),
      scene
    );
    shape.material = railMaterial;
    body.shape = shape;
    railIds.add(node.uniqueId);
  }
}

function makeBall(scene: Scene, R: number): BallBody {
  const node = new TransformNode("ball", scene);
  node.position = new Vector3(0, -1000, 0); // parked until a shot uses it
  const body = new PhysicsBody(node, PhysicsMotionType.DYNAMIC, false, scene);
  const shape = new PhysicsShapeSphere(new Vector3(0, 0, 0), R, scene);
  shape.material = ballMaterial;
  body.shape = shape;
  body.setMassProperties({ mass: 0.17 });
  body.setLinearDamping(LINEAR_DAMPING);
  body.setAngularDamping(ANGULAR_DAMPING);
  body.setCollisionCallbackEnabled(true);
  return { node, body, id: -1 };
}

function park(b: BallBody): void {
  b.id = -1;
  b.body.setMotionType(PhysicsMotionType.STATIC);
  b.node.position.set(0, -1000, 0);
  b.body.disablePreStep = false;
  b.body.setLinearVelocity(Vector3.Zero());
  b.body.setAngularVelocity(Vector3.Zero());
}

/** Analytic pocket capture (reuses the calibrated throat gate, per-variant). */
function capturedHole(x: number, y: number, vx: number, vy: number): boolean {
  for (const hole of G.HOLES) {
    const dx = x - hole.x;
    const dy = y - hole.y;
    if (Math.sqrt(dx * dx + dy * dy) >= hole.radius) continue;
    const vIn = vx * hole.tx + vy * hole.ty;
    if (vIn < 35) continue;
    const speed = Math.sqrt(vx * vx + vy * vy);
    if (speed < 1e-6 || vIn / speed < hole.acceptCos) continue;
    return true;
  }
  return false;
}

/**
 * Simulate one shot with Havok. Pure w.r.t. the engine's TableState (the input
 * is not mutated); the Havok world is reused across calls for performance.
 */
export function simulateShotHavok(
  state: TableState,
  shot: ShotInput,
  opts: { recordFrames?: boolean; frameStride?: number } = {}
): ShotResult {
  if (!world) throw new Error("Havok not initialised — call initHavok() first");
  ensureGeometry(state.gameType); // rebuild the table for snooker's bigger size
  setActiveGeometry(state.gameType); // capturedHole() reads G.HOLES
  const w = world!; // ensureGeometry guarantees a world
  const R = w.R; // ball radius (m) for this variant's geometry
  const rules: GameRules<unknown> = getRules(state.gameType);
  const turnAcc = rules.createTurn();
  const events: ShotEvent[] = [];
  const frames: Frame[] | undefined = opts.recordFrames ? [] : undefined;
  const frameStride = opts.frameStride ?? 2;

  const next: TableState = {
    ...state,
    balls: state.balls.map((b) => ({ ...b })),
    playerColors: [state.playerColors[0], state.playerColors[1]],
    scores: [state.scores[0], state.scores[1]],
  };
  const cueIdx = next.balls.length - 1;

  // Place this shot's balls onto the reusable bodies. Reusing a dynamic body
  // requires a pre-step sync to adopt the new transform, so we set positions
  // with disablePreStep=false, run one zero-velocity warmup step to apply them
  // (and let balls rest on the cloth), then free-simulate.
  w.bodyToBall.clear();
  const active: BallBody[] = [];
  for (let i = 0; i < w.balls.length; i++) {
    const bb = w.balls[i];
    const ball = next.balls[i];
    if (!ball || ball.inHole) {
      park(bb);
      continue;
    }
    bb.id = ball.id;
    bb.body.setMotionType(PhysicsMotionType.DYNAMIC);
    bb.node.position.set(M(ball.x), R, M(ball.y));
    bb.node.rotationQuaternion = Quaternion.Identity();
    bb.node.computeWorldMatrix(true);
    bb.body.disablePreStep = false;
    bb.body.setLinearVelocity(Vector3.Zero());
    bb.body.setAngularVelocity(Vector3.Zero());
    w.bodyToBall.set(bb.node.uniqueId, ball.id);
    active.push(bb);
  }
  // Warmup: apply the placement, then hand control to the solver.
  w.collisions.length = 0;
  w.step(DT);
  for (const bb of active) bb.body.disablePreStep = true;

  // Launch the cue ball: linear velocity from the power curve, plus spin as
  // angular velocity (topspin = follow, backspin = draw, vertical = english).
  const p = Math.min(1, shot.power / MAX_POWER);
  const speed = MAX_SPEED_MS * Math.pow(p, POWER_EXPONENT);
  const dirx = Math.cos(shot.angle);
  const diry = Math.sin(shot.angle);
  const cueBody = w.balls[cueIdx]?.body;
  if (cueBody) {
    cueBody.setLinearVelocity(new Vector3(dirx * speed, 0, diry * speed));
    const spinY = shot.spinY ?? 0; // follow(+)/draw(-)
    const spinX = shot.spinX ?? 0; // english
    const rollRate = speed / R; // natural rolling angular rate
    // A centre-ball hit launches the cue SLIDING (no initial roll), like real
    // pool: cloth friction builds the forward roll over distance, so a close /
    // straight hit STUNS (the cue stops on contact) and only a longer approach
    // rolls into a follow-through. Deliberate follow(+)/draw(−) ride on top via
    // spinY (draw exceeds the roll rate so the cue reverses after contact).
    const followAxis = new Vector3(diry, 0, -dirx); // forward-roll axis
    const ang = followAxis.scale(rollRate * FOLLOW_DRAW_GAIN * spinY);
    ang.y = rollRate * ENGLISH_GAIN * spinX; // english about vertical
    cueBody.setAngularVelocity(ang);
  }

  let steps = 0;
  let moving = true;
  let slowStreak = 0;
  // Require sustained low speed before declaring settle — otherwise the
  // momentary zero-velocity at a cushion rebound or ball-ball contact would
  // end the shot mid-bounce.
  const SETTLE_STREAK = 10;
  // Sub-step the solver: at a single 1/120 step a max-power ball (8.5 m/s) moves
  // ~7 cm — more than a ball diameter — so on contact it penetrated deeply and
  // the solver ejected the pair (visible "jump") or couldn't separate them in
  // one step ("stick"). Stepping at 1/240 keeps per-step travel under a ball
  // radius, so contacts resolve cleanly. Collisions accumulate across substeps.
  const SUBSTEPS = 2;
  // Stun assist: a struck cue naturally rolls up over the approach, and a
  // rolling cue FOLLOWS the object after contact — which reads as the cue
  // "trailing" the object on an ordinary straight hit. On a shot with no
  // deliberate follow/draw, kill the cue's forward roll at its first object
  // contact so it stuns (stops on a full hit, runs the tangent on a cut) like a
  // clean stun shot. Deliberate follow/draw (spinY) launch with strong spin and
  // are left untouched, and side english (the angular y-axis) is preserved.
  const isStunShot = Math.abs(shot.spinY ?? 0) < 0.15;
  const cueId = next.balls[cueIdx]?.id;
  let cueRollKilled = false;
  while (moving && steps < MAX_STEPS) {
    w.collisions.length = 0;
    for (let s = 0; s < SUBSTEPS; s++) w.step(DT / SUBSTEPS);

    // Emit collisions captured this step, in order, and feed the rules.
    for (const c of w.collisions) {
      if ("rail" in c) {
        events.push({ type: "cushion", ballId: c.rail, step: steps });
      } else {
        const a = next.balls[c.a];
        const b = next.balls[c.b];
        events.push({ type: "ballsCollide", a: c.a, b: c.b, step: steps });
        if (a && b) rules.onBallsCollide(next, turnAcc, a, b);
        if (isStunShot && !cueRollKilled && (c.a === cueId || c.b === cueId)) {
          const cb = w.balls[cueIdx]?.body;
          if (cb) {
            const av = cb.getAngularVelocity();
            cb.setAngularVelocity(new Vector3(0, av.y, 0)); // drop follow-roll, keep english
          }
          cueRollKilled = true;
        }
      }
    }

    // Sync positions back to engine px-space; capture pockets; test settle.
    let anyFast = false;
    for (const bb of w.balls) {
      if (bb.id < 0) continue;
      const ball = next.balls[bb.id];
      if (!ball || ball.inHole) continue;
      const x = PX(bb.node.position.x);
      const y = PX(bb.node.position.z);
      const lv = bb.body.getLinearVelocity();
      const vx = PX(lv.x);
      const vy = PX(lv.z);
      ball.x = x;
      ball.y = y;
      ball.vx = vx;
      ball.vy = vy;

      if (capturedHole(x, y, vx, vy)) {
        ball.inHole = true;
        ball.moving = false;
        ball.vx = 0;
        ball.vy = 0;
        events.push({ type: "pocket", ballId: ball.id, color: ball.color, step: steps });
        rules.onPocket(next, turnAcc, ball);
        park(bb);
        continue;
      }

      const spd = Math.sqrt(lv.x * lv.x + lv.z * lv.z);
      ball.moving = spd > SLEEP_SPEED;
      if (ball.moving) anyFast = true;
    }
    slowStreak = anyFast ? 0 : slowStreak + 1;
    moving = slowStreak < SETTLE_STREAK;

    steps++;
    if (frames && steps % frameStride === 0) frames.push(snapshot(next, steps));
  }
  if (frames) frames.push(snapshot(next, steps));

  // Freeze any residually-creeping balls so the end state is clean.
  for (const ball of next.balls) {
    ball.moving = false;
    if (!ball.inHole) {
      ball.vx = 0;
      ball.vy = 0;
    }
  }

  const resolution = rules.resolve(next, turnAcc);
  next.gameOver = resolution.gameOver;
  next.winner = resolution.winner;
  next.turn = resolution.nextTurn;
  next.ballInHand = resolution.ballInHand;

  return { endState: next, events, outcome: resolution, frames, steps };
}

function snapshot(state: TableState, step: number): Frame {
  return {
    step,
    balls: state.balls.map((b) => ({ id: b.id, x: b.x, y: b.y, visible: !b.inHole })),
  };
}

/** Wall-clock ms per recorded frame at the given stride (for the renderer). */
export const HAVOK_STEP_MS = STEP_MS;
