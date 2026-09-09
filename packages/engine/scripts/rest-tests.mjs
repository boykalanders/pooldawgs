// Spec §14 "Rest and cloth" + diagnostics checks, run against BOTH backends.
// These cover the reported symptom directly: balls that keep creeping after a
// shot, and breaks that leave residual motion or interpenetration.
//   node packages/engine/scripts/rest-tests.mjs
import { getRules, geomFor, simulateShot, PHYSICS_VERSION } from "../dist/index.js";
import { initHavok, simulateShotHavok } from "../dist/havok/simulator.js";

let pass = 0;
let fail = 0;
function check(name, ok, detail) {
  console.log(`  ${ok ? "✓" : "✗"} ${name} — ${detail}`);
  ok ? pass++ : fail++;
}

/** Open table: one object ball well clear, cue on the baulk spot. */
function openTable(gameType) {
  const rules = getRules(gameType);
  const s = rules.createInitialState();
  const g = geomFor(gameType);
  let i = 0;
  for (const b of s.balls) {
    if (b.color === "cue") continue;
    // park all but one far from the cue's path
    b.inHole = true;
    b.x = 0;
    b.y = g.TABLE_HEIGHT + 100;
    i++;
  }
  const cue = s.balls.find((b) => b.color === "cue");
  cue.x = g.LEFT_BORDER_X + 200;
  cue.y = (g.TOP_BORDER_Y + g.BOTTOM_BORDER_Y) / 2;
  cue.inHole = false;
  return { state: s, cue };
}

function maxResidualSpeed(res) {
  let m = 0;
  for (const b of res.endState.balls) {
    if (b.inHole) continue;
    m = Math.max(m, Math.hypot(b.vx, b.vy));
  }
  return m;
}

function runBackend(label, sim, gameType) {
  console.log(`\n${label} — ${gameType}`);

  // 1 / 4. Soft straight shot stops dead, with nothing moving afterwards.
  {
    const { state } = openTable(gameType);
    const r = sim(state, { angle: 0, power: 12 });
    const resid = maxResidualSpeed(r);
    check(
      "1+4 soft shot settles with no residual motion",
      resid === 0 && !r.diagnostics.settleCapped,
      `residual ${resid.toFixed(4)} px/s, settle ${r.diagnostics.settleSeconds.toFixed(2)}s, staticStops ${r.diagnostics.staticStops}`
    );
  }

  // 2. Medium shot settles in a sane time (no endless glide).
  {
    const { state } = openTable(gameType);
    const r = sim(state, { angle: 0, power: 40 });
    check(
      "2 medium shot settles promptly",
      r.diagnostics.settleSeconds < 20 && !r.diagnostics.settleCapped,
      `settle ${r.diagnostics.settleSeconds.toFixed(2)}s, maxSpeed ${r.diagnostics.maxSpeed.toFixed(0)} px/s`
    );
  }

  // 3. Full-power shot settles and never reaches the step cap.
  {
    const { state } = openTable(gameType);
    const r = sim(state, { angle: 0.3, power: 75 });
    check(
      "3 full-power shot settles (no step-cap)",
      !r.diagnostics.settleCapped && maxResidualSpeed(r) === 0,
      `settle ${r.diagnostics.settleSeconds.toFixed(2)}s, cushions ${r.diagnostics.cushionContacts}`
    );
  }

  // Break: the cluster case — no deep interpenetration, no residual motion.
  {
    const rules = getRules(gameType);
    const s = rules.createInitialState();
    const r = sim(s, { angle: 0, power: 75 });
    const dia = r.diagnostics;
    const diameter = geomFor(gameType).BALL_SIZE;
    check(
      "break: no deep penetration, settles clean",
      dia.maxPenetration <= 0.1 * diameter && !dia.settleCapped && maxResidualSpeed(r) === 0,
      `pen ${dia.maxPenetration.toFixed(2)}px (limit ${(0.1 * diameter).toFixed(1)}), substeps ${dia.maxSubsteps}, settle ${dia.settleSeconds.toFixed(2)}s, flags [${dia.flags}]`
    );
  }

  // Diagnostics contract.
  {
    const { state } = openTable(gameType);
    const r = sim(state, { angle: 0, power: 30 });
    const d = r.diagnostics;
    check(
      "diagnostics + physics version present",
      r.physicsVersion === PHYSICS_VERSION &&
        d.backend === (label === "TS" ? "ts" : "havok") &&
        typeof d.maxSubsteps === "number" &&
        Array.isArray(d.flags),
      `version ${r.physicsVersion}, backend ${d.backend}, substeps ${d.maxSubsteps}`
    );
  }
}

await initHavok();
for (const gameType of ["8ball", "snooker"]) {
  runBackend("TS", (s, shot) => simulateShot(s, shot), gameType);
  runBackend("Havok", (s, shot) => simulateShotHavok(s, shot), gameType);
}
console.log(`\n  ${pass}/${pass + fail} rest/cloth tests pass\n`);
process.exit(fail ? 1 : 0);
