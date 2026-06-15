import * as fs from "fs";
import * as path from "path";
import { ethers, network, upgrades } from "hardhat";

/**
 * Local full-stack deployment (hardhat node):
 *   • MockDDawgsToken      — faucet $DDawgs stand-in
 *   • PoolDawgsNFT         — mintable membership pass (the play gate)
 *   • MockDDawgsNFT        — stands in for the ChessDawgs NFT (grandfather)
 *   • PoolDawgs proxy      — owned by account #0 (= relayer)
 * Seeds tokens + a pass to two demo players AND the client's real wallet, and
 * gives the client wallet the mock ChessDawgs NFT so the exception is testable.
 * Writes the addresses to <repo root>/local-deployment.json.
 */
const CLIENT_WALLET = "0x14e9D19c867dA8F304f113F1D4661A8F08593Db8";
const PLAYER_FUNDS = ethers.parseEther("1000000");

async function main() {
  const [deployer, playerOne, playerTwo, , , , , , burnPool, companyWallet] =
    await ethers.getSigners();

  const token = await (await ethers.getContractFactory("MockDDawgsToken")).deploy();
  await token.waitForDeployment();
  const nft = await (await ethers.getContractFactory("PoolDawgsNFT")).deploy("");
  await nft.waitForDeployment();
  const chessNft = await (await ethers.getContractFactory("MockDDawgsNFT")).deploy();
  await chessNft.waitForDeployment();

  const PoolDawgs = await ethers.getContractFactory("PoolDawgs");
  const pool = await upgrades.deployProxy(
    PoolDawgs,
    [
      await token.getAddress(),
      await nft.getAddress(),
      await chessNft.getAddress(),
      burnPool.address,
      companyWallet.address,
    ],
    { kind: "transparent" }
  );
  await pool.waitForDeployment();

  for (const player of [playerOne.address, playerTwo.address, CLIENT_WALLET]) {
    await (await token.mint(player, PLAYER_FUNDS)).wait();
    await (await nft.ownerMint(player)).wait();
  }
  // Demo the grandfather path: give the client wallet the mock ChessDawgs NFT.
  await (await chessNft.mint(CLIENT_WALLET)).wait();

  await network.provider.send("hardhat_setBalance", [
    CLIENT_WALLET,
    "0x" + ethers.parseEther("10").toString(16),
  ]);

  const deployment = {
    chainId: 31337,
    rpcUrl: "http://127.0.0.1:8545",
    poolDawgs: await pool.getAddress(),
    ddawgsToken: await token.getAddress(),
    poolDawgsNFT: await nft.getAddress(),
    chessDawgsNFT: await chessNft.getAddress(),
    poolAddress: burnPool.address,
    companyWallet: companyWallet.address,
    owner: deployer.address,
    players: { one: playerOne.address, two: playerTwo.address, client: CLIENT_WALLET },
  };

  const outFile = path.resolve(__dirname, "..", "..", "..", "local-deployment.json");
  fs.writeFileSync(outFile, JSON.stringify(deployment, null, 2));
  console.log("PoolDawgs (proxy):", deployment.poolDawgs);
  console.log("PoolDawgsNFT:      ", deployment.poolDawgsNFT);
  console.log("MockChessDawgsNFT: ", deployment.chessDawgsNFT);
  console.log("Deployment written to", outFile);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
