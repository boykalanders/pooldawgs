// Short, human-shareable game codes (the on-chain gameId). ChessDawgs-style:
// create → get a code → an opponent joins with it. Ambiguous characters
// (I, L, O, 0, 1) are excluded so codes are easy to read aloud / type.
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

export function newGameCode(): string {
  const bytes = new Uint8Array(5);
  crypto.getRandomValues(bytes);
  let s = "";
  for (const b of bytes) s += ALPHABET[b % ALPHABET.length];
  return `POOL-${s}`;
}

/** Accept a raw code, a "POOL-XXXXX" code, or a pasted invite link. */
export function normalizeCode(input: string): string {
  let t = input.trim();
  const fromLink = t.match(/join=([^&\s]+)/i);
  if (fromLink) t = decodeURIComponent(fromLink[1]);
  t = t.toUpperCase().replace(/\s+/g, "");
  if (!t) return "";
  return t.startsWith("POOL-") ? t : `POOL-${t}`;
}

/** Invite link an opponent can open to land on the prefilled join box. */
export function inviteLink(code: string): string {
  const origin = typeof window !== "undefined" ? window.location.origin : "";
  return `${origin}/lobby?join=${encodeURIComponent(code)}`;
}
