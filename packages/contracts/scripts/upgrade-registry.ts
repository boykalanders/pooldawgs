import { ethers, network, upgrades } from "hardhat";

/** In-place upgrade of the PoolDawgs proxy to the registry-aware impl, then
 *  point it at the shared DDawgsNFTRegistry. Proxy address + state preserved. */
const PROXY = process.env.POOLDAWGS_PROXY || "0x1a0ff1B3B4D20495B12367f291A8639B9B268764";
const REGISTRY = process.env.DDAWGS_REGISTRY || "0x4C643a8DD0050f0B5fF6E195CEc29D3e01003205";

async function main() {
  const [signer] = await ethers.getSigners();
  console.log(`Upgrading PoolDawgs ${PROXY} on ${network.name} as ${signer.address}`);
  const Factory = await ethers.getContractFactory("PoolDawgs");
  const upgraded = await upgrades.upgradeProxy(PROXY, Factory);
  await upgraded.waitForDeployment();

  // Wait until the new impl (with registry()) is visible — public RPCs can lag.
  let current = "";
  for (let i = 0; i < 12; i++) {
    try {
      current = await upgraded.registry();
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
  if (current.toLowerCase() !== REGISTRY.toLowerCase()) {
    await (await upgraded.setRegistry(REGISTRY)).wait();
  }
  console.log("  implementation:", await upgrades.erc1967.getImplementationAddress(PROXY));
  console.log("  registry:", await upgraded.registry());
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
