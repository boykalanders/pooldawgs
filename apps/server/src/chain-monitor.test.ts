// Tests for the event-driven chain monitor (chain-monitor.ts) and the RPC circuit breaker
// (rpc.ts), against the acceptance criteria:
//   - no continuous log scans while idle; no block scanned twice
//   - ≤500 blocks per backfill request, starting from the persisted cursor
//   - duplicate events (live + backfill) processed once
//   - a failed or deferred event is retried, never lost
//   - a dropped subscription backfills the gap before resubscribing
//   - a failing provider is not hammered
//
// Run:  pnpm --filter @pooldawgs/server test

import { test } from "vitest";
import assert from "node:assert/strict";
import { ChainEventMonitor, planBackfillRanges, eventKey, type ChainLog, type MonitorDeps } from "./chain-monitor.js";
import { ProviderHealth, pickProviderOrder, classifyRpcError, resolveWsUrls, CIRCUIT_COOLDOWNS_MS } from "./rpc.js";

const CONTRACT = "0x59a04c1078ecFc8B9f2417FE93084c98b97046Cd";
const b = (n: number) => BigInt(n);

function log(
  block: number,
  index: number,
  eventName = "GameCreated",
  tx = `0x${block.toString(16).padStart(64, "0")}`
): ChainLog {
  return { eventName, args: { gameId: `game_${block}` }, transactionHash: tx, logIndex: index, blockNumber: b(block) };
}

/** An in-memory chain + database, recording every RPC-like call. */
function harness(opts: { tip: number; logs?: ChainLog[]; savedCursor?: number | null; withSubscription?: boolean }) {
  const calls: { getLogs: Array<[bigint, bigint]>; getBlockNumber: number } = { getLogs: [], getBlockNumber: 0 };
  const chainLogs = [...(opts.logs ?? [])];
  let tip = opts.tip;
  let cursor: { block: bigint; hash: string | null } | null =
    opts.savedCursor === undefined || opts.savedCursor === null ? null : { block: b(opts.savedCursor), hash: null };
  const ledger = new Set<string>();
  const handled: string[] = [];
  let failNext = 0;
  let deferNext = 0;
  let subscription: { onLogs: (l: ChainLog[]) => void; onError: (e: unknown) => void } | null = null;
  let subscribeCount = 0;

  const deps: MonitorDeps = {
    chainId: 1,
    contractAddress: CONTRACT,
    getBlockNumber: async () => {
      calls.getBlockNumber++;
      return b(tip);
    },
    getBlockHash: async (n) => `0xhash${n}`,
    getLogs: async (from, to) => {
      calls.getLogs.push([from, to]);
      return chainLogs.filter((l) => l.blockNumber >= from && l.blockNumber <= to);
    },
    subscribe: opts.withSubscription
      ? async (onLogs, onError) => {
          subscribeCount++;
          subscription = { onLogs, onError };
          return () => {
            subscription = null;
          };
        }
      : undefined,
    cursor: {
      load: async () => cursor,
      save: async (block, hash) => {
        cursor = { block, hash };
      },
    },
    ledger: {
      has: async (key) => ledger.has(key),
      record: async (key) => {
        if (ledger.has(key)) return false;
        ledger.add(key);
        return true;
      },
    },
    handle: async (l) => {
      if (failNext > 0) {
        failNext--;
        throw new Error("db down");
      }
      if (deferNext > 0) {
        deferNext--;
        return "deferred";
      }
      handled.push(`${l.eventName}@${l.blockNumber}`);
      return "done";
    },
    graceBlocks: b(10),
    maxBlocksPerRequest: b(500),
    bootLookbackBlocks: b(5000),
    resubscribeDelaysMs: [5],
    log: { log() {}, warn() {}, error() {} },
  };
  return {
    deps,
    calls,
    handled,
    ledger,
    get cursor() {
      return cursor;
    },
    setTip: (n: number) => {
      tip = n;
    },
    addLog: (l: ChainLog) => chainLogs.push(l),
    failNext: (n: number) => {
      failNext = n;
    },
    deferNext: (n: number) => {
      deferNext = n;
    },
    emit: (logs: ChainLog[]) => subscription!.onLogs(logs),
    drop: (err: unknown) => subscription!.onError(err),
    get subscribeCount() {
      return subscribeCount;
    },
  };
}

// ---- ranges --------------------------------------------------------------------------------------

test("backfill ranges never exceed 500 blocks and cover the gap exactly", () => {
  assert.deepEqual(planBackfillRanges(b(1), b(1500), b(500)), [
    [b(1), b(500)],
    [b(501), b(1000)],
    [b(1001), b(1500)],
  ]);
  assert.deepEqual(planBackfillRanges(b(10), b(12), b(500)), [[b(10), b(12)]]);
  assert.deepEqual(planBackfillRanges(b(13), b(12), b(500)), []);
});

// ---- startup / cursor --------------------------------------------------------------------------

test("startup resumes from the saved cursor and only reads the gap, ≤500 blocks per request", async () => {
  const h = harness({ tip: 11_510, savedCursor: 10_000, logs: [log(10_050, 0), log(11_400, 3)] });
  const monitor = new ChainEventMonitor(h.deps);
  await monitor.start();

  // Safe tip = 11,510 − 10 grace = 11,500 → gap 10,001–11,500 = 1,500 blocks = 3 requests.
  assert.deepEqual(h.calls.getLogs, [
    [b(10_001), b(10_500)],
    [b(10_501), b(11_000)],
    [b(11_001), b(11_500)],
  ]);
  assert.deepEqual(h.handled, ["GameCreated@10050", "GameCreated@11400"]);
  assert.equal(h.cursor?.block, b(11_500), "cursor advanced to the end of the backfill");
});

test("a second backfill never re-scans blocks already processed", async () => {
  const h = harness({ tip: 1_010, savedCursor: 500 });
  const monitor = new ChainEventMonitor(h.deps);
  await monitor.backfill("first");
  h.setTip(1_020);
  await monitor.backfill("second");
  assert.deepEqual(h.calls.getLogs, [
    [b(501), b(1_000)],
    [b(1_001), b(1_010)],
  ]);
});

test("with nothing new on chain, a backfill makes no log request at all", async () => {
  const h = harness({ tip: 1_010, savedCursor: 1_000 });
  await new ChainEventMonitor(h.deps).backfill("idle check");
  assert.equal(h.calls.getLogs.length, 0);
});

// ---- live operation ------------------------------------------------------------------------------

test("while subscribed and idle, nothing polls the chain", async () => {
  const h = harness({ tip: 1_010, savedCursor: 1_000, withSubscription: true });
  const monitor = new ChainEventMonitor(h.deps);
  await monitor.start();
  const before = { logs: h.calls.getLogs.length, blocks: h.calls.getBlockNumber };
  await new Promise((r) => setTimeout(r, 50)); // time passes, no events
  assert.equal(h.calls.getLogs.length, before.logs, "no getLogs while idle");
  assert.equal(h.calls.getBlockNumber, before.blocks, "no block-number polling while idle");
  assert.equal(monitor.status.mode, "subscription");
  monitor.stop();
});

test("the same event from the subscription and from a backfill is processed once", async () => {
  const h = harness({ tip: 1_010, savedCursor: 990, withSubscription: true });
  const monitor = new ChainEventMonitor(h.deps);
  await monitor.start();

  const event = log(1_005, 2, "GameFinished");
  h.addLog(event);
  h.emit([event]);
  await new Promise((r) => setTimeout(r, 10));
  h.setTip(1_030);
  await monitor.backfill("safety check"); // re-reads block 1,005 from the cursor

  assert.deepEqual(h.handled, ["GameFinished@1005"], "handled exactly once");
  assert.equal(monitor.status.duplicatesSkipped, 1);
  monitor.stop();
});

test("a reorged-out log is ignored", async () => {
  const h = harness({ tip: 1_010, savedCursor: 1_000, withSubscription: true });
  const monitor = new ChainEventMonitor(h.deps);
  await monitor.start();
  h.emit([{ ...log(1_009, 0), removed: true }]);
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(h.handled.length, 0);
  monitor.stop();
});

// ---- failures are retried, never lost --------------------------------------------------------

test("an event whose processing fails is not recorded, and the next backfill retries it", async () => {
  const h = harness({ tip: 1_020, savedCursor: 1_000, logs: [log(1_005, 0)] });
  const monitor = new ChainEventMonitor(h.deps);
  h.failNext(1);
  await monitor.backfill("first"); // processing fails (e.g. DB down)
  assert.equal(h.ledger.size, 0, "not recorded as processed");

  // Failed events keep their place: the safety check re-reads that range.
  const cursorAfterFailure = h.cursor!.block;
  assert.ok(cursorAfterFailure >= b(1_005));
  await monitor.processLog(log(1_005, 0), "backfill");
  assert.deepEqual(h.handled, ["GameCreated@1005"]);
  assert.equal(h.ledger.size, 1);
});

test("a deferred event (GameCreated inside its grace period) is not recorded until finished", async () => {
  const h = harness({ tip: 1_020, savedCursor: 1_010, withSubscription: true });
  const monitor = new ChainEventMonitor(h.deps);
  await monitor.start();
  h.deferNext(1);
  const created = log(1_015, 0);
  await monitor.processLog(created, "subscription");
  assert.equal(h.ledger.size, 0, "deferred → not recorded");
  await monitor.processLog(created, "backfill");
  assert.equal(h.ledger.size, 1);
  monitor.stop();
});

test("if the startup catch-up fails, the live subscription still starts and the next pass catches up", async () => {
  const h = harness({ tip: 1_030, savedCursor: 1_000, withSubscription: true, logs: [log(1_005, 0)] });
  const realGetBlockNumber = h.deps.getBlockNumber;
  let rpcDown = true;
  h.deps.getBlockNumber = async () => {
    if (rpcDown) throw new Error("HTTP 503");
    return realGetBlockNumber();
  };
  const monitor = new ChainEventMonitor(h.deps);
  await monitor.start();
  assert.equal(h.subscribeCount, 1, "subscribed despite the failed catch-up");
  assert.equal(monitor.status.mode, "subscription");

  rpcDown = false;
  await monitor.backfill("safety check");
  assert.deepEqual(h.handled, ["GameCreated@1005"], "the missed event is recovered from the cursor");
  monitor.stop();
});

test("a dropped subscription backfills the gap before listening again", async () => {
  const h = harness({ tip: 1_010, savedCursor: 1_000, withSubscription: true });
  const monitor = new ChainEventMonitor(h.deps);
  await monitor.start();
  assert.equal(h.subscribeCount, 1);

  // While disconnected, a refund happens.
  h.addLog(log(1_003, 1, "OwnerWithdrawal"));
  h.setTip(1_200);
  h.drop(new Error("socket closed"));
  await new Promise((r) => setTimeout(r, 40));

  assert.equal(h.subscribeCount, 2, "resubscribed");
  assert.ok(h.handled.includes("OwnerWithdrawal@1003"), "the missed event was backfilled");
  assert.equal(monitor.status.resubscribes, 1);
  monitor.stop();
});

test("the event key is chain + contract + transaction + log index, case-insensitive", () => {
  const k1 = eventKey(1, CONTRACT, { transactionHash: "0xABC", logIndex: 3 });
  const k2 = eventKey(1, CONTRACT.toLowerCase(), { transactionHash: "0xabc", logIndex: 3 });
  assert.equal(k1, k2);
  assert.notEqual(k1, eventKey(1, CONTRACT, { transactionHash: "0xabc", logIndex: 4 }));
});

// ---- provider failover -------------------------------------------------------------------------

test("a provider is marked unhealthy after two failures, or at once on a rate limit", () => {
  const h = new ProviderHealth("alchemy");
  assert.equal(h.recordFailure("timeout", 0), false, "one timeout: still trusted");
  assert.equal(h.recordFailure("timeout", 0), true, "second in a row: circuit opens");
  assert.equal(h.isAvailable(CIRCUIT_COOLDOWNS_MS[0] - 1), false);
  assert.equal(h.isAvailable(CIRCUIT_COOLDOWNS_MS[0]), true);

  const r = new ProviderHealth("alchemy");
  assert.equal(r.recordFailure("rate-limited", 0), true);
});

test("repeat failures lengthen the cooldown; a success resets it", () => {
  const h = new ProviderHealth("alchemy", 1);
  h.recordFailure("provider", 0);
  const first = h.openUntil;
  h.recordFailure("provider", first);
  assert.ok(h.openUntil - first > first, "second cooldown is longer");
  h.recordSuccess();
  assert.equal(h.isAvailable(0), true);
  assert.equal(h.level, 0);
});

test("requests go to healthy providers in priority order; a full outage still probes one", () => {
  const alchemy = new ProviderHealth("alchemy", 1);
  const infura = new ProviderHealth("infura", 1);
  assert.deepEqual(pickProviderOrder([alchemy, infura], 0), [0, 1], "Alchemy first");
  alchemy.recordFailure("provider", 0);
  assert.deepEqual(pickProviderOrder([alchemy, infura], 1), [1], "Alchemy skipped while cooling down");
  infura.recordFailure("provider", 10);
  assert.deepEqual(pickProviderOrder([alchemy, infura], 20), [0], "both down: probe the one that recovers first");
});

test("chain answers are not provider failures; network problems are", () => {
  // ethers error shapes
  assert.equal(
    classifyRpcError({ code: "CALL_EXCEPTION", message: 'execution reverted: "game completed"' }),
    "deterministic"
  );
  assert.equal(classifyRpcError({ error: { code: -32000, message: "nonce too low" } }), "deterministic");
  assert.equal(classifyRpcError({ code: "TIMEOUT", message: "request timeout" }), "timeout");
  assert.equal(classifyRpcError({ code: "SERVER_ERROR", status: 429, message: "bad response" }), "rate-limited");
  assert.equal(classifyRpcError({ error: { code: -32005, message: "daily request count exceeded" } }), "rate-limited");
  assert.equal(classifyRpcError({ code: "SERVER_ERROR", status: 503, message: "bad response" }), "provider");
  assert.equal(classifyRpcError({ message: "fetch failed" }), "provider");
});

test("WebSocket endpoints are derived from the Alchemy and Infura keys", () => {
  assert.deepEqual(
    resolveWsUrls({
      RPC_URL_ALCHEMY: "https://eth-mainnet.g.alchemy.com/v2/KEY",
      RPC_URL_INFURA: "https://mainnet.infura.io/v3/KEY2",
    } as any),
    ["wss://eth-mainnet.g.alchemy.com/v2/KEY", "wss://mainnet.infura.io/ws/v3/KEY2"]
  );
  assert.deepEqual(resolveWsUrls({ RPC_WSS_URL_ALCHEMY: "wss://custom/x" } as any), ["wss://custom/x"]);
  assert.deepEqual(
    resolveWsUrls({ RPC_URL: "https://ethereum-rpc.publicnode.com" } as any),
    [],
    "no guessing for others"
  );
});
