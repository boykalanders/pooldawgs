import "dotenv/config";
import { SHOT_CLOCK_MS } from "@pooldawgs/shared";
import { resolveRpcUrls, resolveWsUrls } from "./rpc.js";

export interface ServerConfig {
  port: number;
  corsOrigins: string[];
  /** First configured HTTP RPC endpoint (kept for scripts/compat). */
  rpcUrl: string | null;
  /** Every HTTP RPC endpoint, best first (Alchemy, Infura, fallbacks, RPC_URL). */
  rpcUrls?: string[];
  /** WebSocket endpoints for live contract events, best first. */
  wsUrls?: string[];
  /** Chain id, when known — saves a network lookup per provider. */
  chainId?: number;
  contractAddress: string | null;
  ownerPrivateKey: string | null;
  /** Dedicated low-privilege settlement key (preferred over the owner key).
   *  Can only call finishGame/exit/draw on-chain — see PoolDawgs.onlyRelayer. */
  operatorPrivateKey?: string | null;
  shotClockMs: number;
  /** True when RPC + contract are configured; otherwise chain-less dev mode. */
  chainEnabled: boolean;
  /** Directory for best-effort JSON persistence (usernames). */
  dataDir?: string;
  /** Authoritative physics: "havok" (real 3D physics) or "ts" (built-in). */
  physicsBackend?: "havok" | "ts";
  /** PostgreSQL connection string. When set and reachable it's used;
   *  otherwise the server falls back to SQLite. */
  databaseUrl?: string | null;
  /** SQLite file path for the fallback (and default in dev). */
  sqlitePath?: string;
  /** Block the PoolDawgs contract was deployed at — the indexer backfills the
   *  full history from here on its very first start (0 = recent window only). */
  contractDeployBlock?: number;
  /** Max blocks per eth_getLogs during a backfill (Alchemy free tier: 10). */
  backfillMaxBlocks?: number;
  /** Safety check: backfill from the cursor this often even with a live subscription. */
  reconcileIntervalMs?: number;
  /** Without a WebSocket endpoint, how often to backfill instead. */
  fallbackPollMs?: number;
  /** A decided game the winner hasn't claimed for this long is recorded on-chain
   *  with finishGame (needs the operator/owner key), so it can never be lost. */
  settleUnclaimedAfterMs?: number;
  /** Telegram alerts: bot token + chat that receives the daily stuck-funds report. */
  telegramBotToken?: string | null;
  alertTelegramChatId?: string | null;
  /** Interval of the stuck-funds report. */
  stuckReportIntervalMs?: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const rpcUrls = resolveRpcUrls(env);
  const contractAddress = env.CONTRACT_ADDRESS || null;
  return {
    port: Number(env.PORT) || 4000,
    corsOrigins: (env.CORS_ORIGINS ?? "http://localhost:3000")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    rpcUrl: rpcUrls[0] ?? null,
    rpcUrls,
    wsUrls: resolveWsUrls(env),
    chainId: Number(env.CHAIN_ID) || undefined,
    contractAddress,
    ownerPrivateKey: env.OWNER_PRIVATE_KEY || null,
    operatorPrivateKey: env.OPERATOR_PRIVATE_KEY || null,
    shotClockMs: Number(env.SHOT_CLOCK_MS) || SHOT_CLOCK_MS,
    chainEnabled: Boolean(rpcUrls.length && contractAddress),
    dataDir: env.DATA_DIR || process.cwd(),
    physicsBackend: env.PHYSICS_BACKEND === "ts" ? "ts" : "havok",
    databaseUrl: env.DATABASE_URL || null,
    sqlitePath: env.SQLITE_PATH || `${env.DATA_DIR || process.cwd()}/leaderboard.db`,
    contractDeployBlock: Number(env.CONTRACT_DEPLOY_BLOCK) || 0,
    backfillMaxBlocks: Number(env.CHAIN_EVENT_BACKFILL_MAX_BLOCKS) || 500,
    reconcileIntervalMs: Number(env.CHAIN_EVENT_RECONCILE_INTERVAL_MS) || 30 * 60_000,
    fallbackPollMs: Number(env.CHAIN_EVENT_FALLBACK_POLL_MS) || 30_000,
    settleUnclaimedAfterMs: Number(env.SETTLE_UNCLAIMED_AFTER_MS) || 24 * 3_600_000,
    telegramBotToken: env.TELEGRAM_BOT_TOKEN || null,
    alertTelegramChatId: env.ALERT_TELEGRAM_CHAT_ID || null,
    stuckReportIntervalMs: Number(env.STUCK_FUNDS_REPORT_INTERVAL_MS) || 24 * 3_600_000,
  };
}
