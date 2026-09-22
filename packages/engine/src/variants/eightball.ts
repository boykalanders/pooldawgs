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

import { POOL_GEOM } from "../geometry.js";
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
// A FROZEN triangle generated from the ball diameter (v4 — the hand-placed
// integer coordinates only fitted the old 38 px ball). Balls in a column are
// exactly one diameter apart, so they touch; columns step 0.88 diameter, a
// hair over d·cos30° (0.866), so diagonal neighbours sit just over one
// diameter apart and the pack never self-separates at rest. Centred on the
// table's centre line, the same line the cue ball starts on.
const RACK_LAYOUT: ReadonlyArray<ReadonlyArray<{ color: BallColor; number: number }>> = [
  [{ color: "yellow", number: 1 }],
  [{ color: "yellow", number: 2 }, { color: "red", number: 9 }],
  [{ color: "red", number: 10 }, { color: "black", number: 8 }, { color: "yellow", number: 3 }],
  [
    { color: "yellow", number: 4 },
    { color: "red", number: 11 },
    { color: "yellow", number: 5 },
    { color: "red", number: 12 },
  ],
  [
    { color: "red", number: 13 },
    { color: "red", number: 14 },
    { color: "yellow", number: 6 },
    { color: "red", number: 15 },
    { color: "yellow", number: 7 },
  ],
];
const RACK_APEX_X = 1022;
const RACK: ReadonlyArray<{ x: number; y: number; color: BallColor; number: number }> = (() => {
  // +0.001 px: with a fractional diameter, float rounding can otherwise put
  // touching balls a hair INSIDE one diameter (an overlap at rest).
  const d = POOL_GEOM.BALL_SIZE + 0.001;
  const centerY = (POOL_GEOM.TOP_BORDER_Y + POOL_GEOM.BOTTOM_BORDER_Y) / 2;
  return RACK_LAYOUT.flatMap((column, c) =>
    column.map((ball, k) => ({
      ...ball,
      x: RACK_APEX_X + c * d * 0.88,
      y: centerY + (k - (column.length - 1) / 2) * d,
    }))
  );
})();

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
      x: POOL_GEOM.CUE_BALL_START.x,
      y: POOL_GEOM.CUE_BALL_START.y,
      vx: 0,
      vy: 0,
      moving: false,
      inHole: false,
    });
    return {
      gameType: "8ball",
      balls,
      turn: 0,
      // The break is taken with ball in hand behind the head string.
      ballInHand: true,
      placementZone: "kitchen",
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
    // Scratch on the break: the incoming player has ball in hand behind the
    // head string (WPA 8-ball); any other foul is ball in hand anywhere.
    const cueDown = state.balls.some((b) => b.color === "cue" && b.inHole);
    return {
      gameOver: false,
      winner: null,
      foul: acc.foul,
      nextTurn: keepTurn ? turn : other,
      ballInHand: acc.foul,
      placementZone: wasBreak && cueDown ? "kitchen" : "table",
      note: acc.foul ? "Foul — ball in hand" : undefined,
    };
  },
};
