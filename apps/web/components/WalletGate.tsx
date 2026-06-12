"use client";

import type { ReactNode } from "react";
import { ConnectButton } from "@rainbow-me/rainbowkit";
import { useAccount, useReadContract } from "wagmi";
import { ERC721_ABI } from "@pooldawgs/shared";
import { CONTRACTS_CONFIGURED, DDAWGS_NFT_ADDRESS } from "@/lib/env";

/**
 * Gate: wallet connected + holds a Deputy Dawgs NFT. When contracts aren't
 * configured (look-and-feel review build) it only requires a connected wallet.
 */
export default function WalletGate({ children }: { children: ReactNode }) {
  const { address, isConnected } = useAccount();

  const { data: nftBalance, isLoading } = useReadContract({
    address: DDAWGS_NFT_ADDRESS ?? undefined,
    abi: ERC721_ABI,
    functionName: "balanceOf",
    args: address ? [address] : undefined,
    query: { enabled: Boolean(CONTRACTS_CONFIGURED && address) },
  });
  const hasNFT = (nftBalance ?? 0n) > 0n;

  if (!isConnected) {
    return (
      <div className="panel mx-auto flex max-w-md flex-col items-center gap-4 p-10 text-center">
        <h2 className="heading-display text-2xl">Wallet required</h2>
        <p className="text-sm text-amber-100/60">
          Connect the wallet holding your Deputy Dawgs NFT to take a seat.
        </p>
        <ConnectButton />
      </div>
    );
  }

  if (CONTRACTS_CONFIGURED) {
    if (isLoading) {
      return <p className="py-10 text-center text-amber-100/60">Checking your Dawg…</p>;
    }
    if (!hasNFT) {
      return (
        <div className="panel mx-auto max-w-md p-10 text-center">
          <h2 className="heading-display mb-2 text-2xl">No Dawg, no table</h2>
          <p className="text-sm text-amber-100/60">
            This wallet doesn&rsquo;t hold a Deputy Dawgs NFT. Grab one to play
            for $DDawgs.
          </p>
        </div>
      );
    }
  }

  return <>{children}</>;
}
