import * as fs from "fs";
import * as path from "path";
import { ethers, network, upgrades } from "hardhat";

/** Read-only preflight for redeploy-nft.ts — confirms the signer can upgrade
 *  the proxy and re-point the gate, and prints current state. No transactions. */
async function main() {
  const file = path.join(__dirname, "..", "deployments", `${network.name}.json`);
  const d = JSON.parse(fs.readFileSync(file, "utf8"));
  const [signer] = await ethers.getSigners();

  const pool = await ethers.getContractAt("PoolDawgs", d.poolDawgs);
  const owner: string = await pool.owner();
  const admin = await upgrades.erc1967.getAdminAddress(d.poolDawgs);
  const impl = await upgrades.erc1967.getImplementationAddress(d.poolDawgs);
  const currentNft: string = await pool.DDawgsNFT();

  let adminOwner = "(no ProxyAdmin — UUPS?)";
  if (admin && admin !== ethers.ZeroAddress) {
    try {
      const pa = await ethers.getContractAt(
        ["function owner() view returns (address)"],
        admin
      );
      adminOwner = await pa.owner();
    } catch {
      /* not ownable */
    }
  }

  const eq = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
  console.log(`network        ${network.name}`);
  console.log(`signer         ${signer.address}`);
  console.log(`proxy          ${d.poolDawgs}`);
  console.log(`implementation ${impl}`);
  console.log(`proxy admin    ${admin}`);
  console.log(`admin owner    ${adminOwner}`);
  console.log(`escrow owner   ${owner}`);
  console.log(`current gate   ${currentNft}`);
  console.log("");
  console.log(`signer == escrow owner?  ${eq(signer.address, owner) ? "YES" : "NO ❌"}`);
  console.log(`signer == admin owner?   ${eq(signer.address, adminOwner) ? "YES" : "NO ❌"}`);
  console.log(
    eq(signer.address, owner) && eq(signer.address, adminOwner)
      ? "\n✅ Ready: signer can upgrade the proxy and call setDDawgsNFT."
      : "\n⚠️  Signer is NOT authorized for one of these — redeploy-nft.ts would revert."
  );
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
