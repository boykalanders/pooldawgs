// Break-symmetry check: a dead-straight full-power break into a symmetric rack
// must spread the pack evenly, not "drag everything to one side".
//   node packages/engine/scripts/break-symmetry.mjs
// For each backend + variant it breaks the normal rack and the same rack
// mirrored about the cue line. A physically correct solver gives a pack centre
// near the cue line in BOTH cases; an order-dependent solver shows a large
// offset that flips sign when the rack is mirrored.
import { getRules, simulateShot } from "../dist/index.js";
import { initHavok, simulateShotHavok } from "../dist/havok/simulator.js";

let pass = 0;
let fail = 0;
function check(name, ok, detail) {
  console.log(`  ${ok ? "✓" : "✗"} ${name} — ${detail}`);
  ok ? pass++ : fail++;
}

function rack(gameType, mirror) {
  const s = getRules(gameType).createInitialState();
  const cue = s.balls.find((b) => b.color === "cue");
  // Snooker: break the red triangle alone — the colours sit on its axis (pink
  // right at the apex) and would turn this into a different shot.
  if (gameType === "snooker") {
    for (const b of s.balls) {
      if (b.color === "cue" || b.color === "red") continue;
      b.inHole = true;
      b.x = 0;
      b.y = -500;
    }
  }
  const objs = s.balls.filter((b) => b.color !== "cue" && !b.inHole);
  // Put the cue exactly on the rack's own line of symmetry.
  const axis = objs.reduce((a, b) => a + b.y, 0) / objs.length;
  cue.y = axis;
  if (mirror) for (const b of objs) b.y = 2 * axis - b.y;
  return { s, cue, objs, axis };
}

// Measured this many steps (120 Hz) after the break contact: 0.25 s is the
// pack opening, 1 s is the spread across the table the player actually sees.
const WINDOWS = [30, 120];

/** Mean lateral offset of the object balls (and the cue) at each window. */
function spread(sim, gameType, mirror) {
  const { s, cue, objs, axis } = rack(gameType, mirror);
  const r = sim(s, { angle: 0, power: 75 }, { recordFrames: true, frameStride: 1 });
  const hit = r.events.find((e) => e.type === "ballsCollide");
  const ids = new Set(objs.map((b) => b.id));
  return WINDOWS.map((w) => {
    const f = r.frames.find((fr) => fr.step >= hit.step + w) ?? r.frames[r.frames.length - 1];
    // Potted balls keep their last on-table position, so they still count.
    const live = f.balls.filter((b) => ids.has(b.id));
    const meanDy = live.reduce((a, b) => a + (b.y - axis), 0) / live.length;
    const c = f.balls.find((b) => b.id === cue.id);
    return { w, meanDy, cueDy: c.y - axis };
  });
}

function run(label, sim, gameType, tol) {
  console.log(`\n${label} — ${gameType}`);
  const a = spread(sim, gameType, false);
  const b = spread(sim, gameType, true);
  for (let k = 0; k < WINDOWS.length; k++) {
    const t = `${(WINDOWS[k] / 120).toFixed(2)}s`;
    check(
      `pack centre on the cue line @${t}`,
      Math.abs(a[k].meanDy) < tol && Math.abs(b[k].meanDy) < tol,
      `normal ${a[k].meanDy.toFixed(2)}px, mirrored ${b[k].meanDy.toFixed(2)}px (tol ${tol}px)`
    );
    check(
      `cue not deflected sideways @${t}`,
      Math.abs(a[k].cueDy) < tol && Math.abs(b[k].cueDy) < tol,
      `normal ${a[k].cueDy.toFixed(2)}px, mirrored ${b[k].cueDy.toFixed(2)}px`
    );
  }
}

// Both backends resolve ball↔ball contacts with the same order-independent
// Jacobi solve, so both are held to the same tight bound. Before the fix: TS
// ~60 px, Havok 15–28 px, sign flipping with the mirror.
for (const g of ["8ball", "9ball", "snooker"]) run("TS", simulateShot, g, 3);

await initHavok();
for (const g of ["8ball", "9ball", "snooker"]) run("Havok", simulateShotHavok, g, 3);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
