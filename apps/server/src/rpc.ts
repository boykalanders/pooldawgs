import { FetchRequest, JsonRpcApiProvider, JsonRpcProvider, Network, type JsonRpcError, type JsonRpcPayload, type JsonRpcResult } from "ethers";

/**
 * RPC endpoints, failover and usage metrics.
 *
 * Every request goes to the first healthy provider (Alchemy, then Infura, then
 * the rest). A provider failure — timeout, rate limit, 5xx, network error —
 * moves the request to the next one; two failures in a row, or any rate limit,
 * mark the provider unhealthy for a growing cooldown so it isn't hammered.
 * Answers from the chain itself (reverts, nonce errors) are returned as-is and
 * never count against a provider. A transaction resent to a second provider is
 * the same signed bytes and the same hash, so it can't be doubled.
 *
 * (ethers' own FallbackProvider isn't used: with a quorum of 1 it accepts the
 * first provider's error as the answer instead of trying the next provider.)
 */

const clean = (list: Array<string | undefined>): string[] => {
  const out: string[] = [];
  for (const raw of list) {
    const url = (raw ?? "").trim();
    if (url && !out.includes(url)) out.push(url);
  }
  return out;
};

/** HTTP endpoints, best first: Alchemy, Infura, RPC_URL_FALLBACKS, RPC_URL. */
export function resolveRpcUrls(env: NodeJS.ProcessEnv = process.env): string[] {
  return clean([env.RPC_URL_ALCHEMY, env.RPC_URL_INFURA, ...(env.RPC_URL_FALLBACKS ?? "").split(","), env.RPC_URL]);
}

/** WebSocket endpoints for live events. Explicit RPC_WSS_URL_* win; otherwise
 *  derived from the Alchemy / Infura HTTP URLs (same key). */
export function resolveWsUrls(env: NodeJS.ProcessEnv = process.env): string[] {
  const fromAlchemy = env.RPC_URL_ALCHEMY?.trim().replace(/^https:\/\//, "wss://");
  const fromInfura = env.RPC_URL_INFURA?.trim()
    .replace(/^https:\/\//, "wss://")
    .replace(/\.infura\.io\/v3\//, ".infura.io/ws/v3/");
  return clean([
    env.RPC_WSS_URL_ALCHEMY || fromAlchemy,
    env.RPC_WSS_URL,
    env.RPC_WSS_URL_INFURA || fromInfura,
    ...(env.RPC_WSS_URL_FALLBACKS ?? "").split(","),
  ]).filter((u) => u.startsWith("wss://") || u.startsWith("ws://"));
}

export function redactRpcUrl(url: string | undefined): string {
  if (!url) return "(not set)";
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}${u.pathname && u.pathname !== "/" ? "/…" : ""}`;
  } catch {
    return "(invalid url)";
  }
}

// ── circuit breaker ────────────────────────────────────────────────────────

export type FailureKind = "provider" | "timeout" | "rate-limited" | "deterministic";

/** A provider problem (fail over) vs. an answer from the chain (pass through). */
export function classifyRpcError(error: unknown): FailureKind {
  const e = error as { code?: unknown; status?: unknown; shortMessage?: string; message?: string; error?: { code?: unknown; message?: string } };
  const code = Number((e?.error?.code ?? e?.code) as number) || 0;
  const status = Number(e?.status) || 0;
  const message = `${e?.shortMessage ?? ""} ${e?.message ?? ""} ${e?.error?.message ?? ""}`.toLowerCase();
  if (e?.code === "TIMEOUT" || message.includes("timeout") || message.includes("timed out")) return "timeout";
  if (status === 429 || code === 429 || code === -32005 || message.includes("rate limit") || message.includes("too many requests") || message.includes("exceeded") && message.includes("capacity")) {
    return "rate-limited";
  }
  if (e?.code === "SERVER_ERROR" || e?.code === "NETWORK_ERROR" || e?.code === "BAD_DATA" || status >= 500 || status === 401 || status === 403 || message.includes("fetch failed") || message.includes("econnre") || message.includes("enotfound")) {
    return "provider";
  }
  if (code === -32603 && !message.includes("revert")) return "provider";
  return "deterministic";
}

export const CIRCUIT_COOLDOWNS_MS = [30_000, 60_000, 120_000, 300_000, 600_000, 1_800_000];

export class ProviderHealth {
  consecutiveFailures = 0;
  openUntil = 0;
  level = 0;
  lastError: string | null = null;

  constructor(readonly label: string, private readonly failureThreshold = 2) {}

  isAvailable(now: number): boolean {
    return now >= this.openUntil;
  }

  recordSuccess(): void {
    this.consecutiveFailures = 0;
    this.level = 0;
    this.openUntil = 0;
    this.lastError = null;
  }

  /** True when this failure just marked the provider unhealthy. */
  recordFailure(kind: FailureKind, now: number, message?: string): boolean {
    this.consecutiveFailures++;
    this.lastError = message ?? kind;
    if (kind !== "rate-limited" && this.consecutiveFailures < this.failureThreshold) return false;
    this.openUntil = now + CIRCUIT_COOLDOWNS_MS[Math.min(this.level, CIRCUIT_COOLDOWNS_MS.length - 1)];
    this.level++;
    this.consecutiveFailures = 0;
    return true;
  }
}

/** Healthy providers in priority order; if all are cooling down, the one that
 *  recovers first (a single probe), so a total outage still heals itself. */
export function pickProviderOrder(health: ProviderHealth[], now: number): number[] {
  const available = health.map((_, i) => i).filter((i) => health[i].isAvailable(now));
  if (available.length) return available;
  let soonest = 0;
  health.forEach((h, i) => {
    if (h.openUntil < health[soonest].openUntil) soonest = i;
  });
  return [soonest];
}

// ── metrics ────────────────────────────────────────────────────────────────

// Alchemy compute units per method; unlisted methods count as a typical read.
export const METHOD_CU: Record<string, number> = {
  eth_blockNumber: 10,
  eth_chainId: 0,
  eth_call: 26,
  eth_getLogs: 75,
  eth_getBalance: 19,
  eth_getTransactionCount: 26,
  eth_getTransactionReceipt: 15,
  eth_getTransactionByHash: 17,
  eth_getBlockByNumber: 16,
  eth_feeHistory: 10,
  eth_maxPriorityFeePerGas: 10,
  eth_gasPrice: 20,
  eth_estimateGas: 87,
  eth_sendRawTransaction: 250,
  eth_subscribe: 10,
  eth_unsubscribe: 10,
};

type Bucket = { requests: number; cu: number; errors: number; timeouts: number; rateLimited: number };
const bucket = (): Bucket => ({ requests: 0, cu: 0, errors: 0, timeouts: 0, rateLimited: 0 });

class RpcMetrics {
  readonly startedAt = Date.now();
  private byMethod = new Map<string, Bucket>();
  private byProvider = new Map<string, Bucket>();
  failovers = 0;
  subscriptionNotifications = 0;

  record(provider: string, method: string, outcome: "ok" | "error" | "timeout" | "rate-limited"): void {
    const cu = METHOD_CU[method] ?? 26;
    for (const [map, key] of [
      [this.byMethod, method],
      [this.byProvider, provider],
    ] as const) {
      let b = map.get(key);
      if (!b) map.set(key, (b = bucket()));
      b.requests++;
      b.cu += cu;
      if (outcome !== "ok") b.errors++;
      if (outcome === "timeout") b.timeouts++;
      if (outcome === "rate-limited") b.rateLimited++;
    }
  }

  snapshot() {
    const hours = Math.max((Date.now() - this.startedAt) / 3_600_000, 1 / 60);
    const table = (map: Map<string, Bucket>) =>
      Object.fromEntries(
        [...map.entries()]
          .sort((a, b) => b[1].cu - a[1].cu)
          .map(([k, b]) => [k, { ...b, cuPerDay: Math.round((b.cu / hours) * 24) }])
      );
    const total = [...this.byMethod.values()].reduce((s, b) => s + b.cu, 0);
    return {
      since: new Date(this.startedAt).toISOString(),
      estimatedCuPerDay: Math.round((total / hours) * 24),
      byMethod: table(this.byMethod),
      byProvider: table(this.byProvider),
      failovers: this.failovers,
      subscriptionNotifications: this.subscriptionNotifications,
    };
  }
}

export const rpcMetrics = new RpcMetrics();

// ── the provider ───────────────────────────────────────────────────────────

type Backend = { label: string; provider: JsonRpcProvider; health: ProviderHealth };
const allBackends: Backend[] = [];

export function providerStatus(now = Date.now()) {
  return allBackends.map((b) => ({
    provider: b.label,
    healthy: b.health.isAvailable(now),
    cooldownSecondsLeft: Math.max(0, Math.round((b.health.openUntil - now) / 1000)),
    lastError: b.health.lastError,
  }));
}

const methodsOf = (payload: JsonRpcPayload | JsonRpcPayload[]) =>
  (Array.isArray(payload) ? payload : [payload]).map((p) => p.method);

/** An ethers provider over every configured endpoint, with failover + metrics. */
export class ResilientRpcProvider extends JsonRpcApiProvider {
  private readonly backends: Backend[];
  private lastUsed: string | null = null;

  /** @param timeoutMs per-request timeout. ethers' default is 5 minutes, which would
   *  hold a request on a hung provider that long before failing over. */
  constructor(urls: string[], chainId?: number, timeoutMs = Number(process.env.RPC_TIMEOUT_MS) || 15_000) {
    if (urls.length === 0) throw new Error("ResilientRpcProvider: no RPC URLs configured");
    const network = chainId ? Network.from(chainId) : undefined;
    // batchMaxCount 1: one JSON-RPC call per HTTP request, so a failover moves one call.
    super(network, { staticNetwork: network ?? null, batchMaxCount: 1 });
    this.backends = urls.map((url) => {
      const label = redactRpcUrl(url);
      const existing = allBackends.find((b) => b.label === label);
      if (existing) return existing; // share health per endpoint across clients
      const request = new FetchRequest(url);
      request.timeout = timeoutMs;
      const backend: Backend = {
        label,
        provider: new JsonRpcProvider(request, network, { staticNetwork: network ?? null, batchMaxCount: 1 }),
        health: new ProviderHealth(label),
      };
      allBackends.push(backend);
      return backend;
    });
  }

  async _send(payload: JsonRpcPayload | JsonRpcPayload[]): Promise<Array<JsonRpcResult | JsonRpcError>> {
    const methods = methodsOf(payload);
    const order = pickProviderOrder(
      this.backends.map((b) => b.health),
      Date.now()
    );
    let lastError: unknown = new Error("no RPC provider available");
    let failedOver = false;
    for (const index of order) {
      const backend = this.backends[index];
      try {
        const results = await backend.provider._send(payload);
        // A malformed answer (no result, no error — seen from overloaded public nodes)
        // is the provider's fault: try the next one rather than fail the call.
        const malformed = results.length !== methods.length || results.some((r) => !("result" in r) && !("error" in r));
        if (malformed) throw Object.assign(new Error("malformed JSON-RPC response"), { code: "BAD_DATA" });
        // A rate limit can also come back as a JSON-RPC error inside a 200 response.
        const limited = results.find((r) => "error" in r && classifyRpcError(r) === "rate-limited");
        if (limited) throw Object.assign(new Error("rate limited"), { code: 429 });
        backend.health.recordSuccess();
        for (const m of methods) rpcMetrics.record(backend.label, m, "ok");
        if (failedOver) rpcMetrics.failovers++;
        if (this.lastUsed !== backend.label) {
          if (this.lastUsed !== null || failedOver) {
            console.warn(`[rpc] now using ${backend.label}${this.lastUsed ? ` (was ${this.lastUsed})` : ""}`);
          }
          this.lastUsed = backend.label;
        }
        return results;
      } catch (error) {
        const kind = classifyRpcError(error);
        for (const m of methods) {
          rpcMetrics.record(backend.label, m, kind === "timeout" ? "timeout" : kind === "rate-limited" ? "rate-limited" : "error");
        }
        if (kind === "deterministic") throw error;
        lastError = error;
        failedOver = true;
        const message = error instanceof Error ? error.message.split("\n")[0] : String(error);
        if (backend.health.recordFailure(kind, Date.now(), message)) {
          console.warn(`[rpc] ${backend.label} marked unhealthy (${kind}); cooling down`);
        }
      }
    }
    throw lastError;
  }
}

/** The provider every server component should use for HTTP reads/writes. */
export function createRpcProvider(urls: string[], chainId?: number): ResilientRpcProvider {
  return new ResilientRpcProvider(urls, chainId);
}
