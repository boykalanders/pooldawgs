// Full-stack E2E against the LOCAL chain + live game server:
//   approve → createGame → joinGame (on-chain, two wallets)
//   → socket room join (wallet-signature auth) → shot → resign
//   → relayer finishGame (on-chain) → claimReward → 80/10/10 verified.
// Prereqs: hardhat node + deploy-local + game server running.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Contract, JsonRpcProvider, Wallet } from "ethers";
import { io } from "socket.io-client";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const deployment = JSON.parse(fs.readFileSync(path.join(ROOT, "local-deployment.json"), "utf8"));

const SERVER = "http://localhost:4000";
const STAKE = 100n * 10n ** 18n;
const GAME_ID = `e2e-${Date.now().toString(36)}`;

// Hardhat's well-known dev keys (accounts #1 and #2 = the funded players).
const PLAYER_ONE_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const PLAYER_TWO_KEY = "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a";

const POOL_ABI = [
  "function createGame(uint256 stake, string _gameId) returns (string)",
  "function joinGame(string gameId)",
  "function claimReward(string gameId)",
];
const ERC20_ABI = [
  "function approve(address spender, uint256 amount) returns (bool)",
  "function balanceOf(address account) view returns (uint256)",
];

// Must match @pooldawgs/shared loginMessage().
const loginMessage = (address, ts) =>
  `PoolDawgs login\naddress: ${address.toLowerCase()}\nts: ${ts}`;

const provider = new JsonRpcProvider(deployment.rpcUrl);
const playerOne = new Wallet(PLAYER_ONE_KEY, provider);
const playerTwo = new Wallet(PLAYER_TWO_KEY, provider);
const token = new Contract(deployment.ddawgsToken, ERC20_ABI, provider);

let step = 0;
const log = (msg) => console.log(`  [${++step}] ${msg}`);
const fail = (msg) => {
  console.error(`\n✗ FAIL: ${msg}`);
  process.exit(1);
};

function waitFor(socket, event, predicate, timeoutMs, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`timeout waiting for ${label ?? event}`)),
      timeoutMs
    );
    const handler = (payload) => {
      if (!predicate || predicate(payload)) {
        clearTimeout(timer);
        socket.off(event, handler);
        resolve(payload);
      }
    };
    socket.on(event, handler);
  });
}

async function makeAuth(wallet) {
  const ts = Date.now();
  return {
    address: wallet.address,
    ts,
    signature: await wallet.signMessage(loginMessage(wallet.address, ts)),
  };
}

async function main() {
  console.log(`\nPoolDawgs local E2E — game "${GAME_ID}", stake 100 $DDawgs\n`);

  const health = await fetch(`${SERVER}/health`).then((r) => r.json());
  if (!health.chainEnabled) fail("server is not in chain mode — check apps/server/.env");
  log("server healthy, chain mode on");

  // ── on-chain: stake into the game ──
  const pool1 = new Contract(deployment.poolDawgs, POOL_ABI, playerOne);
  const pool2 = new Contract(deployment.poolDawgs, POOL_ABI, playerTwo);
  await (await token.connect(playerOne).approve(deployment.poolDawgs, STAKE)).wait();
  await (await token.connect(playerTwo).approve(deployment.poolDawgs, STAKE)).wait();
  log("both players approved the stake");
  await (await pool1.createGame(STAKE, GAME_ID)).wait();
  log(`playerOne created game on-chain (${playerOne.address})`);

  // Lobby should mirror the GameCreated event (ethers polls ~4s).
  const lobbySocket = io(SERVER, { transports: ["websocket"] });
  lobbySocket.emit("lobby:subscribe");
  await waitFor(
    lobbySocket,
    "lobby:state",
    (p) => p.games.some((g) => g.gameId === GAME_ID && g.status === "open"),
    30000,
    "lobby to list the open game"
  );
  log("lobby mirrors the on-chain game (open)");

  await (await pool2.joinGame(GAME_ID)).wait();
  await waitFor(
    lobbySocket,
    "lobby:state",
    (p) => p.games.some((g) => g.gameId === GAME_ID && g.status === "active"),
    30000,
    "lobby to mark the game active"
  );
  log(`playerTwo joined on-chain (${playerTwo.address}) — game active`);

  // ── sockets: both players take their seats ──
  const s1 = io(SERVER, { transports: ["websocket"] });
  const s2 = io(SERVER, { transports: ["websocket"] });
  s1.on("server:error", (e) => fail(`socket1 server error: ${e.code} ${e.message}`));
  const state1 = waitFor(s1, "room:state", null, 10000, "room state for playerOne");
  s1.emit("room:join", { gameId: GAME_ID, auth: await makeAuth(playerOne) });
  const snap = await state1;
  if (snap.stake !== STAKE.toString()) fail(`snapshot stake ${snap.stake} != ${STAKE}`);
  s2.emit("room:join", { gameId: GAME_ID, auth: await makeAuth(playerTwo) });
  await waitFor(s2, "room:state", null, 10000, "room state for playerTwo");
  log("both players seated via signed socket login; pot visible in snapshot");

  // ── play: one authorized shot, then a resignation ──
  const shotSeen = waitFor(s2, "game:shot", null, 10000, "shot broadcast");
  s1.emit("game:shoot", { gameId: GAME_ID, shot: { angle: 0, power: 30 } });
  const shot = await shotSeen;
  if (shot.bySeat !== 0) fail("shot attributed to the wrong seat");
  log("playerOne's shot simulated server-side and broadcast");

  const balanceBefore = await token.balanceOf(playerOne.address);
  const settled = waitFor(
    s1,
    "game:over",
    (p) => Boolean(p.txHash),
    30000,
    "relayer settlement (game:over with txHash)"
  );
  s2.emit("game:resign", { gameId: GAME_ID });
  const over = await settled;
  if (over.winner.toLowerCase() !== playerOne.address.toLowerCase()) {
    fail("wrong winner settled");
  }
  log(`playerTwo resigned → relayer finishGame on-chain (tx ${over.txHash.slice(0, 18)}…)`);

  // ── claim: 80/10/10 split verified on-chain ──
  const companyBefore = await token.balanceOf(deployment.companyWallet);
  const burnBefore = await token.balanceOf(deployment.poolAddress);
  await (await pool1.claimReward(GAME_ID)).wait();
  const winnerDelta = (await token.balanceOf(playerOne.address)) - balanceBefore;
  const companyDelta = (await token.balanceOf(deployment.companyWallet)) - companyBefore;
  const burnDelta = (await token.balanceOf(deployment.poolAddress)) - burnBefore;
  const pot = STAKE * 2n;
  if (winnerDelta !== (pot * 80n) / 100n) fail(`winner got ${winnerDelta}, expected 80%`);
  if (companyDelta !== pot / 10n) fail(`company got ${companyDelta}, expected 10%`);
  if (burnDelta !== pot / 10n) fail(`burn pool got ${burnDelta}, expected 10%`);
  log("claimReward paid 160 to winner, 20 to company, 20 to burn pool ✓");

  const leaderboard = await fetch(`${SERVER}/leaderboard`).then((r) => r.json());
  const entry = leaderboard.entries.find(
    (e) => e.address === playerOne.address.toLowerCase()
  );
  if (!entry || entry.wins < 1) fail("winner missing from leaderboard");
  log("leaderboard records the win");

  console.log("\n✓ E2E PASS — full wagered game settled on-chain end to end\n");
  for (const s of [lobbySocket, s1, s2]) s.disconnect();
  provider.destroy();
  setTimeout(() => process.exit(0), 250);
}

main().catch((e) => fail(e.message));
