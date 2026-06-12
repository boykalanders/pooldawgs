import { verifyMessage } from "ethers";
import { AUTH_TTL_MS, loginMessage, type AuthPayload, type Address } from "@pooldawgs/shared";

/**
 * Verifies a wallet-signature login. The client signs loginMessage(address, ts)
 * with the wallet it claims; we recover the signer and check freshness.
 * Returns the authenticated address (lowercased) or null.
 */
export function verifyAuth(payload: AuthPayload, now = Date.now()): Address | null {
  if (!payload || typeof payload.signature !== "string") return null;
  if (typeof payload.ts !== "number" || Math.abs(now - payload.ts) > AUTH_TTL_MS) {
    return null;
  }
  try {
    const recovered = verifyMessage(
      loginMessage(payload.address, payload.ts),
      payload.signature
    );
    if (recovered.toLowerCase() !== payload.address.toLowerCase()) return null;
    return payload.address.toLowerCase() as Address;
  } catch {
    return null;
  }
}
