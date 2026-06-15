import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MAX_USERNAME_LENGTH, type Address } from "@pooldawgs/shared";

/**
 * Per-wallet display names. Usernames are the one piece of profile data that
 * isn't on-chain or derivable, so we persist them to a JSON file in dataDir —
 * best-effort: it survives process restarts within a deployment. (On a fresh
 * deploy with an ephemeral filesystem they reset; swap for a DB to make them
 * durable, same as the in-memory lobby/leaderboard stores.)
 */
export class ProfileStore {
  private names = new Map<Address, string>();
  private readonly file: string;

  constructor(dataDir?: string) {
    this.file = join(dataDir || process.cwd(), "profiles.json");
    this.load();
  }

  /** Canonical display name for an address, or null if none set. */
  getName(address: Address): string | null {
    return this.names.get(address.toLowerCase() as Address) ?? null;
  }

  /**
   * Set (or, with an empty string, clear) a wallet's name. Returns the stored
   * value. Sanitizes: strips control characters, collapses whitespace, trims,
   * and caps the length.
   */
  setName(address: Address, raw: string): string | null {
    const key = address.toLowerCase() as Address;
    const clean = sanitize(raw);
    if (clean) this.names.set(key, clean);
    else this.names.delete(key);
    this.persist();
    return clean || null;
  }

  private load(): void {
    try {
      if (!existsSync(this.file)) return;
      const data = JSON.parse(readFileSync(this.file, "utf8")) as Record<string, string>;
      for (const [addr, name] of Object.entries(data)) {
        const clean = sanitize(name);
        if (clean) this.names.set(addr.toLowerCase() as Address, clean);
      }
      console.log(`[profile] loaded ${this.names.size} names from ${this.file}`);
    } catch (e) {
      console.error("[profile] could not load names:", e instanceof Error ? e.message : e);
    }
  }

  private persist(): void {
    try {
      mkdirSync(join(this.file, ".."), { recursive: true });
      writeFileSync(this.file, JSON.stringify(Object.fromEntries(this.names), null, 2));
    } catch (e) {
      console.error("[profile] could not persist names:", e instanceof Error ? e.message : e);
    }
  }
}

/** Drop control chars (code points < 0x20 and 0x7f), collapse whitespace, cap. */
function sanitize(raw: string): string {
  let out = "";
  for (const ch of raw) {
    const code = ch.codePointAt(0) ?? 0;
    out += code < 0x20 || code === 0x7f ? " " : ch;
  }
  return out.replace(/\s+/g, " ").trim().slice(0, MAX_USERNAME_LENGTH);
}
