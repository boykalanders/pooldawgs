import "dotenv/config";
import { SHOT_CLOCK_MS } from "@pooldawgs/shared";

export interface ServerConfig {
  port: number;
  corsOrigins: string[];
  rpcUrl: string | null;
  contractAddress: string | null;
  ownerPrivateKey: string | null;
  /** Dedicated low-privilege settlement key (preferred over the owner key).
   *  Can only call finishGame/exit/draw on-chain — see PoolDawgs.onlyRelayer. */
  operatorPrivateKey: string | null;
  shotClockMs: number;
  /** True when RPC + contract are configured; otherwise chain-less dev mode. */
  chainEnabled: boolean;
  /** Directory for best-effort JSON persistence (usernames). */
  dataDir: string;
  /** Authoritative physics: "havok" (real 3D physics) or "ts" (built-in). */
  physicsBackend: "havok" | "ts";
  /** PostgreSQL connection string for the persistent leaderboard. When set and
   *  reachable it's used; otherwise the server falls back to SQLite. */
  databaseUrl: string | null;
  /** SQLite file path for the leaderboard fallback (and default in dev). */
  sqlitePath: string;
  /** Block the PoolDawgs contract was deployed at — the indexer backfills the
   *  full leaderboard history from here on startup (0 = scan from genesis,
   *  which most RPCs reject, so set this for a real deployment). */
  contractDeployBlock: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const rpcUrl = env.RPC_URL || null;
  const contractAddress = env.CONTRACT_ADDRESS || null;
  return {
    port: Number(env.PORT) || 4000,
    corsOrigins: (env.CORS_ORIGINS ?? "http://localhost:3000")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    rpcUrl,
    contractAddress,
    ownerPrivateKey: env.OWNER_PRIVATE_KEY || null,
    operatorPrivateKey: env.OPERATOR_PRIVATE_KEY || null,
    shotClockMs: Number(env.SHOT_CLOCK_MS) || SHOT_CLOCK_MS,
    chainEnabled: Boolean(rpcUrl && contractAddress),
    dataDir: env.DATA_DIR || process.cwd(),
    physicsBackend: env.PHYSICS_BACKEND === "ts" ? "ts" : "havok",
    databaseUrl: env.DATABASE_URL || null,
    sqlitePath: env.SQLITE_PATH || `${env.DATA_DIR || process.cwd()}/leaderboard.db`,
    contractDeployBlock: Number(env.CONTRACT_DEPLOY_BLOCK) || 0,
  };
}
