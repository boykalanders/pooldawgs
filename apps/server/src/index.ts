import { setSimulator } from "@pooldawgs/engine";
import { initHavok, simulateShotHavok } from "@pooldawgs/engine/havok";
import { loadConfig } from "./config.js";
import { createPersistence } from "./db/persistence.js";
import { LeaderboardStore } from "./leaderboard.js";
import { createPoolDawgsServer } from "./server.js";

const config = loadConfig();

// A stray rejected promise (e.g. a WebSocket write after the socket closed) must
// be logged, not crash the process and take every live table down with it.
process.on("unhandledRejection", (reason) => {
  console.error("[server] unhandled rejection:", reason);
});

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

  // Persistent storage: Postgres if configured + reachable, else SQLite. Results,
  // live tables, the lobby, the leaderboard and the chain cursor all survive
  // restarts; the chain monitor resumes from its saved block.
  const persistence = await createPersistence(config);
  const leaderboard = new LeaderboardStore(persistence);
  await leaderboard.load();

  const server = createPoolDawgsServer(config, undefined, undefined, leaderboard, {
    persist: persistence,
    // Presumed dead and replaced: exit, and the host restarts us as a follower.
    onFenced: () => setTimeout(() => process.exit(1), 100),
  });
  // Clean shutdown (deploys send SIGTERM): store every live table with its clock
  // paused at this moment, so play resumes with exactly the time that was left.
  let stopping = false;
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.on(signal, () => {
      if (stopping) return;
      stopping = true;
      console.log(`[server] ${signal} — saving live tables and shutting down`);
      const force = setTimeout(() => process.exit(1), 10_000);
      server
        .close()
        .catch((e) => console.error("[server] shutdown error:", e))
        .finally(() => {
          clearTimeout(force);
          process.exit(0);
        });
    });
  }

  server.httpServer.listen(config.port, () => {
    console.log(
      `PoolDawgs server on :${config.port} ` +
        `(chain ${config.chainEnabled ? "enabled" : "DISABLED — dev mode"}, ` +
        `physics ${config.physicsBackend}, shot clock ${config.shotClockMs / 1000}s)`
    );
  });
  // Listening before `ready` on purpose: during a deploy this process waits for
  // the old one to hand over the live tables, and the host only stops the old one
  // once this one passes its health check. Joins wait for `ready` (results and
  // live tables loaded) before anyone is seated.
  await server.ready;
  console.log("[server] live tables loaded — serving games");
}

main().catch((e) => {
  console.error("server failed to start:", e);
  process.exit(1);
});
