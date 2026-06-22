/**
 * Client/server clock-skew correction for the shot clock.
 *
 * The server issues an absolute `clockExpiresAt` (its own `Date.now()` +
 * shot-clock ms). If the client's wall clock differs from the server's, naively
 * rendering `expiresAt - Date.now()` shows a wrong countdown. Every snapshot /
 * shot also carries the server's `Date.now()`; we record the offset from it and
 * read time through `serverNow()` so the displayed clock matches the authority.
 */
let offsetMs = 0; // serverNow - clientNow at last sync

/** Record the server's clock from a message that just arrived. */
export function syncServerClock(serverNow: number): void {
  if (typeof serverNow === "number" && Number.isFinite(serverNow)) {
    offsetMs = serverNow - Date.now();
  }
}

/** The current time on the server's clock (best estimate). */
export function serverNow(): number {
  return Date.now() + offsetMs;
}
