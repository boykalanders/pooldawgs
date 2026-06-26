"use client";

import { getDefaultConfig } from "@rainbow-me/rainbowkit";
import { createConfig, http } from "wagmi";
import { base, baseSepolia, hardhat, mainnet, polygon, sepolia } from "wagmi/chains";
import { coinbaseWallet, injected } from "wagmi/connectors";
import { CHAIN_ID, WALLETCONNECT_PROJECT_ID } from "./env";
import { log } from "./log";

const SUPPORTED = [sepolia, mainnet, polygon, base, baseSepolia, hardhat] as const;

export const activeChain = SUPPORTED.find((c) => c.id === CHAIN_ID) ?? sepolia;

// Pin CORS-enabled public RPCs. viem's defaults (e.g. eth.merkle.io) don't
// send CORS headers, so browser reads get blocked. publicnode allows CORS.
// NEXT_PUBLIC_RPC_URL overrides the active chain's endpoint if you have one.
const RPC_OVERRIDE = process.env.NEXT_PUBLIC_RPC_URL;
const rpc = (chainId: number, fallback: string) =>
  http(RPC_OVERRIDE && chainId === CHAIN_ID ? RPC_OVERRIDE : fallback);

const transports = {
  [mainnet.id]: rpc(mainnet.id, "https://ethereum-rpc.publicnode.com"),
  [sepolia.id]: rpc(sepolia.id, "https://ethereum-sepolia-rpc.publicnode.com"),
  [polygon.id]: rpc(polygon.id, "https://polygon-bor-rpc.publicnode.com"),
  [base.id]: rpc(base.id, "https://base-rpc.publicnode.com"),
  [baseSepolia.id]: rpc(baseSepolia.id, "https://base-sepolia-rpc.publicnode.com"),
  [hardhat.id]: http("http://127.0.0.1:8545"),
};

// WalletConnect needs a real 32-hex-char project id from cloud.reown.com. With
// a valid one we use RainbowKit's full wallet list (incl. mobile/QR); without
// it we fall back to injected (MetaMask) + Coinbase so the app still works —
// otherwise WalletConnect throws "projectId must be 32 characters long".
export const hasWalletConnect = /^[0-9a-f]{32}$/i.test(WALLETCONNECT_PROJECT_ID);

export const wagmiConfig = hasWalletConnect
  ? getDefaultConfig({
      appName: "PoolDawgs",
      projectId: WALLETCONNECT_PROJECT_ID,
      chains: SUPPORTED,
      transports,
      ssr: true,
    })
  : createConfig({
      chains: SUPPORTED,
      connectors: [injected(), coinbaseWallet({ appName: "PoolDawgs" })],
      transports,
      ssr: true,
    });

if (typeof window !== "undefined") {
  log.info(
    `wagmi: chain ${activeChain.name} (${activeChain.id}),`,
    hasWalletConnect ? "WalletConnect enabled" : "injected/Coinbase only (no WalletConnect id)"
  );
}
