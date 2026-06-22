// Havok physics playtest — same spirit as the TS playtest, against the Havok
// backend. Verifies a shot scatters/pots, and that REAL spin produces draw &
// follow. Run after `tsc`:  node scripts/havok-playtest.mjs
import {
  createInitialState,
  cueBallId,
  HOLES,
  BALL_SIZE,
  PLAY_LENGTH_PX,
  PX_PER_M,
} from "../dist/index.js";
import { initHavok, simulateShotHavok } from "../dist/havok/simulator.js";

const CM = (px) => ((px / PX_PER_M) * 100).toFixed(1);
const LEN = (px) => (px / PLAY_LENGTH_PX).toFixed(2);
let pass = 0,
  fail = 0;
const report = (n, ok, d) => {
  console.log(`  ${ok ? "✓" : "✗"} ${n} — ${d}`);
  ok ? pass++ : fail++;
};

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
const cue = (s) => s.balls[cueBallId(s)];
function cuePath(r) {
  let path = 0,
    prev = null;
  for (const f of r.frames) {
    const c = f.balls[f.balls.length - 1];
    if (prev) path += Math.hypot(c.x - prev.x, c.y - prev.y);
    prev = c;
  }
  return path;
}

// 1. Full-power roll distance.
{
  const s = createInitialState("8ball");
  clear(s);
  cue(s).x = 120;
  cue(s).y = 412;
  const r = simulateShotHavok(s, { angle: 0, power: 75 }, { recordFrames: true, frameStride: 1 });
  const len = cuePath(r) / PLAY_LENGTH_PX;
  report("full-power roll", len >= 2.5 && len <= 4.5, `${LEN(cuePath(r))} lengths, settle ${(r.steps / 120).toFixed(2)}s`);
}

// 2. Break scatters the rack.
{
  const s = createInitialState("8ball");
  const before = s.balls.map((b) => ({ x: b.x, y: b.y }));
  const r = simulateShotHavok(s, { angle: 0, power: 70 });
  let moved = 0;
  for (let i = 0; i < r.endState.balls.length; i++) {
    const b = r.endState.balls[i];
    if (b.inHole || Math.hypot(b.x - before[i].x, b.y - before[i].y) > 30) moved++;
  }
  report("break scatters the rack", moved >= 6, `${moved} balls moved/potted`);
}

// 3. Straight pot into the corner.
{
  const s = createInitialState("8ball");
  const obj = s.balls.find((b) => b.color === "red");
  clear(s);
  obj.inHole = false;
  const pk = HOLES[3];
  obj.x = pk.x - 80;
  obj.y = pk.y - 80;
  const ax = pk.x - obj.x,
    ay = pk.y - obj.y,
    an = Math.hypot(ax, ay);
  const gx = obj.x - (ax / an) * BALL_SIZE,
    gy = obj.y - (ay / an) * BALL_SIZE;
  const c = cue(s);
  c.x = gx - 150;
  c.y = gy - 150;
  const r = simulateShotHavok(s, { angle: Math.atan2(gy - c.y, gx - c.x), power: 45 });
  report("corner pot", r.endState.balls[obj.id].inHole, r.endState.balls[obj.id].inHole ? "potted" : "missed");
}

// 4 & 5. Draw / follow — REAL spin (cue strikes an object head-on, object rolls
// away; read the cue's peak excursion from the contact point).
function spin(spinY) {
  const s = createInitialState("8ball");
  const obj = s.balls.find((b) => b.color === "red");
  clear(s);
  obj.inHole = false;
  obj.x = 900;
  obj.y = 412;
  const c = cue(s);
  c.x = 400;
  c.y = 412;
  const r = simulateShotHavok(s, { angle: 0, power: 55, spinY }, { recordFrames: true, frameStride: 1 });
  const cid = cueBallId(s);
  const cueAt = (f) => f.balls[f.balls.length - 1];
  const cols = r.events.filter((e) => e.type === "ballsCollide");
  const ci = Math.max(0, r.frames.findIndex((f) => f.step >= (cols[0]?.step ?? 0)));
  const cx = cueAt(r.frames[ci]).x;
  const cutoff = cols[1]?.step ?? Infinity;
  let maxFwd = 0,
    maxBack = 0;
  for (let i = ci + 1; i < r.frames.length; i++) {
    if (r.frames[i].step >= cutoff) break;
    const d = cueAt(r.frames[i]).x - cx;
    if (d > maxFwd) maxFwd = d;
    if (d < maxBack) maxBack = d;
  }
  return { maxFwd, maxBack: -maxBack };
}
{
  const back = spin(-1).maxBack;
  report("draw pulls the cue back", back > 20, `cue drew back ${CM(back)} cm`);
}
{
  const fwd = spin(1).maxFwd;
  report("follow carries the cue forward", fwd > 20, `cue followed ${CM(fwd)} cm`);
}

console.log(`\n  ${pass}/${pass + fail} Havok tests pass\n`);
process.exit(fail ? 1 : 0);
