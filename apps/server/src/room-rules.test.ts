// Turn rules the server owns (client workflow spec): shot-clock timeouts give
// the opponent ball in hand, three missed turns in a row forfeit, turn ids make
// every timer/action idempotent, a disconnect pauses both clocks for a grace
// period, a restart resumes the saved time, and the 8-ball call is held here.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createInitialState, type TableState } from "@pooldawgs/engine";
import type { Address, RoomSnapshot } from "@pooldawgs/shared";
import { GameRoom, type RoomEmitter, type RoomOptions } from "./room.js";
import type { Relayer } from "./relayer.js";

const A = "0x000000000000000000000000000000000000000a" as Address;
const B = "0x000000000000000000000000000000000000000b" as Address;
const CLOCK = 240_000;
const GRACE = 60_000;

const relayer = { signResult: async () => null } as unknown as Relayer;

function makeRoom(options: RoomOptions = {}) {
  const states: RoomSnapshot[] = [];
  const over: Array<{ winner: Address; reason: string }> = [];
  const emitter: RoomEmitter = {
    broadcastShot() {},
    broadcastCuePlaced() {},
    broadcastState: (s) => states.push(s),
    broadcastOver: (p) => over.push(p),
  };
  const room = new GameRoom("t1", [A, B], emitter, relayer, CLOCK, null, "8ball", () => null, {
    graceMs: GRACE,
    ...options,
  });
  return { room, states, over };
}

/** Both at the table: the game is live and seat 0's clock runs. */
function liveRoom() {
  const r = makeRoom();
  r.room.connect(A);
  r.room.connect(B);
  return r;
}

/** Mid-frame 8-ball, seat 0 has cleared the reds and is on the black. */
function onTheBlack(): TableState {
  const s = createInitialState("8ball");
  s.broken = true;
  s.ballInHand = false;
  s.placementZone = undefined;
  s.playerColors = ["red", "yellow"];
  for (const b of s.balls) if (b.color === "red") b.inHole = true;
  return s;
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("shot-clock timeout", () => {
  it("gives the opponent ball in hand without simulating a shot or moving a ball", () => {
    const { room } = liveRoom();
    const before = room.snapshot();
    vi.advanceTimersByTime(CLOCK);
    const after = room.snapshot();
    expect(after.over).toBeNull();
    expect(after.state.turn).toBe(1);
    expect(after.state.ballInHand).toBe(true);
    expect(after.state.balls).toEqual(before.state.balls);
    expect(after.turnId).toBe(before.turnId! + 1);
    expect(after.players[0].missedTurns).toBe(1);
    expect(after.players[1].missedTurns).toBe(0);
    expect(after.clockRemainingMs).toBe(CLOCK); // a full clock for the opponent
  });

  it("three missed turns in a row forfeit; both away → decided by turn order", async () => {
    const { room, over } = liveRoom();
    // Seat 0 misses, seat 1 misses, … seat 0 reaches 3 first.
    for (let i = 0; i < 4; i++) vi.advanceTimersByTime(CLOCK);
    expect(over).toHaveLength(0);
    expect(room.snapshot().players.map((p) => p.missedTurns)).toEqual([2, 2]);
    await vi.advanceTimersByTimeAsync(CLOCK);
    expect(over).toEqual([expect.objectContaining({ winner: B, reason: "timeout" })]);
  });

  it("a player's count resets only after their own valid shot", () => {
    const { room } = liveRoom();
    vi.advanceTimersByTime(CLOCK); // seat 0: 1
    vi.advanceTimersByTime(CLOCK); // seat 1: 1, seat 0 to shoot with ball in hand
    expect(room.snapshot().players.map((p) => p.missedTurns)).toEqual([1, 1]);
    const r = room.handleShot(A, { angle: 0, power: 40 });
    expect(r.ok).toBe(true);
    expect(room.snapshot().players.map((p) => p.missedTurns)).toEqual([0, 1]);
  });
});

describe("turn ids: no double ball in hand, no stale actions", () => {
  it("a shot just before the deadline cancels that turn's timeout", () => {
    const { room } = liveRoom();
    vi.advanceTimersByTime(CLOCK - 1);
    expect(room.handleShot(A, { angle: 0, power: 40 }, 0).ok).toBe(true);
    const afterShot = room.snapshot();
    vi.advanceTimersByTime(1); // the old deadline passes: nothing happens
    expect(room.snapshot().turnId).toBe(afterShot.turnId);
    expect(room.snapshot().players[0].missedTurns).toBe(0);
  });

  it("an action for a turn that already ended is rejected", () => {
    const { room } = liveRoom();
    vi.advanceTimersByTime(CLOCK); // turn 0 timed out → turn 1, seat 1 to play
    const late = room.handleShot(B, { angle: 0, power: 40 }, 0);
    expect(late).toEqual({ ok: false, error: expect.objectContaining({ code: "stale-turn" }) });
    expect(room.handleShot(A, { angle: 0, power: 40 }, 1)).toEqual({
      ok: false,
      error: expect.objectContaining({ code: "not-your-turn" }),
    });
    expect(room.handleShot(B, { angle: 0, power: 40 }, 1).ok).toBe(true);
  });
});

describe("disconnect grace", () => {
  it("pauses both clocks with the remaining time saved; reconnecting resumes it; never a strike", () => {
    const { room } = liveRoom();
    vi.advanceTimersByTime(100_000);
    room.disconnect(B); // the opponent drops: the clock still pauses
    const paused = room.snapshot();
    expect(paused.clockPaused).toBe(true);
    expect(paused.clockRemainingMs).toBe(CLOCK - 100_000);
    expect(paused.players[1].graceExpiresAt).toBe(Date.now() + GRACE);
    vi.advanceTimersByTime(30_000);
    expect(room.snapshot().clockRemainingMs).toBe(CLOCK - 100_000);
    room.connect(B);
    expect(room.snapshot().clockPaused).toBe(false);
    vi.advanceTimersByTime(CLOCK - 100_000 - 1);
    expect(room.snapshot().state.turn).toBe(0);
    vi.advanceTimersByTime(1);
    expect(room.snapshot().state.turn).toBe(1); // timed out exactly on the saved time
    expect(room.snapshot().players[1].missedTurns).toBe(0);
  });

  it("when the grace runs out normal rules resume — the clock runs, no forfeit for being away", () => {
    const { room, over } = liveRoom();
    vi.advanceTimersByTime(200_000);
    room.disconnect(A);
    vi.advanceTimersByTime(GRACE);
    const s = room.snapshot();
    expect(over).toHaveLength(0);
    expect(s.clockPaused).toBe(false);
    expect(s.players[0].graceExpiresAt).toBeNull();
    vi.advanceTimersByTime(40_000); // the 40 s that were left
    expect(room.snapshot().state.turn).toBe(1);
    expect(room.snapshot().players[0].missedTurns).toBe(1);
  });

  it("a player who stays away gets no new grace on later turns", () => {
    const { room } = liveRoom();
    room.disconnect(A);
    vi.advanceTimersByTime(GRACE); // grace used up
    vi.advanceTimersByTime(CLOCK); // seat 0 times out → seat 1 (online) to shoot
    expect(room.snapshot().clockPaused).toBe(false);
  });
});

describe("server outage", () => {
  it("restores the saved remaining time, paused until the players are back", () => {
    const first = liveRoom();
    vi.advanceTimersByTime(90_000);
    const saved = JSON.parse(JSON.stringify(first.room.serialize()));
    first.room.dispose(); // the process dies; its timers are gone

    vi.advanceTimersByTime(10 * 60_000); // down for 10 minutes: nothing counts
    const { room } = makeRoom({
      restore: {
        state: saved.state,
        messages: [],
        started: true,
        turnId: saved.turnId,
        missed: saved.missed,
        clockRemainingMs: saved.clockRemainingMs,
      },
    });
    const s = room.snapshot();
    expect(s.over).toBeNull();
    expect(s.clockPaused).toBe(true);
    expect(s.clockRemainingMs).toBe(CLOCK - 90_000);
    room.connect(A);
    room.connect(B);
    expect(room.snapshot().clockPaused).toBe(false);
    vi.advanceTimersByTime(CLOCK - 90_000);
    expect(room.snapshot().state.turn).toBe(1);
  });
});

describe("8-ball called pocket (server-held)", () => {
  function blackRoom() {
    const r = makeRoom({ restore: { state: onTheBlack(), messages: [], started: true } });
    r.room.connect(A);
    r.room.connect(B);
    return r;
  }

  it("validates the caller, the pocket and the turn, and shows the call to both", () => {
    const { room } = blackRoom();
    expect(room.handleCallPocket(B, 2).ok).toBe(false); // not the active player
    expect(room.handleCallPocket(A, 6).ok).toBe(false); // no such pocket
    expect(room.handleCallPocket(A, 1.5).ok).toBe(false);
    expect(room.handleCallPocket(A, 2, 7).ok).toBe(false); // stale turn
    expect(room.handleCallPocket(A, 2, 0).ok).toBe(true);
    expect(room.snapshot().calledPocket).toBe(2);
  });

  it("is refused when not shooting at the black", () => {
    const { room } = liveRoom();
    expect(room.handleCallPocket(A, 0)).toEqual({ ok: false, error: expect.objectContaining({ code: "illegal-call" }) });
  });

  it("locks at the shot (the held call is used) and clears afterwards", () => {
    const { room } = blackRoom();
    expect(room.handleShot(A, { angle: 0, power: 30 }).ok).toBe(false); // no call yet
    room.handleCallPocket(A, 3);
    expect(room.handleShot(A, { angle: 0, power: 30 }).ok).toBe(true);
    expect(room.snapshot().calledPocket).toBeNull();
  });

  it("a timeout clears the call", () => {
    const { room } = blackRoom();
    room.handleCallPocket(A, 3);
    vi.advanceTimersByTime(CLOCK);
    expect(room.snapshot().calledPocket).toBeNull();
  });
});
