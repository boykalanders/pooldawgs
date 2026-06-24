// UK-style 8-ball — the logic ported verbatim from the original fork
// (GamePolicy.js), now expressed as a GameRules plug-in. Behaviour is
// unchanged from the prior rules.ts so the existing test suite still holds.
//
//   • First pot assigns groups (potting player gets that colour).
//   • A turn's FIRST cue contact must be your own colour once groups exist;
//     anything else (or no contact) is a foul.
//   • When all 7 of your colour are down, contacting the black first is legal.
//   • Potting the cue: foul (and frame over if your set was already cleared).
//   • Potting the black: frame over — win if cleared + no foul, else loss.
//   • Potting an opponent ball: foul. Any foul ⇒ opponent ball-in-hand.
//   • Legal pot ⇒ shoot again; otherwise turns switch.

import { CUE_BALL_START } from "../constants.js";
import type {
  BallColor,
  BallState,
  GameRules,
  PlayerIndex,
  TableState,
  TurnResolution,
} from "../types.js";

interface Acc8 {
  foul: boolean;
  won: boolean;
  scored: boolean;
  firstCollision: boolean;
  /** Was the table "open" (groups undecided) at the start of this shot?
   *  Captured lazily on the first pocket. */
  openStart?: boolean;
  /** Object-ball colours potted while the table was open — used to assign the
   *  group in resolve(). Potting BOTH colours leaves the table open. */
  openPotted: Set<BallColor>;
}

// id → { color, number } matches apps/web ball art (solids 1–7, 8, stripes 9–15).
const RACK: ReadonlyArray<{ x: number; y: number; color: BallColor; number: number }> = [
  { x: 1022, y: 413, color: "yellow", number: 1 },
  { x: 1056, y: 393, color: "yellow", number: 2 },
  { x: 1056, y: 433, color: "red", number: 9 },
  { x: 1090, y: 374, color: "red", number: 10 },
  { x: 1090, y: 413, color: "black", number: 8 },
  { x: 1090, y: 452, color: "yellow", number: 3 },
  { x: 1126, y: 354, color: "yellow", number: 4 },
  { x: 1126, y: 393, color: "red", number: 11 },
  { x: 1126, y: 433, color: "yellow", number: 5 },
  { x: 1126, y: 472, color: "red", number: 12 },
  { x: 1162, y: 335, color: "red", number: 13 },
  { x: 1162, y: 374, color: "red", number: 14 },
  { x: 1162, y: 413, color: "yellow", number: 6 },
  { x: 1162, y: 452, color: "red", number: 15 },
  { x: 1162, y: 491, color: "yellow", number: 7 },
];

function pocketedCount(state: TableState, color: BallColor): number {
  let n = 0;
  for (const b of state.balls) if (b.color === color && b.inHole) n++;
  return n;
}

function allPocketed(state: TableState, color: BallColor): boolean {
  for (const b of state.balls) if (b.color === color && !b.inHole) return false;
  return true;
}

export const eightBall: GameRules<Acc8> = {
  type: "8ball",

  createInitialState(): TableState {
    const balls: BallState[] = RACK.map((b, id) => ({
      id,
      color: b.color,
      number: b.number,
      value: 0,
      x: b.x,
      y: b.y,
      vx: 0,
      vy: 0,
      moving: false,
      inHole: false,
    }));
    balls.push({
      id: RACK.length,
      color: "cue",
      number: 0,
      value: 0,
      x: CUE_BALL_START.x,
      y: CUE_BALL_START.y,
      vx: 0,
      vy: 0,
      moving: false,
      inHole: false,
    });
    return {
      gameType: "8ball",
      balls,
      turn: 0,
      ballInHand: false,
      gameOver: false,
      winner: null,
      playerColors: [null, null],
      scores: [0, 0],
      onColor: false,
      broken: false,
    };
  },

  createTurn: (): Acc8 => ({
    foul: false,
    won: false,
    scored: false,
    firstCollision: true,
    openPotted: new Set<BallColor>(),
  }),

  onBallsCollide(state, acc, b1, b2) {
    const currentColor = state.playerColors[state.turn];

    if (
      currentColor !== null &&
      pocketedCount(state, currentColor) === 7 &&
      (b1.color === "black" || b2.color === "black")
    ) {
      acc.firstCollision = false;
      return;
    }
    if (!acc.firstCollision) return;
    if (currentColor === null) {
      acc.firstCollision = false;
      return;
    }
    if (b1.color === "cue") {
      if (b2.color !== currentColor) acc.foul = true;
      acc.firstCollision = false;
    }
    if (b2.color === "cue") {
      if (b1.color !== currentColor) acc.foul = true;
      acc.firstCollision = false;
    }
  },

  onPocket(state, acc, ball) {
    const turn = state.turn;
    const currentColor = state.playerColors[turn];
    if (acc.openStart === undefined) acc.openStart = currentColor === null;

    // Open table: the group is NOT decided yet, so potting EITHER colour is
    // legal — and potting both in one shot is NOT a foul (the player's group is
    // resolved after the shot). We only judge the cue/black here; the group is
    // assigned in resolve(). This is the rule the user flagged as missing.
    if (acc.openStart) {
      if (ball.color === "cue") {
        acc.foul = true; // scratch is always a foul
      } else if (ball.color === "black") {
        acc.won = true; // potting the 8 with the table open = loss
        acc.foul = true;
      } else if (ball.color === "red" || ball.color === "yellow") {
        acc.openPotted.add(ball.color);
        acc.scored = true; // a legal pot — keep the turn
      }
      return;
    }

    // Groups already assigned — original logic.
    if (currentColor === ball.color) {
      acc.scored = true;
    } else if (ball.color === "cue") {
      // Scratch — always just a foul (opponent gets ball-in-hand). It NEVER
      // ends the frame on its own: even after clearing your group you still
      // have to pot the black, so the black being on the table means the game
      // continues. (The fork wrongly ended the frame here.)
      acc.foul = true;
    } else if (ball.color === "black") {
      if (!allPocketed(state, currentColor!)) acc.foul = true;
      acc.won = true;
    } else {
      acc.foul = true; // potted an opponent ball
    }
  },

  resolve(state, acc): TurnResolution {
    const turn = state.turn;
    const other = ((turn + 1) % 2) as PlayerIndex;

    if (acc.firstCollision) acc.foul = true; // never touched a ball

    // The break shot never assigns a group — the table is always open right
    // after the break (standard 8-ball). Mark the frame as broken so groups can
    // be decided from the next shot on.
    const wasBreak = !state.broken;
    state.broken = true;

    // Open-table group assignment (POST-break only): if the shooter potted
    // exactly ONE colour and didn't foul, that becomes their group. Potting
    // both colours — or potting on the break — leaves the table open, and is
    // not a foul.
    if (!wasBreak && acc.openStart && !acc.foul && acc.openPotted.size === 1) {
      const color = acc.openPotted.values().next().value as BallColor;
      state.playerColors[turn] = color;
      state.playerColors[other] = color === "red" ? "yellow" : "red";
    }

    if (acc.won) {
      const winner = acc.foul ? other : turn;
      return { gameOver: true, winner, foul: acc.foul, nextTurn: turn, ballInHand: false };
    }

    const keepTurn = acc.scored && !acc.foul;
    return {
      gameOver: false,
      winner: null,
      foul: acc.foul,
      nextTurn: keepTurn ? turn : other,
      ballInHand: acc.foul,
      note: acc.foul ? "Foul — ball in hand" : undefined,
    };
  },
};
