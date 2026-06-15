import * as fs from "fs";
import * as path from "path";
import { ethers, network, upgrades } from "hardhat";

/**
 * Finish wiring: point the (already-upgraded) escrow's play gate at NFT_ADDRESS.
 * Sends one explicit transaction with a fresh pending nonce to avoid the
 * "replacement transaction underpriced" race that can follow an upgrade.
 */
async function main() {
  const nftAddress = process.env.NFT_ADDRESS;
  if (!nftAddress) throw new Error("Set NFT_ADDRESS to the new PoolDawgsNFT");

  const file = path.join(__dirname, "..", "deployments", `${network.name}.json`);
  const d = JSON.parse(fs.readFileSync(file, "utf8"));
  const [signer] = await ethers.getSigners();
  const pool = await ethers.getContractAt("PoolDawgs", d.poolDawgs);

  console.log(`Current gate: ${await pool.DDawgsNFT()}`);
  const nonce = await ethers.provider.getTransactionCount(signer.address, "pending");
  const tx = await pool.setDDawgsNFT(nftAddress, { nonce });
  console.log(`setDDawgsNFT(${nftAddress}) → ${tx.hash} (nonce ${nonce})`);
  await tx.wait();

  const gate = await pool.DDawgsNFT();
  console.log(`New gate:     ${gate}`);
  if (gate.toLowerCase() !== nftAddress.toLowerCase()) throw new Error("gate not updated");

  d.poolDawgsNFT = nftAddress;
  d.implementation = await upgrades.erc1967.getImplementationAddress(d.poolDawgs);
  fs.writeFileSync(file, JSON.stringify(d, null, 2));
  console.log("\n✅ Gate re-pointed. Update the frontend env:");
  console.log(`  NEXT_PUBLIC_POOLDAWGS_NFT_ADDRESS=${nftAddress}`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
