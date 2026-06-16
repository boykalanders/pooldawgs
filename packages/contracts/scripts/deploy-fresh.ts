import * as fs from "fs";
import * as path from "path";
import { ethers, network, upgrades } from "hardhat";

/**
 * Deploy a FRESH PoolDawgs escrow proxy (voucher model) reusing the existing
 * token + membership NFT, and wire the backend voucher signer. The backend
 * never sends settlement txns — it signs Result(gameId, winner) vouchers and
 * the winner redeems them via claimRewardSigned; the contract just validates
 * the recovered signer == resultSigner.
 *
 * Run from packages/contracts (DEPLOYER_PRIVATE_KEY funded):
 *
 *   RESULT_SIGNER=0x<backend signer address> \
 *   pnpm --filter @pooldawgs/contracts exec hardhat run scripts/deploy-fresh.ts --network sepolia
 *
 * RESULT_SIGNER must be the ADDRESS of the key the server signs with
 * (OPERATOR_PRIVATE_KEY, else OWNER_PRIVATE_KEY). Defaults to the deployer.
 * Afterwards point the apps at the new proxy:
 *   web:    NEXT_PUBLIC_POOLDAWGS_ADDRESS=<new proxy>
 *   server: CONTRACT_ADDRESS=<new proxy>
 */
async function main() {
  const file = path.join(__dirname, "..", "deployments", `${network.name}.json`);
  const d = JSON.parse(fs.readFileSync(file, "utf8"));
  const [deployer] = await ethers.getSigners();
  const signer = process.env.RESULT_SIGNER || deployer.address;
  if (!ethers.isAddress(signer)) throw new Error("RESULT_SIGNER is not an address");

  console.log(`Network ${network.name} — deployer ${deployer.address}`);
  console.log(`Reusing token ${d.ddawgsToken}, NFT ${d.poolDawgsNFT}, chessNFT ${d.chessDawgsNFT}`);

  const PoolDawgs = await ethers.getContractFactory("PoolDawgs");
  const pool = await upgrades.deployProxy(
    PoolDawgs,
    [d.ddawgsToken, d.poolDawgsNFT, d.chessDawgsNFT, d.poolAddress, d.companyWallet],
    { kind: "transparent" }
  );
  await pool.waitForDeployment();
  const addr = await pool.getAddress();
  console.log(`New PoolDawgs proxy → ${addr}`);

  await (await pool.setResultSigner(signer)).wait();
  console.log(`resultSigner = ${await pool.resultSigner()}`);
  if (process.env.OPERATOR_ADDRESS && ethers.isAddress(process.env.OPERATOR_ADDRESS)) {
    await (await pool.setOperator(process.env.OPERATOR_ADDRESS)).wait();
    console.log(`operator     = ${await pool.operator()}`);
  }

  d.poolDawgs = addr;
  d.implementation = await upgrades.erc1967.getImplementationAddress(addr);
  d.resultSigner = signer;
  fs.writeFileSync(file, JSON.stringify(d, null, 2));

  console.log("\n✅ Deployed. Point the apps at the new proxy:");
  console.log(`  web:    NEXT_PUBLIC_POOLDAWGS_ADDRESS=${addr}`);
  console.log(`  server: CONTRACT_ADDRESS=${addr}`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
