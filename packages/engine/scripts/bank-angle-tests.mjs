// Bank-angle matrix — spec §7 cushion validation, both backends. Fires the
// cue ball at the LEFT rail across a spread of incidence angles and, for a
// fixed angle, with and without side english. Unlike assuming the aim angle
// equals the incidence angle, this MEASURES the actual incoming/outgoing
// angle and speed ratio from recorded frames, and sanity-checks that the
// ball actually hit the rail it was aimed at (not the top/bottom rail by
// accident on a shallow shot) before trusting the result.
//
// This exists to answer one question with real numbers instead of a guess:
// what does each backend's cushion friction (TS 0.12, Havok 0.20) actually
// produce, and how far apart is that in practice? Run after `tsc`:
//   node scripts/bank-angle-tests.mjs
import { createInitialState, cueBallId, geomFor, simulateShot } from "../dist/index.js";
import { initHavok, simulateShotHavok } from "../dist/havok/simulator.js";

await initHavok();
console.log("Havok initialised\n");

function clear(s) {
  for (const b of s.balls) {
    if (b.color === "cue") continue;
    b.inHole = true;
    b.x = 0;
    b.y = 900;
  }
}

function ballAt(frame, id) {
  return frame.balls.find((b) => b.id === id) ?? null;
}
function frameAtStep(frames, step) {
  return frames[step]?.step === step ? frames[step] : frames.find((f) => f.step === step) ?? null;
}
function dir(a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const speed = Math.hypot(dx, dy);
  return { x: dx / (speed || 1), y: dy / (speed || 1), speed };
}
/** Angle (deg) from the LEFT rail's inward normal (+x). 0° = perpendicular,
 *  90° = grazing along the rail. */
function angleFromNormal(d) {
  return (Math.acos(Math.min(1, Math.max(-1, Math.abs(d.x)))) * 180) / Math.PI;
}

/**
 * Fire the cue ball at the left rail from (LEFT_BORDER_X + dx, midY) at
 * `thetaDeg` from the rail normal, and measure what actually happened.
 * Returns null (and logs why) if the shot didn't produce a clean single
 * bounce off the LEFT rail — e.g. it clipped the top/bottom rail first.
 */
function bankShot(sim, gameType, thetaDeg, dx, power, spinX = 0) {
  const g = geomFor(gameType);
  const s = createInitialState(gameType);
  clear(s);
  const cueId = cueBallId(s);
  const cue = s.balls[cueId];
  cue.x = g.LEFT_BORDER_X + dx;
  cue.y = (g.TOP_BORDER_Y + g.BOTTOM_BORDER_Y) / 2;
  const theta = (thetaDeg * Math.PI) / 180;
  const angle = Math.PI - theta; // heading toward -x, tilted by theta off the normal
  const r = sim(s, { angle, power, spinX }, { recordFrames: true, frameStride: 1 });

  const ev = r.events.find((e) => e.type === "cushion" && e.ballId === cueId);
  if (!ev) return { ok: false, why: "no cushion contact recorded" };
  const at = ballAt(frameAtStep(r.frames, ev.step), cueId);
  if (!at || Math.abs(at.x - g.LEFT_BORDER_X) > g.BALL_RADIUS * 1.5) {
    return { ok: false, why: `contact wasn't on the left rail (x=${at?.x?.toFixed(0)})` };
  }
  const f0 = frameAtStep(r.frames, ev.step - 2);
  const f1 = frameAtStep(r.frames, ev.step - 1);
  const f2 = frameAtStep(r.frames, ev.step + 1);
  const f3 = frameAtStep(r.frames, ev.step + 2);
  if (!f0 || !f1 || !f2 || !f3) return { ok: false, why: "not enough frames around contact" };
  const before = dir(ballAt(f0, cueId), ballAt(f1, cueId));
  const after = dir(ballAt(f2, cueId), ballAt(f3, cueId));
  return {
    ok: true,
    inAngle: angleFromNormal(before),
    outAngle: angleFromNormal(after),
    speedRatio: after.speed / (before.speed || 1e-9),
  };
}

const BACKENDS = [
  ["TS", simulateShot],
  ["Havok", simulateShotHavok],
];
const ANGLES = [10, 30, 45, 60, 70]; // degrees from the rail normal
const DX = 90; // px from the rail — stays inside the table at every angle above
const POWER = 35;

console.log("Incidence-angle sweep (left rail, no english)\n");
console.log("backend  aim°  in°    out°   speed-ratio");
for (const [name, sim] of BACKENDS) {
  for (const theta of ANGLES) {
    const r = bankShot(sim, "8ball", theta, DX, POWER);
    if (!r.ok) {
      console.log(`${name.padEnd(7)}${String(theta).padStart(4)}   skipped — ${r.why}`);
      continue;
    }
    console.log(
      `${name.padEnd(7)}${String(theta).padStart(4)}  ${r.inAngle.toFixed(1).padStart(5)}  ${r.outAngle
        .toFixed(1)
        .padStart(5)}  ${r.speedRatio.toFixed(3)}`
    );
  }
}

console.log("\nSide-english throw check (left rail, 30° incidence, fixed power)\n");
console.log("backend  spinX  out°   Δout° vs spinX=0");
for (const [name, sim] of BACKENDS) {
  const base = bankShot(sim, "8ball", 30, DX, 45, 0);
  const spun = bankShot(sim, "8ball", 30, DX, 45, 0.8);
  if (!base.ok || !spun.ok) {
    console.log(`${name.padEnd(7)}  skipped — ${!base.ok ? base.why : spun.why}`);
    continue;
  }
  const delta = spun.outAngle - base.outAngle;
  console.log(`${name.padEnd(7)}  0.0    ${base.outAngle.toFixed(1).padStart(5)}  —`);
  console.log(`${name.padEnd(7)}  0.8    ${spun.outAngle.toFixed(1).padStart(5)}  ${delta >= 0 ? "+" : ""}${delta.toFixed(1)}°`);
}

console.log(
  "\nNot a pass/fail harness — it prints numbers. Use the no-english sweep to see how far apart\n" +
    "TS (CUSHION_FRICTION) and Havok (railMaterial.friction) actually land on out°/speed-ratio at each angle,\n" +
    "then tune one or both toward a shared target. This has not been run against a real build —\n" +
    "verify it executes cleanly after `tsc` before trusting the numbers."
);
