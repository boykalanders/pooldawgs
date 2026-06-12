// Port of GamePolicy.js — UK-style 8-ball with red/yellow groups.
// Semantics preserved from the fork:
//   • First pot assigns groups (potting player gets that colour).
//   • A turn's FIRST cue contact must be with your own colour (once groups
//     are assigned); anything else is a foul. No contact at all is a foul.
//   • When all 7 of your colour are down, contacting the black first is legal.
//   • Potting the white: foul (and frame over if your set was already cleared
//     — opponent wins, because the frame ends on a foul).
//   • Potting the black: frame over. Legal (all your colours down, no foul)
//     → you win; otherwise → opponent wins.
//   • Potting an opponent ball: foul.
//   • Any foul ⇒ opponent gets ball-in-hand.
//   • Pot legally without foul ⇒ shoot again; otherwise turns switch.

import type { BallColor, BallState, PlayerIndex, TableState } from "./types.js";

export interface TurnRules {
  foul: boolean;
  won: boolean;
  scored: boolean;
  firstCollision: boolean;
}

export function createTurnRules(): TurnRules {
  return { foul: false, won: false, scored: false, firstCollision: true };
}

function pocketedCount(state: TableState, color: BallColor): number {
  let n = 0;
  for (const b of state.balls) {
    if (b.color === color && b.inHole) n++;
  }
  return n;
}

function allPocketed(state: TableState, color: BallColor): boolean {
  for (const b of state.balls) {
    if (b.color === color && !b.inHole) return false;
  }
  return true;
}

/** Fork: GamePolicy.checkColisionValidity — runs on the cue's first contact. */
export function onBallsCollide(
  state: TableState,
  rules: TurnRules,
  b1: BallState,
  b2: BallState
): void {
  const currentColor = state.playerColors[state.turn];

  // On the black legally once your set of 7 is cleared.
  if (
    currentColor !== null &&
    pocketedCount(state, currentColor) === 7 &&
    (b1.color === "black" || b2.color === "black")
  ) {
    rules.firstCollision = false;
    return;
  }

  if (!rules.firstCollision) return;

  if (currentColor === null) {
    rules.firstCollision = false;
    return;
  }

  if (b1.color === "white") {
    if (b2.color !== currentColor) rules.foul = true;
    rules.firstCollision = false;
  }
  if (b2.color === "white") {
    if (b1.color !== currentColor) rules.foul = true;
    rules.firstCollision = false;
  }
}

/** Fork: GamePolicy.handleBallInHole — runs the moment a ball drops. */
export function onPocket(state: TableState, rules: TurnRules, ball: BallState): void {
  const turn = state.turn;
  const other = ((turn + 1) % 2) as PlayerIndex;
  let currentColor = state.playerColors[turn];

  if (currentColor === null) {
    if (ball.color === "red" || ball.color === "yellow") {
      state.playerColors[turn] = ball.color;
      state.playerColors[other] = ball.color === "red" ? "yellow" : "red";
      currentColor = ball.color;
    } else if (ball.color === "black") {
      rules.won = true;
      rules.foul = true;
    } else if (ball.color === "white") {
      rules.foul = true;
    }
  }

  if (currentColor !== null && currentColor === ball.color) {
    rules.scored = true;
  } else if (ball.color === "white") {
    if (currentColor !== null) {
      rules.foul = true;
      if (allPocketed(state, currentColor)) {
        rules.won = true;
      }
    }
  } else if (ball.color === "black") {
    if (currentColor !== null) {
      if (!allPocketed(state, currentColor)) {
        rules.foul = true;
      }
      rules.won = true;
    }
  } else if (currentColor !== null) {
    // Potted an opponent ball.
    rules.foul = true;
  }
}

export interface TurnResolution {
  gameOver: boolean;
  winner: PlayerIndex | null;
  foul: boolean;
  nextTurn: PlayerIndex;
  ballInHand: boolean;
}

/** Fork: GamePolicy.updateTurnOutcome — runs once all balls have settled. */
export function resolveTurn(state: TableState, rules: TurnRules): TurnResolution {
  const turn = state.turn;
  const other = ((turn + 1) % 2) as PlayerIndex;

  // Cue ball touched nothing all shot.
  if (rules.firstCollision) {
    rules.foul = true;
  }

  if (rules.won) {
    const winner = rules.foul ? other : turn;
    return {
      gameOver: true,
      winner,
      foul: rules.foul,
      nextTurn: turn,
      ballInHand: false,
    };
  }

  const keepTurn = rules.scored && !rules.foul;
  return {
    gameOver: false,
    winner: null,
    foul: rules.foul,
    nextTurn: keepTurn ? turn : other,
    ballInHand: rules.foul,
  };
}
