import { ethers, upgrades } from "hardhat";

/**
 * Mainnet deployment. The $DDawgs token and the ChessDawgs NFT already exist;
 * a fresh PoolDawgsNFT (the mintable membership pass) is deployed here too.
 *
 * Required env (see .env.example):
 *   DDAWGS_TOKEN_ADDRESS  — $DDawgs ERC-20 (mainnet: 0x19f78a898f3e3c2f40c6E0CD2EE5545F549d5E99)
 *   CHESS_NFT_ADDRESS     — ChessDawgs NFT grandfather (mainnet: 0xf82E0cF5605101efE12689461c2bC9392BfDedEF)
 *   POOL_ADDRESS          — burn destination (receives the 10% burn cut)
 *   COMPANY_WALLET        — receives the 10% company cut
 *
 * The deployer becomes the contract owner and must be the backend relayer key
 * (the only address allowed to call finishGame).
 */
async function main() {
  const token = process.env.DDAWGS_TOKEN_ADDRESS;
  const chessNft = process.env.CHESS_NFT_ADDRESS;
  const poolAddress = process.env.POOL_ADDRESS;
  const company = process.env.COMPANY_WALLET;

  if (!token || !chessNft || !poolAddress || !company) {
    throw new Error(
      "Set DDAWGS_TOKEN_ADDRESS, CHESS_NFT_ADDRESS, POOL_ADDRESS and COMPANY_WALLET"
    );
  }

  const nft = await (await ethers.getContractFactory("PoolDawgsNFT")).deploy(
    process.env.NFT_BASE_URI ?? ""
  );
  await nft.waitForDeployment();
  console.log("PoolDawgsNFT deployed to:", await nft.getAddress());

  const PoolDawgs = await ethers.getContractFactory("PoolDawgs");
  const proxy = await upgrades.deployProxy(
    PoolDawgs,
    [token, await nft.getAddress(), chessNft, poolAddress, company],
    { kind: "transparent" }
  );
  await proxy.waitForDeployment();

  console.log("PoolDawgs proxy deployed to:", await proxy.getAddress());
  console.log(
    "Implementation:",
    await upgrades.erc1967.getImplementationAddress(await proxy.getAddress())
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
