import { ethers, network } from "hardhat";

/**
 * Set the PoolDawgsNFT metadata base URI (owner-only).
 *
 * The contract builds each pass's tokenURI as `baseURI + <tokenId> + ".json"`
 * AT MINT TIME, so this only affects passes minted AFTER you run it. Tokens
 * minted before (with an empty base) keep an empty tokenURI — re-mint to a
 * fresh wallet to test, or switch to the read-time metadata contract (ask me).
 *
 * Usage (from packages/contracts, needs DEPLOYER_PRIVATE_KEY + SEPOLIA_RPC_URL
 * in .env — the deployer is the contract owner):
 *
 *   NFT_ADDRESS=0x42e5...d52C \
 *   BASE_URI="https://pooldawgs-web.vercel.app/nft/" \
 *   pnpm --filter @pooldawgs/contracts exec hardhat run scripts/set-nft-base-uri.ts --network sepolia
 *
 * BASE_URI MUST end with a slash so the result is `.../1.json`.
 */
async function main() {
  const nftAddress = process.env.NFT_ADDRESS;
  const baseURI = process.env.BASE_URI;
  if (!nftAddress) throw new Error("Set NFT_ADDRESS to the PoolDawgsNFT address");
  if (!baseURI) throw new Error('Set BASE_URI, e.g. "https://host/nft/" (trailing slash required)');
  if (!baseURI.endsWith("/")) throw new Error("BASE_URI must end with a slash");

  const [owner] = await ethers.getSigners();
  console.log(`Network ${network.name} — sender ${owner.address}`);

  const nft = await ethers.getContractAt("PoolDawgsNFT", nftAddress);
  const tx = await nft.setBaseURI(baseURI);
  console.log(`setBaseURI("${baseURI}") → ${tx.hash}`);
  await tx.wait();

  // Verify against the next token that will be minted.
  const minted = await nft.totalMinted();
  console.log(`Done. ${minted} passes minted so far.`);
  console.log(`The NEXT mint (token #${minted + 1n}) will resolve: ${baseURI}${minted + 1n}.json`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
