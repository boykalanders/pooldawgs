// Real-process check of the server-owned turn rules (client workflow spec),
// against the BUILT server (node dist/index.js), Havok physics, SQLite storage,
// two wallet-signed Socket.IO clients — no chain needed (dev mode):
//
//   timeout → opponent ball in hand, no ball moved, missed-turn count
//   stale turn id rejected, current one accepted
//   disconnect → both clocks paused with the time saved; reconnect resumes it
//   hard kill → new process waits for the stale lease, then restores the table
//               with the clock charged only up to the last heartbeat
//   SIGTERM (not on Windows, which has no catchable SIGTERM) → exact clock
//
// Build first: pnpm --filter @pooldawgs/engine build && pnpm --filter
// @pooldawgs/shared build && pnpm --filter @pooldawgs/server build
//   node apps/server/scripts/e2e-turn-rules.mjs
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Wallet } from "ethers";
import { io } from "socket.io-client";

const SERVER_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 4100 + Math.floor(Math.random() * 800);
const URL = `http://127.0.0.1:${PORT}`;
const DB = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "pd-e2e-")), "e2e.db");
const SHOT_CLOCK_MS = 8_000;
const GRACE_MS = 3_000;
const GAME = `e2e-rules-${Date.now().toString(36)}`;

const loginMessage = (address, ts) => `PoolDawgs login\naddress: ${address.toLowerCase()}\nts: ${ts}`;
const walletA = Wallet.createRandom();
const walletB = Wallet.createRandom();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
function check(name, ok, detail = "") {
  console.log(`  ${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) {
    cleanup();
    process.exit(1);
  }
  pass++;
}

let proc = null;
function startServer(label) {
  const p = spawn(process.execPath, ["dist/index.js"], {
    cwd: SERVER_DIR,
    env: {
      ...process.env,
      PORT: String(PORT),
      SQLITE_PATH: DB,
      DATABASE_URL: "",
      RPC_URL: "",
      RPC_URLS: "",
      CONTRACT_ADDRESS: "",
      SHOT_CLOCK_MS: String(SHOT_CLOCK_MS),
      RECONNECT_GRACE_MS: String(GRACE_MS),
      PHYSICS_BACKEND: "havok",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  p.output = "";
  const tag = (d) => {
    p.output += d;
    if (process.env.E2E_VERBOSE) process.stdout.write(`    [${label}] ${d}`);
  };
  p.stdout.on("data", tag);
  p.stderr.on("data", tag);
  proc = p;
  return p;
}
function cleanup() {
  for (const c of clients) c.disconnect();
  if (proc && proc.exitCode === null) proc.kill();
}
async function untilServing(timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const h = await (await fetch(`${URL}/health`)).json();
      if (h.serving) return Date.now() - t0;
    } catch {
      /* not listening yet */
    }
    await sleep(100);
  }
  throw new Error("server never started serving");
}

const clients = [];
async function auth(wallet) {
  const ts = Date.now();
  return { address: wallet.address, ts, signature: await wallet.signMessage(loginMessage(wallet.address, ts)) };
}
/** A player client that, like the web page, re-joins on every (re)connect. */
function player(wallet) {
  const s = io(URL, { transports: ["websocket"], reconnectionDelay: 200, reconnectionDelayMax: 500 });
  s.latest = null;
  s.errors = [];
  s.on("room:state", (snap) => (s.latest = snap));
  s.on("server:error", (e) => s.errors.push(e));
  s.on("connect", async () => s.emit("room:join", { gameId: GAME, auth: await auth(wallet) }));
  clients.push(s);
  return s;
}
function next(socket, event, pred = () => true, ms = 20_000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout waiting for ${event}`)), ms);
    const h = (p) => {
      if (!pred(p)) return;
      clearTimeout(t);
      socket.off(event, h);
      resolve(p);
    };
    socket.on(event, h);
  });
}

console.log(`\nTurn rules, real process (port ${PORT}, ${DB})\n`);

// ── 1. two players at the table ──
startServer("A");
await untilServing(30_000);
const a = player(walletA);
await sleep(400); // dev mode: the room forms when the second wallet joins
const b = player(walletB);
const first = await next(b, "room:state", (s) => s.players.every((p) => p.connected));
check("both seated, clock running", first.clockPaused === false && first.turnId === 0, `turn ${first.state.turn}`);

// ── 2. timeout → ball in hand, nothing moved ──
const handover = await next(b, "room:state", (s) => s.turnId === 1, SHOT_CLOCK_MS + 5_000);
const same = handover.state.balls.every((x, i) => x.x === first.state.balls[i].x && x.y === first.state.balls[i].y);
check(
  "timeout hands the opponent ball in hand without moving a ball",
  handover.state.turn === 1 && handover.state.ballInHand && same && handover.players[0].missedTurns === 1,
  `turn ${handover.state.turn}, ballInHand ${handover.state.ballInHand}, missed ${handover.players[0].missedTurns}`
);

// ── 3. turn ids ──
b.emit("game:shoot", { gameId: GAME, shot: { angle: 0, power: 40 }, turnId: 0 });
const stale = await next(b, "server:error");
check("a shot for the turn that timed out is rejected", stale.code === "stale-turn", stale.message);
const shotP = next(a, "game:shot");
b.emit("game:shoot", { gameId: GAME, shot: { angle: 0, power: 40 }, turnId: 1 });
const shot = await shotP;
check("the current turn's shot is played (Havok, server-side)", shot.turnId === 2, `turn now ${shot.endState.turn}`);
await sleep(300);

// ── 4. disconnect grace ──
const onTurn = shot.endState.turn === 0 ? a : b;
const other = onTurn === a ? b : a;
await sleep(1_500);
onTurn.disconnect();
const paused = await next(other, "room:state", (s) => s.clockPaused === true);
await sleep(1_500);
other.emit("room:sync", { gameId: GAME });
const stillPaused = await next(other, "room:state");
check(
  "disconnect pauses the clock with the time saved",
  stillPaused.clockPaused && stillPaused.clockRemainingMs === paused.clockRemainingMs,
  `${(paused.clockRemainingMs / 1000).toFixed(2)} s held`
);
onTurn.connect();
const resumed = await next(other, "room:state", (s) => s.clockPaused === false);
check(
  "reconnect resumes from the saved time (not a strike)",
  Math.abs(resumed.clockRemainingMs - paused.clockRemainingMs) < 300 &&
    resumed.players.every((p) => p.missedTurns <= 1),
  `${(resumed.clockRemainingMs / 1000).toFixed(2)} s left`
);

// ── 5. hard kill → stale lease → restore charged to the last heartbeat ──
await sleep(2_000);
other.emit("room:sync", { gameId: GAME });
const beforeKill = await next(other, "room:state");
proc.kill("SIGKILL");
await new Promise((r) => proc.once("exit", r));
const lostAtKill = beforeKill.clockRemainingMs; // synced just before the kill
await sleep(3_000); // outage
const restoredP = next(other, "room:state", (s) => s.turnId === beforeKill.turnId && s.players.every((p) => p.connected), 30_000);
startServer("B");
const waited = await untilServing(30_000);
check("new process waits for the dead server's lease to go stale", waited >= 1_000, `${waited} ms after start`);
const restored = await restoredP;
const given = restored.clockRemainingMs - lostAtKill;
check(
  "restored with the time left at the crash, outage not charged",
  given >= -150 && given <= 1_300,
  `${(lostAtKill / 1000).toFixed(2)} s at the kill → ${(restored.clockRemainingMs / 1000).toFixed(2)} s restored (≤ 1 heartbeat to the player)`
);

// ── 6. SIGTERM → exact ──
if (process.platform !== "win32") {
  await sleep(1_500);
  other.emit("room:sync", { gameId: GAME });
  const beforeTerm = await next(other, "room:state");
  const sentAt = Date.now();
  proc.kill("SIGTERM");
  await new Promise((r) => proc.once("exit", r));
  const atTerm = beforeTerm.clockRemainingMs - (Date.now() - sentAt);
  const backP = next(other, "room:state", (s) => s.turnId === beforeTerm.turnId && s.players.every((p) => p.connected), 30_000);
  startServer("C");
  await untilServing(30_000);
  const back = await backP;
  check(
    "clean shutdown resumes with exactly the time left",
    Math.abs(back.clockRemainingMs - atTerm) < 300,
    `${(atTerm / 1000).toFixed(2)} s → ${(back.clockRemainingMs / 1000).toFixed(2)} s`
  );
} else {
  console.log("  - clean-shutdown (SIGTERM) step skipped on Windows — covered by the in-process handover test");
}

console.log(`\n  ${pass} checks passed\n`);
cleanup();
process.exit(0);
