import { Contract, Interface, Network, WebSocketProvider, type AbstractProvider, type Log } from "ethers";
import { POOL_DAWGS_ABI, type Address } from "@pooldawgs/shared";
import type { ServerConfig } from "./config.js";
import type { Persistence } from "./db/persistence.js";
import type { LeaderboardStore } from "./leaderboard.js";
import type { LobbyStore } from "./lobby.js";
import { ChainEventMonitor, type ChainLog, type HandleResult, type LogSource } from "./chain-monitor.js";
import { ProviderHealth, pickProviderOrder, redactRpcUrl, rpcMetrics } from "./rpc.js";

/** Every contract event the server acts on — one log request covers them all. */
const EVENT_NAMES = [
  "GameCreated",
  "GameJoined",
  "GameFinished",
  "GameCancelled",
  "RewardClaimed",
  "GameExited",
  "DrawRewardClaimed",
  "OwnerWithdrawal",
] as const;

export interface ChainEventHandlers {
  lobby: LobbyStore;
  leaderboard: LeaderboardStore;
  /** Both seats are paid: make sure the game is being played (or resolved). */
  onGameJoined(gameId: string): void | Promise<void>;
  /** The chain recorded a winner (finishGame or a voucher claim). */
  onGameFinished(gameId: string, winner: Address, reward: string): Promise<void>;
  /** The winner was paid (RewardClaimed / OwnerWithdrawal). */
  onPaidOut(gameId: string): Promise<void>;
}

export interface ChainListener {
  stop(): void;
  backfill(reason: string): Promise<void>;
  status(): Record<string, unknown>;
}

const lower = (a: unknown) => String(a).toLowerCase() as Address;

/**
 * Mirrors PoolDawgs contract events into the server: lobby, leaderboard, results.
 *
 * Live events arrive over a WebSocket subscription (eth_subscribe) — nothing is
 * polled while nothing happens. Missed events are recovered by backfilling from
 * the saved cursor (startup, reconnect, a 30-min safety check), ≤500 blocks per
 * request, never re-scanning processed blocks. Each event is recorded in a ledger
 * keyed by chain + contract + tx hash + log index, so one seen live and again in
 * a backfill is handled once.
 */
export function startChainListener(
  config: ServerConfig,
  persist: Persistence,
  provider: AbstractProvider,
  handlers: ChainEventHandlers
): ChainListener {
  if (!config.chainEnabled) {
    console.log("[chain] disabled — running in chain-less dev mode");
    return { stop() {}, async backfill() {}, status: () => ({ mode: "disabled" }) };
  }

  const address = config.contractAddress!;
  const iface = new Interface(POOL_DAWGS_ABI);
  const topics = EVENT_NAMES.map((n) => iface.getEvent(n)!.topicHash);
  const contract = new Contract(address, POOL_DAWGS_ABI, provider);
  const { lobby, leaderboard } = handlers;

  const toChainLog = (log: Log): ChainLog | null => {
    let parsed;
    try {
      parsed = iface.parseLog({ topics: [...log.topics], data: log.data });
    } catch {
      return null;
    }
    if (!parsed) return null;
    return {
      eventName: parsed.name,
      args: parsed.args.toObject(),
      transactionHash: log.transactionHash,
      logIndex: log.index,
      blockNumber: BigInt(log.blockNumber),
      blockHash: log.blockHash,
      removed: log.removed,
    };
  };

  let statsTimer: ReturnType<typeof setTimeout> | null = null;
  const refreshStats = () => {
    if (statsTimer) return;
    statsTimer = setTimeout(async () => {
      statsTimer = null;
      try {
        const [games, wagered, burned] = await contract.platformStats();
        leaderboard.setChainStats({ games: Number(games), totalWagered: wagered.toString(), totalBurned: burned.toString() });
      } catch {
        // Older contract without platformStats(): keep the derived figures.
      }
    }, 2_000);
  };

  async function handle(log: ChainLog, _source: LogSource): Promise<HandleResult> {
    const a = log.args as Record<string, unknown>;
    const gameId = String(a.gameId);
    switch (log.eventName) {
      case "GameCreated":
        lobby.upsertCreated(gameId, lower(a.playerOne), String(a.stake), Date.now());
        break;
      case "GameJoined":
        lobby.markJoined(gameId, lower(a.playerTwo));
        await handlers.onGameJoined(gameId);
        break;
      case "GameFinished":
        lobby.markStatus(gameId, "finished");
        await handlers.onGameFinished(gameId, lower(a.winner), String(a.reward));
        refreshStats();
        break;
      case "RewardClaimed":
      case "OwnerWithdrawal":
        await handlers.onPaidOut(gameId);
        break;
      case "GameCancelled":
        lobby.markStatus(gameId, "cancelled");
        break;
      case "GameExited":
        lobby.markStatus(gameId, "finished");
        refreshStats();
        break;
      default:
        break; // DrawRewardClaimed: nothing to update (pool has no draws in practice)
    }
    return "done";
  }

  // ── live subscription over WebSocket ──
  const wsUrls = config.wsUrls ?? [];
  const wsHealth = wsUrls.map((u) => new ProviderHealth(redactRpcUrl(u)));
  let wsLabel: string | null = null;

  const subscribe = wsUrls.length
    ? async (onLogs: (logs: ChainLog[]) => void, onError: (e: unknown) => void): Promise<() => void> => {
        let lastError: unknown = new Error("no WebSocket endpoint available");
        for (const i of pickProviderOrder(wsHealth, Date.now())) {
          const url = wsUrls[i];
          const network = config.chainId ? Network.from(config.chainId) : undefined;
          const ws = new WebSocketProvider(url, network, network ? { staticNetwork: network } : {});
          let closed = false;
          let keepAlive: ReturnType<typeof setInterval> | null = null;
          const socket = ws.websocket as unknown as {
            onclose: ((e: unknown) => void) | null;
            onerror: ((e: unknown) => void) | null;
            ping?: () => void;
            terminate?: () => void;
            on?: (event: string, fn: () => void) => void;
          };
          const close = () => {
            if (keepAlive) clearInterval(keepAlive);
            if (closed) return;
            closed = true;
            void ws.destroy();
          };
          const fail = (e: unknown) => {
            if (closed) return;
            close();
            onError(e);
          };
          socket.onerror = (e) => fail(e instanceof Error ? e : new Error("websocket error"));
          socket.onclose = () => fail(new Error("websocket closed"));
          try {
            await Promise.race([
              ws._waitUntilReady(),
              new Promise((_, reject) => setTimeout(() => reject(new Error("websocket connect timeout")), 15_000)),
            ]);
            await ws.on({ address, topics: [topics] }, (log: Log) => {
              rpcMetrics.subscriptionNotifications++;
              const parsed = toChainLog(log);
              if (parsed) onLogs([parsed]);
            });
          } catch (error) {
            close();
            wsHealth[i].recordFailure("provider", Date.now(), error instanceof Error ? error.message : String(error));
            lastError = error;
            console.warn(`[chain] could not subscribe via ${wsHealth[i].label}:`, error instanceof Error ? error.message : error);
            continue;
          }
          // Keep-alive ping (a WebSocket ping frame, not an RPC call — costs nothing).
          if (socket.ping) {
            let alive = true;
            socket.on?.("pong", () => (alive = true));
            keepAlive = setInterval(() => {
              if (!alive) {
                socket.terminate?.();
                fail(new Error("websocket keep-alive timed out"));
                return;
              }
              alive = false;
              try {
                socket.ping!();
              } catch (e) {
                fail(e);
              }
            }, 30_000);
          }
          wsHealth[i].recordSuccess();
          wsLabel = wsHealth[i].label;
          console.log(`[chain] subscribed to contract events via ${wsLabel}`);
          return close;
        }
        throw lastError;
      }
    : undefined;

  const monitor = new ChainEventMonitor({
    chainId: config.chainId ?? 0,
    contractAddress: address,
    getBlockNumber: async () => BigInt(await provider.getBlockNumber()),
    getBlockHash: async (n) => (await provider.getBlock(Number(n)))?.hash ?? null,
    getLogs: async (from, to) => {
      const logs = await provider.getLogs({ address, topics: [topics], fromBlock: Number(from), toBlock: Number(to) });
      return logs.map(toChainLog).filter((l): l is ChainLog => l !== null);
    },
    subscribe,
    cursor: {
      load: async () => {
        const c = await persist.loadCursorState();
        return c ? { block: BigInt(c.block), hash: c.hash || null } : null;
      },
      save: (block, hash) => persist.saveCursor(Number(block), hash),
    },
    ledger: {
      has: (key) => persist.hasEvent(key),
      record: (key, log) => persist.recordEvent(key, Number(log.blockNumber), log.eventName, String(log.args.gameId ?? "") || null),
    },
    handle,
    // Live events arrive immediately; catch-up reads stay 2 blocks behind the tip so a
    // block that is about to be replaced is not taken as final.
    graceBlocks: BigInt(2),
    maxBlocksPerRequest: BigInt(config.backfillMaxBlocks ?? 500),
    bootLookbackBlocks: BigInt(800),
  });

  let stopped = false;
  const safetyMs = subscribe ? config.reconcileIntervalMs ?? 30 * 60_000 : config.fallbackPollMs ?? 30_000;
  const safety = setInterval(() => {
    monitor.backfill("safety check").catch((e) => console.warn("[chain] safety check failed (will retry):", e?.message ?? e));
  }, safetyMs);

  void (async () => {
    // First start: begin at the contract's deploy block so the whole history is read once.
    if (!(await persist.loadCursorState()) && (config.contractDeployBlock ?? 0) > 0) {
      await persist.saveCursor(config.contractDeployBlock! - 1, null);
    }
    if (stopped) return;
    refreshStats();
    await monitor.start();
    if (!subscribe) {
      console.warn(
        `[chain] no WebSocket RPC endpoint (RPC_URL_ALCHEMY / RPC_WSS_URL_*) — events are read every ${Math.round(safetyMs / 1000)}s instead of live — set RPC_WSS_URL (e.g. wss://ethereum-sepolia-rpc.publicnode.com)`
      );
    }
  })().catch((e) => console.error("[chain] startup failed (the safety check will retry):", e?.message ?? e));

  return {
    stop() {
      stopped = true;
      clearInterval(safety);
      if (statsTimer) clearTimeout(statsTimer);
      monitor.stop();
    },
    backfill: (reason) => monitor.backfill(reason),
    status: () => ({ ...monitor.status, websocket: wsLabel }),
  };
}
