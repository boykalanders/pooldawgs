import {
  createInitialState,
  mustCallPocket,
  placeCueBall,
  POCKET_NAMES,
  simulateShot,
  stateHash,
  timeoutHandover,
  validateShot,
  type GameType,
  type PlayerIndex,
  type ShotInput,
  type TableState,
} from "@pooldawgs/engine";
import { MAX_MISSED_TURNS, RECONNECT_GRACE_MS } from "@pooldawgs/shared";
import type {
  Address,
  ChatMessage,
  GameOverReason,
  RoomSnapshot,
  ServerError,
  ShotBroadcast,
} from "@pooldawgs/shared";
import type { Relayer } from "./relayer.js";

export interface RoomEmitter {
  broadcastShot(p: ShotBroadcast): void;
  broadcastCuePlaced(p: { gameId: string; x: number; y: number; stateHash: string }): void;
  broadcastState(p: RoomSnapshot): void;
  broadcastOver(p: {
    gameId: string;
    winner: Address;
    reason: GameOverReason;
    txHash?: string;
    voucher?: string;
  }): void;
}

export type RoomActionResult = { ok: true } | { ok: false; error: ServerError };

/** What the room needs from the server to survive restarts and never lose a result. */
export interface RoomHooks {
  /** Store the decided game BEFORE anyone is told. Resolves with the stored
   *  result — the existing one if the game was already decided (the first result
   *  always stands). Must throw if it can't be stored; the room then retries. */
  recordResult(r: { gameId: string; winner: Address; loser: Address; reason: GameOverReason }): Promise<{
    winner: string;
    reason: string;
  }>;
  /** Save the live table (after every shot / placement / chat). Best effort. */
  saveState(room: GameRoom): void;
  /** The game is decided and announced; its live table can be dropped. */
  ended(room: GameRoom): void;
}

/** Both stakes being returned because the game never started. */
export interface RefundState {
  txHash: string | null;
  done: boolean;
}

/** A live table as stored between restarts. */
export interface SerializedRoom {
  gameId: string;
  seats: [Address, Address];
  stake: string | null;
  gameType: GameType;
  state: TableState;
  messages: ChatMessage[];
  /** False while it's still a waiting room (absent in rows saved before waiting rooms existed = started). */
  started?: boolean;
  waitingSince?: number;
  refund?: RefundState | null;
  /** Turn bookkeeping (absent in rows saved before it existed). */
  turnId?: number;
  missed?: [number, number];
  /** Shot clock left for the player to shoot when the table was saved. */
  clockRemainingMs?: number;
  calledPocket?: number | null;
}

/** Reconnect grace for one seat. */
interface Grace {
  /** Grace left this turn (ms). Refilled on a turn change for a seat that is online. */
  budgetMs: number;
  /** Offline since (epoch ms), or null while connected. */
  since: number | null;
  timer: ReturnType<typeof setTimeout> | null;
}

export interface RoomOptions {
  /** Resume a stored table instead of racking a new frame. */
  restore?: {
    state: TableState;
    messages: ChatMessage[];
    started?: boolean;
    waitingSince?: number;
    refund?: RefundState | null;
    turnId?: number;
    missed?: [number, number];
    clockRemainingMs?: number;
    calledPocket?: number | null;
  };
  /** Reconnect grace before a disconnected player's clock runs again (default 60 s). */
  graceMs?: number;
  /** How long a waiting room may wait for both players before both stakes are refunded. */
  waitingTimeoutMs?: number;
  /** Open the room on an already-decided game (no play, just the result). */
  decided?: { winner: Address; reason: GameOverReason; voucher?: string };
  hooks?: RoomHooks;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function err(code: ServerError["code"], message: string): RoomActionResult {
  return { ok: false, error: { code, message } };
}

/**
 * One authoritative room per on-chain gameId. All gameplay flows through
 * here: the room validates that inputs come from the seated player whose
 * turn it is, runs the deterministic engine, enforces the 4-minute shot
 * clock and reports the final winner to the chain via the relayer.
 *
 * Turn rules (server-owned):
 *  - Shot clock expires: no shot is simulated, the opponent gets ball in hand
 *    and the timed-out player's missed-turn count goes up; MAX_MISSED_TURNS in
 *    a row forfeits. A player's count resets only after their own valid shot.
 *  - Every turn change bumps `turnId`. Timer callbacks carry the turn id (and a
 *    clock generation) they were armed for and do nothing if it moved on, so a
 *    shot/timeout race can never apply ball in hand twice.
 *  - A disconnected player gets a reconnect grace (60 s per turn): both clocks
 *    pause with the remaining time saved, and resume from it on reconnect or
 *    when the grace runs out. A disconnect is never a strike by itself.
 *  - After a restart the table resumes with the saved remaining time and every
 *    player gets a fresh grace to reconnect (the outage costs nobody time).
 */
export class GameRoom {
  readonly gameId: string;
  readonly seats: [Address, Address];
  private state: TableState;
  private connected = new Set<Address>();
  private clockTimer: ReturnType<typeof setTimeout> | null = null;
  /** Shot clock left for the player to shoot (ms), and since when it's been running. */
  private clockRemainingMs: number;
  private clockRunningSince: number | null = null;
  /** Invalidates timer callbacks armed before the latest stop/arm. */
  private clockGen = 0;
  private checkpointTimer: ReturnType<typeof setInterval> | null = null;
  private turnId = 0;
  private missed: [number, number] = [0, 0];
  private grace: [Grace, Grace];
  private readonly graceMs: number;
  /** 8-ball on the black: the pocket called for this turn. */
  private calledPocket: number | null = null;
  private over: RoomSnapshot["over"] = null;
  private settling = false;
  private disposed = false;
  private messages: ChatMessage[] = [];
  readonly gameType: GameType;
  private readonly hooks: RoomHooks | null;
  /**
   * Waiting room until BOTH players have come to the table: no shot clock runs and
   * nobody can lose by being away. Once both have been here the game is live, and
   * from then on being away costs you the shot clock as normal.
   */
  private started = false;
  readonly waitingSince: number;
  private readonly waitingTimeoutMs: number;
  private refund: RefundState | null = null;

  constructor(
    gameId: string,
    seats: [Address, Address],
    private readonly emitter: RoomEmitter,
    private readonly relayer: Relayer,
    private readonly shotClockMs: number,
    private readonly stake: string | null = null,
    gameType: GameType = "8ball",
    private readonly nameOf: (address: Address) => string | null = () => null,
    options: RoomOptions = {}
  ) {
    this.gameId = gameId;
    this.seats = seats;
    this.gameType = gameType;
    this.hooks = options.hooks ?? null;
    this.state = options.restore?.state ?? createInitialState(gameType);
    this.messages = options.restore?.messages ?? [];
    this.waitingSince = options.restore?.waitingSince ?? Date.now();
    this.waitingTimeoutMs = options.waitingTimeoutMs ?? 30 * 60_000;
    this.refund = options.restore?.refund ?? null;
    this.graceMs = options.graceMs ?? RECONNECT_GRACE_MS;
    this.grace = [0, 1].map(() => ({ budgetMs: this.graceMs, since: null, timer: null })) as [Grace, Grace];
    this.turnId = options.restore?.turnId ?? 0;
    this.missed = options.restore?.missed ?? [0, 0];
    this.calledPocket = options.restore?.calledPocket ?? null;
    const saved = options.restore?.clockRemainingMs;
    this.clockRemainingMs = saved !== undefined && saved > 0 ? Math.min(saved, shotClockMs) : shotClockMs;
    if (options.decided) {
      const seat = this.seatOf(options.decided.winner);
      this.state = { ...this.state, gameOver: true, winner: seat };
      this.over = { ...options.decided, winner: options.decided.winner.toLowerCase() as Address };
      return; // decided: no clock, no play
    }
    if (options.restore && options.restore.started !== false) {
      // Server outage: nothing counted while we were down. The player to shoot
      // keeps the time they had left, and both players get a fresh reconnect
      // grace; the clock stays paused until they're back (or the grace ends).
      this.started = true;
      const now = Date.now();
      for (const seat of [0, 1] as const) this.beginGrace(seat, now);
      this.syncClock();
    }
    // Otherwise a waiting room: the clock starts when both players are at the table.
  }

  /** Still a waiting room (both paid, not both at the table yet). */
  isWaiting(): boolean {
    return !this.started && !this.over;
  }

  refundState(): RefundState | null {
    return this.refund;
  }

  /**
   * The waiting room expired: return both stakes. Only possible while the game has
   * never started; from this moment it never can (even if both players turn up).
   * False if the game started (or a refund is already under way).
   */
  beginRefund(): boolean {
    if (this.started || this.over || this.refund) return false;
    this.refund = { txHash: null, done: false };
    this.hooks?.saveState(this);
    this.emitter.broadcastState(this.snapshot());
    return true;
  }

  setRefundTx(txHash: string | null): void {
    if (!this.refund) return;
    this.refund = { ...this.refund, txHash };
    this.hooks?.saveState(this);
  }

  refundDone(): void {
    if (!this.refund) return;
    this.refund = { ...this.refund, done: true };
    this.emitter.broadcastState(this.snapshot());
  }

  private startIfBothHere(): void {
    if (this.started || this.over || this.refund) return;
    if (!this.seats.every((s) => this.connected.has(s))) return;
    this.started = true;
    this.newTurnClock();
    this.hooks?.saveState(this);
  }

  /** The live table, for storage between restarts. */
  serialize(): SerializedRoom {
    return {
      gameId: this.gameId,
      seats: this.seats,
      stake: this.stake,
      gameType: this.gameType,
      state: this.state,
      messages: this.messages,
      started: this.started,
      waitingSince: this.waitingSince,
      refund: this.refund,
      turnId: this.turnId,
      missed: this.missed,
      clockRemainingMs: this.remainingMs(),
      calledPocket: this.calledPocket,
    };
  }

  seatOf(address: Address): PlayerIndex | null {
    const idx = this.seats.findIndex((s) => s === address.toLowerCase());
    return idx === -1 ? null : (idx as PlayerIndex);
  }

  isOver(): boolean {
    return this.over !== null;
  }

  /** Per-player stake in wei (decimal string), or null for dev tables. */
  stakeWei(): string | null {
    return this.stake;
  }

  /** Append a chat message to the room's history (kept so reconnecting players
   *  see it). Capped to the most recent 100. */
  addChat(msg: ChatMessage): void {
    this.messages.push(msg);
    if (this.messages.length > 100) this.messages.shift();
    this.hooks?.saveState(this);
  }

  connect(address: Address): void {
    const key = address.toLowerCase() as Address;
    this.connected.add(key);
    const seat = this.seatOf(key);
    if (seat !== null) this.endGrace(seat);
    this.startIfBothHere();
    this.syncClock();
    this.emitter.broadcastState(this.snapshot());
  }

  /** The player's last connection dropped (Socket.IO heartbeat: a ping every
   *  5 s, so at most ~15 s of silence). Not a strike: the grace pauses both
   *  clocks. In a waiting room nothing runs. */
  disconnect(address: Address): void {
    const key = address.toLowerCase() as Address;
    this.connected.delete(key);
    const seat = this.seatOf(key);
    if (seat !== null && this.started && !this.over && !this.settling) {
      this.beginGrace(seat, Date.now());
      this.syncClock();
      this.hooks?.saveState(this);
    }
    this.emitter.broadcastState(this.snapshot());
  }

  // ── reconnect grace ──

  private inGrace(seat: PlayerIndex): boolean {
    const g = this.grace[seat];
    return g.since !== null && g.budgetMs > 0;
  }

  private beginGrace(seat: PlayerIndex, now: number): void {
    const g = this.grace[seat];
    if (g.since !== null) return;
    g.since = now;
    if (g.budgetMs <= 0) return; // used up this turn: the clock keeps running
    g.timer = setTimeout(() => {
      // Grace over: normal rules resume (the clock runs; no forfeit for this alone).
      g.timer = null;
      g.budgetMs = 0;
      if (this.disposed || this.over || this.settling) return;
      this.syncClock();
      this.hooks?.saveState(this);
      this.emitter.broadcastState(this.snapshot());
    }, g.budgetMs);
  }

  private endGrace(seat: PlayerIndex): void {
    const g = this.grace[seat];
    if (g.since === null) return;
    g.budgetMs = Math.max(0, g.budgetMs - (Date.now() - g.since));
    g.since = null;
    if (g.timer) clearTimeout(g.timer);
    g.timer = null;
  }

  /** A new turn: a connected player's grace is full again; a player who is still
   *  away keeps what was left, so being away for good can't pause the game
   *  forever (with both players gone, the deadlines keep running). */
  private refreshGraceForNewTurn(): void {
    for (const seat of [0, 1] as const) {
      if (this.grace[seat].since === null) this.grace[seat].budgetMs = this.graceMs;
    }
  }

  private graceExpiresAt(seat: PlayerIndex): number | null {
    const g = this.grace[seat];
    return this.inGrace(seat) && g.since !== null ? g.since + g.budgetMs : null;
  }

  snapshot(): RoomSnapshot {
    return {
      gameId: this.gameId,
      players: this.seats.map((address, seat) => ({
        address,
        seat: seat as PlayerIndex,
        connected: this.connected.has(address),
        username: this.nameOf(address),
        graceExpiresAt: this.graceExpiresAt(seat as PlayerIndex),
        missedTurns: this.missed[seat],
      })),
      stake: this.stake,
      state: this.state,
      stateHash: stateHash(this.state),
      messages: this.messages,
      clockExpiresAt: this.clockExpiresAt(),
      clockPaused: this.started && !this.over && this.clockRunningSince === null,
      clockRemainingMs: this.remainingMs(),
      turnId: this.turnId,
      calledPocket: this.calledPocket,
      serverNow: Date.now(),
      over: this.over,
      waiting: this.isWaiting(),
      waitingExpiresAt: this.isWaiting() ? this.waitingSince + this.waitingTimeoutMs : null,
      refund: this.refund,
    };
  }

  /** Turn id clients echo on actions; undefined (older clients) skips the check. */
  private staleTurn(turnId: number | undefined): boolean {
    return turnId !== undefined && turnId !== this.turnId;
  }

  handleShot(address: Address, shot: ShotInput, turnId?: number): RoomActionResult {
    if (this.over || this.settling) return err("illegal-shot", "game is over");
    if (!this.started) return err("illegal-shot", "the game starts when both players are at the table");
    const seat = this.seatOf(address);
    if (seat === null) return err("not-a-player", "not seated in this game");
    if (seat !== this.state.turn) return err("not-your-turn", "wait for your turn");
    if (this.staleTurn(turnId)) return err("stale-turn", "that turn has already ended");

    // On the black the call is locked in as the shot starts: the one sent with
    // the shot (calling at the last moment), else the one already held here.
    if (mustCallPocket(this.state)) {
      shot = { ...shot, calledPocket: shot.calledPocket ?? this.calledPocket ?? undefined };
    } else if (shot.calledPocket !== undefined) {
      shot = { ...shot, calledPocket: undefined }; // only meaningful on the black
    }

    const valid = validateShot(this.state, shot);
    if (!valid.ok) return err("illegal-shot", valid.reason ?? "illegal shot");

    const preHash = stateHash(this.state);
    // Simulated in full right here: the shot resolves even if the shooter's
    // connection drops while the balls are still rolling on their screen.
    const result = simulateShot(this.state, shot);
    this.state = result.endState;
    this.missed[seat] = 0; // their own valid shot clears their missed turns
    this.calledPocket = null; // a call is for one shot only
    this.turnId++;

    this.newTurnClock();
    this.emitter.broadcastShot({
      gameId: this.gameId,
      bySeat: seat,
      shot,
      preStateHash: preHash,
      endState: result.endState,
      endStateHash: stateHash(result.endState),
      clockExpiresAt: this.clockExpiresAt(),
      turnId: this.turnId,
      clockPaused: this.clockRunningSince === null,
      clockRemainingMs: this.remainingMs(),
      serverNow: Date.now(),
    });

    if (result.outcome.gameOver && result.outcome.winner !== null) {
      void this.settle(result.outcome.winner, "pot");
    } else {
      this.hooks?.saveState(this);
    }
    return { ok: true };
  }

  handlePlaceCueBall(address: Address, x: number, y: number, turnId?: number): RoomActionResult {
    if (this.over || this.settling) return err("illegal-placement", "game is over");
    if (!this.started) return err("illegal-placement", "the game starts when both players are at the table");
    const seat = this.seatOf(address);
    if (seat === null) return err("not-a-player", "not seated in this game");
    if (seat !== this.state.turn) return err("not-your-turn", "wait for your turn");
    if (this.staleTurn(turnId)) return err("stale-turn", "that turn has already ended");

    const result = placeCueBall(this.state, x, y);
    if (!result.ok) return err("illegal-placement", result.reason);

    this.state = result.state;
    this.hooks?.saveState(this);
    this.emitter.broadcastCuePlaced({
      gameId: this.gameId,
      x,
      y,
      stateHash: stateHash(this.state),
    });
    return { ok: true };
  }

  /** 8-ball, on the black: call (or change) the pocket before shooting. Stored
   *  here and shown to the opponent; locked when the shot starts. */
  handleCallPocket(address: Address, pocket: number, turnId?: number): RoomActionResult {
    if (this.over || this.settling) return err("illegal-call", "game is over");
    if (!this.started) return err("illegal-call", "the game starts when both players are at the table");
    const seat = this.seatOf(address);
    if (seat === null) return err("not-a-player", "not seated in this game");
    if (seat !== this.state.turn) return err("not-your-turn", "only the player to shoot can call the pocket");
    if (this.staleTurn(turnId)) return err("stale-turn", "that turn has already ended");
    if (!mustCallPocket(this.state)) return err("illegal-call", "a pocket is only called when shooting at the 8-ball");
    if (!Number.isInteger(pocket) || pocket < 0 || pocket >= POCKET_NAMES.length) {
      return err("illegal-call", "called pocket must be one of the six pockets");
    }
    this.calledPocket = pocket;
    this.hooks?.saveState(this);
    this.emitter.broadcastState(this.snapshot());
    return { ok: true };
  }

  handleResign(address: Address): RoomActionResult {
    if (this.over || this.settling) return err("illegal-shot", "game is over");
    if (!this.started) return err("illegal-shot", "the game starts when both players are at the table");
    const seat = this.seatOf(address);
    if (seat === null) return err("not-a-player", "not seated in this game");

    const winnerSeat = ((seat + 1) % 2) as PlayerIndex;
    void this.settle(winnerSeat, "resign");
    return { ok: true };
  }

  // ── shot clock (4 minutes, enforced here, never on-chain) ──

  private remainingMs(now = Date.now()): number {
    if (this.clockRunningSince === null) return this.clockRemainingMs;
    return Math.max(0, this.clockRemainingMs - (now - this.clockRunningSince));
  }

  private clockExpiresAt(): number {
    if (!this.started || this.over) return 0;
    return Date.now() + this.remainingMs();
  }

  /** A fresh, full clock for the player now to shoot. */
  private newTurnClock(): void {
    this.stopClock();
    this.clockRemainingMs = this.shotClockMs;
    this.refreshGraceForNewTurn();
    this.syncClock();
  }

  /** Run the clock unless the game isn't live or a player is inside the
   *  reconnect grace, in which case it's paused with the remaining time kept. */
  private syncClock(): void {
    const shouldRun =
      this.started && !this.over && !this.settling && !this.disposed && !this.inGrace(0) && !this.inGrace(1);
    if (shouldRun && this.clockRunningSince === null) {
      this.clockRunningSince = Date.now();
      const gen = ++this.clockGen;
      const turnId = this.turnId;
      this.clockTimer = setTimeout(() => this.onClockExpired(gen, turnId), this.clockRemainingMs);
      // Checkpoint the remaining time so a crash loses at most a few seconds of it.
      this.checkpointTimer = setInterval(() => this.hooks?.saveState(this), 5_000);
    } else if (!shouldRun && this.clockRunningSince !== null) {
      this.stopClock();
    }
  }

  /** Pause: keep the remaining time, cancel the pending expiry. */
  private stopClock(): void {
    this.clockRemainingMs = this.remainingMs();
    this.clockRunningSince = null;
    this.clockGen++;
    if (this.clockTimer) {
      clearTimeout(this.clockTimer);
      this.clockTimer = null;
    }
    if (this.checkpointTimer) {
      clearInterval(this.checkpointTimer);
      this.checkpointTimer = null;
    }
  }

  /**
   * Time ran out: no shot, no ball moves. The opponent gets ball in hand and the
   * timed-out player has missed a turn; MAX_MISSED_TURNS in a row forfeits. With
   * both players away this keeps alternating, so whoever reaches the limit first
   * (decided purely by turn order) loses. No draw, no refund.
   */
  private onClockExpired(gen: number, turnId: number): void {
    // Armed for a clock or a turn that's gone (paused, a shot landed, restored): ignore.
    if (gen !== this.clockGen || turnId !== this.turnId) return;
    if (this.over || this.settling || this.disposed) return;
    this.clockTimer = null;
    this.stopClock();
    const seat = this.state.turn;
    const opponent = ((seat + 1) % 2) as PlayerIndex;
    this.missed[seat]++;
    console.log(`[room] ${this.gameId}: seat ${seat} ran out of time (${this.missed[seat]}/${MAX_MISSED_TURNS} in a row)`);
    if (this.missed[seat] >= MAX_MISSED_TURNS) {
      void this.settle(opponent, "timeout");
      return;
    }
    this.state = timeoutHandover(this.state);
    this.calledPocket = null;
    this.turnId++;
    this.newTurnClock();
    this.hooks?.saveState(this);
    this.emitter.broadcastState(this.snapshot());
  }

  private async settle(winnerSeat: PlayerIndex, reason: GameOverReason): Promise<void> {
    if (this.over || this.settling) return;
    this.settling = true;
    this.stopClock();

    let winner: Address = this.seats[winnerSeat];
    let finalReason: GameOverReason = reason;

    // Store the result before anyone hears about it. If storage is down the
    // table stays frozen (no shots, clock stopped) and the write is retried —
    // announcing a result that isn't saved is how a game gets replayed or lost.
    if (this.hooks) {
      const loser = this.seats[((winnerSeat + 1) % 2) as PlayerIndex];
      for (let attempt = 0; ; attempt++) {
        try {
          const stored = await this.hooks.recordResult({ gameId: this.gameId, winner, loser, reason });
          winner = stored.winner.toLowerCase() as Address; // an earlier result always stands
          finalReason = stored.reason as GameOverReason;
          break;
        } catch (error) {
          console.error(
            `[room] ${this.gameId}: could not store the result (attempt ${attempt + 1}) — retrying`,
            error instanceof Error ? error.message : error
          );
          if (this.disposed) return;
          await sleep(Math.min(30_000, 1_000 * 2 ** attempt));
          if (this.disposed) return;
        }
      }
    }

    const seat = this.seatOf(winner) ?? winnerSeat;
    this.state = { ...this.state, gameOver: true, winner: seat };

    // Sign the win voucher off-chain (fast, no transaction). The winner redeems
    // it via claimRewardSigned, which settles AND pays in a single winner-paid
    // tx. If signing is unavailable the result still stands; the winner can
    // claim later from their profile (which re-signs the voucher on demand).
    let voucher: string | undefined;
    try {
      voucher = (await this.relayer.signResult(this.gameId, winner)) ?? undefined;
    } catch {
      /* logged by the relayer */
    }
    this.over = { winner, reason: finalReason, voucher };
    this.settling = false;
    this.emitter.broadcastOver({ gameId: this.gameId, winner, reason: finalReason, voucher });
    this.emitter.broadcastState(this.snapshot());
    this.hooks?.ended(this);
  }

  dispose(): void {
    this.disposed = true;
    this.stopClock();
    for (const g of this.grace) {
      if (g.timer) clearTimeout(g.timer);
      g.timer = null;
    }
  }
}
