"use client";

import { useEffect, useState } from "react";
import { serverNow } from "@/lib/serverClock";

/** 4-minute shot clock display. The server is the enforcer; this just shows it.
 *  Counts down against the server's clock (skew-corrected) so it matches the
 *  authoritative timeout regardless of the client's wall-clock accuracy. */
export default function ShotClock({ expiresAt }: { expiresAt: number }) {
  const [remaining, setRemaining] = useState(() => Math.max(0, expiresAt - serverNow()));

  useEffect(() => {
    const interval = setInterval(() => {
      setRemaining(Math.max(0, expiresAt - serverNow()));
    }, 250);
    return () => clearInterval(interval);
  }, [expiresAt]);

  const totalSeconds = Math.ceil(remaining / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  const urgent = totalSeconds <= 30;
  // Final 10 seconds: blow the clock up big and pulse it for emphasis.
  const critical = totalSeconds <= 10 && remaining > 0;

  return (
    <div
      className={`panel flex origin-top items-center gap-2 font-mono tabular-nums transition-all duration-200 ${
        critical
          ? "animate-pulse scale-110 border-burn px-6 py-3 text-burn shadow-burn-glow"
          : urgent
            ? "border-burn px-4 py-2 text-xl text-burn shadow-burn-glow"
            : "px-4 py-2 text-xl text-gold-bright"
      }`}
      title="Shot clock — run out of time and you forfeit the game"
    >
      <span className="text-[10px] uppercase tracking-widest opacity-70">
        {critical ? "Hurry" : "Shot clock"}
      </span>
      <span className={critical ? "text-4xl font-extrabold leading-none" : ""}>
        {minutes}:{seconds.toString().padStart(2, "0")}
      </span>
    </div>
  );
}
