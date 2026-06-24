// Per-variant table geometry. The physics CONSTANTS (speed, friction,
// restitution, spin) are scale-independent and live in constants.ts; only the
// GEOMETRY (table size, ball size, pockets) differs between variants, and only
// that is selected here. PX_PER_M is shared across variants, so a metre is the
// same number of pixels everywhere and the calibrated speeds/frictions stay
// valid — snooker simply uses a bigger table (in px) and smaller balls.
//
// Real-world dimensions (client spec):
//   8-ball / 9-ball : 2.54 m × 1.27 m, corner pocket 115 mm, middle 125 mm
//   snooker         : 3.569 m × 1.778 m, corner pocket 86 mm, middle 89 mm
// Pool balls are ~57 mm, snooker balls ~52.5 mm — so on its much larger table a
// snooker ball is far smaller relative to the cloth (the "finer" snooker feel).

import {
  BALL_ORIGIN as POOL_BALL_ORIGIN,
  BALL_RADIUS as POOL_BALL_RADIUS,
  BALL_SIZE as POOL_BALL_SIZE,
  BORDER_SIZE as POOL_BORDER_SIZE,
  BOTTOM_BORDER_Y as POOL_BOTTOM,
  CUE_BALL_START as POOL_CUE_START,
  HOLES as POOL_HOLES,
  HOLE_RADIUS as POOL_HOLE_RADIUS,
  LEFT_BORDER_X as POOL_LEFT,
  POCKETED_PARK as POOL_PARK,
  PX_PER_M,
  RIGHT_BORDER_X as POOL_RIGHT,
  TABLE_HEIGHT as POOL_TABLE_HEIGHT,
  TABLE_WIDTH as POOL_TABLE_WIDTH,
  TOP_BORDER_Y as POOL_TOP,
  type Hole,
} from "./constants.js";
import type { GameType } from "./types.js";

export interface TableGeometry {
  TABLE_WIDTH: number;
  TABLE_HEIGHT: number;
  BALL_SIZE: number;
  BALL_RADIUS: number;
  BALL_ORIGIN: number;
  BORDER_SIZE: number;
  LEFT_BORDER_X: number;
  RIGHT_BORDER_X: number;
  TOP_BORDER_Y: number;
  BOTTOM_BORDER_Y: number;
  HOLE_RADIUS: number;
  HOLES: readonly Hole[];
  CUE_BALL_START: { x: number; y: number };
  POCKETED_PARK: { x: number; y: number };
}

const SQRT1_2 = Math.SQRT1_2;
const CORNER_ACCEPT = Math.cos((52 * Math.PI) / 180);
const SIDE_ACCEPT = Math.cos((26 * Math.PI) / 180);

/** Build the six pockets for a table of the given size and pocket radii. */
function buildHoles(
  width: number,
  height: number,
  border: number,
  ballOrigin: number,
  cornerR: number,
  middleR: number
): Hole[] {
  const inset = border + 5; // corner mouth, slightly inside the rail corner
  const midX = width / 2;
  // Centre pockets must reach a ball resting at the cushion (its centre is
  // clamped at border + ballOrigin). Place the centre so that ball sits ~0.78r
  // inside the mouth — otherwise, with a small radius (snooker), the pocket
  // ends short of the cushion line and never captures.
  const clamp = border + ballOrigin;
  const topMid = clamp - middleR * 0.78;
  return [
    { x: inset, y: inset, radius: cornerR, tx: -SQRT1_2, ty: -SQRT1_2, acceptCos: CORNER_ACCEPT },
    { x: width - inset, y: inset, radius: cornerR, tx: SQRT1_2, ty: -SQRT1_2, acceptCos: CORNER_ACCEPT },
    { x: inset, y: height - inset, radius: cornerR, tx: -SQRT1_2, ty: SQRT1_2, acceptCos: CORNER_ACCEPT },
    { x: width - inset, y: height - inset, radius: cornerR, tx: SQRT1_2, ty: SQRT1_2, acceptCos: CORNER_ACCEPT },
    { x: midX, y: topMid, radius: middleR, tx: 0, ty: -1, acceptCos: SIDE_ACCEPT },
    { x: midX, y: height - topMid, radius: middleR, tx: 0, ty: 1, acceptCos: SIDE_ACCEPT },
  ];
}

/** 8-ball / 9-ball — the engine's existing, calibrated geometry (unchanged). */
export const POOL_GEOM: TableGeometry = {
  TABLE_WIDTH: POOL_TABLE_WIDTH,
  TABLE_HEIGHT: POOL_TABLE_HEIGHT,
  BALL_SIZE: POOL_BALL_SIZE,
  BALL_RADIUS: POOL_BALL_RADIUS,
  BALL_ORIGIN: POOL_BALL_ORIGIN,
  BORDER_SIZE: POOL_BORDER_SIZE,
  LEFT_BORDER_X: POOL_LEFT,
  RIGHT_BORDER_X: POOL_RIGHT,
  TOP_BORDER_Y: POOL_TOP,
  BOTTOM_BORDER_Y: POOL_BOTTOM,
  HOLE_RADIUS: POOL_HOLE_RADIUS,
  HOLES: POOL_HOLES,
  CUE_BALL_START: POOL_CUE_START,
  POCKETED_PARK: POOL_PARK,
};

// ── Snooker: real 3.569 m × 1.778 m, same px/m as pool ──────────────────────
const SNK_BORDER = 57;
const SNK_PLAY_LEN = Math.round(3.569 * PX_PER_M); // ≈ 1948 px
const SNK_PLAY_WID = Math.round(1.778 * PX_PER_M); // ≈ 970 px
const SNK_W = SNK_PLAY_LEN + 2 * SNK_BORDER;
const SNK_H = SNK_PLAY_WID + 2 * SNK_BORDER;
// Snooker balls (52.5 mm) are ~8% smaller than pool balls; keep the engine's
// pool oversize factor so they read at the same on-cloth scale ratio as real.
const SNK_BALL_SIZE = Math.round(POOL_BALL_SIZE * (52.5 / 57.15)); // ≈ 35 px
const SNK_BALL_RADIUS = SNK_BALL_SIZE / 2;
const SNK_BALL_ORIGIN = Math.round(POOL_BALL_ORIGIN * (SNK_BALL_SIZE / POOL_BALL_SIZE));
// Snooker pockets (86 / 89 mm) are tighter than pool's (115 / 125 mm).
const SNK_CORNER_R = Math.round(POOL_HOLE_RADIUS * (86 / 115)); // ≈ 34
const SNK_MIDDLE_R = Math.round(52 * (89 / 125)); // ≈ 37

export const SNOOKER_GEOM: TableGeometry = {
  TABLE_WIDTH: SNK_W,
  TABLE_HEIGHT: SNK_H,
  BALL_SIZE: SNK_BALL_SIZE,
  BALL_RADIUS: SNK_BALL_RADIUS,
  BALL_ORIGIN: SNK_BALL_ORIGIN,
  BORDER_SIZE: SNK_BORDER,
  LEFT_BORDER_X: SNK_BORDER,
  RIGHT_BORDER_X: SNK_W - SNK_BORDER,
  TOP_BORDER_Y: SNK_BORDER,
  BOTTOM_BORDER_Y: SNK_H - SNK_BORDER,
  HOLE_RADIUS: SNK_CORNER_R,
  HOLES: buildHoles(SNK_W, SNK_H, SNK_BORDER, SNK_BALL_ORIGIN, SNK_CORNER_R, SNK_MIDDLE_R),
  CUE_BALL_START: { x: SNK_BORDER + Math.round(0.6 * PX_PER_M), y: Math.round(SNK_H / 2) },
  POCKETED_PARK: { x: 0, y: SNK_H + 120 },
};

export function geomFor(gameType: GameType): TableGeometry {
  return gameType === "snooker" ? SNOOKER_GEOM : POOL_GEOM;
}

/**
 * Active geometry singleton. Physics reads its fields at call time; the
 * simulators replace its contents per shot via setActiveGeometry(gameType).
 * Simulation is single-shot and synchronous, so this stays deterministic.
 */
export const G: TableGeometry = { ...POOL_GEOM };

export function setActiveGeometry(gameType: GameType): void {
  Object.assign(G, geomFor(gameType));
}
