// Simulation constants — mostly from the forked Classic-Pool-Game
// (Global.js, GamePolicy.js, GameWorld.js), with deliberate upgrades noted
// inline (elastic collisions, centre-pocket capture). Changing ANY of these
// breaks replay-compatibility: server and client must run the same values.

export const TABLE_WIDTH = 1500;
export const TABLE_HEIGHT = 825;

/** Minimum centre distance treated as a ball-ball collision. */
export const BALL_SIZE = 38;
/** Half sprite size; used for cushion clamping, as in the fork. */
export const BALL_ORIGIN = 25;
export const BORDER_SIZE = 57;
export const HOLE_RADIUS = 46;

/** Fixed simulation timestep (100 Hz). */
export const DELTA = 1 / 100;

export const FRICTION_PER_STEP = 0.98;
export const CUSHION_DAMPING = 0.95;
/**
 * Ball-ball restitution for the elastic collision model. This replaces the
 * fork's non-physical symmetric shove (total-speed × 0.00482 × 90 applied to
 * both balls) with real momentum exchange along the contact normal — head-on
 * shots stop the cue ball, cut shots split correctly.
 */
export const BALL_RESTITUTION = 0.94;
export const SHOT_VELOCITY_FACTOR = 100;
export const STOP_THRESHOLD = 1;

/**
 * Anti-tunneling substeps. A full-power shot moves 75px per 1/100s step —
 * twice the 38px collision diameter — so each step is subdivided until no
 * ball travels more than SUBSTEP_TRAVEL px between collision checks.
 * Friction stays per OUTER step, so slow shots behave exactly as before.
 */
export const SUBSTEP_TRAVEL = 12;
export const MAX_SUBSTEPS = 12;

export const MAX_POWER = 75;

// Spin model (PoolDawgs extension; the fork had no spin).
/** Follow/draw impulse as a fraction of cue speed at first contact. */
export const SPIN_FOLLOW_FACTOR = 0.5;
/** Tangential velocity added per cushion bounce, scaled by impact speed. */
export const SPIN_SIDE_FACTOR = 0.35;
/** Side spin retained after each cushion bounce. */
export const SPIN_SIDE_DECAY = 0.55;

/** Hard cap on settle time so a shot can never simulate forever. */
export const MAX_STEPS = 10000;

export const LEFT_BORDER_X = BORDER_SIZE;
export const RIGHT_BORDER_X = TABLE_WIDTH - BORDER_SIZE;
export const TOP_BORDER_Y = BORDER_SIZE;
export const BOTTOM_BORDER_Y = TABLE_HEIGHT - BORDER_SIZE;

export interface Hole {
  x: number;
  y: number;
  radius: number;
}

/**
 * Pocket capture zones. Corners keep the fork's GamePolicy.js values (they
 * play fine). The fork's CENTRE pockets sat so deep under the rail — (750,32)
 * and (750,794), radius 52 — that a cushion-hugging ball (centre clamped to
 * y 82/743) had a capture window of only ~29px / ~20px: visually a hole,
 * functionally a wall. They are deliberately retuned — recessed into the
 * rail but still honouring the drawn mouth (~48px capture window along the
 * rail, ≈1.3 ball diameters).
 */
export const HOLES: readonly Hole[] = [
  { x: 62, y: 62, radius: HOLE_RADIUS }, // top left
  { x: 1435, y: 62, radius: HOLE_RADIUS }, // top right
  { x: 62, y: 762, radius: HOLE_RADIUS }, // bottom left
  { x: 1435, y: 762, radius: HOLE_RADIUS }, // bottom right
  { x: 750, y: 36, radius: 52 }, // top centre
  { x: 750, y: 789, radius: 52 }, // bottom centre
];

export const CUE_BALL_START = { x: 413, y: 413 };

/** Where pocketed balls are parked, mirroring Ball.out() in the fork. */
export const POCKETED_PARK = { x: 0, y: 900 };
