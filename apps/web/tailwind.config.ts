import type { Config } from "tailwindcss";

/**
 * Deputy Dawgs premium theme — dark mahogany / black-walnut wood, metallic
 * gold trim, deep emerald cloth, gunmetal panels. Matches the Chess Dawgs
 * aesthetic rather than arcade styling.
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
        mahogany: {
          DEFAULT: "#3b1f17",
          dark: "#2a140e",
          deep: "#1c0d09",
        },
        walnut: "#241510",
        gold: {
          DEFAULT: "#c9a227",
          bright: "#e8c547",
          dim: "#8a6d1d",
        },
        cloth: {
          emerald: "#0b3d2e",
          midnight: "#102a43",
          crimson: "#4a1220",
        },
        gunmetal: {
          DEFAULT: "#23292f",
          dark: "#171b1f",
        },
        burn: "#ff6b35",
      },
      fontFamily: {
        display: ["Georgia", "Times New Roman", "serif"],
      },
      boxShadow: {
        "gold-glow": "0 0 12px rgba(201, 162, 39, 0.45)",
        "pocket-glow": "0 0 18px rgba(232, 197, 71, 0.6)",
        "burn-glow": "0 0 14px rgba(255, 107, 53, 0.55)",
      },
      backgroundImage: {
        "wood-grain":
          "linear-gradient(160deg, #3b1f17 0%, #2a140e 45%, #1c0d09 100%)",
        "gold-sheen":
          "linear-gradient(110deg, #8a6d1d 0%, #e8c547 50%, #8a6d1d 100%)",
      },
    },
  },
  plugins: [],
};

export default config;
