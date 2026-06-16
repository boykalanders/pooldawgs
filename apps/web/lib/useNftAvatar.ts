"use client";

import { useEffect, useMemo, useState } from "react";
import { usePublicClient } from "wagmi";
import { ERC721_ABI, POOL_DAWGS_NFT_ABI, type Address } from "@pooldawgs/shared";
import { CHESS_NFT_ADDRESS, POOLDAWGS_NFT_ADDRESS } from "./env";
import { identiconDataUri } from "./identicon";
import { log } from "./log";

type Client = NonNullable<ReturnType<typeof usePublicClient>>;

const IPFS_GATEWAY = "https://ipfs.io/ipfs/";

function ipfsToHttp(uri?: string | null): string | null {
  if (!uri) return null;
  if (uri.startsWith("ipfs://")) return IPFS_GATEWAY + uri.slice("ipfs://".length).replace(/^ipfs\//, "");
  if (uri.startsWith("http://") || uri.startsWith("https://") || uri.startsWith("data:")) return uri;
  return null;
}

async function fetchJson(url: string, ms = 6000): Promise<Record<string, unknown> | null> {
  if (url.startsWith("data:application/json")) {
    const comma = url.indexOf(",");
    const body = url.slice(comma + 1);
    const json = url.slice(0, comma).includes("base64") ? atob(body) : decodeURIComponent(body);
    return JSON.parse(json);
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) return null;
    return (await res.json()) as Record<string, unknown>;
  } finally {
    clearTimeout(timer);
  }
}

/** tokenURI → metadata → resolved image URL (handles ipfs:// and data: URIs). */
async function imageFromTokenUri(tokenUri: string): Promise<string | null> {
  const metaUrl = ipfsToHttp(tokenUri);
  if (!metaUrl) return null;
  const meta = await fetchJson(metaUrl);
  const image = (meta?.image ?? meta?.image_url ?? meta?.imageUrl) as string | undefined;
  return ipfsToHttp(image);
}

async function poolPassImage(client: Client, owner: Address): Promise<string | null> {
  if (!POOLDAWGS_NFT_ADDRESS) return null;
  const balance = (await client.readContract({
    address: POOLDAWGS_NFT_ADDRESS,
    abi: POOL_DAWGS_NFT_ABI,
    functionName: "balanceOf",
    args: [owner],
  })) as bigint;
  if (balance === 0n) return null;
  // Find the holder's token id from the Minted event (indexed `to`). Bound the
  // range — public RPCs cap eth_getLogs (publicnode: 50k blocks). The pass NFT
  // is recent, so the last ~45k blocks (~6 days on Sepolia) covers it.
  const head = await client.getBlockNumber();
  const fromBlock = head > 45000n ? head - 45000n : 0n;
  const logs = await client.getContractEvents({
    address: POOLDAWGS_NFT_ADDRESS,
    abi: POOL_DAWGS_NFT_ABI,
    eventName: "Minted",
    args: { to: owner },
    fromBlock,
  });
  const tokenId = logs.at(-1)?.args?.tokenId as bigint | undefined;
  if (tokenId === undefined) return null;
  const uri = (await client.readContract({
    address: POOLDAWGS_NFT_ADDRESS,
    abi: POOL_DAWGS_NFT_ABI,
    functionName: "tokenURI",
    args: [tokenId],
  })) as string;
  return uri ? imageFromTokenUri(uri) : null;
}

async function chessDawgsImage(client: Client, owner: Address): Promise<string | null> {
  if (!CHESS_NFT_ADDRESS) return null;
  const balance = (await client.readContract({
    address: CHESS_NFT_ADDRESS,
    abi: ERC721_ABI,
    functionName: "balanceOf",
    args: [owner],
  })) as bigint;
  if (balance === 0n) return null;
  // Requires ERC721Enumerable; if the contract isn't, this throws and we bail.
  const tokenId = (await client.readContract({
    address: CHESS_NFT_ADDRESS,
    abi: ERC721_ABI,
    functionName: "tokenOfOwnerByIndex",
    args: [owner, 0n],
  })) as bigint;
  const uri = (await client.readContract({
    address: CHESS_NFT_ADDRESS,
    abi: ERC721_ABI,
    functionName: "tokenURI",
    args: [tokenId],
  })) as string;
  return uri ? imageFromTokenUri(uri) : null;
}

async function resolveNftImage(client: Client, owner: Address): Promise<string | null> {
  // Prefer the PoolDawgs membership pass; fall back to a grandfathered
  // ChessDawgs NFT. Each lookup is best-effort — any failure (no metadata,
  // non-enumerable contract, RPC hiccup) just yields null → identicon.
  for (const resolve of [poolPassImage, chessDawgsImage]) {
    try {
      const image = await resolve(client, owner);
      if (image) return image;
    } catch (e) {
      log.info("nft-avatar: lookup skipped —", e instanceof Error ? e.message : e);
    }
  }
  return null;
}

/**
 * Avatar src for a wallet: its NFT artwork when resolvable, otherwise a
 * deterministic identicon derived from the address. Returns "" for no address.
 */
export function useNftAvatar(address?: string): string {
  const fallback = useMemo(() => (address ? identiconDataUri(address) : ""), [address]);
  const [src, setSrc] = useState(fallback);
  const publicClient = usePublicClient();

  useEffect(() => {
    setSrc(fallback);
    if (!address || !publicClient) return;
    let cancelled = false;
    void resolveNftImage(publicClient, address.toLowerCase() as Address).then((image) => {
      if (!cancelled && image) setSrc(image);
    });
    return () => {
      cancelled = true;
    };
  }, [address, publicClient, fallback]);

  return src;
}
