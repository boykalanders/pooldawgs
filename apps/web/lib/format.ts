import { formatUnits } from "viem";

export function shortAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

export function formatStake(wei: string | bigint): string {
  const value = formatUnits(typeof wei === "bigint" ? wei : BigInt(wei), 18);
  // Trim trailing zeros for display.
  return `${Number(value).toLocaleString(undefined, { maximumFractionDigits: 4 })} $DDawgs`;
}
