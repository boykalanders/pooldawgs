import { Contract, JsonRpcProvider, ZeroAddress } from "ethers";
import { POOL_DAWGS_ABI } from "@pooldawgs/shared";
import type { ServerConfig } from "./config.js";

export interface ChainGame {
  playerOne: string;
  playerTwo: string;
  isCompleted: boolean;
  stake: bigint;
}

export interface ChainReader {
  /** Read a game straight from the contract — authoritative, no event lag. */
  getGame(gameId: string): Promise<ChainGame | null>;
}

/**
 * Reads game state directly from the chain. Seat resolution uses this rather
 * than the event-mirrored lobby, so a join is never blocked by event-listener
 * lag or a public RPC dropping a log filter.
 */
export function createChainReader(config: ServerConfig): ChainReader {
  if (!config.chainEnabled) {
    return { async getGame() { return null; } };
  }
  const provider = new JsonRpcProvider(config.rpcUrl!, undefined, { staticNetwork: true });
  const contract = new Contract(config.contractAddress!, POOL_DAWGS_ABI, provider);

  return {
    async getGame(gameId: string): Promise<ChainGame | null> {
      try {
        const g = await contract.games(gameId);
        const playerOne = (g.playerOne ?? g[0]) as string;
        if (playerOne === ZeroAddress) return null;
        return {
          playerOne,
          playerTwo: (g.playerTwo ?? g[1]) as string,
          isCompleted: (g.isCompleted ?? g[2]) as boolean,
          stake: (g.stake ?? g[4]) as bigint,
        };
      } catch (e) {
        console.error(
          `[chain] getGame(${gameId}) failed:`,
          e instanceof Error ? e.message : e
        );
        return null;
      }
    },
  };
}

export { ZeroAddress };
