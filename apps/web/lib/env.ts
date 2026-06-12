import type { Address } from "@pooldawgs/shared";

export const SERVER_URL =
  process.env.NEXT_PUBLIC_SERVER_URL ?? "http://localhost:4000";

export const POOLDAWGS_ADDRESS = (process.env.NEXT_PUBLIC_POOLDAWGS_ADDRESS ||
  null) as Address | null;

export const DDAWGS_TOKEN_ADDRESS = (process.env.NEXT_PUBLIC_DDAWGS_TOKEN_ADDRESS ||
  null) as Address | null;

export const DDAWGS_NFT_ADDRESS = (process.env.NEXT_PUBLIC_DDAWGS_NFT_ADDRESS ||
  null) as Address | null;

// Deputy Dawgs lives on Ethereum mainnet (chainId 1).
export const CHAIN_ID = Number(process.env.NEXT_PUBLIC_CHAIN_ID) || 1;

export const WALLETCONNECT_PROJECT_ID =
  process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID ?? "pooldawgs-dev";

/** True when running the look-and-feel review build without deployed contracts. */
export const CONTRACTS_CONFIGURED = Boolean(
  POOLDAWGS_ADDRESS && DDAWGS_TOKEN_ADDRESS && DDAWGS_NFT_ADDRESS
);
