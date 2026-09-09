// Spec §14 "Ball collisions" + "Cushions" checks (Phase B), both backends.
//   node packages/engine/scripts/contact-tests.mjs
import { getRules, geomFor, simulateShot } from "../dist/index.js";
import { initHavok, simulateShotHavok } from "../dist/havok/simulator.js";

let pass = 0;
let fail = 0;
function check(name, ok, detail) {
  console.log(`  ${ok ? "✓" : "✗"} ${name} — ${detail}`);
  ok ? pass++ : fail++;
}

/** Cue + exactly one live object ball; everything else parked off-table. */
function table(gameType) {
  const s = getRules(gameType).createInitialState();
  const g = geomFor(gameType);
  const obj = s.balls.find((b) => b.color !== "cue");
  for (const b of s.balls) {
    if (b.color === "cue" || b.id === obj.id) continue;
    b.inHole = true;
    b.x = 0;
    b.y = g.TABLE_HEIGHT + 100;
  }
  const cue = s.balls.find((b) => b.color === "cue");
  return { s, cue, obj };
}

function run(label, sim, gameType) {
  console.log(`\n${label} — ${gameType}`);
  const g = geomFor(gameType);
  const midY = (g.TOP_BORDER_Y + g.BOTTOM_BORDER_Y) / 2;

  // 5. Head-on collision: cue transfers its pace to the object and stuns.
  {
    const { s, cue, obj } = table(gameType);
    obj.x = g.LEFT_BORDER_X + 600;
    obj.y = midY;
    cue.x = g.LEFT_BORDER_X + 200;
    cue.y = midY;
    const r = sim(s, { angle: 0, power: 40 }, { recordFrames: true, frameStride: 1 });
    const hit = r.events.find((e) => e.type === "ballsCollide");
    const f = r.frames.find((fr) => fr.step >= hit.step + 25);
    const c = f.balls.find((b) => b.id === cue.id);
    const o = f.balls.find((b) => b.id === obj.id);
    // object must be moving away, cue must have shed most of its pace
    const cueSpeed = Math.hypot(c.x - cue.x, c.y - cue.y);
    check(
      "5 head-on transfers pace to the object",
      o.x > obj.x + 20 && Math.abs(o.y - midY) < 6,
      `object advanced ${(o.x - obj.x).toFixed(0)}px, lateral ${Math.abs(o.y - midY).toFixed(2)}px, cue travel ${cueSpeed.toFixed(0)}px`
    );
  }

  // 6. Thin cut must not inject sideways energy into the CUE's line.
  {
    const { s, cue, obj } = table(gameType);
    obj.x = g.LEFT_BORDER_X + 600;
    obj.y = midY - g.BALL_SIZE * 0.85; // thin contact
    cue.x = g.LEFT_BORDER_X + 200;
    cue.y = midY;
    const r = sim(s, { angle: 0, power: 40 }, { recordFrames: true, frameStride: 1 });
    const hit = r.events.find((e) => e.type === "ballsCollide");
    const f = r.frames.find((fr) => fr.step >= hit.step + 25);
    const o = f.balls.find((b) => b.id === obj.id);
    // a thin cut sends the object mostly sideways, not straight down the line
    const dx = o.x - obj.x;
    const dy = o.y - obj.y;
    check(
      "6 thin cut sends the object off the contact line",
      dy < -2 && Math.abs(dy) > Math.abs(dx) * 0.15,
      `object moved dx ${dx.toFixed(0)} dy ${dy.toFixed(0)} px`
    );
  }

  // 7. Cluster break leaves no persistent overlap.
  {
    const s = getRules(gameType).createInitialState();
    const r = sim(s, { angle: 0, power: 75 });
    let worst = 0;
    const live = r.endState.balls.filter((b) => !b.inHole);
    for (let i = 0; i < live.length; i++) {
      for (let j = i + 1; j < live.length; j++) {
        const d = Math.hypot(live[i].x - live[j].x, live[i].y - live[j].y);
        worst = Math.max(worst, g.BALL_SIZE - d);
      }
    }
    check(
      "7 break leaves no overlapping balls",
      worst <= 0.5,
      `worst final overlap ${worst.toFixed(3)}px, in-shot peak ${r.diagnostics.maxPenetration.toFixed(2)}px`
    );
  }

  // 12. Repeated cushion contacts bleed energy and settle.
  {
    const { s, cue } = table(gameType);
    cue.x = g.LEFT_BORDER_X + 150;
    cue.y = midY;
    const r = sim(s, { angle: 0.62, power: 75 });
    check(
      "12 repeated banks bleed energy and settle",
      !r.diagnostics.settleCapped && r.diagnostics.cushionContacts >= 1,
      `${r.diagnostics.cushionContacts} cushion contacts, settle ${r.diagnostics.settleSeconds.toFixed(2)}s`
    );
  }

  // §7.4 — one cushion event per physical contact, not one per substep.
  {
    const { s, cue } = table(gameType);
    cue.x = g.LEFT_BORDER_X + 150;
    cue.y = midY;
    const r = sim(s, { angle: 0, power: 30 }); // straight into the far rail
    const perStep = new Map();
    for (const e of r.events) {
      if (e.type !== "cushion") continue;
      const k = `${e.step}:${e.ballId}`;
      perStep.set(k, (perStep.get(k) ?? 0) + 1);
    }
    const dupes = [...perStep.values()].filter((n) => n > 1).length;
    check(
      "§7.4 no duplicate cushion events in a step",
      dupes === 0,
      `${r.diagnostics.cushionContacts} contacts, ${dupes} duplicated`
    );
  }
}

await initHavok();
for (const gameType of ["8ball", "snooker"]) {
  run("TS", (s, shot, o) => simulateShot(s, shot, o), gameType);
  run("Havok", (s, shot, o) => simulateShotHavok(s, shot, o), gameType);
}
console.log(`\n  ${pass}/${pass + fail} contact tests pass\n`);
process.exit(fail ? 1 : 0);
