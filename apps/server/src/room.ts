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
  private messages: ChatMessage[] = [];

  constructor(
    gameId: string,
    seats: [Address, Address],
    private readonly emitter: RoomEmitter,
    private readonly relayer: Relayer,
    private readonly shotClockMs: number,
    private readonly stake: string | null = null,
    gameType: GameType = "8ball",
    private readonly nameOf: (address: Address) => string | null = () => null
  ) {
    this.gameId = gameId;
    this.seats = seats;
    this.state = createInitialState(gameType);
    this.restartClock();
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
    if (this.over) return err("illegal-shot", "game is over");
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
    }
    return { ok: true };
  }

  handlePlaceCueBall(address: Address, x: number, y: number): RoomActionResult {
    if (this.over) return err("illegal-placement", "game is over");
    const seat = this.seatOf(address);
    if (seat === null) return err("not-a-player", "not seated in this game");
    if (seat !== this.state.turn) return err("not-your-turn", "wait for your turn");

    const result = placeCueBall(this.state, x, y);
    if (!result.ok) return err("illegal-placement", result.reason);

    this.state = result.state;
    this.emitter.broadcastCuePlaced({
      gameId: this.gameId,
      x,
      y,
      stateHash: stateHash(this.state),
    });
    return { ok: true };
  }

  handleResign(address: Address): RoomActionResult {
    if (this.over) return err("illegal-shot", "game is over");
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

    const winner = this.seats[winnerSeat];
    this.state = { ...this.state, gameOver: true, winner: winnerSeat };

    // Sign the win voucher off-chain (fast, no transaction). The winner redeems
    // it via claimRewardSigned, which settles AND pays in a single winner-paid
    // tx — so there's no relayer gas and no "waiting to settle" window. If
    // signing is unavailable the frame still stands; the winner can claim later
    // from their profile (which re-signs the voucher on demand).
    let voucher: string | undefined;
    try {
      voucher = (await this.relayer.signResult(this.gameId, winner)) ?? undefined;
    } catch {
      /* logged by the relayer */
    }
    this.over = { winner, reason, voucher };
    this.emitter.broadcastOver({ gameId: this.gameId, winner, reason, voucher });
    this.emitter.broadcastState(this.snapshot());
    this.settling = false;
  }

  dispose(): void {
    this.stopClock();
  }
}
