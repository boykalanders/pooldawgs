import { afterEach, describe, expect, it } from "vitest";
import { io as ioc, type Socket } from "socket.io-client";
import { Wallet } from "ethers";
import {
  loginMessage,
  type Address,
  type AuthPayload,
  type ClientToServerEvents,
  type RoomSnapshot,
  type ServerToClientEvents,
} from "@pooldawgs/shared";
import { createPoolDawgsServer, type PoolDawgsServer } from "./server.js";
import type { ServerConfig } from "./config.js";

type TestClient = Socket<ServerToClientEvents, ClientToServerEvents>;

const walletA = Wallet.createRandom();
const walletB = Wallet.createRandom();

function testConfig(overrides: Partial<ServerConfig> = {}): ServerConfig {
  return {
    port: 0,
    corsOrigins: ["http://localhost:3000"],
    rpcUrl: null,
    contractAddress: null,
    ownerPrivateKey: null,
    shotClockMs: 60_000,
    chainEnabled: false,
    ...overrides,
  };
}

async function makeAuth(wallet: Wallet): Promise<AuthPayload> {
  const address = wallet.address as Address;
  const ts = Date.now();
  const signature = await wallet.signMessage(loginMessage(address, ts));
  return { address, ts, signature };
}

function waitFor<E extends keyof ServerToClientEvents>(
  socket: TestClient,
  event: E
): Promise<Parameters<ServerToClientEvents[E]>[0]> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${String(event)}`)), 8000);
    socket.once(event as never, ((payload: never) => {
      clearTimeout(timer);
      resolve(payload);
    }) as never);
  });
}

let server: PoolDawgsServer | null = null;
let clients: TestClient[] = [];

async function startServer(config: ServerConfig): Promise<number> {
  server = createPoolDawgsServer(config);
  await new Promise<void>((resolve) => server!.httpServer.listen(0, resolve));
  const addr = server.httpServer.address();
  if (typeof addr === "object" && addr) return addr.port;
  throw new Error("no port");
}

function connect(port: number): TestClient {
  const socket: TestClient = ioc(`http://127.0.0.1:${port}`, { transports: ["websocket"] });
  clients.push(socket);
  return socket;
}

afterEach(async () => {
  for (const c of clients) c.disconnect();
  clients = [];
  if (server) {
    await server.close();
    server = null;
  }
});

async function joinBoth(port: number, gameId: string): Promise<{ a: TestClient; b: TestClient; snapshot: RoomSnapshot }> {
  const a = connect(port);
  const b = connect(port);
  a.emit("room:join", { gameId, auth: await makeAuth(walletA) });
  // Dev mode: the room forms when the second distinct wallet joins.
  await new Promise((r) => setTimeout(r, 300));
  b.emit("room:join", { gameId, auth: await makeAuth(walletB) });
  const snapshot = await waitFor(b, "room:state");
  return { a, b, snapshot };
}

describe("PoolDawgs server (dev mode)", () => {
  it("forms a room with two authed wallets and enforces seating", async () => {
    const port = await startServer(testConfig());
    const { snapshot } = await joinBoth(port, "42");
    expect(snapshot.players).toHaveLength(2);
    expect(snapshot.players.map((p) => p.address)).toContain(
      walletA.address.toLowerCase()
    );
    expect(snapshot.state.turn).toBe(0);
    expect(snapshot.over).toBeNull();
  });

  it("rejects a forged signature", async () => {
    const port = await startServer(testConfig());
    const c = connect(port);
    const auth = await makeAuth(walletA);
    c.emit("room:join", {
      gameId: "1",
      auth: { ...auth, address: walletB.address as Address },
    });
    const error = await waitFor(c, "server:error");
    expect(error.code).toBe("unauthorized");
  });

  it("rejects shots out of turn and broadcasts authorized shots", async () => {
    const port = await startServer(testConfig());
    const { a, b } = await joinBoth(port, "7");

    // Seat 1 (wallet B) tries to shoot on seat 0's turn.
    b.emit("game:shoot", { gameId: "7", shot: { angle: 0, power: 30 } });
    const refusal = await waitFor(b, "server:error");
    expect(refusal.code).toBe("not-your-turn");

    // Seat 0 (wallet A) shoots legally; both clients get the broadcast.
    const shotPromise = waitFor(b, "game:shot");
    a.emit("game:shoot", { gameId: "7", shot: { angle: 0, power: 30 } });
    const shot = await shotPromise;
    expect(shot.bySeat).toBe(0);
    expect(shot.endStateHash).toMatch(/^[0-9a-f]{8}$/);
    expect(shot.endState.balls).toHaveLength(16);
  });

  it("rejects an illegal shot (overpowered)", async () => {
    const port = await startServer(testConfig());
    const { a } = await joinBoth(port, "8");
    a.emit("game:shoot", { gameId: "8", shot: { angle: 0, power: 9999 } });
    const error = await waitFor(a, "server:error");
    expect(error.code).toBe("illegal-shot");
  });

  it("resign settles the game for the opponent", async () => {
    const port = await startServer(testConfig());
    const { a, b } = await joinBoth(port, "9");
    const overPromise = waitFor(b, "game:over");
    a.emit("game:resign", { gameId: "9" });
    const over = await overPromise;
    expect(over.reason).toBe("resign");
    // A resigned, so B wins.
    expect(over.winner).toBe(walletB.address.toLowerCase());
  });

  it("shot-clock expiry forfeits the player on turn", async () => {
    const port = await startServer(testConfig({ shotClockMs: 1200 }));
    const { b } = await joinBoth(port, "10");
    const over = await waitFor(b, "game:over");
    expect(over.reason).toBe("timeout");
    // Seat 0 was on turn and timed out → seat 1 (wallet B) wins.
    expect(over.winner).toBe(walletB.address.toLowerCase());
  });

  it("relays chat between players", async () => {
    const port = await startServer(testConfig());
    const { a, b } = await joinBoth(port, "11");
    const msgPromise = waitFor(b, "chat:message");
    a.emit("chat:send", { gameId: "11", text: "  good luck dawg  " });
    const msg = await msgPromise;
    expect(msg.text).toBe("good luck dawg");
    expect(msg.from).toBe(walletA.address.toLowerCase());
  });
});
