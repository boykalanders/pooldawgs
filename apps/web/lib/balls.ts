import type { BallColor } from "@pooldawgs/engine";

/**
 * Ball appearance. Pool variants (8-ball / 9-ball) carry a printed `number`
 * and render via the numbered SVG art; snooker balls have no number and
 * render as solid colours (drawn in the canvas — no SVG needed).
 */
export interface BallStyle {
  number: number | null;
  kind: "solid" | "stripe" | "eight" | "cue" | "snooker";
  color: string;
}

/** Classic pool palette by ball number (stripe n shares the hue of n−8). */
const NUMBER_COLORS: Record<number, string> = {
  1: "#f0b90b",
  2: "#1f4fd8",
  3: "#d2122e",
  4: "#6a2c91",
  5: "#ef7d14",
  6: "#0f7a3d",
  7: "#7a1f2b",
  8: "#101014",
};

/** Snooker solid-ball colours. */
const SNOOKER_COLORS: Partial<Record<BallColor, string>> = {
  red: "#c0202a",
  yellow: "#e8c33a",
  green: "#1f7a3d",
  brown: "#7a4a1e",
  blue: "#1f4fd8",
  pink: "#e87fa6",
  black: "#15151a",
};

export interface BallLike {
  color: BallColor;
  number: number;
}

export function ballStyle(ball: BallLike): BallStyle {
  if (ball.color === "cue") return { number: null, kind: "cue", color: "#f5efe0" };
  if (ball.number === 0) {
    // Snooker red / colour — solid, no printed number.
    return { number: null, kind: "snooker", color: SNOOKER_COLORS[ball.color] ?? "#888" };
  }
  const n = ball.number;
  if (n === 8) return { number: 8, kind: "eight", color: NUMBER_COLORS[8] };
  if (n <= 7) return { number: n, kind: "solid", color: NUMBER_COLORS[n] };
  return { number: n, kind: "stripe", color: NUMBER_COLORS[n - 8] };
}

/**
 * PNG asset for a ball. Pool balls (1–15 + cue) render from their numbered
 * photoreal PNGs; snooker colour balls render from their solid colour PNGs.
 * Returns null only for a colour with no matching art (falls back to vector).
 */
export function ballAssetPath(ball: BallLike): string | null {
  const style = ballStyle(ball);
  if (style.kind === "cue") return "/assets/balls/ball-cue.png";
  if (style.number !== null) return `/assets/balls/ball-${style.number}.png`;
  // Snooker colour ball — solid photoreal PNG by colour name.
  if (ball.color in SNOOKER_COLORS) return `/assets/balls/ball-${ball.color}.png`;
  return null;
}

/** PNG asset by pool ball number (for HUD trackers). */
export function ballAssetByNumber(n: number): string {
  return `/assets/balls/ball-${n}.png`;
}

export function numberColor(n: number): string {
  return NUMBER_COLORS[n <= 8 ? n : n - 8];
}
