import { ethers, network, upgrades } from "hardhat";

/**
 * In-place upgrade of the PoolDawgs proxy to the current implementation, which
 * adds the on-chain platform counters (totalGamesFinished / totalWageredWei /
 * totalBurnedWei + the platformStats() view that the leaderboard reads).
 *
 * The proxy address and ALL existing games are preserved — the new counters
 * were appended at the end of storage and start at zero, so they count from
 * this upgrade forward.
 *
 * Optionally seed the pre-upgrade history (summed off-chain from past
 * GameFinished events: pot = reward * 1.25, burn = reward * 0.125) by setting
 * SEED_GAMES / SEED_WAGERED / SEED_BURNED — applied once, only while the
 * on-chain totals are still zero.
 *
 *   POOLDAWGS_PROXY=0x... \
 *   [SEED_GAMES=12 SEED_WAGERED=<wei> SEED_BURNED=<wei>] \
 *   pnpm --filter @pooldawgs/contracts upgrade:pooldawgs:sepolia
 */
const PROXY = process.env.POOLDAWGS_PROXY || "0x1a0ff1B3B4D20495B12367f291A8639B9B268764";

async function main() {
  const [signer] = await ethers.getSigners();
  console.log(`Upgrading PoolDawgs ${PROXY} on ${network.name} as ${signer.address}`);

  const Factory = await ethers.getContractFactory("PoolDawgs");
  // upgradeProxy validates the storage layout is upgrade-safe before switching.
  const upgraded = await upgrades.upgradeProxy(PROXY, Factory);
  await upgraded.waitForDeployment();

  // Wait until the new impl (with platformStats()) is live — public RPCs lag.
  let stats: [bigint, bigint, bigint] | null = null;
  for (let i = 0; i < 12; i++) {
    try {
      stats = await upgraded.platformStats();
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
  if (!stats) throw new Error("platformStats() not callable after upgrade — check the implementation");

  console.log("  implementation:", await upgrades.erc1967.getImplementationAddress(PROXY));
  console.log(`  platformStats: games=${stats[0]} wagered=${stats[1]} burned=${stats[2]}`);

  // Optional one-time seed of pre-upgrade history.
  const seedGames = process.env.SEED_GAMES;
  const seedWagered = process.env.SEED_WAGERED;
  const seedBurned = process.env.SEED_BURNED;
  if (seedGames || seedWagered || seedBurned) {
    if (stats[0] !== 0n || stats[1] !== 0n || stats[2] !== 0n) {
      console.log("  seed skipped — on-chain totals are already non-zero");
    } else {
      const g = BigInt(seedGames ?? "0");
      const w = BigInt(seedWagered ?? "0");
      const b = BigInt(seedBurned ?? "0");
      console.log(`  seeding history: games=${g} wagered=${w} burned=${b}`);
      await (await upgraded.seedPlatformTotals(g, w, b)).wait();
      const after = await upgraded.platformStats();
      console.log(`  seeded: games=${after[0]} wagered=${after[1]} burned=${after[2]}`);
    }
  }

  console.log("Upgrade complete. Set CONTRACT_DEPLOY_BLOCK on the server for full-history ranking backfill.");
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
