import { Contract, EventLog, JsonRpcProvider } from "ethers";
import { POOL_DAWGS_ABI, type Address } from "@pooldawgs/shared";
import type { ServerConfig } from "./config.js";
import type { LeaderboardStore } from "./leaderboard.js";
import type { LobbyStore } from "./lobby.js";

const POLL_MS = 5000;
/** Blocks to backfill on first poll (~3h on Sepolia) so recent games show. */
const BACKFILL_BLOCKS = 800;
/** Max block span per getLogs call (public RPCs cap the range). */
const MAX_SPAN = 800;

/**
 * Mirrors PoolDawgs contract events into the lobby for the browse list.
 *
 * Uses periodic `getLogs` (queryFilter) over block ranges rather than
 * `contract.on(...)`: public RPCs expire the stateful log filters that
 * event subscriptions rely on ("filter not found"), whereas getLogs is
 * stateless and reliable. Seat resolution does NOT depend on this — it reads
 * the contract directly (see chain.ts) — so a lagging poll never blocks play.
 */
export function startChainListener(
  config: ServerConfig,
  lobby: LobbyStore,
  leaderboard: LeaderboardStore
): () => void {
  if (!config.chainEnabled) {
    console.log("[chain] disabled — running in chain-less dev mode");
    return () => {};
  }

  const provider = new JsonRpcProvider(config.rpcUrl!, undefined, { staticNetwork: true });
  const contract = new Contract(config.contractAddress!, POOL_DAWGS_ABI, provider);

  let next = -1; // next block to scan from
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const argsOf = <T>(ev: unknown): T => (ev as EventLog).args as unknown as T;

  async function scan(from: number, to: number): Promise<void> {
    for (const ev of await contract.queryFilter(contract.filters.GameCreated(), from, to)) {
      const a = argsOf<{ gameId: string; playerOne: string; stake: bigint }>(ev);
      lobby.upsertCreated(a.gameId, a.playerOne.toLowerCase() as Address, a.stake.toString(), Date.now());
    }
    for (const ev of await contract.queryFilter(contract.filters.GameJoined(), from, to)) {
      const a = argsOf<{ gameId: string; playerTwo: string }>(ev);
      lobby.markJoined(a.gameId, a.playerTwo.toLowerCase() as Address);
    }
    for (const ev of await contract.queryFilter(contract.filters.GameFinished(), from, to)) {
      const a = argsOf<{ gameId: string; winner: string; reward: bigint }>(ev);
      lobby.markStatus(a.gameId, "finished");
      // Feed the unclaimed-rewards list (idempotent by gameId). The client
      // cross-checks each game's on-chain rewardClaimed flag before showing it.
      leaderboard.recordWonGame(a.winner.toLowerCase() as Address, a.gameId, a.reward.toString());
    }
    for (const ev of await contract.queryFilter(contract.filters.GameCancelled(), from, to)) {
      lobby.markStatus(argsOf<{ gameId: string }>(ev).gameId, "cancelled");
    }
  }

  async function poll(): Promise<void> {
    if (stopped) return;
    try {
      const head = await provider.getBlockNumber();
      if (next < 0) next = Math.max(0, head - BACKFILL_BLOCKS);
      while (next <= head) {
        const to = Math.min(next + MAX_SPAN - 1, head);
        await scan(next, to);
        next = to + 1;
      }
    } catch (e) {
      console.error("[chain] poll error:", e instanceof Error ? e.message : e);
    }
    if (!stopped) timer = setTimeout(poll, POLL_MS);
  }

  void poll();
  console.log(`[chain] polling ${config.contractAddress} every ${POLL_MS / 1000}s`);

  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
