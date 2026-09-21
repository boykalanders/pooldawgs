// TS ↔ Havok parity — spec §12. Nothing else in this suite runs the SAME
// shot through both backends and compares outcomes. Not meant to require
// bit-identical results (they're different solvers) — meant to catch the
// case that actually matters: Practice (TS) teaching a shot that Havok
// (the authoritative, wagered backend) would resolve very differently.
//
// Three shots, increasing complexity:
//   1. Roll + one cushion bounce, no other balls — isolates how far apart
//      the two cushion-friction values (TS 0.12, Havok 0.20) land in practice.
//   2. A single cut shot on one object ball — isolates collision-model parity.
//   3. A straight full-power break — the real stress case, reusing the same
//      "cue on the rack's symmetry axis" setup break-symmetry.mjs already
//      trusts.
//
// Run after `tsc`:  node scripts/parity-tests.mjs
import { createInitialState, cueBallId, geomFor, simulateShot } from "../dist/index.js";
import { initHavok, simulateShotHavok } from "../dist/havok/simulator.js";

/** A mid-frame table: no ball in hand, so the scenario may put the cue ball
 *  anywhere (a fresh rack starts with ball in hand behind the head string /
 *  in the D, and the engine rejects a shot from outside that zone). */
function midFrame(s) {
  s.ballInHand = false;
  s.placementZone = undefined;
  return s;
}

await initHavok();

let pass = 0;
let warn = 0;
function report(name, ok, detail) {
  console.log(`  ${ok ? "✓" : "!"} ${name} — ${detail}`);
  ok ? pass++ : warn++;
}

function clearAllButCue(s) {
  for (const b of s.balls) {
    if (b.color === "cue") continue;
    b.inHole = true;
    b.x = 0;
    b.y = 900;
  }
}

function pocketedIds(s) {
  return new Set(s.balls.filter((b) => b.inHole && b.color !== "cue").map((b) => b.id));
}
function setsRoughlyMatch(a, b) {
  if (a.size !== b.size) return false;
  for (const x of a) if (!b.has(x)) return false;
  return true;
}
function dist(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

// A gap this size only matters if it changes what the player experiences —
// a table-length is ~1386 px, so ~15% of that is a generous "still roughly
// the same shot" bound, not a precision target.
const POSITION_TOLERANCE_PX = 200;

console.log("Test 1 — roll + single cushion bounce, no other balls\n");
{
  const gameType = "8ball";
  const g = geomFor(gameType);
  const mid = (g.TOP_BORDER_Y + g.BOTTOM_BORDER_Y) / 2;

  const sTs = midFrame(createInitialState(gameType));
  clearAllButCue(sTs);
  sTs.balls[cueBallId(sTs)].x = g.LEFT_BORDER_X + 500;
  sTs.balls[cueBallId(sTs)].y = mid;

  const sHv = midFrame(createInitialState(gameType));
  clearAllButCue(sHv);
  sHv.balls[cueBallId(sHv)].x = g.LEFT_BORDER_X + 500;
  sHv.balls[cueBallId(sHv)].y = mid;

  // π − 0.35 rad reaches the left rail ~180 px below centre — clear of every
  // pocket. (The original π − 0.6 ran straight into the bottom-left corner on
  // both backends, so this "cushion" test compared two scratched cue balls'
  // park positions and passed by coincidence.)
  const shot = { angle: Math.PI - 0.35, power: 45, spinX: 0, spinY: 0 };
  const rTs = simulateShot(sTs, shot, {});
  const rHv = simulateShotHavok(sHv, shot, {});
  const cueTs = rTs.endState.balls[cueBallId(rTs.endState)];
  const cueHv = rHv.endState.balls[cueBallId(rHv.endState)];
  const cushTs = rTs.events.filter((e) => e.type === "cushion").length;
  const cushHv = rHv.events.filter((e) => e.type === "cushion").length;
  if (cueTs.inHole || cueHv.inHole) {
    report("cue pocketed the same on both", cueTs.inHole === cueHv.inHole, `TS inHole=${cueTs.inHole}, Havok inHole=${cueHv.inHole}`);
  } else {
    const d = dist(cueTs, cueHv);
    report(
      "final cue position within tolerance",
      d <= POSITION_TOLERANCE_PX,
      `TS (${cueTs.x.toFixed(0)}, ${cueTs.y.toFixed(0)}) vs Havok (${cueHv.x.toFixed(0)}, ${cueHv.y.toFixed(0)}) — ${d.toFixed(0)} px apart; cushions TS ${cushTs} / Havok ${cushHv}`
    );
  }
}

console.log("\nTest 2 — single cut shot on one object ball\n");
{
  const gameType = "8ball";
  const g = geomFor(gameType);
  const mid = (g.TOP_BORDER_Y + g.BOTTOM_BORDER_Y) / 2;

  function setup() {
    const s = midFrame(createInitialState(gameType));
    clearAllButCue(s);
    const cue = s.balls[cueBallId(s)];
    cue.x = g.LEFT_BORDER_X + 300;
    cue.y = mid;
    // Bring back one object ball for a ~30° cut toward the lower-right area.
    const obj = s.balls.find((b) => b.color !== "cue");
    obj.inHole = false;
    obj.x = g.LEFT_BORDER_X + 700;
    obj.y = mid + 120;
    return { s, objId: obj.id };
  }
  const { s: sTs, objId } = setup();
  const { s: sHv } = setup();
  const shot = { angle: 0.35, power: 50, spinX: 0, spinY: 0 };
  const rTs = simulateShot(sTs, shot, {});
  const rHv = simulateShotHavok(sHv, shot, {});
  const objTs = rTs.endState.balls.find((b) => b.id === objId);
  const objHv = rHv.endState.balls.find((b) => b.id === objId);
  const cueTs = rTs.endState.balls[cueBallId(rTs.endState)];
  const cueHv = rHv.endState.balls[cueBallId(rHv.endState)];
  report(
    "object ball pocketed the same on both",
    objTs.inHole === objHv.inHole,
    `TS inHole=${objTs.inHole}, Havok inHole=${objHv.inHole}`
  );
  if (!objTs.inHole && !objHv.inHole) {
    const d = dist(objTs, objHv);
    report("object-ball rest position within tolerance", d <= POSITION_TOLERANCE_PX, `${d.toFixed(0)} px apart`);
  }
  const dc = dist(cueTs, cueHv);
  report("cue-ball rest position within tolerance", dc <= POSITION_TOLERANCE_PX, `${dc.toFixed(0)} px apart`);
}

console.log("\nTest 3 — straight full-power break\n");
{
  const gameType = "8ball";
  function rack() {
    const s = midFrame(createInitialState(gameType));
    const cue = s.balls[cueBallId(s)];
    const objs = s.balls.filter((b) => b.color !== "cue" && !b.inHole);
    const axis = objs.reduce((a, b) => a + b.y, 0) / objs.length;
    cue.y = axis;
    return s;
  }
  const sTs = rack();
  const sHv = rack();
  const shot = { angle: 0, power: 75, spinX: 0, spinY: 0 };
  const rTs = simulateShot(sTs, shot, {});
  const rHv = simulateShotHavok(sHv, shot, {});
  const potsTs = pocketedIds(rTs.endState);
  const potsHv = pocketedIds(rHv.endState);
  report(
    "same balls pocketed off the break",
    setsRoughlyMatch(potsTs, potsHv),
    `TS pocketed {${[...potsTs].join(",")}} vs Havok {${[...potsHv].join(",")}}`
  );
  const cueTs = rTs.endState.balls[cueBallId(rTs.endState)];
  const cueHv = rHv.endState.balls[cueBallId(rHv.endState)];
  const dc = dist(cueTs, cueHv);
  report("cue-ball rest position within tolerance", dc <= POSITION_TOLERANCE_PX, `${dc.toFixed(0)} px apart`);
}

console.log(`\n${pass} within tolerance, ${warn} flagged for a look. Tolerance is ${POSITION_TOLERANCE_PX}px, not zero —`);
console.log("the two backends are different solvers by design; this catches divergence big enough to matter,");
console.log("not floating-point drift. This has not been run against a real build — verify it executes cleanly");
console.log("after `tsc` before trusting the numbers, and tighten POSITION_TOLERANCE_PX once you've seen real output.");
