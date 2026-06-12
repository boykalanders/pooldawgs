// Constants ported verbatim from the forked Classic-Pool-Game
// (Global.js, GamePolicy.js, GameWorld.js). Changing any of these breaks
// replay-compatibility between server and client simulations.

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
export const BALL_COLLISION_DAMPING = 0.97;
export const COLLISION_POWER_FACTOR = 0.00482;
export const COLLISION_IMPULSE = 90;
export const SHOT_VELOCITY_FACTOR = 100;
export const STOP_THRESHOLD = 1;

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

/** Pocket centres from GamePolicy.js; centre pockets get +6 radius as in the fork. */
export const HOLES: readonly Hole[] = [
  { x: 62, y: 62, radius: HOLE_RADIUS }, // top left
  { x: 1435, y: 62, radius: HOLE_RADIUS }, // top right
  { x: 62, y: 762, radius: HOLE_RADIUS }, // bottom left
  { x: 1435, y: 762, radius: HOLE_RADIUS }, // bottom right
  { x: 750, y: 32, radius: HOLE_RADIUS + 6 }, // top centre
  { x: 750, y: 794, radius: HOLE_RADIUS + 6 }, // bottom centre
];

export const CUE_BALL_START = { x: 413, y: 413 };

/** Where pocketed balls are parked, mirroring Ball.out() in the fork. */
export const POCKETED_PARK = { x: 0, y: 900 };
