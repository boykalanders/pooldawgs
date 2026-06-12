import { Contract, JsonRpcProvider, Wallet } from "ethers";
import { POOL_DAWGS_ABI, type Address } from "@pooldawgs/shared";
import type { ServerConfig } from "./config.js";

export interface Relayer {
  /** Records the winner on-chain. Resolves to the tx hash, or null in dev mode. */
  finishGame(gameId: string, winner: Address): Promise<string | null>;
}

const RETRIES = 3;

/**
 * The relayer holds the contract OWNER key — the single off-chain authority
 * the contract trusts to report outcomes (pot, resign, or shot-clock forfeit).
 */
export function createRelayer(config: ServerConfig): Relayer {
  if (!config.chainEnabled || !config.ownerPrivateKey) {
    return {
      async finishGame(gameId, winner) {
        console.log(`[relayer:dev] finishGame(${gameId}, ${winner}) — no chain configured`);
        return null;
      },
    };
  }

  const provider = new JsonRpcProvider(config.rpcUrl!);
  const wallet = new Wallet(config.ownerPrivateKey, provider);
  const contract = new Contract(config.contractAddress!, POOL_DAWGS_ABI, wallet);

  return {
    async finishGame(gameId, winner) {
      let lastError: unknown;
      for (let attempt = 1; attempt <= RETRIES; attempt++) {
        try {
          const tx = await contract.finishGame(gameId, winner);
          const receipt = await tx.wait();
          console.log(`[relayer] finishGame(${gameId}, ${winner}) tx=${receipt.hash}`);
          return receipt.hash as string;
        } catch (error) {
          lastError = error;
          console.error(`[relayer] finishGame attempt ${attempt}/${RETRIES} failed`, error);
          await new Promise((r) => setTimeout(r, attempt * 2000));
        }
      }
      // Surface loudly: an unsettled finished game means escrowed funds are
      // stuck until retried manually (ownerWithdrawUnpaid is the last resort).
      console.error(`[relayer] PERMANENT FAILURE settling game ${gameId}`, lastError);
      throw lastError;
    },
  };
}
