// Measures cue-ball stopping distance & travel time at several powers, on a
// clear table, to tune the friction model. Run after `tsc`:  node scripts/measure-physics.mjs
import { createInitialState, simulateShot, TABLE_WIDTH } from "../dist/index.js";

function clearTable() {
  const s = createInitialState("8ball");
  // Park every object ball; leave only the cue at far left, fire straight +x.
  for (const b of s.balls) {
    if (b.color === "cue") {
      b.x = 100;
      b.y = 412;
    } else {
      b.inHole = true;
      b.x = 0;
      b.y = 900;
    }
  }
  return s;
}

console.log(`table width ${TABLE_WIDTH}px = 1 length. Path length = total cloth rolled.\n`);
for (const power of [10, 25, 50, 75]) {
  const s = clearTable();
  const r = simulateShot(s, { angle: 0, power, spinX: 0, spinY: 0 }, { recordFrames: true, frameStride: 1 });
  // Sum per-frame cue movement to get true rolled distance (bounces included).
  let path = 0;
  let prev = null;
  for (const f of r.frames) {
    const c = f.balls[f.balls.length - 1]; // cue is last
    if (prev) path += Math.hypot(c.x - prev.x, c.y - prev.y);
    prev = c;
  }
  const lengths = (path / TABLE_WIDTH).toFixed(2);
  console.log(
    `power ${String(power).padStart(2)}  →  rolled ${path.toFixed(0)}px (${lengths} lengths)  settle ${(r.steps / 100).toFixed(2)}s`
  );
}
