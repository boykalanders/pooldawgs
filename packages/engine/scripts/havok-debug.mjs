import { createInitialState, cueBallId, PX_PER_M, PLAY_LENGTH_PX } from "../dist/index.js";
import { initHavok, simulateShotHavok } from "../dist/havok/simulator.js";

await initHavok();
const s = createInitialState("8ball");
for (const b of s.balls) {
  if (b.color === "cue") continue;
  b.inHole = true;
  b.x = 0;
  b.y = 900;
}
const cid = cueBallId(s);
s.balls[cid].x = 120;
s.balls[cid].y = 412;

const r = simulateShotHavok(s, { angle: 0, power: 75 }, { recordFrames: true, frameStride: 1 });
console.log(`steps=${r.steps} frames=${r.frames.length}`);
let maxX = 0;
for (let i = 0; i < r.frames.length; i++) {
  const c = r.frames[i].balls[r.frames[i].balls.length - 1];
  if (c.x > maxX) maxX = c.x;
  if (i % 10 === 0 || i === r.frames.length - 1)
    console.log(`  step ${r.frames[i].step}: x=${c.x.toFixed(0)} y=${c.y.toFixed(0)} vis=${c.visible}`);
}
console.log(`maxX=${maxX.toFixed(0)} (right rail ~1418), endX=${r.endState.balls[cid].x.toFixed(0)} inHole=${r.endState.balls[cid].inHole}`);
console.log(`1 length = ${PLAY_LENGTH_PX}px`);
process.exit(0);
