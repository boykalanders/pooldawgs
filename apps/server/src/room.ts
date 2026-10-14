import {
  createInitialState,
  cueBall,
  placeCueBall,
  simulateShot,
  stateHash,
  validateShot,
  type GameType,
  type PlayerIndex,
  type ShotInput,
  type TableState,
} from "@pooldawgs/engine";
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

/** A live table as stored between restarts. */
export interface SerializedRoom {
  gameId: string;
  seats: [Address, Address];
  stake: string | null;
  gameType: GameType;
  state: TableState;
  messages: ChatMessage[];
}

export interface RoomOptions {
  /** Resume a stored table instead of racking a new frame. */
  restore?: { state: TableState; messages: ChatMessage[] };
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
 */
export class GameRoom {
  readonly gameId: string;
  readonly seats: [Address, Address];
  private state: TableState;
  private connected = new Set<Address>();
  private clockTimer: ReturnType<typeof setTimeout> | null = null;
  private clockExpiresAt = 0;
  private over: RoomSnapshot["over"] = null;
  private settling = false;
  private disposed = false;
  private messages: ChatMessage[] = [];
  readonly gameType: GameType;
  private readonly hooks: RoomHooks | null;

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
    if (options.decided) {
      const seat = this.seatOf(options.decided.winner);
      this.state = { ...this.state, gameOver: true, winner: seat };
      this.over = { ...options.decided, winner: options.decided.winner.toLowerCase() as Address };
      return; // decided: no clock, no play
    }
    // A restored table gets a fresh, full shot clock: the server being down must
    // never cost the player whose turn it was the game.
    this.restartClock();
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
    this.connected.add(address.toLowerCase() as Address);
    this.emitter.broadcastState(this.snapshot());
  }

  disconnect(address: Address): void {
    this.connected.delete(address.toLowerCase() as Address);
    // The shot clock keeps running — disconnecting does not pause a wagered
    // game; staying away for 4 minutes forfeits it.
    this.emitter.broadcastState(this.snapshot());
  }

  snapshot(): RoomSnapshot {
    return {
      gameId: this.gameId,
      players: this.seats.map((address, seat) => ({
        address,
        seat: seat as PlayerIndex,
        connected: this.connected.has(address),
        username: this.nameOf(address),
      })),
      stake: this.stake,
      state: this.state,
      stateHash: stateHash(this.state),
      messages: this.messages,
      clockExpiresAt: this.clockExpiresAt,
      serverNow: Date.now(),
      over: this.over,
    };
  }

  handleShot(address: Address, shot: ShotInput): RoomActionResult {
    if (this.over || this.settling) return err("illegal-shot", "game is over");
    const seat = this.seatOf(address);
    if (seat === null) return err("not-a-player", "not seated in this game");
    if (seat !== this.state.turn) return err("not-your-turn", "wait for your turn");

    const valid = validateShot(this.state, shot);
    if (!valid.ok) return err("illegal-shot", valid.reason ?? "illegal shot");

    const preHash = stateHash(this.state);
    const result = simulateShot(this.state, shot);
    this.state = result.endState;

    this.restartClock();
    this.emitter.broadcastShot({
      gameId: this.gameId,
      bySeat: seat,
      shot,
      preStateHash: preHash,
      endState: result.endState,
      endStateHash: stateHash(result.endState),
      clockExpiresAt: this.clockExpiresAt,
      serverNow: Date.now(),
    });

    if (result.outcome.gameOver && result.outcome.winner !== null) {
      void this.settle(result.outcome.winner, "pot");
    } else {
      this.hooks?.saveState(this);
    }
    return { ok: true };
  }

  handlePlaceCueBall(address: Address, x: number, y: number): RoomActionResult {
    if (this.over || this.settling) return err("illegal-placement", "game is over");
    const seat = this.seatOf(address);
    if (seat === null) return err("not-a-player", "not seated in this game");
    if (seat !== this.state.turn) return err("not-your-turn", "wait for your turn");

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

  handleResign(address: Address): RoomActionResult {
    if (this.over || this.settling) return err("illegal-shot", "game is over");
    const seat = this.seatOf(address);
    if (seat === null) return err("not-a-player", "not seated in this game");

    const winnerSeat = ((seat + 1) % 2) as PlayerIndex;
    void this.settle(winnerSeat, "resign");
    return { ok: true };
  }

  /** 4-minute shot clock — enforced here, never on-chain. */
  private restartClock(): void {
    this.stopClock();
    this.clockExpiresAt = Date.now() + this.shotClockMs;
    this.clockTimer = setTimeout(() => this.onClockExpired(), this.shotClockMs);
  }

  private stopClock(): void {
    if (this.clockTimer) {
      clearTimeout(this.clockTimer);
      this.clockTimer = null;
    }
  }

  private onClockExpired(): void {
    if (this.over || this.settling) return;
    const loser = this.state.turn;
    const winnerSeat = ((loser + 1) % 2) as PlayerIndex;
    void this.settle(winnerSeat, "timeout");
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
  }
}
