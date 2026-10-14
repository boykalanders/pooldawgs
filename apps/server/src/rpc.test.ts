// Failover against real HTTP endpoints (two local fake JSON-RPC servers).
import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { ResilientRpcProvider, providerStatus, redactRpcUrl, rpcMetrics } from "./rpc.js";

/** Return null to never answer (a hung provider). */
type Handler = (body: { id: number; method: string }) => { status?: number; json?: unknown } | null;
const servers: Server[] = [];

async function fakeRpc(handler: Handler): Promise<{ url: string; calls: string[] }> {
  const calls: string[] = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = JSON.parse(raw);
      calls.push(body.method);
      const out = handler(body);
      if (!out) return;
      res.writeHead(out.status ?? 200, { "content-type": "application/json" });
      res.end(JSON.stringify(out.json ?? {}));
    });
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  if (typeof addr !== "object" || !addr) throw new Error("no port");
  // A unique path per server keeps each one's health separate.
  return { url: `http://127.0.0.1:${addr.port}/rpc${servers.length}`, calls };
}

afterEach(async () => {
  for (const s of servers.splice(0)) {
    s.closeAllConnections(); // the "hung" fake never answers
    await new Promise((r) => s.close(r));
  }
});

const ok = (id: number, result: unknown) => ({ json: { jsonrpc: "2.0", id, result } });

describe("ResilientRpcProvider", () => {
  it("fails over to the backup when the primary is down, then stops hammering the primary", async () => {
    const primary = await fakeRpc(() => ({ status: 503, json: { error: "down" } }));
    const backup = await fakeRpc((b) => ok(b.id, "0x10"));
    const provider = new ResilientRpcProvider([primary.url, backup.url], 11155111);

    expect(await provider.send("eth_blockNumber", [])).toBe("0x10");
    expect(await provider.send("eth_blockNumber", [])).toBe("0x10");
    // Two failures in a row open the primary's circuit: the third call goes straight to the backup.
    const before = primary.calls.length;
    expect(await provider.send("eth_blockNumber", [])).toBe("0x10");
    expect(primary.calls.length).toBe(before);
    expect(providerStatus().find((p) => p.provider === redactRpcUrl(primary.url))?.healthy).toBe(false);
    expect(rpcMetrics.snapshot().failovers).toBeGreaterThan(0);
    provider.destroy();
  });

  it("a rate limit inside a 200 response also fails over", async () => {
    const primary = await fakeRpc((b) => ({ json: { jsonrpc: "2.0", id: b.id, error: { code: 429, message: "Your app has exceeded its compute units per second capacity" } } }));
    const backup = await fakeRpc((b) => ok(b.id, "0x20"));
    const provider = new ResilientRpcProvider([primary.url, backup.url], 11155111);
    expect(await provider.getBlockNumber()).toBe(32);
    expect(backup.calls).toContain("eth_blockNumber");
    provider.destroy();
  });

  it("an empty or garbage response is a provider failure", async () => {
    const broken = await fakeRpc(() => ({ json: {} }));
    const backup = await fakeRpc((b) => ok(b.id, "0x40"));
    const provider = new ResilientRpcProvider([broken.url, backup.url], 11155111);
    expect(await provider.send("eth_blockNumber", [])).toBe("0x40");
    provider.destroy();
  });

  it("a revert is the chain's answer — returned as-is, no failover", async () => {
    const revert = (id: number) => ({
      json: { jsonrpc: "2.0", id, error: { code: 3, message: "execution reverted: game completed", data: "0x" } },
    });
    const primary = await fakeRpc((b) => revert(b.id));
    const backup = await fakeRpc((b) => ok(b.id, "0x"));
    const provider = new ResilientRpcProvider([primary.url, backup.url], 11155111);
    await expect(provider.call({ to: "0x1a0ff1B3B4D20495B12367f291A8639B9B268764", data: "0x" })).rejects.toThrow(/revert/);
    expect(backup.calls).toHaveLength(0);
    provider.destroy();
  });
});

describe("ResilientRpcProvider timeouts", () => {
  it("a hung provider is abandoned after the request timeout, not ethers' 5 minutes", async () => {
    const hung = await fakeRpc(() => null);
    const backup = await fakeRpc((b) => ok(b.id, "0x30"));
    const provider = new ResilientRpcProvider([hung.url, backup.url], 11155111, 300);
    const started = Date.now();
    expect(await provider.send("eth_blockNumber", [])).toBe("0x30");
    expect(Date.now() - started).toBeLessThan(3_000);
    provider.destroy();
  });
});
