import { describe, expect, it } from "vitest";
import {
  CUE_BALL_ID,
  cloneState,
  createInitialState,
  cueBall,
  placeCueBall,
  simulateShot,
  stateHash,
  validateShot,
} from "./world.js";
import { HOLES, MAX_POWER } from "./constants.js";
import type { TableState } from "./types.js";

/** A state with only cue + black + one red/one yellow left, for endgame tests. */
function nearEndState(playerColor: "red" | "yellow"): TableState {
  const state = createInitialState();
  state.playerColors = playerColor === "red" ? ["red", "yellow"] : ["yellow", "red"];
  for (const ball of state.balls) {
    if (ball.color === "red" || ball.color === "yellow") {
      ball.inHole = true;
      ball.x = 0;
      ball.y = 900;
    }
  }
  return state;
}

describe("determinism", () => {
  it("identical (state, shot) produces an identical end state and hash", () => {
    const a = simulateShot(createInitialState(), { angle: 0, power: 60 });
    const b = simulateShot(createInitialState(), { angle: 0, power: 60 });
    expect(JSON.stringify(a.endState)).toEqual(JSON.stringify(b.endState));
    expect(stateHash(a.endState)).toEqual(stateHash(b.endState));
    expect(a.events).toEqual(b.events);
    expect(a.steps).toEqual(b.steps);
  });

  it("does not mutate the input state", () => {
    const initial = createInitialState();
    const before = JSON.stringify(initial);
    simulateShot(initial, { angle: 0.1, power: 50 });
    expect(JSON.stringify(initial)).toEqual(before);
  });

  it("a break shot moves the rack and always settles", () => {
    const result = simulateShot(createInitialState(), { angle: 0, power: 75 });
    expect(result.steps).toBeLessThan(10000);
    const movedBalls = result.endState.balls.filter(
      (b, i) => !b.inHole && (b.x !== createInitialState().balls[i].x || b.y !== createInitialState().balls[i].y)
    );
    expect(movedBalls.length).toBeGreaterThan(2);
    for (const ball of result.endState.balls) {
      expect(ball.moving).toBe(false);
    }
  });
});

describe("shot validation", () => {
  it("rejects zero/negative/overpowered shots and non-finite input", () => {
    const state = createInitialState();
    expect(validateShot(state, { angle: 0, power: 0 }).ok).toBe(false);
    expect(validateShot(state, { angle: 0, power: -5 }).ok).toBe(false);
    expect(validateShot(state, { angle: 0, power: MAX_POWER + 1 }).ok).toBe(false);
    expect(validateShot(state, { angle: NaN, power: 10 }).ok).toBe(false);
    expect(validateShot(state, { angle: 0, power: 10 }).ok).toBe(true);
  });

  it("requires cue placement after a scratch", () => {
    const state = createInitialState();
    cueBall(state).inHole = true;
    expect(validateShot(state, { angle: 0, power: 10 }).ok).toBe(false);
  });
});

describe("fouls and turn order", () => {
  it("no contact at all is a foul: turn switches with ball in hand", () => {
    // Shoot softly straight up: cue bounces off the top cushion, hits nothing.
    const result = simulateShot(createInitialState(), { angle: -Math.PI / 2, power: 10 });
    expect(result.outcome.foul).toBe(true);
    expect(result.outcome.nextTurn).toBe(1);
    expect(result.outcome.ballInHand).toBe(true);
    expect(result.outcome.gameOver).toBe(false);
  });

  it("scratching the cue ball is a foul", () => {
    const state = createInitialState();
    // Aim the cue straight at the top-left pocket from nearby.
    const cue = cueBall(state);
    cue.x = 200;
    cue.y = 200;
    const hole = HOLES[0];
    const angle = Math.atan2(hole.y - cue.y, hole.x - cue.x);
    const result = simulateShot(state, { angle, power: 30 });
    expect(result.endState.balls[CUE_BALL_ID].inHole).toBe(true);
    expect(result.outcome.foul).toBe(true);
    expect(result.outcome.ballInHand).toBe(true);
  });

  it("a clean break with no pot passes the turn without foul", () => {
    const result = simulateShot(createInitialState(), { angle: 0, power: 40 });
    // Power 40 straight into the rack: contact happens; whether a ball drops
    // is deterministic — assert consistent turn logic either way.
    if (!result.outcome.foul && !result.endState.gameOver) {
      const potted = result.events.some(
        (e) => e.type === "pocket" && e.color !== "white"
      );
      if (potted) {
        expect(result.outcome.nextTurn).toBe(0);
      } else {
        expect(result.outcome.nextTurn).toBe(1);
      }
    }
  });
});

describe("group assignment", () => {
  it("first potted colour assigns groups to the potting player", () => {
    const state = createInitialState();
    // Put a red directly in front of a corner pocket and fire the cue at it.
    const red = state.balls.find((b) => b.color === "red")!;
    const hole = HOLES[3]; // bottom right
    red.x = hole.x - 60;
    red.y = hole.y - 60;
    const cue = cueBall(state);
    cue.x = red.x - 200;
    cue.y = red.y - 200;
    const angle = Math.atan2(red.y - cue.y, red.x - cue.x);
    const result = simulateShot(state, { angle, power: 40 });

    const redPotted = result.events.some(
      (e) => e.type === "pocket" && e.color === "red"
    );
    expect(redPotted).toBe(true);
    expect(result.endState.playerColors[0]).toBe("red");
    expect(result.endState.playerColors[1]).toBe("yellow");
    //

    if (!result.outcome.foul) {
      expect(result.outcome.nextTurn).toBe(0); // pot your own ball → shoot again
    }
  });
});

describe("8-ball endgame", () => {
  it("potting the black after clearing your set wins the frame", () => {
    const state = nearEndState("red");
    const black = state.balls.find((b) => b.color === "black")!;
    const hole = HOLES[3];
    black.x = hole.x - 60;
    black.y = hole.y - 60;
    const cue = cueBall(state);
    cue.x = black.x - 200;
    cue.y = black.y - 200;
    const angle = Math.atan2(black.y - cue.y, black.x - cue.x);
    // Soft shot: enough to drop the black, not enough for the cue to
    // follow through into the pocket (which would be a losing scratch).
    const result = simulateShot(state, { angle, power: 7 });

    expect(result.events.some((e) => e.type === "pocket" && e.color === "black")).toBe(true);
    expect(result.outcome.gameOver).toBe(true);
    expect(result.outcome.winner).toBe(0);
  });

  it("potting the black with your balls still up loses the frame", () => {
    const state = createInitialState();
    state.playerColors = ["red", "yellow"]; // groups assigned, nothing potted
    const black = state.balls.find((b) => b.color === "black")!;
    const hole = HOLES[3];
    black.x = hole.x - 60;
    black.y = hole.y - 60;
    const cue = cueBall(state);
    cue.x = black.x - 200;
    cue.y = black.y - 200;
    const angle = Math.atan2(black.y - cue.y, black.x - cue.x);
    const result = simulateShot(state, { angle, power: 40 });

    expect(result.events.some((e) => e.type === "pocket" && e.color === "black")).toBe(true);
    expect(result.outcome.gameOver).toBe(true);
    expect(result.outcome.winner).toBe(1); // opponent wins
  });
});

describe("ball in hand placement", () => {
  function foulState(): TableState {
    const state = createInitialState();
    state.ballInHand = true;
    cueBall(state).inHole = true;
    return state;
  }

  it("accepts a legal placement and restores the cue ball", () => {
    const result = placeCueBall(foulState(), 400, 400);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const cue = cueBall(result.state);
      expect(cue.inHole).toBe(false);
      expect(cue.x).toBe(400);
      expect(result.state.ballInHand).toBe(false);
    }
  });

  it("rejects placements outside borders, in pockets, or overlapping balls", () => {
    expect(placeCueBall(foulState(), 10, 10).ok).toBe(false); // outside
    expect(placeCueBall(foulState(), HOLES[0].x, HOLES[0].y).ok).toBe(false); // pocket
    expect(placeCueBall(foulState(), 1090, 413).ok).toBe(false); // on the black
    expect(placeCueBall(foulState(), NaN, 400).ok).toBe(false);
  });

  it("rejects placement when there is no ball in hand", () => {
    expect(placeCueBall(createInitialState(), 400, 400).ok).toBe(false);
  });
});

describe("pocket capture matches the visual mouth", () => {
  /** Lone cue ball hugging a cushion (centre clamped to the rail line). */
  function railState(y: number): TableState {
    const state = createInitialState();
    for (const ball of state.balls) {
      if (ball.id === CUE_BALL_ID) continue;
      ball.inHole = true;
      ball.x = 0;
      ball.y = 900;
    }
    const cue = cueBall(state);
    cue.x = 600;
    cue.y = y;
    return state;
  }

  it("a ball rolling along the TOP rail drops into the top-centre pocket", () => {
    // Top cushion rest line: centre y = BORDER + ball origin = 82.
    const result = simulateShot(railState(82), { angle: 0, power: 20 });
    expect(
      result.events.some((e) => e.type === "pocket" && e.ballId === CUE_BALL_ID)
    ).toBe(true);
    expect(result.endState.balls[CUE_BALL_ID].inHole).toBe(true);
  });

  it("a ball rolling along the BOTTOM rail drops into the bottom-centre pocket", () => {
    // Bottom cushion rest line: centre y = 825 - 57 - 25 = 743.
    const result = simulateShot(railState(743), { angle: 0, power: 20 });
    expect(
      result.events.some((e) => e.type === "pocket" && e.ballId === CUE_BALL_ID)
    ).toBe(true);
    expect(result.endState.balls[CUE_BALL_ID].inHole).toBe(true);
  });

  it("a ball rolling along the rail into a corner drops", () => {
    const state = railState(82);
    const cue = cueBall(state);
    cue.x = 300;
    const result = simulateShot(state, { angle: Math.PI, power: 20 }); // roll left
    expect(
      result.events.some((e) => e.type === "pocket" && e.ballId === CUE_BALL_ID)
    ).toBe(true);
  });
});

describe("spin / english (PoolDawgs extension)", () => {
  /** Cue at head spot firing straight +x into a single object ball. */
  function straightShotState(): TableState {
    const state = createInitialState();
    // Park everything except one red object ball and the cue.
    for (const ball of state.balls) {
      if (ball.id === CUE_BALL_ID) continue;
      ball.inHole = true;
      ball.x = 0;
      ball.y = 900;
    }
    const object = state.balls.find((b) => b.color === "red")!;
    object.inHole = false;
    object.x = 800;
    object.y = 413;
    const cue = cueBall(state);
    cue.x = 400;
    cue.y = 413;
    state.playerColors = ["red", "yellow"];
    return state;
  }

  it("follow (top spin) carries the cue ball further than a flat shot", () => {
    const flat = simulateShot(straightShotState(), { angle: 0, power: 30 });
    const follow = simulateShot(straightShotState(), {
      angle: 0,
      power: 30,
      spinY: 1,
    });
    const flatCue = flat.endState.balls[CUE_BALL_ID];
    const followCue = follow.endState.balls[CUE_BALL_ID];
    expect(followCue.x).toBeGreaterThan(flatCue.x);
  });

  it("draw (back spin) pulls the cue ball back behind a flat shot", () => {
    const flat = simulateShot(straightShotState(), { angle: 0, power: 30 });
    const draw = simulateShot(straightShotState(), {
      angle: 0,
      power: 30,
      spinY: -1,
    });
    const flatCue = flat.endState.balls[CUE_BALL_ID];
    const drawCue = draw.endState.balls[CUE_BALL_ID];
    expect(drawCue.x).toBeLessThan(flatCue.x);
  });

  it("side english changes the path after a cushion bounce", () => {
    // Fire the lone cue ball into the top cushion at an angle.
    const state = straightShotState();
    const object = state.balls.find((b) => b.color === "red")!;
    object.inHole = true;
    object.x = 0;
    object.y = 900;
    const plain = simulateShot(state, { angle: -Math.PI / 3, power: 30 });
    const english = simulateShot(state, { angle: -Math.PI / 3, power: 30, spinX: 1 });
    const plainCue = plain.endState.balls[CUE_BALL_ID];
    const englishCue = english.endState.balls[CUE_BALL_ID];
    expect(
      Math.abs(plainCue.x - englishCue.x) + Math.abs(plainCue.y - englishCue.y)
    ).toBeGreaterThan(10);
  });

  it("spin shots stay deterministic", () => {
    const a = simulateShot(createInitialState(), { angle: 0, power: 60, spinX: 0.5, spinY: -0.7 });
    const b = simulateShot(createInitialState(), { angle: 0, power: 60, spinX: 0.5, spinY: -0.7 });
    expect(stateHash(a.endState)).toEqual(stateHash(b.endState));
    expect(a.events).toEqual(b.events);
  });

  it("rejects out-of-range or non-finite spin", () => {
    const state = createInitialState();
    expect(validateShot(state, { angle: 0, power: 10, spinX: 1.5 }).ok).toBe(false);
    expect(validateShot(state, { angle: 0, power: 10, spinY: -2 }).ok).toBe(false);
    expect(validateShot(state, { angle: 0, power: 10, spinX: NaN }).ok).toBe(false);
    expect(validateShot(state, { angle: 0, power: 10, spinX: 0.5, spinY: -0.5 }).ok).toBe(true);
  });
});

describe("state utilities", () => {
  it("cloneState is deep for balls", () => {
    const state = createInitialState();
    const copy = cloneState(state);
    copy.balls[0].x = 999;
    expect(state.balls[0].x).not.toBe(999);
  });

  it("stateHash changes when state changes", () => {
    const state = createInitialState();
    const h1 = stateHash(state);
    const moved = cloneState(state);
    moved.balls[0].x += 1;
    expect(stateHash(moved)).not.toEqual(h1);
  });
});
