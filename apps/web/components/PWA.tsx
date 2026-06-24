"use client";

import { useEffect } from "react";

/** Registers the PWA service worker (production only) so the app is installable
 *  and loads app-like offline. No-ops where service workers aren't supported. */
export function PWA() {
  useEffect(() => {
    if (
      typeof navigator !== "undefined" &&
      "serviceWorker" in navigator &&
      process.env.NODE_ENV === "production"
    ) {
      navigator.serviceWorker.register("/sw.js").catch(() => {});
    }
  }, []);
  return null;
}
