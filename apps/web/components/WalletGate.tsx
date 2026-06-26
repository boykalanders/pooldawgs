"use client";

import { useEffect, useState, type ReactNode } from "react";
import { ConnectButton } from "@rainbow-me/rainbowkit";
import {
  useAccount,
  usePublicClient,
  useReadContract,
  useSwitchChain,
  useWriteContract,
} from "wagmi";
import { POOL_DAWGS_ABI, POOL_DAWGS_NFT_ABI } from "@pooldawgs/shared";
import {
  CHAIN_ID,
  CONTRACTS_CONFIGURED,
  NETWORK_NAME,
  POOLDAWGS_ADDRESS,
  POOLDAWGS_NFT_ADDRESS,
} from "@/lib/env";
import { log } from "@/lib/log";
import { hasWalletConnect } from "@/lib/wagmi";

/**
 * Play gate. A wallet may enter if the PoolDawgs contract's `ownsNFT` is true —
 * i.e. it holds the PoolDawgs membership pass OR (grandfather) a ChessDawgs
 * NFT. Otherwise we offer a one-tap mint of a pass. When contracts aren't
 * configured for the active network (e.g. mainnet pre-deploy) it only requires
 * a connected wallet (look-and-feel build).
 */
export default function WalletGate({ children }: { children: ReactNode }) {
  const { address, isConnected, chainId } = useAccount();
  const publicClient = usePublicClient();
  const { writeContractAsync } = useWriteContract();
  const { switchChain, isPending: switching } = useSwitchChain();
  const [minting, setMinting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const {
    data: owns,
    isLoading,
    refetch,
  } = useReadContract({
    address: POOLDAWGS_ADDRESS ?? undefined,
    abi: POOL_DAWGS_ABI,
    functionName: "ownsNFT",
    args: address ? [address] : undefined,
    query: { enabled: Boolean(CONTRACTS_CONFIGURED && address) },
  });

  useEffect(() => {
    log.info("gate:", { connected: isConnected, address, walletChain: chainId, expectedChain: CHAIN_ID });
  }, [isConnected, address, chainId]);

  useEffect(() => {
    if (CONTRACTS_CONFIGURED && address && !isLoading) {
      log.info("gate: ownsNFT =", owns, "(pool pass or ChessDawgs NFT)");
    }
  }, [owns, isLoading, address]);

  async function mint() {
    if (!POOLDAWGS_NFT_ADDRESS || !publicClient) return;
    setError(null);
    setMinting(true);
    log.info("gate: minting pass at", POOLDAWGS_NFT_ADDRESS);
    try {
      const hash = await writeContractAsync({
        address: POOLDAWGS_NFT_ADDRESS,
        abi: POOL_DAWGS_NFT_ABI,
        functionName: "mint",
      });
      log.info("gate: mint tx", hash, "— waiting…");
      await publicClient.waitForTransactionReceipt({ hash });
      await refetch();
      log.info("gate: mint confirmed");
    } catch (e) {
      log.error("gate: mint failed —", e);
      setError(e instanceof Error ? e.message.split("\n")[0] : "Mint failed");
    } finally {
      setMinting(false);
    }
  }

  if (!isConnected) {
    return (
      <div className="panel mx-auto flex max-w-md flex-col items-center gap-4 p-10 text-center">
        <h2 className="heading-display text-2xl">Wallet required</h2>
        <p className="text-sm text-amber-100/60">
          Connect your wallet to play PoolDawgs on{" "}
          <span className="text-gold">{NETWORK_NAME}</span>.
        </p>
        <ConnectButton />
        {!hasWalletConnect && (
          <p className="mt-1 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-200/80">
            ⚠ Mobile wallets are unavailable — WalletConnect isn&rsquo;t configured.
            Set <code className="text-amber-100">NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID</code> to a
            valid Reown project id and redeploy.
          </p>
        )}
      </div>
    );
  }

  // Wrong network → every contract call (approve/join/mint) would revert.
  // Force the correct chain before anything else.
  if (CONTRACTS_CONFIGURED && chainId !== CHAIN_ID) {
    return (
      <div className="panel mx-auto flex max-w-md flex-col items-center gap-4 p-10 text-center">
        <div className="text-4xl">🔌</div>
        <h2 className="heading-display text-2xl">Wrong network</h2>
        <p className="text-sm text-amber-100/60">
          PoolDawgs runs on <span className="text-gold">{NETWORK_NAME}</span>. Your
          wallet is on a different network — switch to continue.
        </p>
        <button
          className="btn-gold"
          disabled={switching}
          onClick={() => switchChain({ chainId: CHAIN_ID })}
        >
          {switching ? "Switching…" : `Switch to ${NETWORK_NAME}`}
        </button>
        <ConnectButton showBalance={false} />
      </div>
    );
  }

  if (CONTRACTS_CONFIGURED) {
    if (isLoading) {
      return <p className="py-10 text-center text-amber-100/60">Checking your pass…</p>;
    }
    if (!owns) {
      return (
        <div className="panel mx-auto max-w-md space-y-4 p-10 text-center">
          <div className="text-4xl">🎟️</div>
          <h2 className="heading-display text-2xl">Mint your Pool Dawgs pass</h2>
          <p className="text-sm text-amber-100/60">
            A Pool Dawgs NFT is your seat at the table. Mint one (free) to start
            staking $DDawgs.
          </p>
          <button className="btn-gold w-full" disabled={minting} onClick={mint}>
            {minting ? "Minting…" : "Mint pass"}
          </button>
          {error && <p className="text-sm text-red-300">{error}</p>}
          <p className="text-xs text-amber-100/40">
            Already hold a <span className="text-gold">ChessDawgs</span> NFT?
            You&rsquo;re in automatically — no mint needed.
          </p>
        </div>
      );
    }
  }

  return <>{children}</>;
}
