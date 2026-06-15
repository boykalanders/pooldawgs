// Snooker — points-based, 15 reds + 6 colours.
//
// Reds remaining (phase A): alternate red → colour. Pot a red (+1) ⇒ you are
// "on a colour"; pot any colour (+its value) ⇒ the colour is respotted and you
// are back "on a red". Reds never respot. Miss/foul ⇒ turn passes.
// All reds gone (phase B): pot the colours in ascending order
// (yellow 2 → green 3 → brown 4 → blue 5 → pink 6 → black 7); they stay down.
// Frame ends when the table is cleared; higher score wins.
//
// Fouls award the opponent max(4, value of the ball involved). Cue in-off ⇒
// ball-in-hand. Nomination, free balls and "play-again" requests are out of
// scope (documented).

import {
  BORDER_SIZE,
  TABLE_HEIGHT,
  TABLE_WIDTH,
} from "../constants.js";
import type {
  BallColor,
  BallState,
  GameRules,
  PlayerIndex,
  TableState,
  TurnResolution,
} from "../types.js";
import {
  createFacts,
  cueId,
  type FactsAcc,
  onTableBefore,
  recordContact,
  recordPocket,
  respot,
} from "./shared.js";

const CENTER_Y = TABLE_HEIGHT / 2; // 412.5
// A touching triangle: columns step by diameter·cos30° (≈33), balls within a
// column step by a full diameter (BALL_SIZE = 38) plus a hair so no two reds
// overlap. RED_STEP_Y MUST be ≥ BALL_SIZE — that was the racking bug.
const RED_STEP_X = 34;
const RED_STEP_Y = 39;
const REDS_APEX_X = 1052;

/** Colour spots laid out for our landscape table (baulk on the left). */
const COLOURS: ReadonlyArray<{ color: BallColor; value: number; x: number; y: number }> = [
  { color: "yellow", value: 2, x: 360, y: 525 },
  { color: "green", value: 3, x: 360, y: 300 },
  { color: "brown", value: 4, x: 360, y: 412 },
  { color: "blue", value: 5, x: 750, y: 412 },
  { color: "pink", value: 6, x: 1010, y: 412 },
  { color: "black", value: 7, x: 1320, y: 412 },
];

const CUE_START = { x: 300, y: 470 };

function buildReds(): Array<{ x: number; y: number }> {
  const reds: Array<{ x: number; y: number }> = [];
  for (let col = 0; col < 5; col++) {
    const count = col + 1;
    const x = REDS_APEX_X + col * RED_STEP_X;
    for (let k = 0; k < count; k++) {
      const y = CENTER_Y + (k - (count - 1) / 2) * RED_STEP_Y;
      reds.push({ x, y });
    }
  }
  return reds; // 15
}

function colourBalls(state: TableState): BallState[] {
  return state.balls.filter((b) => b.color !== "cue" && b.color !== "red");
}

function reds(state: TableState): BallState[] {
  return state.balls.filter((b) => b.color === "red");
}

export const snooker: GameRules<FactsAcc> = {
  type: "snooker",

  createInitialState(): TableState {
    const balls: BallState[] = [];
    let id = 0;
    for (const r of buildReds()) {
      balls.push({
        id: id++,
        color: "red",
        number: 0,
        value: 1,
        x: r.x,
        y: r.y,
        vx: 0,
        vy: 0,
        moving: false,
        inHole: false,
      });
    }
    for (const c of COLOURS) {
      balls.push({
        id: id++,
        color: c.color,
        number: 0,
        value: c.value,
        x: c.x,
        y: c.y,
        vx: 0,
        vy: 0,
        moving: false,
        inHole: false,
        homeX: c.x,
        homeY: c.y,
      });
    }
    balls.push({
      id: id,
      color: "cue",
      number: 0,
      value: 0,
      x: CUE_START.x,
      y: CUE_START.y,
      vx: 0,
      vy: 0,
      moving: false,
      inHole: false,
    });
    return {
      gameType: "snooker",
      balls,
      turn: 0,
      ballInHand: false,
      gameOver: false,
      winner: null,
      playerColors: [null, null],
      scores: [0, 0],
      onColor: false,
    };
  },

  createTurn: createFacts,

  onBallsCollide(state, acc, b1, b2) {
    recordContact(state, acc, b1, b2);
  },

  onPocket(state, acc, ball) {
    recordPocket(state, acc, ball);
  },

  resolve(state, acc): TurnResolution {
    const turn = state.turn;
    const other = ((turn + 1) % 2) as PlayerIndex;
    const balls = state.balls;
    const cue = cueId(state);

    const pottedBalls = acc.potted.map((id) => balls[id]);
    const pottedReds = pottedBalls.filter((b) => b.color === "red");
    const pottedColours = pottedBalls.filter((b) => b.color !== "red" && b.id !== cue);
    const firstBall = acc.firstContactId !== null ? balls[acc.firstContactId] : null;

    const redsBefore = reds(state).filter((b) => onTableBefore(acc, b)).length;
    const phaseB = redsBefore === 0;
    const wasOnColour = state.onColor;

    let foul = false;

    if (acc.cuePotted) foul = true;
    if (firstBall === null) foul = true;

    if (!phaseB) {
      if (!wasOnColour) {
        // On a red.
        if (firstBall && firstBall.color !== "red") foul = true;
        if (pottedColours.length > 0) foul = true;
      } else {
        // On a colour (any colour legal to strike/pot, but only one).
        if (firstBall && firstBall.color === "red") foul = true;
        if (pottedReds.length > 0) foul = true;
        if (pottedColours.length > 1) foul = true;
      }
    } else {
      // Phase B: the lowest-value colour remaining is "on".
      const lowest = colourBalls(state)
        .filter((b) => onTableBefore(acc, b))
        .reduce<BallState | null>((lo, b) => (lo === null || b.value < lo.value ? b : lo), null);
      if (firstBall && lowest && firstBall.id !== lowest.id) foul = true;
      for (const b of pottedColours) if (lowest && b.id !== lowest.id) foul = true;
      if (pottedReds.length > 0) foul = true;
    }

    let nextTurn: PlayerIndex;
    let ballInHand = false;
    let note: string | undefined;

    if (!foul) {
      let gained = 0;
      for (const b of pottedBalls) if (b.id !== cue) gained += b.value;
      state.scores[turn] += gained;

      if (!phaseB) {
        if (!wasOnColour) {
          // On a red: potting red(s) puts you on a colour.
          state.onColor = pottedReds.length > 0;
          nextTurn = pottedReds.length > 0 ? turn : other;
        } else {
          // On a colour: respot it, back on a red.
          for (const b of pottedColours) respot(state, b);
          state.onColor = false;
          nextTurn = pottedColours.length > 0 ? turn : other;
        }
      } else {
        // Phase B: potted colour stays down.
        state.onColor = false;
        nextTurn = pottedColours.length > 0 ? turn : other;
      }
      if (gained > 0) note = `+${gained}`;
    } else {
      const penalty = Math.max(
        4,
        firstBall ? firstBall.value : 0,
        ...pottedBalls.map((b) => b.value)
      );
      state.scores[other] += penalty;
      // Colours potted on a foul are respotted; reds stay down.
      for (const b of pottedColours) respot(state, b);
      state.onColor = false;
      nextTurn = other;
      ballInHand = acc.cuePotted;
      note = `Foul — ${penalty} to opponent`;
    }

    // Frame ends once nothing but the cue remains.
    const objectsLeft = balls.filter((b) => b.color !== "cue" && !b.inHole).length;
    if (objectsLeft === 0) {
      const winner: PlayerIndex = state.scores[0] >= state.scores[1] ? 0 : 1;
      return { gameOver: true, winner, foul, nextTurn: turn, ballInHand: false, note };
    }

    return { gameOver: false, winner: null, foul, nextTurn, ballInHand, note };
  },
};

// Re-export geometry so the renderer can match the snooker layout if needed.
export const SNOOKER_BAULK_X = 360;
export const SNOOKER_PLAY_LEFT = BORDER_SIZE;
export const SNOOKER_PLAY_RIGHT = TABLE_WIDTH - BORDER_SIZE;
