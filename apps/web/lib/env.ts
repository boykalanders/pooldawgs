import type { Address } from "@pooldawgs/shared";

export const SERVER_URL =
  process.env.NEXT_PUBLIC_SERVER_URL ?? "http://localhost:4000";

// A real WalletConnect/Reown project id is 32 hex chars. Empty by default so
// the app falls back to injected wallets instead of throwing.
export const WALLETCONNECT_PROJECT_ID =
  process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID ?? "";

/** Active chain: Sepolia by default; set NEXT_PUBLIC_CHAIN_ID=1 for mainnet. */
export const CHAIN_ID = Number(process.env.NEXT_PUBLIC_CHAIN_ID) || 11155111;

interface NetworkContracts {
  name: string;
  poolDawgs: Address | null;
  ddawgsToken: Address | null;
  /** Mintable PoolDawgs membership pass (the mint target). */
  poolDawgsNFT: Address | null;
  /** Grandfathered ChessDawgs NFT (informational; the gate ORs it in-contract). */
  chessDawgsNFT: Address | null;
}

/**
 * Dual-network address book. Sepolia is live (deployed by
 * `pnpm --filter @pooldawgs/contracts deploy:sepolia`). Mainnet knows the
 * existing $DDawgs token and ChessDawgs NFT; the PoolDawgs proxy and the new
 * membership NFT are filled in once deployed there. Env vars override per key.
 */
const NETWORKS: Record<number, NetworkContracts> = {
  11155111: {
    name: "Sepolia",
    poolDawgs: "0xcbc5287F4BE6656614a479257E74af0c9bd28db4",
    ddawgsToken: "0xe60F1A83C0A08FF104b3c1F74D932f0C9D629C4E",
    poolDawgsNFT: "0x42e5ed18Ec067b1Ce5421F2f584b9Ebb683fd52C",
    chessDawgsNFT: "0x276252194f9313D9B0747210cacD259107f4e1A5",
  },
  1: {
    name: "Ethereum",
    poolDawgs: null, // not deployed on mainnet yet
    ddawgsToken: "0x19f78a898f3e3c2f40c6E0CD2EE5545F549d5E99",
    poolDawgsNFT: null,
    chessDawgsNFT: "0xf82E0cF5605101efE12689461c2bC9392BfDedEF",
  },
};

const active = NETWORKS[CHAIN_ID] ?? NETWORKS[11155111];

const envAddr = (key: string, fallback: Address | null): Address | null =>
  (process.env[key] as Address | undefined) || fallback;

export const NETWORK_NAME = active.name;
export const POOLDAWGS_ADDRESS = envAddr("NEXT_PUBLIC_POOLDAWGS_ADDRESS", active.poolDawgs);
export const DDAWGS_TOKEN_ADDRESS = envAddr(
  "NEXT_PUBLIC_DDAWGS_TOKEN_ADDRESS",
  active.ddawgsToken
);
export const POOLDAWGS_NFT_ADDRESS = envAddr(
  "NEXT_PUBLIC_POOLDAWGS_NFT_ADDRESS",
  active.poolDawgsNFT
);
export const CHESS_NFT_ADDRESS = envAddr("NEXT_PUBLIC_CHESS_NFT_ADDRESS", active.chessDawgsNFT);

/** True when the game proxy + token are known for the active network. */
export const CONTRACTS_CONFIGURED = Boolean(POOLDAWGS_ADDRESS && DDAWGS_TOKEN_ADDRESS);

/** Testnet (anything but Ethereum mainnet) — enables the public $DDawgs faucet. */
export const IS_TESTNET = CHAIN_ID !== 1;
