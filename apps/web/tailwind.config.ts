import type { Config } from "tailwindcss";

/**
 * Deputy Dawgs / Chess Dawgs premium theme — deep emerald chess-felt surfaces,
 * metallic gold trim, cream type. The "mahogany"/"gunmetal" token names are
 * kept (now mapped to emerald shades) so the whole app reskins from one place.
 */
const config: Config = {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  theme: {
    extend: {
      screens: {
        /** Touch-first devices (phones/tablets) — pointer is coarse. */
        touch: { raw: "(pointer: coarse)" },
        /** Mouse-driven devices (PCs) — pointer is fine. */
        desktop: { raw: "(pointer: fine)" },
      },
      colors: {
        // Surface ramp (deep → light), formerly mahogany — now emerald.
        mahogany: {
          DEFAULT: "#0e2a20",
          dark: "#0a2017",
          deep: "#06130d",
        },
        emerald: {
          felt: "#0b3d2e",
          deep: "#06130d",
          panel: "#0c241b",
          rail: "#124a37",
        },
        walnut: "#0c2419",
        gold: {
          DEFAULT: "#c9a227",
          bright: "#e8c547",
          dim: "#8a7a3d",
        },
        cream: {
          DEFAULT: "#f5ecd6",
          dim: "#d8cba8",
        },
        cloth: {
          emerald: "#0b3d2e",
          midnight: "#102a43",
          crimson: "#4a1220",
        },
        // Panels — emerald gunmetal.
        gunmetal: {
          DEFAULT: "#123a2c",
          dark: "#0c241b",
        },
        burn: "#ff6b35",
      },
      fontFamily: {
        display: ["var(--font-display)", "Georgia", "Times New Roman", "serif"],
        sans: ["var(--font-sans)", "ui-sans-serif", "system-ui", "sans-serif"],
      },
      boxShadow: {
        "gold-glow": "0 0 12px rgba(201, 162, 39, 0.45)",
        "pocket-glow": "0 0 18px rgba(232, 197, 71, 0.6)",
        "burn-glow": "0 0 14px rgba(255, 107, 53, 0.55)",
        "felt-inset": "inset 0 1px 0 rgba(232,197,71,0.08), inset 0 0 40px rgba(0,0,0,0.45)",
      },
      backgroundImage: {
        "wood-grain":
          "linear-gradient(160deg, #124a37 0%, #0b3d2e 45%, #06130d 100%)",
        "gold-sheen":
          "linear-gradient(110deg, #8a6d1d 0%, #e8c547 50%, #8a6d1d 100%)",
        "felt-radial":
          "radial-gradient(ellipse at 50% 35%, #0f4634 0%, #0b3d2e 45%, #072017 100%)",
      },
    },
  },
  plugins: [],
};

export default config;
