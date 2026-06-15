// Diagnoses the lobby mirror: subscribes to lobby:state, creates a game
// on-chain as A, and watches whether it shows up (open) — the exact mechanism
// the creator's auto-navigate relies on.
import { Contract, JsonRpcProvider, Wallet, parseEther } from "ethers";
import { io } from "socket.io-client";

const RPC = "https://ethereum-sepolia-rpc.publicnode.com";
const SERVER = "http://localhost:4000";
const POOL = "0xcbc5287F4BE6656614a479257E74af0c9bd28db4";
const TOKEN = "0xe60F1A83C0A08FF104b3c1F74D932f0C9D629C4E";
const A_KEY = "0xc8105b73ad11c7bbd24935b21a96a148c586c430789fd46302d11239eed3c9fc";
const STAKE = parseEther("5");
const CODE = "POOL-DIAG" + Math.floor(Date.now() / 1000).toString(36).toUpperCase();

const provider = new JsonRpcProvider(RPC, undefined, { staticNetwork: true });
const A = new Wallet(A_KEY, provider);

const sock = io(SERVER, { transports: ["websocket"] });
let sawIt = false;
sock.on("connect", () => {
  console.log("socket connected; subscribing to lobby");
  sock.emit("lobby:subscribe");
});
sock.on("lobby:state", ({ games }) => {
  const mine = games.find((g) => g.gameId === CODE);
  console.log(
    `lobby:state — ${games.length} games` +
      (mine ? ` | ${CODE} = ${mine.status} ✓` : ` | ${CODE} not present yet`)
  );
  if (mine) sawIt = true;
});

async function main() {
  await new Promise((r) => setTimeout(r, 1500));
  console.log(`\ncreating ${CODE} on-chain as ${A.address}…`);
  const token = new Contract(TOKEN, ["function allowance(address,address) view returns(uint256)", "function approve(address,uint256) returns(bool)"], A);
  if ((await token.allowance(A.address, POOL)) < STAKE) {
    await (await token.approve(POOL, STAKE)).wait();
  }
  const pool = new Contract(POOL, ["function createGame(uint256,string) returns(string)"], A);
  const tx = await pool.createGame(STAKE, CODE);
  await tx.wait();
  console.log(`created (tx ${tx.hash.slice(0, 18)}…); watching lobby for up to 20s…\n`);

  for (let i = 0; i < 20 && !sawIt; i++) await new Promise((r) => setTimeout(r, 1000));
  console.log(
    sawIt
      ? "\n✓ MIRROR WORKS — the open game appeared in lobby:state (creator auto-nav prerequisite OK)"
      : "\n✗ MIRROR BROKEN — game never appeared in lobby:state within 20s"
  );
  sock.disconnect();
  provider.destroy();
  setTimeout(() => process.exit(0), 200);
}
main().catch((e) => {
  console.error("error:", e.message);
  process.exit(1);
});
