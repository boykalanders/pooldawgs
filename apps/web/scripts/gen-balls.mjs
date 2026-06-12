// Generates crisp geometric SVGs for the 16 balls (matching the client's
// numbered-ball art style) plus the $DDawgs paw token.
// Run: node scripts/gen-balls.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "public", "assets", "balls");
fs.mkdirSync(OUT, { recursive: true });

// Classic palette (stripe n shares the hue of n−8) — keep in sync with lib/balls.ts.
const COLORS = {
  1: "#f0b90b",
  2: "#1f4fd8",
  3: "#d2122e",
  4: "#6a2c91",
  5: "#ef7d14",
  6: "#0f7a3d",
  7: "#7a1f2b",
  8: "#101014",
};

function lighten(hex, amount = 70) {
  const n = parseInt(hex.slice(1), 16);
  const r = Math.min(255, ((n >> 16) & 0xff) + amount);
  const g = Math.min(255, ((n >> 8) & 0xff) + amount);
  const b = Math.min(255, (n & 0xff) + amount);
  return `rgb(${r},${g},${b})`;
}

function ballSvg({ number, kind }) {
  const color = kind === "cue" ? "#f5efe0" : COLORS[number <= 8 ? number : number - 8];
  const base = kind === "stripe" || kind === "cue" ? "#f7f2e4" : color;

  const stripe =
    kind === "stripe"
      ? `<g clip-path="url(#c)"><rect x="0" y="24" width="100" height="52" fill="${color}"/></g>`
      : "";

  const label =
    kind === "cue"
      ? `<circle cx="50" cy="50" r="9" fill="none" stroke="#c0272d" stroke-width="4"/>`
      : `<circle cx="50" cy="50" r="21" fill="#f7f2e4"/>
  <text x="50" y="51" font-family="Georgia, 'Times New Roman', serif" font-size="26" font-weight="bold" fill="#16120e" text-anchor="middle" dominant-baseline="central">${number}</text>`;

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <defs>
    <radialGradient id="g" cx="0.36" cy="0.3" r="0.85">
      <stop offset="0" stop-color="${lighten(base.startsWith("#") ? base : "#f7f2e4")}"/>
      <stop offset="0.55" stop-color="${base}"/>
      <stop offset="1" stop-color="${base}"/>
    </radialGradient>
    <clipPath id="c"><circle cx="50" cy="50" r="48"/></clipPath>
    <radialGradient id="s" cx="0.5" cy="0.45" r="0.6">
      <stop offset="0.7" stop-color="rgba(0,0,0,0)"/>
      <stop offset="1" stop-color="rgba(0,0,0,0.35)"/>
    </radialGradient>
  </defs>
  <circle cx="50" cy="50" r="48" fill="url(#g)"/>
  ${stripe}
  ${label}
  <circle cx="50" cy="50" r="48" fill="url(#s)"/>
  <ellipse cx="36" cy="29" rx="16" ry="9" transform="rotate(-32 36 29)" fill="rgba(255,255,255,0.55)"/>
  <circle cx="50" cy="50" r="48" fill="none" stroke="rgba(0,0,0,0.3)" stroke-width="1.5"/>
</svg>`;
}

// Solids 1–7, eight, stripes 9–15, cue.
for (let n = 1; n <= 15; n++) {
  const kind = n === 8 ? "eight" : n <= 7 ? "solid" : "stripe";
  fs.writeFileSync(path.join(OUT, `ball-${n}.svg`), ballSvg({ number: n, kind }));
}
fs.writeFileSync(path.join(OUT, "ball-cue.svg"), ballSvg({ number: null, kind: "cue" }));

// $DDawgs paw token (hand-built — the source JPG is too small to trace well).
const token = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <defs>
    <radialGradient id="coin" cx="0.4" cy="0.32" r="0.9">
      <stop offset="0" stop-color="#f0d77b"/>
      <stop offset="0.55" stop-color="#c9a227"/>
      <stop offset="1" stop-color="#8a6d1d"/>
    </radialGradient>
    <radialGradient id="inner" cx="0.42" cy="0.36" r="0.95">
      <stop offset="0" stop-color="#d9b54a"/>
      <stop offset="1" stop-color="#a07f22"/>
    </radialGradient>
  </defs>
  <circle cx="50" cy="50" r="48" fill="url(#coin)"/>
  <circle cx="50" cy="50" r="40" fill="url(#inner)" stroke="#7a611a" stroke-width="1.5"/>
  ${Array.from({ length: 24 }, (_, i) => {
    const a = (i / 24) * Math.PI * 2;
    const x = (50 + Math.cos(a) * 44).toFixed(1);
    const y = (50 + Math.sin(a) * 44).toFixed(1);
    return `<circle cx="${x}" cy="${y}" r="1.8" fill="#7a611a"/>`;
  }).join("\n  ")}
  <g fill="#2a1c0d">
    <ellipse cx="50" cy="60" rx="15" ry="12"/>
    <circle cx="35" cy="44" r="6"/>
    <circle cx="45" cy="38" r="6"/>
    <circle cx="55" cy="38" r="6"/>
    <circle cx="65" cy="44" r="6"/>
  </g>
  <ellipse cx="38" cy="26" rx="14" ry="6" transform="rotate(-28 38 26)" fill="rgba(255,244,200,0.5)"/>
</svg>`;
fs.writeFileSync(path.join(ROOT, "public", "assets", "token.svg"), token);

console.log("Wrote 16 ball SVGs + token.svg");
