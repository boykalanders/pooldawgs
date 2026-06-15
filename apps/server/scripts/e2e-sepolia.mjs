// Full wagered game on LIVE Sepolia + the local server: fund a fresh wallet B,
// gate it (pass) + faucet it, then A create → B join → both seat over sockets
// → shot → resign → relayer finishGame (real tx) → claimReward 80/10/10.
// Proves the join/seat fix end to end. Run with the server running on :4000.
import {
  Contract,
  JsonRpcProvider,
  Wallet,
  parseEther,
  formatEther,
} from "ethers";
import { io } from "socket.io-client";

const RPC = "https://ethereum-sepolia-rpc.publicnode.com";
const SERVER = "http://localhost:4000";
const POOL = "0xcbc5287F4BE6656614a479257E74af0c9bd28db4";
const TOKEN = "0xe60F1A83C0A08FF104b3c1F74D932f0C9D629C4E";
const NFT = "0x42e5ed18Ec067b1Ce5421F2f584b9Ebb683fd52C";
const A_KEY = "0xc8105b73ad11c7bbd24935b21a96a148c586c430789fd46302d11239eed3c9fc";
const STAKE = parseEther("10");
const GAME_ID = "POOL-E2E" + Math.floor(Date.now() / 1000).toString(36).toUpperCase();

const POOL_ABI = [
  "function createGame(uint256 stake, string gameId) returns (string)",
  "function joinGame(string gameId)",
  "function claimReward(string gameId)",
  "function ownsNFT(address) view returns (bool)",
  "function companyWallet() view returns (address)",
];
const TOKEN_ABI = [
  "function mint(address to, uint256 amount)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
];
const NFT_ABI = [
  "function ownerMint(address to) returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
];

const loginMessage = (address, ts) =>
  `PoolDawgs login\naddress: ${address.toLowerCase()}\nts: ${ts}`;

let step = 0;
const log = (m) => console.log(`  [${++step}] ${m}`);
const fail = (m) => {
  console.error(`\n✗ FAIL: ${m}`);
  process.exit(1);
};

function waitFor(socket, event, predicate, ms, label) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout: ${label ?? event}`)), ms);
    const h = (p) => {
      if (!predicate || predicate(p)) {
        clearTimeout(t);
        socket.off(event, h);
        resolve(p);
      }
    };
    socket.on(event, h);
  });
}

const provider = new JsonRpcProvider(RPC, undefined, { staticNetwork: true });
const A = new Wallet(A_KEY, provider);
const B = Wallet.createRandom(provider);

async function auth(wallet) {
  const ts = Date.now();
  return { address: wallet.address, ts, signature: await wallet.signMessage(loginMessage(wallet.address, ts)) };
}
async function approveIfNeeded(wallet) {
  const token = new Contract(TOKEN, TOKEN_ABI, wallet);
  if ((await token.allowance(wallet.address, POOL)) < STAKE) {
    await (await token.approve(POOL, STAKE)).wait();
  }
}

async function main() {
  console.log(`\nSepolia E2E — game ${GAME_ID}, stake 10 $DDawgs`);
  console.log(`A ${A.address}\nB ${B.address}\n`);

  const health = await fetch(`${SERVER}/health`).then((r) => r.json());
  if (!health.chainEnabled) fail("server not in chain mode");
  log("server healthy (chain mode)");

  // Fund + gate + faucet B from A.
  await (await A.sendTransaction({ to: B.address, value: parseEther("0.03") })).wait();
  log("funded B with 0.03 ETH");
  await (await new Contract(NFT, NFT_ABI, A).ownerMint(B.address)).wait();
  await (await new Contract(TOKEN, TOKEN_ABI, A).mint(B.address, STAKE)).wait();
  log("gated B (pass) + faucet'd B 10 $DDawgs");

  const pool = new Contract(POOL, POOL_ABI, provider);
  if (!(await pool.ownsNFT(A.address))) fail("A fails the NFT gate");
  if (!(await pool.ownsNFT(B.address))) fail("B fails the NFT gate");
  log("both wallets pass the on-chain NFT gate");

  // On-chain create + join.
  await approveIfNeeded(A);
  await (await new Contract(POOL, POOL_ABI, A).createGame(STAKE, GAME_ID)).wait();
  log(`A created game ${GAME_ID} on-chain`);
  await approveIfNeeded(B);
  await (await new Contract(POOL, POOL_ABI, B).joinGame(GAME_ID)).wait();
  log("B joined on-chain");

  // Socket seating — THE fix: server resolves seats from chain, not events.
  const sa = io(SERVER, { transports: ["websocket"] });
  const sb = io(SERVER, { transports: ["websocket"] });
  sa.on("server:error", (e) => fail(`A socket error: ${e.code} ${e.message}`));
  sb.on("server:error", (e) => fail(`B socket error: ${e.code} ${e.message}`));

  const aState = waitFor(sa, "room:state", null, 20000, "A room:state");
  sa.emit("room:join", { gameId: GAME_ID, auth: await auth(A) });
  const snapA = await aState;
  log(`A seated (room:state, ${snapA.players.length} players, stake ${snapA.stake})`);

  const bState = waitFor(sb, "room:state", null, 20000, "B room:state");
  sb.emit("room:join", { gameId: GAME_ID, auth: await auth(B) });
  await bState;
  log("B seated — both players in the room ✓ (the bug is fixed)");

  // A shoots; B sees it.
  const shot = waitFor(sb, "game:shot", null, 15000, "shot broadcast");
  sa.emit("game:shoot", { gameId: GAME_ID, shot: { angle: 0, power: 30 } });
  await shot;
  log("A's shot simulated server-side and broadcast to B");

  // B resigns → relayer finishGame on Sepolia → A wins.
  const settled = waitFor(sa, "game:over", (p) => Boolean(p.txHash), 120000, "relayer settlement");
  sb.emit("game:resign", { gameId: GAME_ID });
  const over = await settled;
  if (over.winner.toLowerCase() !== A.address.toLowerCase()) fail("wrong winner");
  log(`B resigned → relayer finishGame on-chain (tx ${over.txHash.slice(0, 18)}…), A wins`);

  // A claims. Winner share = 80% of the 20 pot = 16. The company wallet also
  // gets 10% (2); in this deploy companyWallet == A, so A nets 16 + 2 = 18.
  const token = new Contract(TOKEN, TOKEN_ABI, provider);
  const company = await pool.companyWallet();
  const pot = STAKE * 2n;
  let expected = (pot * 80n) / 100n;
  if (company.toLowerCase() === A.address.toLowerCase()) expected += (pot * 10n) / 100n;
  const before = await token.balanceOf(A.address);
  await (await new Contract(POOL, POOL_ABI, A).claimReward(GAME_ID)).wait();
  const delta = (await token.balanceOf(A.address)) - before;
  if (delta !== expected) fail(`winner got ${formatEther(delta)}, expected ${formatEther(expected)}`);
  log(
    `A claimed ${formatEther(delta)} $DDawgs ` +
      `(80% winner${company.toLowerCase() === A.address.toLowerCase() ? " + 10% company, same wallet" : ""}) ✓`
  );

  console.log("\n✓ SEPOLIA E2E PASS — create → join → seat → play → settle → claim\n");
  for (const s of [sa, sb]) s.disconnect();
  provider.destroy();
  setTimeout(() => process.exit(0), 250);
}

main().catch((e) => fail(e.message));
