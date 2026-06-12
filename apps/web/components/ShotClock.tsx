"use client";

import { useEffect, useState } from "react";

/** 4-minute shot clock display. The server is the enforcer; this just shows it. */
export default function ShotClock({ expiresAt }: { expiresAt: number }) {
  const [remaining, setRemaining] = useState(() => Math.max(0, expiresAt - Date.now()));

  useEffect(() => {
    const interval = setInterval(() => {
      setRemaining(Math.max(0, expiresAt - Date.now()));
    }, 250);
    return () => clearInterval(interval);
  }, [expiresAt]);

  const totalSeconds = Math.ceil(remaining / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  const urgent = totalSeconds <= 30;

  return (
    <div
      className={`panel flex items-center gap-2 px-4 py-2 font-mono text-xl ${
        urgent ? "border-burn text-burn shadow-burn-glow" : "text-gold-bright"
      }`}
      title="Shot clock — run out of time and you forfeit the game"
    >
      <span className="text-xs uppercase tracking-widest opacity-60">Shot clock</span>
      <span>
        {minutes}:{seconds.toString().padStart(2, "0")}
      </span>
    </div>
  );
}
