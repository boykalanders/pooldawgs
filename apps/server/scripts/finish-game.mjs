// Manually settle a game on-chain (owner-only backstop). The backend relayer
// does this automatically when a game ends, but if a game ever got stranded
// (server down at the wrong moment, RPC outage), the owner can record the
// result here so the winner can claim.
//
//   GAME_ID=P8-XXXXX WINNER=0x<winner> \
//   OWNER_PRIVATE_KEY=0x... RPC_URL=https://... CONTRACT_ADDRESS=0xcbc5... \
//   node apps/server/scripts/finish-game.mjs
//
// Omit WINNER to just inspect the game's current on-chain state.
import { Contract, JsonRpcProvider, Wallet } from "ethers";

const RPC = process.env.RPC_URL || "https://ethereum-sepolia-rpc.publicnode.com";
const POOL = process.env.CONTRACT_ADDRESS || "0xcbc5287F4BE6656614a479257E74af0c9bd28db4";
const KEY = process.env.OWNER_PRIVATE_KEY;
const GAME_ID = process.env.GAME_ID;
const WINNER = process.env.WINNER;

if (!GAME_ID) throw new Error("Set GAME_ID");

const ABI = [
  "function games(string) view returns (address playerOne, address playerTwo, bool isCompleted, address winner, uint256 stake, bool rewardClaimed, bool exitRequested, address exitRequester, uint256 exitRequestTimestamp, bool exitAccepted, bool playerOneClaimed, bool playerTwoClaimed, bool drawCompleted)",
  "function finishGame(string gameId, address winner)",
  "function owner() view returns (address)",
];

const provider = new JsonRpcProvider(RPC);
const read = new Contract(POOL, ABI, provider);

const g = await read.games(GAME_ID);
console.log(`game ${GAME_ID}`);
console.log(`  playerOne   : ${g.playerOne}`);
console.log(`  playerTwo   : ${g.playerTwo}`);
console.log(`  isCompleted : ${g.isCompleted}`);
console.log(`  winner      : ${g.winner}`);
console.log(`  rewardClaimed: ${g.rewardClaimed}`);

if (!WINNER) {
  console.log("\n(no WINNER given — inspection only)");
  process.exit(0);
}
if (g.isCompleted) {
  console.log("\nAlready completed on-chain — nothing to do. The winner can claim.");
  process.exit(0);
}
if (!KEY) throw new Error("Set OWNER_PRIVATE_KEY to settle");

const owner = new Wallet(KEY, provider);
if ((await read.owner()).toLowerCase() !== owner.address.toLowerCase()) {
  throw new Error(`signer ${owner.address} is not the contract owner ${await read.owner()}`);
}
const write = new Contract(POOL, ABI, owner);
console.log(`\nfinishGame(${GAME_ID}, ${WINNER}) as owner ${owner.address}…`);
const tx = await write.finishGame(GAME_ID, WINNER);
console.log(`  tx: ${tx.hash}`);
await tx.wait();
const after = await read.games(GAME_ID);
console.log(`  isCompleted now: ${after.isCompleted}, winner: ${after.winner}`);
console.log("✅ Settled — the winner can now claim.");
