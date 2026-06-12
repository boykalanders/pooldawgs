"use client";

import { getDefaultConfig } from "@rainbow-me/rainbowkit";
import { http } from "wagmi";
import { base, baseSepolia, hardhat, mainnet, polygon, sepolia } from "wagmi/chains";
import { CHAIN_ID, WALLETCONNECT_PROJECT_ID } from "./env";

const SUPPORTED = [sepolia, mainnet, polygon, base, baseSepolia, hardhat] as const;

export const activeChain =
  SUPPORTED.find((c) => c.id === CHAIN_ID) ?? sepolia;

export const wagmiConfig = getDefaultConfig({
  appName: "PoolDawgs",
  projectId: WALLETCONNECT_PROJECT_ID,
  chains: [activeChain],
  transports: { [activeChain.id]: http() },
  ssr: true,
});
