import * as fs from "fs";
import * as path from "path";
import { ethers, network, upgrades } from "hardhat";

/**
 * Local full-stack deployment (hardhat node):
 *   • MockDDawgsToken + MockDDawgsNFT (stand-ins for the mainnet contracts)
 *   • PoolDawgs behind a transparent proxy, owned by account #0 (= relayer)
 *   • Mints tokens + a gate NFT to two demo players AND to the client's real
 *     wallet (funded with local ETH) so MetaMask can connect and play.
 * Writes the addresses to <repo root>/local-deployment.json.
 */
const CLIENT_WALLET = "0x14e9D19c867dA8F304f113F1D4661A8F08593Db8";
const PLAYER_FUNDS = ethers.parseEther("1000000");

async function main() {
  const [deployer, playerOne, playerTwo, , , , , , burnPool, companyWallet] =
    await ethers.getSigners();

  const token = await (await ethers.getContractFactory("MockDDawgsToken")).deploy();
  await token.waitForDeployment();
  const nft = await (await ethers.getContractFactory("MockDDawgsNFT")).deploy();
  await nft.waitForDeployment();

  const PoolDawgs = await ethers.getContractFactory("PoolDawgs");
  const pool = await upgrades.deployProxy(
    PoolDawgs,
    [
      await token.getAddress(),
      await nft.getAddress(),
      burnPool.address,
      companyWallet.address,
    ],
    { kind: "transparent" }
  );
  await pool.waitForDeployment();

  for (const player of [playerOne.address, playerTwo.address, CLIENT_WALLET]) {
    await (await token.mint(player, PLAYER_FUNDS)).wait();
    await (await nft.mint(player)).wait();
  }
  // Give the client's real wallet local gas so MetaMask works out of the box.
  await network.provider.send("hardhat_setBalance", [
    CLIENT_WALLET,
    "0x" + ethers.parseEther("10").toString(16),
  ]);

  const deployment = {
    chainId: 31337,
    rpcUrl: "http://127.0.0.1:8545",
    poolDawgs: await pool.getAddress(),
    ddawgsToken: await token.getAddress(),
    ddawgsNFT: await nft.getAddress(),
    poolAddress: burnPool.address,
    companyWallet: companyWallet.address,
    owner: deployer.address,
    players: {
      one: playerOne.address,
      two: playerTwo.address,
      client: CLIENT_WALLET,
    },
  };

  const outFile = path.resolve(__dirname, "..", "..", "..", "local-deployment.json");
  fs.writeFileSync(outFile, JSON.stringify(deployment, null, 2));

  console.log("PoolDawgs (proxy):", deployment.poolDawgs);
  console.log("MockDDawgsToken:  ", deployment.ddawgsToken);
  console.log("MockDDawgsNFT:    ", deployment.ddawgsNFT);
  console.log("Deployment written to", outFile);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
