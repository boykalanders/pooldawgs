// Short, human-shareable game codes — these ARE the on-chain gameId string.
// ChessDawgs-style: create → get a code → an opponent joins with it.
//
// The code's PREFIX encodes the variant, so the variant rides along with the
// gameId everywhere (no contract change, no extra storage): the web mints the
// prefixed code, the contract stores it verbatim, and the server reads the
// prefix back to build the right table. Both sides import this one module so
// the convention can never drift between them.
import type { GameType } from "@pooldawgs/engine";

// Ambiguous characters (I, L, O, 0, 1) are excluded so codes read aloud / type
// cleanly. Prefixes also avoid those letters.
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

/** Variant → code prefix. e.g. 9-ball codes look like "P9-7K3Q2". */
export const GAME_TYPE_PREFIX: Record<GameType, string> = {
  "8ball": "P8",
  "9ball": "P9",
  snooker: "SN",
};

/** Variant → display label for UI chrome. */
export const GAME_TYPE_LABEL: Record<GameType, string> = {
  "8ball": "8-Ball",
  "9ball": "9-Ball",
  snooker: "Snooker",
};

export const GAME_TYPES: GameType[] = ["8ball", "9ball", "snooker"];

// Prefixes we accept on input. "POOL" is the legacy prefix from before variant
// selection existed — those games are all 8-ball.
const PREFIX_TO_TYPE: Record<string, GameType> = {
  P8: "8ball",
  P9: "9ball",
  SN: "snooker",
  POOL: "8ball",
};

/** Derive the variant from a gameId. Unknown / legacy prefixes are 8-ball. */
export function gameTypeFromId(gameId: string): GameType {
  const up = gameId.trim().toUpperCase();
  const prefix = up.split("-")[0];
  return PREFIX_TO_TYPE[prefix] ?? "8ball";
}

// Web Crypto is a global in both the browser and Node 18+, but the shared
// package compiles with lib: ["ES2022"] (no DOM), so reach it through a
// structurally-typed globalThis instead of the ambient `crypto` name.
function randomBytes(n: number): Uint8Array {
  const bytes = new Uint8Array(n);
  const webcrypto = (globalThis as {
    crypto?: { getRandomValues<T extends ArrayBufferView>(array: T): T };
  }).crypto;
  if (webcrypto?.getRandomValues) return webcrypto.getRandomValues(bytes);
  // Exotic runtime with no Web Crypto — codes aren't secrets, so a weak source
  // is acceptable here purely as a last resort.
  for (let i = 0; i < n; i++) bytes[i] = Math.floor(Math.random() * 256);
  return bytes;
}

/** Mint a fresh code for the given variant, e.g. newGameCode("snooker") → "SN-9PQ4K". */
export function newGameCode(gameType: GameType = "8ball"): string {
  let s = "";
  for (const b of randomBytes(5)) s += ALPHABET[b % ALPHABET.length];
  return `${GAME_TYPE_PREFIX[gameType]}-${s}`;
}

/** Accept a raw code, a prefixed code, or a pasted invite link → canonical code. */
export function normalizeCode(input: string): string {
  let t = input.trim();
  const fromLink = t.match(/join=([^&\s]+)/i);
  if (fromLink) t = decodeURIComponent(fromLink[1]);
  t = t.toUpperCase().replace(/\s+/g, "");
  if (!t) return "";
  const prefix = t.split("-")[0];
  // Already carries a recognized prefix (and a dash) → leave it alone.
  if (t.includes("-") && prefix in PREFIX_TO_TYPE) return t;
  // A bare body with no prefix can't carry a variant; assume legacy 8-ball.
  return `P8-${t}`;
}
