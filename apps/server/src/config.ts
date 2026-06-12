import "dotenv/config";
import { SHOT_CLOCK_MS } from "@pooldawgs/shared";

export interface ServerConfig {
  port: number;
  corsOrigins: string[];
  rpcUrl: string | null;
  contractAddress: string | null;
  ownerPrivateKey: string | null;
  shotClockMs: number;
  /** True when RPC + contract are configured; otherwise chain-less dev mode. */
  chainEnabled: boolean;
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
    shotClockMs: Number(env.SHOT_CLOCK_MS) || SHOT_CLOCK_MS,
    chainEnabled: Boolean(rpcUrl && contractAddress),
  };
}
