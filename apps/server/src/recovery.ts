import { formatEther } from "ethers";
import type { Address } from "@pooldawgs/shared";
import type { ChainReader } from "./chain.js";
import type { ServerConfig } from "./config.js";
import type { LobbyStore } from "./lobby.js";
import type { Relayer } from "./relayer.js";
import type { ResultStore } from "./results.js";
import type { GameRoom } from "./room.js";

/**
 * Background recovery — so no pot can sit forever:
 *
 *  - Paid, never played: both stakes are in but nobody opened the table (or the
 *    server missed the join). The table is opened and the shot clock started,
 *    so the game resolves by the normal rules.
 *  - Won, never claimed: the winner's voucher works only while the game is open
 *    on-chain, and the owner's ownerWithdrawUnpaid only once it is completed. A
 *    win unclaimed for SETTLE_UNCLAIMED_AFTER_MS (24h) is recorded on-chain with
 *    one finishGame, after which the winner claims with plain claimReward.
 *    Transaction-aware: a finishGame still pending is never sent again, and a
 *    receipt timeout is not treated as a failure.
 *  - A daily stuck-funds report to Telegram when anything needs a human.
 */
export interface RecoveryDeps {
  config: ServerConfig;
  relayer: Relayer;
  chainReader: ChainReader;
  results: ResultStore;
  lobby: LobbyStore;
  rooms: Map<string, GameRoom>;
  ensureLive(gameId: string): Promise<void>;
  /** Override for tests. */
  sendTelegram?(text: string): Promise<void>;
}

export interface Recovery {
  stop(): void;
  status(): Record<string, unknown>;
  /** One pass of each sweep (used by the timers and by tests). */
  sweepUnplayed(): Promise<void>;
  sweepUnclaimed(now?: number): Promise<void>;
  buildReport(now?: number): Promise<string | null>;
}

const MAX_FINISHES_PER_SWEEP = 10;
const LOW_RELAYER_BALANCE_WEI = 5_000_000_000_000_000n; // 0.005 ETH

export function startRecovery(deps: RecoveryDeps, opts: { timers?: boolean } = {}): Recovery {
  const { config, relayer, chainReader, results, lobby, rooms } = deps;
  const settleAfter = config.settleUnclaimedAfterMs ?? 24 * 3_600_000;
  const hasKey = Boolean(config.operatorPrivateKey || config.ownerPrivateKey);
  const finishErrors = new Map<string, string>();
  const state = { lastUnplayedSweep: null as string | null, lastUnclaimedSweep: null as string | null, lastReport: null as string | null };

  async function sweepUnplayed(): Promise<void> {
    state.lastUnplayedSweep = new Date().toISOString();
    for (const g of lobby.all()) {
      if (g.status !== "active" || rooms.has(g.gameId) || results.get(g.gameId)) continue;
      try {
        await deps.ensureLive(g.gameId);
      } catch (e) {
        console.warn(`[recovery] ${g.gameId}: could not open the table:`, e instanceof Error ? e.message : e);
      }
    }
  }

  async function sweepUnclaimed(now = Date.now()): Promise<void> {
    state.lastUnclaimedSweep = new Date(now).toISOString();
    let sent = 0;
    for (const r of results.all()) {
      if (r.onchain !== "pending" || now - r.decidedAt < settleAfter) continue;
      let game;
      try {
        game = await chainReader.getGame(r.gameId);
      } catch {
        continue; // chain unreachable — next sweep
      }
      if (!game) continue;
      if (game.isCompleted) {
        await results.markOnchain(r.gameId, game.rewardClaimed ? "claimed" : "finished");
        finishErrors.delete(r.gameId);
        continue;
      }
      if (r.finishTx) {
        let status;
        try {
          status = await relayer.txStatus(r.finishTx);
        } catch {
          continue;
        }
        if (status === "pending") continue; // never send a second one while the first may still mine
        if (status === "succeeded") {
          await results.markOnchain(r.gameId, "finished");
          continue;
        }
        // failed or dropped: send a new one below
      }
      if (!hasKey || sent >= MAX_FINISHES_PER_SWEEP) continue;
      try {
        const hash = await relayer.finishGame(r.gameId, r.winner as Address);
        if (hash) {
          await results.setFinishTx(r.gameId, hash);
          finishErrors.delete(r.gameId);
          sent++;
        }
      } catch (e) {
        const message = e instanceof Error ? e.message.split("\n")[0] : String(e);
        finishErrors.set(r.gameId, message);
        console.error(`[recovery] ${r.gameId}: backstop finishGame failed: ${message}`);
      }
    }
  }

  async function buildReport(now = Date.now()): Promise<string | null> {
    const lines: string[] = [];
    const unplayed = lobby
      .all()
      .filter((g) => g.status === "active" && !rooms.has(g.gameId) && !results.get(g.gameId));
    if (unplayed.length) {
      lines.push(`• ${unplayed.length} paid game(s) with no table yet (being opened): ${unplayed.slice(0, 10).map((g) => g.gameId).join(", ")}`);
    }
    const unclaimed = results.all().filter((r) => r.onchain === "pending" && now - r.decidedAt >= settleAfter);
    const inFlight = unclaimed.filter((r) => r.finishTx);
    if (unclaimed.length) {
      lines.push(`• ${unclaimed.length} win(s) unclaimed for over ${Math.round(settleAfter / 3_600_000)}h (${inFlight.length} being recorded on-chain)`);
      if (!hasKey) lines.push("  ⚠ no OPERATOR_PRIVATE_KEY / OWNER_PRIVATE_KEY set — they can't be recorded on-chain automatically");
    }
    for (const [gameId, error] of [...finishErrors.entries()].slice(0, 10)) {
      lines.push(`• ${gameId}: finishGame failed — ${error}`);
    }
    if (hasKey) {
      try {
        const wei = await relayer.balance();
        if (wei !== null && wei < LOW_RELAYER_BALANCE_WEI) {
          lines.push(`• ⚠ relayer wallet low on gas: ${formatEther(wei)} ETH`);
        }
      } catch {
        /* balance unavailable — not worth a line */
      }
    }
    if (!lines.length) return null;
    return ["🎱 Pool Dawgs — stuck funds report", ...lines].join("\n");
  }

  async function sendTelegram(text: string): Promise<void> {
    if (deps.sendTelegram) return deps.sendTelegram(text);
    const token = config.telegramBotToken;
    const chatId = config.alertTelegramChatId;
    if (!token || !chatId) return;
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: text.slice(0, 4000), disable_web_page_preview: true }),
    });
    if (!res.ok) console.warn(`[recovery] Telegram report failed: HTTP ${res.status} ${await res.text().catch(() => "")}`);
  }

  async function report(): Promise<void> {
    state.lastReport = new Date().toISOString();
    const text = await buildReport();
    if (!text) {
      console.log("[recovery] stuck-funds report: nothing stuck");
      return;
    }
    console.warn(text);
    await sendTelegram(text);
  }

  const timers: Array<ReturnType<typeof setInterval> | ReturnType<typeof setTimeout>> = [];
  if (opts.timers !== false) {
    const safe = (name: string, fn: () => Promise<void>) => () => {
      fn().catch((e) => console.error(`[recovery] ${name} failed:`, e instanceof Error ? e.message : e));
    };
    timers.push(setTimeout(safe("unplayed sweep", sweepUnplayed), 60_000));
    timers.push(setInterval(safe("unplayed sweep", sweepUnplayed), 5 * 60_000));
    timers.push(setInterval(safe("unclaimed sweep", () => sweepUnclaimed()), 30 * 60_000));
    timers.push(setTimeout(safe("report", report), 5 * 60_000));
    timers.push(setInterval(safe("report", report), config.stuckReportIntervalMs ?? 24 * 3_600_000));
  }

  return {
    stop() {
      for (const t of timers) clearTimeout(t as ReturnType<typeof setTimeout>);
    },
    status: () => ({ ...state, finishErrors: Object.fromEntries(finishErrors) }),
    sweepUnplayed,
    sweepUnclaimed,
    buildReport,
  };
}
