"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ConnectButton } from "@rainbow-me/rainbowkit";

/** Game pages provide their own bottom navigation (the shell nav), so the
 *  site chrome can get out of the way on touch devices there. */
function useIsGamePage(): boolean {
  const pathname = usePathname();
  return pathname.startsWith("/game/") || pathname === "/practice";
}

export function SiteHeader() {
  const onGamePage = useIsGamePage();
  return (
    <header
      data-testid="site-header"
      className={`items-center justify-between border-b border-gold-dim/30 px-6 py-2 ${
        onGamePage ? "hidden desktop:flex" : "flex"
      }`}
    >
      <div className="flex items-center gap-8">
        <Link href="/" className="flex items-center gap-2">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/assets/logo.svg"
            alt="Pool Dawgs"
            className="h-12 w-auto"
            draggable={false}
          />
        </Link>
        <nav className="flex gap-6 text-sm text-amber-100/80">
          <Link href="/lobby" className="transition hover:text-gold-bright">
            Lobby
          </Link>
          <Link href="/practice" className="transition hover:text-gold-bright">
            Practice table
          </Link>
          <Link href="/leaderboard" className="transition hover:text-gold-bright">
            Leaderboard
          </Link>
        </nav>
      </div>
      <ConnectButton showBalance={false} />
    </header>
  );
}

export function SiteFooter() {
  const onGamePage = useIsGamePage();
  return (
    <footer
      className={`border-t border-gold-dim/20 px-6 py-2 text-center text-xs text-amber-100/40 ${
        onGamePage ? "hidden desktop:block" : "block"
      }`}
    >
      Winner takes 80% · 10% company · 10% <span className="text-burn">burned</span> 🔥
      — Deputy Dawgs ecosystem
    </footer>
  );
}
