import * as fs from "fs";
import * as path from "path";
import { ethers, network, upgrades } from "hardhat";

/**
 * Redeploy the membership-pass NFT with real metadata and wire it into the
 * existing PoolDawgs escrow — the clean, retroactive path.
 *
 * Steps:
 *   1. Deploy a fresh PoolDawgsNFT with the given BASE_URI (read-time metadata).
 *   2. Upgrade the PoolDawgs proxy so it gains `setDDawgsNFT`.
 *   3. Re-point the play gate at the new NFT.
 *   4. (Optional) ownerMint a pass to each address in HOLDERS.
 *
 * Run from packages/contracts (DEPLOYER_PRIVATE_KEY must be the escrow owner):
 *
 *   BASE_URI="https://backend.chessdawgs.io/v1/nft/pooldawgs/" \
 *   HOLDERS="0xabc...,0xdef..." \
 *   pnpm --filter @pooldawgs/contracts exec hardhat run scripts/redeploy-nft.ts --network sepolia
 *
 * Afterwards set NEXT_PUBLIC_POOLDAWGS_NFT_ADDRESS (web) to the printed address
 * and redeploy the frontend.
 */
async function main() {
  const baseURI = process.env.BASE_URI;
  if (!baseURI) throw new Error('Set BASE_URI, e.g. "https://host/nft/" (trailing slash)');
  if (!baseURI.endsWith("/")) throw new Error("BASE_URI must end with a slash");

  const file = path.join(__dirname, "..", "deployments", `${network.name}.json`);
  if (!fs.existsSync(file)) throw new Error(`No deployment record at ${file}`);
  const deployment = JSON.parse(fs.readFileSync(file, "utf8"));
  const proxyAddress: string = deployment.poolDawgs;

  const [deployer] = await ethers.getSigners();
  console.log(`Network ${network.name} — owner ${deployer.address}`);
  console.log(`Escrow proxy ${proxyAddress}`);

  // 1. New NFT with metadata.
  const nft = await (await ethers.getContractFactory("PoolDawgsNFT")).deploy(baseURI);
  await nft.waitForDeployment();
  const nftAddress = await nft.getAddress();
  console.log(`New PoolDawgsNFT → ${nftAddress}  (baseURI ${baseURI})`);

  // 2. Upgrade the escrow so it has setDDawgsNFT, then 3. re-point the gate.
  const PoolDawgs = await ethers.getContractFactory("PoolDawgs");
  const pool = await upgrades.upgradeProxy(proxyAddress, PoolDawgs);
  await pool.waitForDeployment();
  console.log("Escrow proxy upgraded (gains setDDawgsNFT)");
  await (await pool.setDDawgsNFT(nftAddress)).wait();
  console.log("Gate re-pointed to the new NFT");

  // 4. Optional seed mints.
  const holders = (process.env.HOLDERS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  for (const to of holders) {
    await (await nft.ownerMint(to)).wait();
    console.log(`ownerMint → ${to}`);
  }

  deployment.poolDawgsNFT = nftAddress;
  deployment.implementation = await upgrades.erc1967.getImplementationAddress(proxyAddress);
  fs.writeFileSync(file, JSON.stringify(deployment, null, 2));

  console.log("\nDone. Update the frontend env:");
  console.log(`  NEXT_PUBLIC_POOLDAWGS_NFT_ADDRESS=${nftAddress}`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
