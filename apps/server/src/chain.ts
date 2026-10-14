import { Contract, ZeroAddress, type AbstractProvider } from "ethers";
import { POOL_DAWGS_ABI } from "@pooldawgs/shared";
import type { ServerConfig } from "./config.js";
import { createRpcProvider } from "./rpc.js";

export interface ChainGame {
  playerOne: string;
  playerTwo: string;
  isCompleted: boolean;
  winner: string;
  stake: bigint;
  rewardClaimed: boolean;
  drawCompleted: boolean;
}

/** The chain couldn't be read (RPC outage) — NOT the same as "no such game". */
export class ChainUnavailableError extends Error {
  constructor(cause: unknown) {
    super(`chain read failed: ${cause instanceof Error ? cause.message.split("\n")[0] : String(cause)}`);
    this.name = "ChainUnavailableError";
  }
}

export interface ChainReader {
  /** Read a game straight from the contract — authoritative, no event lag.
   *  null = no such game; throws ChainUnavailableError when the chain can't be
   *  read, so an RPC hiccup is never mistaken for a missing game. */
  getGame(gameId: string): Promise<ChainGame | null>;
}

/**
 * Reads game state directly from the chain. Seat resolution uses this rather
 * than the event-mirrored lobby, so a join is never blocked by event-listener lag.
 */
export function createChainReader(config: ServerConfig, provider?: AbstractProvider): ChainReader {
  if (!config.chainEnabled) {
    return {
      async getGame() {
        return null;
      },
    };
  }
  const contract = new Contract(
    config.contractAddress!,
    POOL_DAWGS_ABI,
    provider ?? createRpcProvider(config.rpcUrls ?? [config.rpcUrl!], config.chainId)
  );

  return {
    async getGame(gameId: string): Promise<ChainGame | null> {
      let g;
      try {
        g = await contract.games(gameId);
      } catch (e) {
        console.error(`[chain] getGame(${gameId}) failed:`, e instanceof Error ? e.message : e);
        throw new ChainUnavailableError(e);
      }
      const playerOne = (g.playerOne ?? g[0]) as string;
      if (playerOne === ZeroAddress) return null;
      return {
        playerOne,
        playerTwo: (g.playerTwo ?? g[1]) as string,
        isCompleted: (g.isCompleted ?? g[2]) as boolean,
        winner: (g.winner ?? g[3]) as string,
        stake: (g.stake ?? g[4]) as bigint,
        rewardClaimed: (g.rewardClaimed ?? g[5]) as boolean,
        drawCompleted: (g.drawCompleted ?? g[12]) as boolean,
      };
    },
  };
}

export { ZeroAddress };
