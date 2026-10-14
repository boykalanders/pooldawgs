/**
 * Event-driven chain monitoring with a persistent cursor and targeted backfill.
 *
 * Replaces log polling on a timer (four eth_getLogs every 5s — roughly 5–6M Alchemy CU a day, almost
 * all of it scanning blocks where nothing happened). Normal operation (ported from Chess Dawgs):
 *
 *   contract event → live subscription (eth_subscribe over WebSocket) → validate → process →
 *   record in the event ledger → update game state
 *
 * Recovery, only when something may have been missed — startup, a dropped subscription, a provider
 * failover, and a low-frequency safety check — reads from the saved cursor to the current safe block
 * in requests of at most `maxBlocksPerRequest` (500) blocks, then resumes the subscription. Blocks are
 * never re-scanned on a timer: every backfill starts where the last one ended.
 *
 * Processing is idempotent. Every log is identified by chain, contract, transaction hash and log
 * index; one that is already in the ledger (seen live, then again by a backfill) is skipped. The
 * handlers themselves are idempotent too, so even a log processed twice changes nothing twice.
 *
 * Everything chain- and database-specific is injected, which keeps this module testable.
 */

export type ChainLog = {
  eventName: string;
  args: Record<string, any>;
  transactionHash: string;
  logIndex: number;
  blockNumber: bigint;
  blockHash?: string;
  removed?: boolean;
};

export type LogSource = "subscription" | "backfill";

/** 'done' records the log in the ledger; 'deferred' leaves it for a later pass to finish. */
export type HandleResult = "done" | "deferred";

export type MonitorDeps = {
  chainId: number;
  contractAddress: string;
  getBlockNumber(): Promise<bigint>;
  getBlockHash(blockNumber: bigint): Promise<string | null>;
  getLogs(fromBlock: bigint, toBlock: bigint): Promise<ChainLog[]>;
  /** Live subscription; resolves to an unsubscribe function. Absent → no WebSocket configured. */
  subscribe?(onLogs: (logs: ChainLog[]) => void, onError: (error: unknown) => void): Promise<() => void>;
  cursor: {
    load(): Promise<{ block: bigint; hash: string | null } | null>;
    save(block: bigint, hash: string | null): Promise<void>;
  };
  ledger: {
    has(key: string): Promise<boolean>;
    /** Insert; must not throw on a duplicate key (return false instead). */
    record(key: string, log: ChainLog, source: LogSource): Promise<boolean>;
  };
  handle(log: ChainLog, source: LogSource): Promise<HandleResult>;
  graceBlocks: bigint;
  maxBlocksPerRequest: bigint;
  bootLookbackBlocks: bigint;
  /** Delays before re-subscribing after a subscription failure; grows per consecutive failure. */
  resubscribeDelaysMs?: number[];
  log?: Pick<Console, "log" | "warn" | "error">;
  onBackfill?(requests: number): void;
};

export function eventKey(
  chainId: number,
  contractAddress: string,
  log: Pick<ChainLog, "transactionHash" | "logIndex">
) {
  return `${chainId}:${contractAddress.toLowerCase()}:${log.transactionHash.toLowerCase()}:${log.logIndex}`;
}

/** Split [from, to] into inclusive ranges of at most `max` blocks. */
export function planBackfillRanges(from: bigint, to: bigint, max: bigint): Array<[bigint, bigint]> {
  if (max < BigInt(1)) throw new Error("max must be at least 1 block");
  const ranges: Array<[bigint, bigint]> = [];
  for (let start = from; start <= to; start += max) {
    const end = start + max - BigInt(1) > to ? to : start + max - BigInt(1);
    ranges.push([start, end]);
  }
  return ranges;
}

// A cursor saved this close to the tip could sit on a block that is later reorged away; on startup
// we verify its hash and, if it no longer matches, rewind this far before backfilling.
export const REORG_REWIND_BLOCKS = BigInt(64);

export type MonitorStatus = {
  mode: "subscription" | "backfill-only" | "starting" | "stopped";
  subscriptionConnected: boolean;
  lastProcessedBlock: string | null;
  lastEventAt: string | null;
  lastEventName: string | null;
  lastBackfillAt: string | null;
  lastError: string | null;
  backfills: number;
  backfillRequests: number;
  eventsProcessed: number;
  duplicatesSkipped: number;
  deferred: number;
  resubscribes: number;
};

export class ChainEventMonitor {
  private cursorBlock: bigint | null = null;
  private unsubscribe: (() => void) | null = null;
  private backfilling: Promise<void> | null = null;
  private inFlight = new Set<string>();
  private resubscribeFailures = 0;
  private resubscribeTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private readonly log: Pick<Console, "log" | "warn" | "error">;

  readonly status: MonitorStatus = {
    mode: "starting",
    subscriptionConnected: false,
    lastProcessedBlock: null,
    lastEventAt: null,
    lastEventName: null,
    lastBackfillAt: null,
    lastError: null,
    backfills: 0,
    backfillRequests: 0,
    eventsProcessed: 0,
    duplicatesSkipped: 0,
    deferred: 0,
    resubscribes: 0,
  };

  constructor(private readonly deps: MonitorDeps) {
    this.log = deps.log ?? console;
  }

  /** Restart recovery, then live operation: load cursor → backfill the gap → subscribe. */
  async start(): Promise<void> {
    this.stopped = false;
    try {
      await this.backfill("startup");
    } catch (error: any) {
      // Still subscribe: a failed catch-up must not leave the server without live events.
      // The next backfill (reconnect or safety check) resumes from the cursor.
      this.status.lastError = `startup backfill: ${error?.message || error}`;
      this.log.warn("[ChainEvents] startup backfill failed (will retry):", error?.message || error);
    }
    await this.subscribe();
  }

  stop() {
    this.stopped = true;
    this.status.mode = "stopped";
    if (this.resubscribeTimer) clearTimeout(this.resubscribeTimer);
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.status.subscriptionConnected = false;
  }

  /**
   * Process everything from the saved cursor up to the current safe block (tip − grace), at most
   * `maxBlocksPerRequest` blocks per request, advancing the cursor after each range. Concurrent calls
   * share one run.
   */
  backfill(reason: string): Promise<void> {
    if (!this.backfilling) {
      this.backfilling = this.runBackfill(reason).finally(() => {
        this.backfilling = null;
      });
    }
    return this.backfilling;
  }

  private async runBackfill(reason: string) {
    const d = this.deps;
    const tip = await d.getBlockNumber();
    const safeTip = tip > d.graceBlocks ? tip - d.graceBlocks : BigInt(0);

    if (this.cursorBlock === null) {
      const saved = await d.cursor.load();
      if (saved) {
        this.cursorBlock = saved.block;
        if (saved.hash) {
          const current = await d.getBlockHash(saved.block);
          if (current && current.toLowerCase() !== saved.hash.toLowerCase()) {
            this.log.warn(
              `[ChainEvents] cursor block ${saved.block} was reorged; rewinding ${REORG_REWIND_BLOCKS} blocks`
            );
            this.cursorBlock = saved.block > REORG_REWIND_BLOCKS ? saved.block - REORG_REWIND_BLOCKS : BigInt(0);
          }
        }
      } else {
        this.cursorBlock = safeTip > d.bootLookbackBlocks ? safeTip - d.bootLookbackBlocks : BigInt(0);
        this.log.log(
          `[ChainEvents] no saved cursor; starting ${d.bootLookbackBlocks} blocks back (block ${this.cursorBlock})`
        );
      }
    }

    const from = this.cursorBlock + BigInt(1);
    if (from > safeTip) return;

    const ranges = planBackfillRanges(from, safeTip, d.maxBlocksPerRequest);
    this.status.backfills++;
    this.log.log(`[ChainEvents] backfill (${reason}): blocks ${from}–${safeTip} in ${ranges.length} request(s)`);
    for (const [start, end] of ranges) {
      const logs = await d.getLogs(start, end);
      this.status.backfillRequests++;
      d.onBackfill?.(1);
      const ordered = [...logs].sort((a, b) =>
        a.blockNumber === b.blockNumber ? a.logIndex - b.logIndex : a.blockNumber < b.blockNumber ? -1 : 1
      );
      for (const log of ordered) {
        await this.processLog(log, "backfill");
      }
      // The cursor only moves once every log in the range is processed (or deferred to a later pass).
      const hash = end === safeTip ? await d.getBlockHash(end) : null;
      await d.cursor.save(end, hash);
      this.cursorBlock = end;
      this.status.lastProcessedBlock = end.toString();
    }
    this.status.lastBackfillAt = new Date().toISOString();
  }

  /** Validate, de-duplicate and handle one log. Never throws. */
  async processLog(log: ChainLog, source: LogSource): Promise<void> {
    if (log.removed) return; // reorged out
    const key = eventKey(this.deps.chainId, this.deps.contractAddress, log);
    if (this.inFlight.has(key)) return;
    this.inFlight.add(key);
    try {
      if (await this.deps.ledger.has(key)) {
        this.status.duplicatesSkipped++;
        return;
      }
      const result = await this.deps.handle(log, source);
      if (result === "deferred") {
        this.status.deferred++;
        return;
      }
      const recorded = await this.deps.ledger.record(key, log, source);
      if (recorded) {
        this.status.eventsProcessed++;
        this.status.lastEventAt = new Date().toISOString();
        this.status.lastEventName = log.eventName;
      } else {
        this.status.duplicatesSkipped++;
      }
    } catch (error: any) {
      // Not recorded, so the next backfill over this block retries it.
      this.status.lastError = `${log.eventName} ${log.transactionHash}: ${error?.message || error}`;
      this.log.error(`[ChainEvents] failed to process ${log.eventName} in ${log.transactionHash}:`, error);
    } finally {
      this.inFlight.delete(key);
    }
  }

  private async subscribe() {
    const d = this.deps;
    if (this.stopped) return;
    if (!d.subscribe) {
      this.status.mode = "backfill-only";
      return;
    }
    try {
      this.unsubscribe = await d.subscribe(
        (logs) => {
          for (const log of logs) void this.processLog(log, "subscription");
        },
        (error) => this.onSubscriptionError(error)
      );
      this.status.mode = "subscription";
      this.status.subscriptionConnected = true;
      this.resubscribeFailures = 0;
    } catch (error) {
      this.onSubscriptionError(error);
    }
  }

  private onSubscriptionError(error: unknown) {
    this.status.subscriptionConnected = false;
    this.status.lastError = `subscription: ${(error as any)?.message || error}`;
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.stopped || this.resubscribeTimer) return;

    const delays = this.deps.resubscribeDelaysMs ?? [5_000, 30_000, 60_000, 300_000, 900_000];
    const delay = delays[Math.min(this.resubscribeFailures, delays.length - 1)];
    this.resubscribeFailures++;
    this.log.warn(`[ChainEvents] subscription lost (${this.status.lastError}); reconnecting in ${delay / 1000}s`);
    this.resubscribeTimer = setTimeout(async () => {
      this.resubscribeTimer = null;
      this.status.resubscribes++;
      // Catch up on whatever happened while disconnected, then listen again.
      try {
        await this.backfill("reconnect");
      } catch (backfillError: any) {
        this.log.warn(
          "[ChainEvents] backfill after disconnect failed (will retry):",
          backfillError?.message || backfillError
        );
      }
      await this.subscribe();
    }, delay);
  }
}
