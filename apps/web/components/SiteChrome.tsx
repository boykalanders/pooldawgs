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

const NAV = [
  { href: "/lobby", label: "Lobby" },
  { href: "/practice", label: "Practice" },
  { href: "/leaderboard", label: "Leaderboard" },
  { href: "/profile", label: "Profile" },
];

export function SiteHeader() {
  const onGamePage = useIsGamePage();
  const pathname = usePathname();
  return (
    <header
      data-testid="site-header"
      className={`sticky top-0 z-40 items-center justify-between border-b border-gold-dim/25 bg-emerald-deep/80 px-6 py-2.5 backdrop-blur-md ${
        onGamePage ? "hidden desktop:flex" : "flex"
      }`}
    >
      <div className="flex items-center gap-8">
        <Link href="/" className="flex items-center gap-2 transition hover:drop-shadow-[0_0_14px_rgba(201,162,39,0.4)]">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/assets/logo.svg" alt="Pool Dawgs" className="h-11 w-auto" draggable={false} />
        </Link>
        <nav className="hidden items-center gap-1 sm:flex">
          {NAV.map((item) => {
            const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
            return (
              <Link
                key={item.href}
                href={item.href}
                className={`relative rounded-lg px-3 py-1.5 text-sm tracking-wide transition ${
                  active
                    ? "text-gold-bright"
                    : "text-cream/70 hover:text-gold-bright"
                }`}
              >
                {item.label}
                {active && (
                  <span className="absolute inset-x-2 -bottom-0.5 h-px bg-gradient-to-r from-transparent via-gold to-transparent" />
                )}
              </Link>
            );
          })}
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
      className={`relative border-t border-gold-dim/20 px-6 py-3 text-center text-xs text-cream/45 ${
        onGamePage ? "hidden desktop:block" : "block"
      }`}
    >
      <span className="absolute inset-x-0 top-0 mx-auto h-px w-1/3 bg-gradient-to-r from-transparent via-gold/40 to-transparent" />
      Winner takes 80% · 10% company · 10% <span className="text-burn">burned</span> 🔥
      <span className="mx-2 text-gold-dim/40">·</span>
      <span className="tracking-wide text-cream/60">Deputy Dawgs ecosystem</span>
    </footer>
  );
}
