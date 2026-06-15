/** Supported game variants. */
export type GameType = "8ball" | "9ball" | "snooker";

/**
 * Ball identity used by rules and by the snooker renderer. Pool variants
 * (8-ball / 9-ball) additionally carry a printed `number` and render by it;
 * snooker balls have no number and render by `color`.
 */
export type BallColor =
  | "cue"
  | "red"
  | "yellow"
  | "green"
  | "brown"
  | "blue"
  | "pink"
  | "black"
  | "orange"
  | "purple"
  | "maroon";

export type PlayerIndex = 0 | 1;

export interface BallState {
  /** Stable index into the rack. The cue ball is always the LAST element. */
  id: number;
  color: BallColor;
  /** Printed number: 0 = none (cue ball; snooker reds & colours). */
  number: number;
  /** Points value for scored variants (snooker colours). 0 otherwise. */
  value: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  moving: boolean;
  inHole: boolean;
  /** Respot home for snooker colours; undefined = ball does not respot. */
  homeX?: number;
  homeY?: number;
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
  gameType: GameType;
  balls: BallState[];
  /** Whose turn it is to shoot. */
  turn: PlayerIndex;
  /** Set after a foul: the player to shoot may (re)place the cue ball. */
  ballInHand: boolean;
  gameOver: boolean;
  /** Winning player once gameOver. */
  winner: PlayerIndex | null;
  /** 8-ball: assigned groups; null until the first pot decides them. */
  playerColors: [BallColor | null, BallColor | null];
  /** Scored variants (snooker): running points per player. */
  scores: [number, number];
  /** Snooker: true when the striker is "on a colour" (just potted a red). */
  onColor: boolean;
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

export interface TurnResolution {
  gameOver: boolean;
  winner: PlayerIndex | null;
  foul: boolean;
  /** Player who shoots next (== shooter when they legally potted). */
  nextTurn: PlayerIndex;
  /** Next player may re-place the cue ball (any foul). */
  ballInHand: boolean;
  /** Human-readable note for the HUD (e.g. "Foul — 4 to opponent"). */
  note?: string;
}

export interface ShotOutcome extends TurnResolution {}

export interface ShotResult {
  endState: TableState;
  events: ShotEvent[];
  outcome: ShotOutcome;
  /** Present when simulateShot was asked to record frames. */
  frames?: Frame[];
  /** Number of fixed steps the shot took to settle. */
  steps: number;
}

/**
 * Per-variant rules plug-in. The core physics is variant-agnostic; each
 * variant supplies its rack, its per-shot accumulator, the collision/pocket
 * observers, and the end-of-shot resolution (which may mutate state to
 * respot balls or update scores). `Acc` is the variant's private shot state.
 */
export interface GameRules<Acc = unknown> {
  type: GameType;
  createInitialState(): TableState;
  /** Fresh per-shot accumulator. */
  createTurn(): Acc;
  /** Observe the cue's/object balls' contacts as they happen. */
  onBallsCollide(state: TableState, acc: Acc, b1: BallState, b2: BallState): void;
  /** Observe a ball dropping. */
  onPocket(state: TableState, acc: Acc, ball: BallState): void;
  /** Decide the outcome once everything has settled; may mutate `state`. */
  resolve(state: TableState, acc: Acc): TurnResolution;
}
