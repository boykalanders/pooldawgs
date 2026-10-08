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
  pocketFromJaws,
  BALL_RADIUS as POOL_BALL_RADIUS,
  BALL_SIZE as POOL_BALL_SIZE,
  BORDER_SIZE as POOL_BORDER_SIZE,
  BOTTOM_BORDER_Y as POOL_BOTTOM,
  CORNER_ACCEPT,
  CUE_BALL_START as POOL_CUE_START,
  HOLES as POOL_HOLES,
  HEAD_STRING_X as POOL_HEAD_STRING_X,
  HOLE_RADIUS as POOL_HOLE_RADIUS,
  LEFT_BORDER_X as POOL_LEFT,
  POCKETED_PARK as POOL_PARK,
  PX_PER_M,
  RIGHT_BORDER_X as POOL_RIGHT,
  SIDE_ACCEPT,
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
  BORDER_SIZE: number;
  LEFT_BORDER_X: number;
  RIGHT_BORDER_X: number;
  TOP_BORDER_Y: number;
  BOTTOM_BORDER_Y: number;
  HOLE_RADIUS: number;
  HOLES: readonly Hole[];
  CUE_BALL_START: { x: number; y: number };
  POCKETED_PARK: { x: number; y: number };
  /** Ball-in-hand "kitchen" limit: the cue ball's centre must be at x ≤ this.
   *  Pool: the head string (¼ of the playing length). Snooker: the baulk line. */
  HEAD_STRING_X: number;
  /** Snooker's D (half-ellipse on the baulk line, opening toward the baulk
   *  cushion); null on pool tables. Slightly elliptical because it is matched
   *  to the D painted on the table artwork, which is drawn with a slightly
   *  different x/y scale. */
  D: { x: number; y: number; rx: number; ry: number } | null;
}

// Pockets are built from REAL mouth widths by buildPockets() in constants.ts
// (see the note there): the cushions stop at the jaw tips and a ball only drops
// if it crosses the mouth with the jaws clear.

/** 8-ball / 9-ball — the engine's existing, calibrated geometry (unchanged). */
export const POOL_GEOM: TableGeometry = {
  TABLE_WIDTH: POOL_TABLE_WIDTH,
  TABLE_HEIGHT: POOL_TABLE_HEIGHT,
  BALL_SIZE: POOL_BALL_SIZE,
  BALL_RADIUS: POOL_BALL_RADIUS,
  BORDER_SIZE: POOL_BORDER_SIZE,
  LEFT_BORDER_X: POOL_LEFT,
  RIGHT_BORDER_X: POOL_RIGHT,
  TOP_BORDER_Y: POOL_TOP,
  BOTTOM_BORDER_Y: POOL_BOTTOM,
  HOLE_RADIUS: POOL_HOLE_RADIUS,
  HOLES: POOL_HOLES,
  CUE_BALL_START: POOL_CUE_START,
  POCKETED_PARK: POOL_PARK,
  HEAD_STRING_X: POOL_HEAD_STRING_X,
  D: null,
};

// ── Snooker: fitted to the table art (snooker_table.webp, 8 Oct 2026) ──────
// Everything here is measured from the painted table, fitted by its cushion
// nose line (x 126–1873, y 139–938.5 in the 2000 × 1130 image) at ONE scale,
// 0.89728 image px per engine px, so circles stay circles.
const SNK_BORDER = 57;
// The art's cloth is 1747 × 799.5 px: 3.569 m long at our scale, as a real
// table, but 1.633 m wide where a real one is 1.778 m (an aspect of 2.185, not
// 2.007). The engine follows the art rather than stretching it: squeezing the
// picture 9% to regulation width would turn every pocket and the D into ovals.
const SNK_PLAY_LEN = Math.round(3.569 * PX_PER_M); // ≈ 1947 px
const SNK_PLAY_WID = 891; // the art's width — regulation 1.778 m would be 970
const SNK_W = SNK_PLAY_LEN + 2 * SNK_BORDER;
const SNK_H = SNK_PLAY_WID + 2 * SNK_BORDER;
/**
 * Snooker ball, sized to the PAINTED pockets so the ball-to-pocket ratio — what
 * decides how hard a pot is — is a real snooker table's: corners 69.5 px →
 * 1.62 ball widths (WPBSA 86 mm = 1.64), middles 74.7 px → 1.74 (89 mm = 1.70).
 * That is 1.5× a regulation 52.5 mm ball on this cloth, the same trade the pool
 * table makes (1.3×) for clear balls on a phone.
 */
const SNK_BALL_SIZE = 43;
const SNK_BALL_RADIUS = SNK_BALL_SIZE / 2;
/** Corner mouth on the art (for HOLE_RADIUS and reference). */
const SNK_CORNER_MOUTH = 69.5;
// Baulk line and D, measured from the art: the baulk line is 0.742 m off the
// baulk cushion (regulation 0.737), the D a true semicircle of 0.334 m
// (regulation 0.292 — the art paints it larger).
const SNK_BAULK_X = 461.6;
const SNK_D = { x: SNK_BAULK_X, y: 501.1, rx: 182.2, ry: 182.2 };
const L = SNK_BORDER, R = SNK_W - SNK_BORDER, T = SNK_BORDER, B = SNK_H - SNK_BORDER;
/**
 * Pockets measured from the art. Corner jaw tips are where each painted facing
 * meets the nose line. The middle pockets' facings converge sharply behind the
 * nose (89 px apart there, 67 px at the back), so their mouth is taken at that
 * narrowest point — the gap a ball actually has to pass — centred on the
 * pocket. Centres are the middles of the painted holes (drop animation).
 */
const SNK_HOLES = [
  pocketFromJaws({ x: 102.7, y: T }, { x: L, y: 109.4 }, -Math.SQRT1_2, -Math.SQRT1_2, CORNER_ACCEPT, { x: 40.8, y: 39.1 }), // top left
  pocketFromJaws({ x: 1958.3, y: T }, { x: R, y: 109.4 }, Math.SQRT1_2, -Math.SQRT1_2, CORNER_ACCEPT, { x: 2017.4, y: 39.2 }), // top right
  pocketFromJaws({ x: 102.7, y: B }, { x: L, y: 895.6 }, -Math.SQRT1_2, Math.SQRT1_2, CORNER_ACCEPT, { x: 38.5, y: 969.6 }), // bottom left
  pocketFromJaws({ x: 1958.3, y: B }, { x: R, y: 895.6 }, Math.SQRT1_2, Math.SQRT1_2, CORNER_ACCEPT, { x: 2022.5, y: 967.7 }), // bottom right
  pocketFromJaws({ x: 994.3, y: T }, { x: 1068.9, y: T }, 0, -1, SIDE_ACCEPT, { x: 1028.9, y: 24.7 }), // top middle
  pocketFromJaws({ x: 994.3, y: B }, { x: 1068.9, y: B }, 0, 1, SIDE_ACCEPT, { x: 1031.5, y: 981.6 }), // bottom middle
];

export const SNOOKER_GEOM: TableGeometry = {
  TABLE_WIDTH: SNK_W,
  TABLE_HEIGHT: SNK_H,
  BALL_SIZE: SNK_BALL_SIZE,
  BALL_RADIUS: SNK_BALL_RADIUS,
  BORDER_SIZE: SNK_BORDER,
  LEFT_BORDER_X: SNK_BORDER,
  RIGHT_BORDER_X: SNK_W - SNK_BORDER,
  TOP_BORDER_Y: SNK_BORDER,
  BOTTOM_BORDER_Y: SNK_H - SNK_BORDER,
  HOLE_RADIUS: SNK_CORNER_MOUTH / 2,
  HOLES: SNK_HOLES,
  CUE_BALL_START: { x: SNK_BORDER + Math.round(0.6 * PX_PER_M), y: Math.round(SNK_H / 2) },
  POCKETED_PARK: { x: 0, y: SNK_H + 120 },
  HEAD_STRING_X: SNK_BAULK_X,
  D: SNK_D,
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
