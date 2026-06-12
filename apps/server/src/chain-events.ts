import { Contract, JsonRpcProvider } from "ethers";
import { POOL_DAWGS_ABI, type Address } from "@pooldawgs/shared";
import type { ServerConfig } from "./config.js";
import type { LobbyStore } from "./lobby.js";

/**
 * Subscribes to PoolDawgs contract events and mirrors them into the lobby.
 * The chain is the source of truth for who staked into which game; the
 * server only adds the gameplay layer on top.
 */
export function startChainListener(config: ServerConfig, lobby: LobbyStore): () => void {
  if (!config.chainEnabled) {
    console.log("[chain] disabled — running in chain-less dev mode");
    return () => {};
  }

  const provider = new JsonRpcProvider(config.rpcUrl!);
  const contract = new Contract(config.contractAddress!, POOL_DAWGS_ABI, provider);

  // gameIds are client-chosen strings in the ChessDawgs template.
  const onCreated = (gameId: string, playerOne: string, stake: bigint) => {
    lobby.upsertCreated(
      gameId,
      playerOne.toLowerCase() as Address,
      stake.toString(),
      Date.now()
    );
  };
  const onJoined = (gameId: string, playerTwo: string) => {
    lobby.markJoined(gameId, playerTwo.toLowerCase() as Address);
  };
  const onFinished = (gameId: string) => {
    lobby.markStatus(gameId, "finished");
  };
  const onCancelled = (gameId: string) => {
    lobby.markStatus(gameId, "cancelled");
  };

  contract.on("GameCreated", onCreated);
  contract.on("GameJoined", onJoined);
  contract.on("GameFinished", onFinished);
  contract.on("GameCancelled", onCancelled);
  console.log(`[chain] listening to ${config.contractAddress}`);

  return () => {
    contract.off("GameCreated", onCreated);
    contract.off("GameJoined", onJoined);
    contract.off("GameFinished", onFinished);
    contract.off("GameCancelled", onCancelled);
  };
}
