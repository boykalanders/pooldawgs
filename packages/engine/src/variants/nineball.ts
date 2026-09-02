// 9-ball — rotation rules.
//   • Legal first contact = the LOWEST-numbered ball on the table.
//   • Any ball legally pocketed stays down; pot something legal ⇒ shoot again.
//   • Pot the 9-ball on a legal shot (incl. combinations) ⇒ win.
//   • Foul (wrong first ball, no contact, scratch) ⇒ opponent ball-in-hand.
//     The 9-ball potted on a foul is respotted; the frame continues.

import { CUE_BALL_START } from "../constants.js";
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
  type FactsAcc,
  onTableBefore,
  recordContact,
  recordPocket,
  respot,
} from "./shared.js";

// Diamond rack, apex (1) toward the breaker, 9 in the centre. Cosmetic colours
// (rendering uses the numbered SVGs); rules key off `number`.
const COLOR_BY_NUMBER: Record<number, BallColor> = {
  1: "yellow",
  2: "blue",
  3: "red",
  4: "purple",
  5: "orange",
  6: "green",
  7: "maroon",
  8: "black",
  9: "yellow",
};

// A FROZEN diamond: columns step +33 px (≥ diameter·cos30°), balls within a
// column step a full diameter (38 px) — vertical neighbours touch exactly and
// diagonal neighbours sit 38.08 px apart. Visually frozen, always ≥ 1 diameter
// so the pack never self-separates before the break; integer coords stay
// deterministic across server and client.
const RACK: ReadonlyArray<{ x: number; y: number; number: number }> = [
  { x: 1022, y: 413, number: 1 },
  { x: 1055, y: 394, number: 2 },
  { x: 1055, y: 432, number: 3 },
  { x: 1088, y: 375, number: 4 },
  { x: 1088, y: 413, number: 9 }, // centre
  { x: 1088, y: 451, number: 5 },
  { x: 1121, y: 394, number: 6 },
  { x: 1121, y: 432, number: 7 },
  { x: 1154, y: 413, number: 8 },
];

const NINE_HOME = { x: 1090, y: 413 };

export const nineBall: GameRules<FactsAcc> = {
  type: "9ball",

  createInitialState(): TableState {
    const balls: BallState[] = RACK.map((b, id) => ({
      id,
      color: COLOR_BY_NUMBER[b.number],
      number: b.number,
      value: 0,
      x: b.x,
      y: b.y,
      vx: 0,
      vy: 0,
      moving: false,
      inHole: false,
      ...(b.number === 9 ? { homeX: NINE_HOME.x, homeY: NINE_HOME.y } : {}),
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
      gameType: "9ball",
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

    const objectBalls = balls.filter((b) => b.color !== "cue");
    const lowestOnTable = objectBalls
      .filter((b) => onTableBefore(acc, b))
      .reduce<BallState | null>((lo, b) => (lo === null || b.number < lo.number ? b : lo), null);

    let foul = false;
    if (acc.cuePotted) foul = true;
    if (acc.firstContactId === null) {
      foul = true;
    } else if (lowestOnTable && balls[acc.firstContactId].number !== lowestOnTable.number) {
      foul = true;
    }

    const nine = balls.find((b) => b.number === 9)!;
    const ninePotted = acc.potted.includes(nine.id);

    if (ninePotted && !foul) {
      return { gameOver: true, winner: turn, foul: false, nextTurn: turn, ballInHand: false };
    }

    if (foul) {
      if (ninePotted) respot(state, nine); // 9 on a foul comes back up
      return {
        gameOver: false,
        winner: null,
        foul: true,
        nextTurn: other,
        ballInHand: true,
        note: "Foul — ball in hand",
      };
    }

    const pottedObject = acc.potted.some((id) => id !== balls.length - 1);
    return {
      gameOver: false,
      winner: null,
      foul: false,
      nextTurn: pottedObject ? turn : other,
      ballInHand: false,
    };
  },
};
