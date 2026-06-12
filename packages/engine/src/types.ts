/** Ball groups. The fork uses UK-style red/yellow sets rather than solids/stripes. */
export type BallColor = "white" | "black" | "red" | "yellow";

export type PlayerIndex = 0 | 1;

export interface BallState {
  /** Stable index into the rack (15 = cue ball). */
  id: number;
  color: BallColor;
  x: number;
  y: number;
  vx: number;
  vy: number;
  moving: boolean;
  inHole: boolean;
}

/** A shot: aim angle (radians), stick power (0–75) and optional cue-ball
 *  spin. Spin is an extension over the forked engine (which had none) —
 *  it is part of the deterministic simulation, so server and client agree. */
export interface ShotInput {
  angle: number;
  power: number;
  /** Side english, -1..1 — alters the cue ball's cushion rebounds. */
  spinX?: number;
  /** Follow/draw, -1..1 — +1 rolls the cue ball through after first contact,
   *  -1 draws it back. */
  spinY?: number;
}

export interface TableState {
  balls: BallState[];
  /** Whose turn it is to shoot. */
  turn: PlayerIndex;
  /** Assigned ball colors; null until the first pot decides groups. */
  playerColors: [BallColor | null, BallColor | null];
  /** Set after a foul: the player to shoot may (re)place the cue ball. */
  ballInHand: boolean;
  gameOver: boolean;
  /** Winning player once gameOver. */
  winner: PlayerIndex | null;
}

export type ShotEvent =
  | { type: "pocket"; ballId: number; color: BallColor; step: number }
  | { type: "cushion"; ballId: number; step: number }
  | { type: "ballsCollide"; a: number; b: number; step: number };

/** Sampled ball positions for replay/animation. */
export interface Frame {
  step: number;
  balls: Array<{ id: number; x: number; y: number; visible: boolean }>;
}

export interface ShotOutcome {
  /** True when this shot ended the frame (8-ball potted, or scratch-clears). */
  gameOver: boolean;
  winner: PlayerIndex | null;
  foul: boolean;
  /** Player who shoots next (== shooter when they legally potted their own ball). */
  nextTurn: PlayerIndex;
  /** Next player may re-place the cue ball (any foul, per the fork's rules). */
  ballInHand: boolean;
}

export interface ShotResult {
  endState: TableState;
  events: ShotEvent[];
  outcome: ShotOutcome;
  /** Present when simulateShot was asked to record frames. */
  frames?: Frame[];
  /** Number of fixed steps the shot took to settle. */
  steps: number;
}
