import { setSimulator } from "@pooldawgs/engine";
import { initHavok, simulateShotHavok } from "@pooldawgs/engine/havok";
import { loadConfig } from "./config.js";
import { createPersistence } from "./db/persistence.js";
import { LeaderboardStore } from "./leaderboard.js";
import { createPoolDawgsServer } from "./server.js";

const config = loadConfig();

// Bring up the authoritative Havok physics backend before accepting play, then
// inject it so every room's simulateShot() runs on Havok. The SERVER is the
// sole authority — it simulates each shot and the clients replay the result —
// so Havok's cross-machine non-determinism is irrelevant to who wins the pot.
async function main() {
  if (config.physicsBackend === "havok") {
    const t0 = Date.now();
    await initHavok();
    setSimulator(simulateShotHavok);
    console.log(`Havok physics ready in ${Date.now() - t0}ms (authoritative)`);
  } else {
    console.log("Physics backend: built-in TS engine");
  }

  // Persistent leaderboard: Postgres if configured + reachable, else SQLite.
  // Load the saved rows so the ranking survives restarts; the chain indexer
  // then resumes from the saved block (or backfills from the deploy block).
  const persistence = await createPersistence(config);
  const leaderboard = new LeaderboardStore(persistence);
  await leaderboard.load();

  const server = createPoolDawgsServer(config, undefined, undefined, leaderboard);
  server.httpServer.listen(config.port, () => {
    console.log(
      `PoolDawgs server on :${config.port} ` +
        `(chain ${config.chainEnabled ? "enabled" : "DISABLED — dev mode"}, ` +
        `physics ${config.physicsBackend}, shot clock ${config.shotClockMs / 1000}s)`
    );
  });
}

main().catch((e) => {
  console.error("server failed to start:", e);
  process.exit(1);
});
