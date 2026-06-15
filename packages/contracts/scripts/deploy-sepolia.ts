import * as fs from "fs";
import * as path from "path";
import { ethers, network, upgrades } from "hardhat";

/**
 * Testnet deployment (Sepolia). The real $DDawgs token and ChessDawgs NFT only
 * exist on mainnet, so on testnet we deploy stand-ins:
 *   • MockDDawgsToken — faucet test-token (mint to anyone)
 *   • PoolDawgsNFT    — the real mintable membership pass (the play gate)
 *   • MockDDawgsNFT   — stands in for the ChessDawgs NFT (grandfather exception)
 *   • PoolDawgs proxy — owned by the deployer (= backend relayer)
 *
 * Seeds the deployer + the client wallet with faucet tokens, and gives the
 * client wallet the mock ChessDawgs NFT so the grandfather path is testable.
 * Writes deployments/<network>.json.
 */
const CLIENT_WALLET = "0x14e9D19c867dA8F304f113F1D4661A8F08593Db8";
const BURN_ADDRESS = "0x000000000000000000000000000000000000dEaD";
const FAUCET = ethers.parseEther("100000");

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log(`Deploying to ${network.name} as ${deployer.address}`);

  const token = await (await ethers.getContractFactory("MockDDawgsToken")).deploy();
  await token.waitForDeployment();
  const nft = await (await ethers.getContractFactory("PoolDawgsNFT")).deploy("");
  await nft.waitForDeployment();
  const chessNft = await (await ethers.getContractFactory("MockDDawgsNFT")).deploy();
  await chessNft.waitForDeployment();

  const company = process.env.COMPANY_WALLET || deployer.address;
  const burn = process.env.POOL_ADDRESS || BURN_ADDRESS;

  const PoolDawgs = await ethers.getContractFactory("PoolDawgs");
  const pool = await upgrades.deployProxy(
    PoolDawgs,
    [
      await token.getAddress(),
      await nft.getAddress(),
      await chessNft.getAddress(),
      burn,
      company,
    ],
    { kind: "transparent" }
  );
  await pool.waitForDeployment();

  // Faucet + demo the grandfather path.
  await (await token.mint(deployer.address, FAUCET)).wait();
  await (await token.mint(CLIENT_WALLET, FAUCET)).wait();
  await (await chessNft.mint(CLIENT_WALLET)).wait();

  const proxyAddr = await pool.getAddress();
  const deployment = {
    network: network.name,
    chainId: Number((await ethers.provider.getNetwork()).chainId),
    deployedAt: new Date().toISOString(),
    poolDawgs: proxyAddr,
    implementation: await upgrades.erc1967.getImplementationAddress(proxyAddr),
    ddawgsToken: await token.getAddress(),
    poolDawgsNFT: await nft.getAddress(),
    chessDawgsNFT: await chessNft.getAddress(),
    poolAddress: burn,
    companyWallet: company,
    owner: deployer.address,
  };

  const dir = path.resolve(__dirname, "..", "deployments");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${network.name}.json`), JSON.stringify(deployment, null, 2));

  console.log("\n── Deployed ──");
  for (const [k, v] of Object.entries(deployment)) console.log(`${k}: ${v}`);
  console.log(`\nWritten to deployments/${network.name}.json`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
