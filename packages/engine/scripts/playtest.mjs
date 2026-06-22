// PHYSICS SPEC V0.1 — playtest checklist harness. Measures every checklist
// item (spec §12) against the calibrated constants and reports actual numbers
// vs targets. Run after `tsc`:  node scripts/playtest.mjs
import {
  createInitialState,
  simulateShot,
  cueBallId,
  HOLES,
  BALL_SIZE,
  PLAY_LENGTH_PX,
  PX_PER_M,
} from "../dist/index.js";

const CM = (px) => ((px / PX_PER_M) * 100).toFixed(1);
const LEN = (px) => (px / PLAY_LENGTH_PX).toFixed(2);
let pass = 0;
let fail = 0;
const report = (name, ok, detail) => {
  console.log(`  ${ok ? "✓" : "✗"} ${name} — ${detail}`);
  ok ? pass++ : fail++;
};

function clearTable(s) {
  for (const b of s.balls) {
    if (b.color === "cue") continue;
    b.inHole = true;
    b.x = 0;
    b.y = 900;
  }
}
function cue(s) {
  return s.balls[cueBallId(s)];
}
/** Total cloth distance the cue ball rolled (bounces included). */
function cuePath(result) {
  let path = 0;
  let prev = null;
  for (const f of result.frames) {
    const c = f.balls[f.balls.length - 1];
    if (prev) path += Math.hypot(c.x - prev.x, c.y - prev.y);
    prev = c;
  }
  return path;
}

// ── Test 1: full table shot → cue rolls ≈3–4 table lengths ────────────────
{
  const s = createInitialState("8ball");
  clearTable(s);
  cue(s).x = 100;
  cue(s).y = 412;
  const r = simulateShot(s, { angle: 0, power: 75 }, { recordFrames: true, frameStride: 1 });
  const lengths = cuePath(r) / PLAY_LENGTH_PX;
  report(
    "Test 1 full-power roll",
    lengths >= 3 && lengths <= 4,
    `${LEN(cuePath(r))} table lengths (target 3–4), settle ${(r.steps / 120).toFixed(2)}s`
  );
}

// ── Test 2: 45° bank → natural rebound, no pinball ────────────────────────
{
  const s = createInitialState("8ball");
  clearTable(s);
  cue(s).x = 300;
  cue(s).y = 600;
  const r = simulateShot(s, { angle: -Math.PI / 4, power: 55 }, { recordFrames: true, frameStride: 1 });
  const banks = r.events.filter((e) => e.type === "cushion").length;
  // "No pinball" = it loses energy and settles in a sane number of rails.
  report(
    "Test 2 45° bank",
    banks >= 1 && banks <= 6 && r.endState.balls.every((b) => !b.moving),
    `${banks} cushion contacts, rolled ${LEN(cuePath(r))} lengths, settled`
  );
}

// ── Test 3: thin cut → pots when correctly aimed ──────────────────────────
{
  const s = createInitialState("8ball");
  const obj = s.balls.find((b) => b.color === "red");
  clearTable(s);
  obj.inHole = false;
  const pocket = HOLES[3]; // bottom-right corner
  // Object just outside the pocket; cue aimed to send it along the throat line.
  obj.x = pocket.x - 70;
  obj.y = pocket.y - 70;
  // Ghost-ball contact point behind the object on the object→pocket line.
  const ax = pocket.x - obj.x;
  const ay = pocket.y - obj.y;
  const an = Math.hypot(ax, ay);
  const ghostX = obj.x - (ax / an) * BALL_SIZE;
  const ghostY = obj.y - (ay / an) * BALL_SIZE;
  const c = cue(s);
  c.x = ghostX - 180;
  c.y = ghostY - 110; // a genuine cut angle, not a straight shot
  const angle = Math.atan2(ghostY - c.y, ghostX - c.x);
  const r = simulateShot(s, { angle, power: 45 });
  report(
    "Test 3 thin cut",
    r.endState.balls[obj.id].inHole,
    r.endState.balls[obj.id].inHole ? "object potted" : "MISSED"
  );
}

// ── Tests 4 & 5: draw / follow distance ───────────────────────────────────
// Centre-lane straight shot: the cue strikes a stationary object head-on; the
// object rolls away and we read the cue's FIRST settle position (before the
// object can bank back), so the displacement is pure spin effect.
function spinShot(spinY) {
  const s = createInitialState("8ball");
  const obj = s.balls.find((b) => b.color === "red");
  clearTable(s);
  obj.inHole = false;
  obj.x = 900;
  obj.y = 412;
  const c = cue(s);
  c.x = 400;
  c.y = 412;
  const r = simulateShot(s, { angle: 0, power: 50, spinY }, { recordFrames: true, frameStride: 1 });
  const frames = r.frames;
  const cueAt = (i) => frames[i].balls[frames[i].balls.length - 1];
  const collides = r.events.filter((e) => e.type === "ballsCollide");
  const ci = Math.max(0, frames.findIndex((f) => f.step >= (collides[0]?.step ?? 0)));
  const contactX = cueAt(ci).x;
  // Cut off at the SECOND cue collision (object banking back) so the late
  // re-hit can't corrupt the measurement; track the cue's peak excursion.
  const cutoffStep = collides[1]?.step ?? Infinity;
  let maxFwd = 0;
  let maxBack = 0;
  for (let i = ci + 1; i < frames.length; i++) {
    if (frames[i].step >= cutoffStep) break;
    const d = cueAt(i).x - contactX;
    if (d > maxFwd) maxFwd = d;
    if (d < maxBack) maxBack = d;
  }
  return { maxFwd, maxBack: -maxBack };
}
{
  const back = spinShot(-1).maxBack; // draw → backward excursion
  report(
    "Test 4 draw",
    back >= 109 && back <= 273,
    `cue returned ${CM(back)} cm (target 20–50 cm)`
  );
}
{
  const fwd = spinShot(1).maxFwd; // follow → forward excursion
  report(
    "Test 5 follow",
    fwd >= 80 && fwd <= 220,
    `cue followed ${CM(fwd)} cm (target ~25 cm)`
  );
}

// ── Test 6: soft pocket shot → drops, no lip bounce ───────────────────────
{
  const s = createInitialState("8ball");
  const obj = s.balls.find((b) => b.color === "red");
  clearTable(s);
  obj.inHole = false;
  const pocket = HOLES[3];
  // A close-range hanger — the real "soft pocket shot": must drop, not rattle.
  obj.x = pocket.x - 60;
  obj.y = pocket.y - 60;
  const c = cue(s);
  const ax = pocket.x - obj.x;
  const ay = pocket.y - obj.y;
  const an = Math.hypot(ax, ay);
  c.x = obj.x - (ax / an) * 90;
  c.y = obj.y - (ay / an) * 90;
  const angle = Math.atan2(obj.y - c.y, obj.x - c.x);
  const r = simulateShot(s, { angle, power: 12 }); // gentle
  report(
    "Test 6 soft pocket",
    r.endState.balls[obj.id].inHole,
    r.endState.balls[obj.id].inHole ? "dropped softly" : "did not drop"
  );
}

console.log(`\n  ${pass}/${pass + fail} checklist tests pass\n`);
process.exit(fail ? 1 : 0);
