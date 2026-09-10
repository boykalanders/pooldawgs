// ─────────────────────────────────────────────────────────────────────────
// POOL DAWGS — PHYSICS SPEC V0.1 (calibrated to the fork's pixel geometry)
//
// The spec is written in SI units (mm, kg, m, m/s). This engine inherits the
// fork's FIXED pixel geometry (rack layout, pocket positions and the canvas
// renderer all depend on it), so we keep the geometry and translate the spec's
// DIMENSIONLESS coefficients directly, while CALIBRATING the velocity/friction
// scale so the spec's distance targets (3–4 table lengths on full power,
// 20–50 cm draw, ~25 cm follow) hold in pixels. scripts/playtest.mjs measures
// every checklist item against these values — tune there, not by eye.
//
// Changing ANY value here changes the deterministic outcome: server and client
// must run identical constants or replays desync.
// ─────────────────────────────────────────────────────────────────────────

/**
 * Physics version (spec §1.2). Stamped onto every ShotResult so a match or a
 * replay records which constants produced it. NEVER change constants for an
 * active match or an existing replay — bump this instead.
 *   v1 = the original calibration (pre 9 Sep 2026)
 *   v2 = real per-pair contact friction, explicit rolling resistance,
 *        static-stop hysteresis, adaptive substepping
 */
export const PHYSICS_VERSION = "pooldawgs-v3";

export const TABLE_WIDTH = 1500;
export const TABLE_HEIGHT = 825;

/** Minimum centre distance treated as a ball-ball collision (= 1 diameter). */
export const BALL_SIZE = 38;
/** Physical ball radius in px (spec: 28.575 mm). */
export const BALL_RADIUS = BALL_SIZE / 2;
export const BORDER_SIZE = 57;
export const HOLE_RADIUS = 46;

export const LEFT_BORDER_X = BORDER_SIZE;
export const RIGHT_BORDER_X = TABLE_WIDTH - BORDER_SIZE;
export const TOP_BORDER_Y = BORDER_SIZE;
export const BOTTOM_BORDER_Y = TABLE_HEIGHT - BORDER_SIZE;

// ── unit scale ──────────────────────────────────────────────────────────
/** Cushion-to-cushion playing length = 1 table length (spec 8-ball 2.54 m). */
export const PLAY_LENGTH_PX = RIGHT_BORDER_X - LEFT_BORDER_X; // 1386
/** Pixel ↔ metre conversion derived from the 8-ball table length. */
export const PX_PER_M = PLAY_LENGTH_PX / 2.54; // ≈ 545.7

// ── update rate (spec §9: target 120 Hz) ─────────────────────────────────
export const PHYSICS_FPS = 120;
export const DELTA = 1 / PHYSICS_FPS;
/** Wall-clock duration of one sim step (ms) — the web replay uses this. */
export const STEP_MS = 1000 / PHYSICS_FPS;

// ── cue power (spec §7: non-linear, power = input^1.4) ────────────────────
export const MAX_POWER = 75; // input scale the UI sends (0–75)
export const POWER_EXPONENT = 1.4;
/**
 * Launch speed at full power (px/s) = 8.5 m/s, the SAME physical speed the Havok
 * backend uses (spec §12 parity). Was 9600 px/s ≈ 17.6 m/s — roughly twice a real
 * break, which is why the TS backend needed unphysical drag to stop a ball and
 * still felt different from the server. A real cue-ball break tops out ~7–8 m/s.
 */
export const MAX_SHOT_SPEED = 8.5 * PX_PER_M; // ≈ 4638 px/s

// ── cloth friction (spec §4: ≈3–4 table lengths on full power) ────────────
// Constant-deceleration rolling model (real billiards) rather than the fork's
// exponential decay: a fixed speed loss per second (Coulomb rolling
// resistance) plus a small viscous term, so balls roll a long way then settle
// rather than gliding forever.
// Two-term model: viscous drag (speed-proportional) bleeds the high-speed
// glide and sets the full-power distance; a SMALL constant rolling resistance
// gives the gentle final roll-out. Keeping ROLL_DECEL low is what makes balls
// ease to rest instead of halting abruptly (client feedback: "the way it
// stops"); the stop threshold is low so the settle reads as smooth.
export const ROLL_DECEL = 420; // px/s² constant deceleration (spec §4.4: 180–220)
export const VISCOUS_DRAG = 0.998; // residual per-step drag (spec §4.4: 0.997–0.999)
/** Below this speed (px/s) a ball is considered stopped. */
export const STOP_THRESHOLD = 2.5;

// ── rolling resistance & static stop (spec §4) ────────────────────────────
// Damping alone is velocity-proportional, so it gets weaker exactly when a ball
// is nearly stopped — that is what produced the residual low-speed drift. The
// cloth is now modelled as a CONSTANT deceleration a = µ_r·g (Coulomb rolling
// resistance) with a separate static-stop threshold, and damping is demoted to a
// small residual term.
export const GRAVITY_MS2 = 9.81;
/** Cloth rolling-resistance coefficient, per variant (spec §3.1 / §3.2). */
export const POOL_ROLLING_RESISTANCE = 0.022;
export const SNOOKER_ROLLING_RESISTANCE = 0.025;
/** Rolling resistance applies above this speed (m/s). */
export const ROLLING_STOP_SPEED_MS = 0.01;
/** Below this speed (m/s) a ball counts toward a static stop. */
export const STATIC_STOP_SPEED_MS = 0.004;
/** Consecutive steps below STATIC_STOP_SPEED before the ball is pinned. */
export const STATIC_STOP_STEPS = 10;
/** TS equivalent of STATIC_STOP_SPEED, in px/s (spec §4.4: 1.5–2.5). */
export const TS_STATIC_STOP_SPEED = 2.0;

// ── restitution (spec §3, §5) ─────────────────────────────────────────────
/** Ball-ball restitution (spec 0.93). */
export const BALL_RESTITUTION = 0.93;
/** Ball-ball Coulomb friction — polished phenolic is slick (spec §3.1: 0.055).
 *  Matches the Havok ball material, so cut shots throw the same on both. */
export const BALL_BALL_FRICTION = 0.06;

// ── iterative contact solving (spec §6) ───────────────────────────────────
// One pass in a fixed order let a cluster push itself toward a cushion and
// leave residual overlap. Contacts are now solved iteratively, and overlap is
// corrected with a slop + partial correction rather than by injecting velocity.
export const VELOCITY_ITERATIONS = 6;
export const POSITION_ITERATIONS = 8;
/** Overlap tolerated before positional correction acts (spec §6.3: 1–3 mm). */
export const CONTACT_SLOP = 0.002 * PX_PER_M; // ≈ 1.1 px
/** Fraction of the remaining overlap resolved per position iteration. */
export const POSITIONAL_CORRECTION = 0.2;
/** Cushion normal restitution. Lowered 0.88 → 0.72 to match the Havok rail and
 *  the fix-spec's 0.70 target (§7.2, §12 parity): at 0.88 a full-power ball kept
 *  ~28% of its speed through 10 banks and pinballed for ~10 table lengths. */
export const CUSHION_RESTITUTION = 0.72;
/** Cushion tangential friction (spec 0.12) — natural angle bleed off the rail. */
export const CUSHION_FRICTION = 0.12;
/** Below this relative normal speed a contact is resolved inelastically
 *  (no bounce) to prevent jitter/micro-bouncing (spec 0.02 m/s). */
export const MIN_COLLISION_SPEED = 0.02 * PX_PER_M; // ≈ 11 px/s

// ── spin / english (spec §8) ──────────────────────────────────────────────
/** Follow (top spin) impulse as a fraction of cue speed at first contact. */
export const TOP_SPIN = 0.2;
/** Draw (back spin) impulse fraction (applied with a negative sign). */
export const BACK_SPIN = 0.32;
/** Side english authority — tangential velocity added per cushion bounce. */
export const SIDE_ENGLISH = 0.18;
/** Spin imparted to the object ball on contact ("throw"). */
export const SPIN_TRANSFER = 0.15;
/** Spin retained per sim step (spec: spin *= 0.985 per frame). */
export const SPIN_DECAY = 0.985;
/** Side spin retained after each cushion bounce. */
export const SPIN_SIDE_DECAY = 0.6;

// ── anti-tunneling substeps ───────────────────────────────────────────────
// A full-power shot moves far per step — more than the 38px collision
// diameter — so each step is subdivided until no ball travels more than
// SUBSTEP_TRAVEL px between collision checks. Friction stays per OUTER step.
// Spec §8.2: a ball may never travel more than one-fifth of its DIAMETER
// between collision checks. Expressed as a fraction so it stays correct after
// any ball-size migration (was a flat 12 px ≈ 0.32 diameters — too coarse).
export const SUBSTEP_TRAVEL_FRACTION = 0.2;
export const MAX_SUBSTEPS = 24;

/** Hard cap on settle time so a shot can never simulate forever. */
export const MAX_STEPS = 12000;

export const SHOT_VELOCITY_FACTOR = MAX_SHOT_SPEED; // back-compat alias

// ── pockets (spec §6, §10) ───────────────────────────────────────────────
// The fork captured any ball whose centre entered a circular hole, so balls
// SKIMMING a rail past a centre pocket got vacuumed in ("too forgiving",
// spec §6). We add a directional gate: a ball only drops if it is actually
// travelling INTO the throat (within the pocket's acceptance cone and above a
// minimum inward speed). Magnetism (spec §10) then nudges near-perfect shots
// that are on-line so they drop satisfyingly.

export interface Hole {
  x: number;
  y: number;
  radius: number;
  /** Unit vector pointing from the table interior INTO the pocket throat. */
  tx: number;
  ty: number;
  /** cos(acceptance half-angle): a ball's inward direction must exceed this. */
  acceptCos: number;
}

const SQRT1_2 = Math.SQRT1_2;
/** Corners are fed by two rails — a generous cone (spec §6: 8°, widened for
 *  the fork's coarser geometry so legitimate cut pots still drop). Exported so
 *  geometry.ts's per-variant buildHoles() (snooker) shares the exact same
 *  cones instead of re-deriving them and drifting out of sync. */
export const CORNER_ACCEPT = Math.cos((52 * Math.PI) / 180);
/** Centre pockets get a tighter cone than corners — this is what rejects the
 *  rail-skimmers the fork wrongly captured. Widened over time on client feedback
 *  that the middle pocket felt too narrow (26° → 31° → 40°); the min-inward-speed
 *  gate, not this cone, is what still rejects true rail-skims. */
export const SIDE_ACCEPT = Math.cos((40 * Math.PI) / 180);

/** Centre-pocket mouth radius — bigger than a corner so the generous side
 *  pocket takes the ball easily (also widens the rail gap and the drawn mouth). */
export const MIDDLE_RADIUS = 64;

export const HOLES: readonly Hole[] = [
  { x: 62, y: 62, radius: HOLE_RADIUS, tx: -SQRT1_2, ty: -SQRT1_2, acceptCos: CORNER_ACCEPT }, // top left
  { x: 1435, y: 62, radius: HOLE_RADIUS, tx: SQRT1_2, ty: -SQRT1_2, acceptCos: CORNER_ACCEPT }, // top right
  { x: 62, y: 762, radius: HOLE_RADIUS, tx: -SQRT1_2, ty: SQRT1_2, acceptCos: CORNER_ACCEPT }, // bottom left
  { x: 1435, y: 762, radius: HOLE_RADIUS, tx: SQRT1_2, ty: SQRT1_2, acceptCos: CORNER_ACCEPT }, // bottom right
  { x: 750, y: 36, radius: MIDDLE_RADIUS, tx: 0, ty: -1, acceptCos: SIDE_ACCEPT }, // top centre
  { x: 750, y: 789, radius: MIDDLE_RADIUS, tx: 0, ty: 1, acceptCos: SIDE_ACCEPT }, // bottom centre
];

/** Minimum inward speed (px/s) to be captured — rejects a ball that has all
 *  but stopped at the jaw. The acceptance cone (not this) rejects directional
 *  rail-skims, so this stays low enough that soft on-line pots still drop. */
export const POCKET_MIN_INWARD = 35;
/** Capture-zone multiplier: magnetism engages within radius × this. */
export const POCKET_MAGNET_RANGE = 1.35;
/** Per-substep steer toward the pocket centre for on-line shots (spec §10). */
export const POCKET_MAGNETISM = 0.02;

export const CUE_BALL_START = { x: 413, y: 413 };

/** Where pocketed balls are parked, mirroring Ball.out() in the fork. */
export const POCKETED_PARK = { x: 0, y: 900 };
