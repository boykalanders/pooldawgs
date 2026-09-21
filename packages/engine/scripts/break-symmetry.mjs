// Break-symmetry check: a dead-straight full-power break into a symmetric rack
// must spread the pack evenly, not "drag everything to one side".
//   node packages/engine/scripts/break-symmetry.mjs
// For each backend + variant it breaks the normal rack and the same rack
// mirrored about the cue line. A physically correct solver gives a pack centre
// near the cue line in BOTH cases; an order-dependent solver shows a large
// offset that flips sign when the rack is mirrored.
import { geomFor, getRules, simulateShot } from "../dist/index.js";
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
  // Centre the whole setup on the TABLE's centre line. The pool rack sits at
  // y 413 while the cushions are symmetric about 412.5, and after a second of
  // cushion bounces that half-pixel alone moves the pack a few px — a property
  // of the table, not of the solver this test is checking.
  const g = geomFor(gameType);
  const axis = (g.TOP_BORDER_Y + g.BOTTOM_BORDER_Y) / 2;
  const rackAxis = objs.reduce((a, b) => a + b.y, 0) / objs.length;
  for (const b of objs) b.y += axis - rackAxis;
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
    const upTo = r.frames.filter((fr) => fr.step <= hit.step + w);
    const f = upTo[upTo.length - 1];
    // A potted ball counts at its LAST ON-TABLE position (the TS backend moves
    // it to an off-table park spot, which would read as a huge sideways drift).
    const lastSeen = new Map();
    for (const fr of upTo) for (const b of fr.balls) if (b.visible) lastSeen.set(b.id, b);
    const live = [...ids].map((id) => lastSeen.get(id));
    const meanDy = live.reduce((a, b) => a + (b.y - axis), 0) / live.length;
    const c = lastSeen.get(cue.id) ?? f.balls.find((b) => b.id === cue.id);
    return { w, meanDy, cueDy: c.y - axis };
  });
}

/**
 * Share of the table's kinetic energy still present 25 ms after the break
 * contact (equal masses, so Σv²), relative to the cue just before it. Guards
 * the other way to get the break wrong: an order-independent solve that makes
 * the collisions inelastic (13 %, a dead break) or creates energy (> 100 %).
 */
function breakEnergy(sim, gameType) {
  const { s } = rack(gameType, false);
  const r = sim(s, { angle: 0, power: 75 }, { recordFrames: true, frameStride: 1 });
  const hit = r.events.find((e) => e.type === "ballsCollide").step;
  const F = (k) => r.frames.find((f) => f.step === k);
  const ke = (k) => {
    const a = F(k - 1);
    let e = 0;
    for (const b of F(k).balls) {
      if (!b.visible) continue;
      const p = a.balls.find((x) => x.id === b.id);
      e += (b.x - p.x) ** 2 + (b.y - p.y) ** 2;
    }
    return e;
  };
  return ke(hit + 3) / ke(hit - 1);
}

function run(label, sim, gameType, tol) {
  console.log(`\n${label} — ${gameType}`);
  const kept = breakEnergy(sim, gameType);
  check(
    "break keeps its energy (no dead or explosive break)",
    kept > 0.4 && kept <= 1.0,
    `${(kept * 100).toFixed(0)}% of the cue's energy on the table 25 ms after impact (want 40–100%)`
  );
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
// (Jacobi, Poisson-restitution) solve, so both are held to the same tight
// bound. Before the fix: TS ~60 px, Havok 15–28 px, sign flipping with the
// mirror.
for (const g of ["8ball", "9ball", "snooker"]) run("TS", simulateShot, g, 3);

await initHavok();
for (const g of ["8ball", "9ball", "snooker"]) run("Havok", simulateShotHavok, g, 3);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
