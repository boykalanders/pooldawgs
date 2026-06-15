// The code/variant convention lives in @pooldawgs/shared so the server reads
// the exact same prefixes the web mints. Re-exported here for local imports.
export {
  GAME_TYPE_PREFIX,
  GAME_TYPE_LABEL,
  GAME_TYPES,
  gameTypeFromId,
  newGameCode,
  normalizeCode,
} from "@pooldawgs/shared";

/** Invite link an opponent can open to land on the prefilled join box. */
export function inviteLink(code: string): string {
  const origin = typeof window !== "undefined" ? window.location.origin : "";
  return `${origin}/lobby?join=${encodeURIComponent(code)}`;
}
