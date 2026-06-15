// Functional verification of the live Sepolia deployment: reads every config
// field, checks the proxy/implementation wiring (EIP-1967), confirms the NFT
// gate (ownsNFT for a holder, a non-holder, and the grandfathered wallet), and
// proves the mint flow with a REAL transaction (deployer mints a pass, then the
// gate flips to true). Run: node scripts/verify-sepolia.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Contract, JsonRpcProvider, Wallet, formatEther, getAddress } from "ethers";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const dep = JSON.parse(
  fs.readFileSync(path.join(ROOT, "packages", "contracts", "deployments", "sepolia.json"), "utf8")
);
const RPC = process.env.SEPOLIA_RPC_URL || "https://ethereum-sepolia-rpc.publicnode.com";
const DEPLOYER_KEY = "0xc8105b73ad11c7bbd24935b21a96a148c586c430789fd46302d11239eed3c9fc";
const CLIENT = "0x14e9D19c867dA8F304f113F1D4661A8F08593Db8";
const RANDOM = "0x0000000000000000000000000000000000005678";
const IMPL_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const ADMIN_SLOT = "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103";

const provider = new JsonRpcProvider(RPC, undefined, { staticNetwork: true });
const deployer = new Wallet(DEPLOYER_KEY, provider);

let pass = 0;
let fail = 0;
const check = (name, ok, detail = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
  ok ? pass++ : fail++;
};
const eq = (a, b) => getAddress(a) === getAddress(b);

const POOL_ABI = [
  "function rewardToken() view returns (address)",
  "function DDawgsNFT() view returns (address)",
  "function chessDawgsNFT() view returns (address)",
  "function poolAddress() view returns (address)",
  "function companyWallet() view returns (address)",
  "function owner() view returns (address)",
  "function paused() view returns (bool)",
  "function ABANDONMENT_TIMEOUT() view returns (uint256)",
  "function ownsNFT(address) view returns (bool)",
  "function initialize(address,address,address,address,address)",
];
const NFT_ABI = [
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function balanceOf(address) view returns (uint256)",
  "function totalMinted() view returns (uint256)",
  "function owns(address) view returns (bool)",
  "function mint() returns (uint256)",
];
const ERC20_ABI = [
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function balanceOf(address) view returns (uint256)",
];

async function main() {
  const net = await provider.getNetwork();
  console.log(`\nVerifying PoolDawgs on chainId ${net.chainId} (${dep.network})`);
  console.log(`Proxy ${dep.poolDawgs}\n`);
  check("connected to Sepolia", Number(net.chainId) === 11155111, `chainId ${net.chainId}`);

  // ── bytecode present ──
  for (const [name, addr] of [
    ["proxy", dep.poolDawgs],
    ["implementation", dep.implementation],
    ["token", dep.ddawgsToken],
    ["PoolDawgsNFT", dep.poolDawgsNFT],
    ["chessDawgsNFT", dep.chessDawgsNFT],
  ]) {
    const code = await provider.getCode(addr);
    check(`${name} has bytecode`, code !== "0x", `${(code.length - 2) / 2} bytes`);
  }

  // ── EIP-1967 proxy wiring ──
  const implSlot = "0x" + (await provider.getStorage(dep.poolDawgs, IMPL_SLOT)).slice(26);
  check("proxy → implementation slot matches", eq(implSlot, dep.implementation), implSlot);
  const adminSlot = "0x" + (await provider.getStorage(dep.poolDawgs, ADMIN_SLOT)).slice(26);
  check("proxy has a ProxyAdmin", adminSlot !== "0x0000000000000000000000000000000000000000", adminSlot);

  // ── config wiring (via proxy) ──
  const pool = new Contract(dep.poolDawgs, POOL_ABI, provider);
  check("rewardToken == $DDawgs", eq(await pool.rewardToken(), dep.ddawgsToken));
  check("DDawgsNFT == PoolDawgsNFT", eq(await pool.DDawgsNFT(), dep.poolDawgsNFT));
  check("chessDawgsNFT wired", eq(await pool.chessDawgsNFT(), dep.chessDawgsNFT));
  check("poolAddress == burn", eq(await pool.poolAddress(), dep.poolAddress));
  check("companyWallet wired", eq(await pool.companyWallet(), dep.companyWallet));
  check("owner == deployer/relayer", eq(await pool.owner(), dep.owner));
  check("not paused", (await pool.paused()) === false);
  check("ABANDONMENT_TIMEOUT == 3600", (await pool.ABANDONMENT_TIMEOUT()) === 3600n);

  // ── implementation is locked (cannot be re-initialised) ──
  const impl = new Contract(dep.implementation, POOL_ABI, provider);
  let locked = false;
  try {
    await impl.initialize.staticCall(
      dep.ddawgsToken,
      dep.poolDawgsNFT,
      dep.chessDawgsNFT,
      dep.poolAddress,
      dep.companyWallet
    );
  } catch {
    locked = true;
  }
  check("implementation initializers disabled", locked);

  // ── token + NFT metadata ──
  const token = new Contract(dep.ddawgsToken, ERC20_ABI, provider);
  check("token metadata", true, `${await token.name()} / ${await token.symbol()} (${await token.decimals()}d)`);
  const nft = new Contract(dep.poolDawgsNFT, NFT_ABI, deployer);
  check("NFT is Pool Dawgs / PDAWG", (await nft.name()) === "Pool Dawgs" && (await nft.symbol()) === "PDAWG");

  // ── the gate ──
  check("ownsNFT(client) — grandfathered via ChessDawgs", (await pool.ownsNFT(CLIENT)) === true);
  check("ownsNFT(random) — no NFT", (await pool.ownsNFT(RANDOM)) === false);
  const deployerHadPass = (await nft.balanceOf(deployer.address)) > 0n;
  check("ownsNFT(deployer) — before mint", (await pool.ownsNFT(deployer.address)) === deployerHadPass);

  // ── LIVE mint, only if the deployer has no pass yet ──
  if (!deployerHadPass) {
    const mintedBefore = await nft.totalMinted();
    console.log("\n  … sending live mint() from the deployer …");
    const tx = await nft.mint();
    const rcpt = await tx.wait();
    check("mint() succeeded", rcpt.status === 1, `tx ${rcpt.hash}`);
    check("deployer now holds a pass", (await nft.balanceOf(deployer.address)) === 1n);
    check("totalMinted incremented", (await nft.totalMinted()) === mintedBefore + 1n);
    check("gate now opens for deployer (ownsNFT)", (await pool.ownsNFT(deployer.address)) === true);
  } else {
    console.log("  (deployer already holds a pass — skipping live mint)");
    check("gate open for deployer (already minted)", (await pool.ownsNFT(deployer.address)) === true);
  }

  console.log(`\n  deployer balance: ${formatEther(await provider.getBalance(deployer.address))} ETH`);
  console.log(`\n${fail === 0 ? "✓ ALL CHECKS PASSED" : `✗ ${fail} CHECK(S) FAILED`} (${pass} passed)\n`);
  console.log("Explorer:");
  console.log(`  proxy   https://sepolia.etherscan.io/address/${dep.poolDawgs}`);
  console.log(`  NFT     https://sepolia.etherscan.io/address/${dep.poolDawgsNFT}`);
  console.log(`  token   https://sepolia.etherscan.io/address/${dep.ddawgsToken}`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
