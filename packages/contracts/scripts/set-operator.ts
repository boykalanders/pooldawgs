import * as fs from "fs";
import * as path from "path";
import { ethers, network, upgrades } from "hardhat";

/**
 * Harden the relayer: upgrade the escrow so settlement (finishGame/exit/draw)
 * accepts a dedicated low-privilege OPERATOR in addition to the owner, then
 * appoint that operator. After this you can run the backend with a sealed
 * OPERATOR_PRIVATE_KEY (or a KMS key) that can ONLY settle games — never move
 * funds, change wallets/gate, pause, or upgrade.
 *
 * Run from packages/contracts (DEPLOYER_PRIVATE_KEY must be the escrow owner):
 *
 *   OPERATOR_ADDRESS=0x<operator wallet> \
 *   pnpm --filter @pooldawgs/contracts exec hardhat run scripts/set-operator.ts --network sepolia
 *
 * Then set OPERATOR_PRIVATE_KEY (the key for OPERATOR_ADDRESS) on the server.
 */
async function main() {
  const operator = process.env.OPERATOR_ADDRESS;
  if (!operator || !ethers.isAddress(operator)) {
    throw new Error("Set OPERATOR_ADDRESS to the operator wallet address");
  }

  const file = path.join(__dirname, "..", "deployments", `${network.name}.json`);
  const deployment = JSON.parse(fs.readFileSync(file, "utf8"));
  const proxyAddress: string = deployment.poolDawgs;

  const [deployer] = await ethers.getSigners();
  console.log(`Network ${network.name} — owner ${deployer.address}`);
  console.log(`Escrow proxy ${proxyAddress}`);

  // 1. Upgrade so the escrow has setOperator + the onlyRelayer guard.
  const PoolDawgs = await ethers.getContractFactory("PoolDawgs");
  const pool = await upgrades.upgradeProxy(proxyAddress, PoolDawgs);
  await pool.waitForDeployment();
  console.log("Escrow upgraded (operator role available)");

  // 2. Appoint the operator (fresh nonce to avoid a post-upgrade race).
  const nonce = await ethers.provider.getTransactionCount(deployer.address, "pending");
  const tx = await pool.setOperator(operator, { nonce });
  console.log(`setOperator(${operator}) → ${tx.hash}`);
  await tx.wait();
  console.log(`operator() = ${await pool.operator()}`);

  deployment.operator = operator;
  deployment.implementation = await upgrades.erc1967.getImplementationAddress(proxyAddress);
  fs.writeFileSync(file, JSON.stringify(deployment, null, 2));
  console.log("\n✅ Done. Set OPERATOR_PRIVATE_KEY (for that address) on the backend.");
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
