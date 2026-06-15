"use client";

import { getDefaultConfig } from "@rainbow-me/rainbowkit";
import { createConfig, http } from "wagmi";
import { base, baseSepolia, hardhat, mainnet, polygon, sepolia } from "wagmi/chains";
import { coinbaseWallet, injected } from "wagmi/connectors";
import { CHAIN_ID, WALLETCONNECT_PROJECT_ID } from "./env";
import { log } from "./log";

const SUPPORTED = [sepolia, mainnet, polygon, base, baseSepolia, hardhat] as const;

export const activeChain = SUPPORTED.find((c) => c.id === CHAIN_ID) ?? sepolia;

const transports = {
  [sepolia.id]: http(),
  [mainnet.id]: http(),
  [polygon.id]: http(),
  [base.id]: http(),
  [baseSepolia.id]: http(),
  [hardhat.id]: http(),
};

// WalletConnect needs a real 32-hex-char project id from cloud.reown.com. With
// a valid one we use RainbowKit's full wallet list (incl. mobile/QR); without
// it we fall back to injected (MetaMask) + Coinbase so the app still works —
// otherwise WalletConnect throws "projectId must be 32 characters long".
const hasWalletConnect = /^[0-9a-f]{32}$/i.test(WALLETCONNECT_PROJECT_ID);

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
