import { describe, expect, it } from "vitest";
import {
  cloneState,
  createInitialState,
  cueBall,
  cueBallId,
  placeCueBall,
  simulateShot,
  stateHash,
  validateShot,
} from "./world.js";
import { BALL_SIZE, HOLES, MAX_POWER, TABLE_WIDTH } from "./constants.js";
import { getRules } from "./variants/index.js";
import type { BallState, TableState } from "./types.js";

const BR_CORNER = HOLES[3]; // bottom-right (1435, 762)

/** Park every object ball off-table, leaving only the cue (and any kept ids). */
function clearExcept(state: TableState, keep: number[] = []): void {
  const cue = cueBallId(state);
  for (const b of state.balls) {
    if (b.id === cue || keep.includes(b.id)) continue;
    b.inHole = true;
    b.x = 0;
    b.y = 900;
  }
}

/** Place obj + cue collinear toward the bott-right corner; return the aim. */
function setupCornerPot(state: TableState, obj: BallState): number {
  obj.x = 1380;
  obj.y = 718;
  obj.inHole = false;
  obj.moving = false;
  const cue = cueBall(state);
  cue.x = 1300;
  cue.y = 655;
  cue.inHole = false;
  cue.moving = false;
  state.ballInHand = false;
  return Math.atan2(BR_CORNER.y - cue.y, BR_CORNER.x - cue.x);
}

describe("racks", () => {
  it.each(["8ball", "9ball", "snooker"] as const)(
    "%s starts with no overlapping balls",
    (gt) => {
      const balls = createInitialState(gt).balls;
      for (let i = 0; i < balls.length; i++) {
        for (let j = i + 1; j < balls.length; j++) {
          const d = Math.hypot(balls[i].x - balls[j].x, balls[i].y - balls[j].y);
          expect(d, `${gt}: balls ${i} & ${j} overlap`).toBeGreaterThanOrEqual(BALL_SIZE);
        }
      }
    }
  );
});

describe("determinism", () => {
  it("identical (state, shot) → identical end state, events, hash", () => {
    const a = simulateShot(createInitialState(), { angle: 0, power: 60 });
    const b = simulateShot(createInitialState(), { angle: 0, power: 60 });
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

  it("a break moves the rack and always settles", () => {
    const result = simulateShot(createInitialState(), { angle: 0, power: 75 });
    expect(result.steps).toBeLessThan(10000);
    for (const ball of result.endState.balls) expect(ball.moving).toBe(false);
  });
});

describe("physics realism (constant-deceleration friction)", () => {
  function rollDistance(power: number): number {
    const s = createInitialState();
    clearExcept(s);
    const cue = cueBall(s);
    cue.x = 100;
    cue.y = 412;
    const r = simulateShot(s, { angle: 0, power }, { recordFrames: true, frameStride: 1 });
    let path = 0;
    let prev: { x: number; y: number } | null = null;
    for (const f of r.frames!) {
      const c = f.balls[f.balls.length - 1];
      if (prev) path += Math.hypot(c.x - prev.x, c.y - prev.y);
      prev = c;
    }
    return path;
  }

  it("rolls farther with more power, and full power crosses multiple lengths", () => {
    const soft = rollDistance(20);
    const hard = rollDistance(75);
    expect(hard).toBeGreaterThan(soft);
    // Full power crosses the table at least twice (real break behaviour).
    expect(hard).toBeGreaterThan(2 * TABLE_WIDTH);
    // …but is not perpetual.
    expect(hard).toBeLessThan(5 * TABLE_WIDTH);
  });
});

describe("anti-tunneling at full power", () => {
  it("a full-power head-on transfers momentum instead of passing through", () => {
    const state = createInitialState();
    const object = state.balls.find((b) => b.color === "red")!;
    clearExcept(state, [object.id]);
    object.x = 800;
    object.y = 412;
    const cue = cueBall(state);
    cue.x = 400;
    cue.y = 412;
    const result = simulateShot(state, { angle: 0, power: MAX_POWER });
    expect(result.events.some((e) => e.type === "ballsCollide")).toBe(true);
    const endObject = result.endState.balls[object.id];
    const moved =
      endObject.inHole || Math.abs(endObject.x - 800) + Math.abs(endObject.y - 412) > 200;
    expect(moved).toBe(true);
  });

  it("a full-power break never leaves balls overlapping at rest", () => {
    const result = simulateShot(createInitialState(), { angle: 0, power: MAX_POWER });
    const onTable = result.endState.balls.filter((b) => !b.inHole);
    for (let i = 0; i < onTable.length; i++) {
      for (let j = i + 1; j < onTable.length; j++) {
        const d = Math.hypot(onTable[i].x - onTable[j].x, onTable[i].y - onTable[j].y);
        expect(d).toBeGreaterThan(BALL_SIZE - 2);
      }
    }
  });
});

describe("shot validation", () => {
  it("rejects bad power, bad spin, and ball-in-hand", () => {
    const s = createInitialState();
    expect(validateShot(s, { angle: 0, power: 0 }).ok).toBe(false);
    expect(validateShot(s, { angle: 0, power: MAX_POWER + 1 }).ok).toBe(false);
    expect(validateShot(s, { angle: NaN, power: 10 }).ok).toBe(false);
    expect(validateShot(s, { angle: 0, power: 10, spinX: 2 }).ok).toBe(false);
    expect(validateShot(s, { angle: 0, power: 10 }).ok).toBe(true);
    s.ballInHand = true;
    expect(validateShot(s, { angle: 0, power: 10 }).ok).toBe(false);
  });
});

describe("8-ball rules", () => {
  it("no contact is a foul: turn switches, ball in hand", () => {
    const result = simulateShot(createInitialState(), { angle: -Math.PI / 2, power: 10 });
    expect(result.outcome.foul).toBe(true);
    expect(result.outcome.nextTurn).toBe(1);
    expect(result.outcome.ballInHand).toBe(true);
  });

  it("first potted colour assigns groups and you continue", () => {
    const state = createInitialState();
    const red = state.balls.find((b) => b.color === "red")!;
    const angle = setupCornerPot(state, red);
    const result = simulateShot(state, { angle, power: 42 });
    expect(result.events.some((e) => e.type === "pocket" && e.ballId === red.id)).toBe(true);
    expect(result.endState.playerColors[0]).toBe("red");
    expect(result.endState.playerColors[1]).toBe("yellow");
    if (!result.outcome.foul) expect(result.outcome.nextTurn).toBe(0);
  });

  it("potting the black after clearing your set wins", () => {
    const state = createInitialState();
    state.playerColors = ["red", "yellow"];
    for (const b of state.balls) {
      if (b.color === "red") {
        b.inHole = true;
        b.x = 0;
        b.y = 900;
      }
    }
    const black = state.balls.find((b) => b.color === "black")!;
    clearExcept(state, [black.id]);
    const angle = setupCornerPot(state, black);
    const result = simulateShot(state, { angle, power: 42 });
    expect(result.outcome.gameOver).toBe(true);
    expect(result.outcome.winner).toBe(0);
  });

  it("scratching while potting your last group ball is a FOUL, not a win (black remains)", () => {
    const rules = getRules("8ball");
    const state = createInitialState("8ball");
    state.playerColors = ["red", "yellow"];
    const reds = state.balls.filter((b) => b.color === "red");
    // All reds but one already down; this shot clears the group.
    for (let i = 1; i < reds.length; i++) {
      reds[i].inHole = true;
      reds[i].x = 0;
      reds[i].y = 900;
    }
    const lastRed = reds[0];
    const cue = state.balls[cueBallId(state)];
    const acc = rules.createTurn();

    rules.onBallsCollide(state, acc, cue, lastRed); // legal first contact
    lastRed.inHole = true;
    rules.onPocket(state, acc, lastRed); // clears the group
    cue.inHole = true;
    rules.onPocket(state, acc, cue); // scratch on the same shot

    const res = rules.resolve(state, acc);
    expect(res.gameOver).toBe(false); // black is still on the table
    expect(res.foul).toBe(true);
    expect(res.ballInHand).toBe(true);
    expect(res.nextTurn).toBe(1);
    expect(state.balls.find((b) => b.color === "black")!.inHole).toBe(false);
  });

  it("potting the black with balls remaining loses", () => {
    const state = createInitialState();
    state.playerColors = ["red", "yellow"];
    const black = state.balls.find((b) => b.color === "black")!;
    const aRed = state.balls.find((b) => b.color === "red")!;
    clearExcept(state, [black.id, aRed.id]);
    aRed.x = 700; // player 0 still has a red on the table → black is illegal
    aRed.y = 150;
    const angle = setupCornerPot(state, black);
    const result = simulateShot(state, { angle, power: 42 });
    expect(result.outcome.gameOver).toBe(true);
    expect(result.outcome.winner).toBe(1);
  });
});

describe("ball in hand placement", () => {
  function foulState(): TableState {
    const s = createInitialState();
    s.ballInHand = true;
    cueBall(s).inHole = true;
    return s;
  }
  it("accepts a legal placement, rejects illegal ones", () => {
    expect(placeCueBall(foulState(), 400, 400).ok).toBe(true);
    expect(placeCueBall(foulState(), 10, 10).ok).toBe(false);
    expect(placeCueBall(foulState(), HOLES[0].x, HOLES[0].y).ok).toBe(false);
    expect(placeCueBall(createInitialState(), 400, 400).ok).toBe(false);
  });
});

describe("spin / english", () => {
  function straight(): TableState {
    const s = createInitialState();
    const obj = s.balls.find((b) => b.color === "red")!;
    clearExcept(s, [obj.id]);
    s.playerColors = ["red", "yellow"];
    obj.x = 800;
    obj.y = 412;
    const cue = cueBall(s);
    cue.x = 400;
    cue.y = 412;
    return s;
  }
  it("follow carries the cue forward, draw pulls it back", () => {
    const flat = simulateShot(straight(), { angle: 0, power: 30 });
    const follow = simulateShot(straight(), { angle: 0, power: 30, spinY: 1 });
    const draw = simulateShot(straight(), { angle: 0, power: 30, spinY: -1 });
    const cid = cueBallId(straight());
    expect(follow.endState.balls[cid].x).toBeGreaterThan(flat.endState.balls[cid].x);
    expect(draw.endState.balls[cid].x).toBeLessThan(flat.endState.balls[cid].x);
  });
  it("spin shots stay deterministic", () => {
    const a = simulateShot(createInitialState(), { angle: 0, power: 60, spinX: 0.5, spinY: -0.7 });
    const b = simulateShot(createInitialState(), { angle: 0, power: 60, spinX: 0.5, spinY: -0.7 });
    expect(stateHash(a.endState)).toEqual(stateHash(b.endState));
  });
});

describe("9-ball rules", () => {
  function nine() {
    return createInitialState("9ball");
  }
  it("racks 9 object balls + cue, 1 at the apex", () => {
    const s = nine();
    expect(s.balls).toHaveLength(10);
    expect(cueBall(s).color).toBe("cue");
    expect(s.balls.filter((b) => b.color !== "cue").map((b) => b.number).sort((a, b) => a - b))
      .toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it("hitting a ball that is not the lowest is a foul → ball in hand", () => {
    const s = nine();
    const one = s.balls.find((b) => b.number === 1)!;
    const three = s.balls.find((b) => b.number === 3)!;
    clearExcept(s, [one.id, three.id]);
    one.x = 700;
    one.y = 200; // out of the firing line
    three.x = 700;
    three.y = 412;
    const cue = cueBall(s);
    cue.x = 300;
    cue.y = 412;
    const r = simulateShot(s, { angle: 0, power: 35 });
    expect(r.outcome.foul).toBe(true);
    expect(r.outcome.ballInHand).toBe(true);
    expect(r.outcome.nextTurn).toBe(1);
  });

  it("legally potting the 9 wins the frame", () => {
    const s = nine();
    const nineBall = s.balls.find((b) => b.number === 9)!;
    clearExcept(s, [nineBall.id]); // 9 is now the lowest (and only) ball
    const angle = setupCornerPot(s, nineBall);
    const r = simulateShot(s, { angle, power: 42 });
    expect(r.events.some((e) => e.type === "pocket" && e.ballId === nineBall.id)).toBe(true);
    expect(r.outcome.gameOver).toBe(true);
    expect(r.outcome.winner).toBe(0);
  });

  it("the 9 potted on a foul is respotted and the frame continues", () => {
    const s = nine();
    const one = s.balls.find((b) => b.number === 1)!;
    const nineBall = s.balls.find((b) => b.number === 9)!;
    clearExcept(s, [one.id, nineBall.id]);
    one.x = 700;
    one.y = 150; // present (keeps 9 illegal) but out of the line
    const angle = setupCornerPot(s, nineBall); // hit the 9 first = foul
    const r = simulateShot(s, { angle, power: 42 });
    expect(r.outcome.gameOver).toBe(false);
    expect(r.outcome.foul).toBe(true);
    expect(r.endState.balls[nineBall.id].inHole).toBe(false); // respotted
  });
});

describe("snooker rules", () => {
  function snk() {
    return createInitialState("snooker");
  }
  it("racks 15 reds + 6 colours + cue", () => {
    const s = snk();
    expect(s.balls).toHaveLength(22);
    expect(s.balls.filter((b) => b.color === "red")).toHaveLength(15);
    expect(cueBall(s).color).toBe("cue");
    const black = s.balls.find((b) => b.color === "black")!;
    expect(black.value).toBe(7);
  });

  it("potting a red scores 1 and puts you on a colour", () => {
    const s = snk();
    const reds = s.balls.filter((b) => b.color === "red");
    // Keep one red (place near corner) + colours on their spots; park the rest.
    clearExcept(s, [...s.balls.filter((b) => b.color !== "red").map((b) => b.id), reds[0].id]);
    const angle = setupCornerPot(s, reds[0]);
    const r = simulateShot(s, { angle, power: 42 });
    expect(r.events.some((e) => e.type === "pocket" && e.ballId === reds[0].id)).toBe(true);
    expect(r.outcome.foul).toBe(false);
    expect(r.endState.scores[0]).toBe(1);
    expect(r.endState.onColor).toBe(true);
    expect(r.outcome.nextTurn).toBe(0);
  });

  it("on a colour, potting a colour scores its value and respots it", () => {
    const s = snk();
    s.onColor = true; // pretend we just potted a red
    const blue = s.balls.find((b) => b.color === "blue")!;
    const angle = setupCornerPot(s, blue);
    const r = simulateShot(s, { angle, power: 42 });
    expect(r.endState.scores[0]).toBe(5); // blue = 5
    expect(r.endState.onColor).toBe(false);
    expect(r.endState.balls[blue.id].inHole).toBe(false); // respotted
  });

  it("hitting a colour first while on a red is a foul (penalty to opponent)", () => {
    const s = snk();
    const blue = s.balls.find((b) => b.color === "blue")!;
    clearExcept(s, [...s.balls.filter((b) => b.color === "red").map((b) => b.id), blue.id]);
    blue.x = 700;
    blue.y = 412;
    const cue = cueBall(s);
    cue.x = 300;
    cue.y = 412;
    const r = simulateShot(s, { angle: 0, power: 35 });
    expect(r.outcome.foul).toBe(true);
    expect(r.endState.scores[1]).toBeGreaterThanOrEqual(4);
    expect(r.outcome.nextTurn).toBe(1);
  });
});

describe("state utilities", () => {
  it("cloneState is deep", () => {
    const s = createInitialState();
    const c = cloneState(s);
    c.balls[0].x = 999;
    c.scores[0] = 50;
    expect(s.balls[0].x).not.toBe(999);
    expect(s.scores[0]).toBe(0);
  });
});
