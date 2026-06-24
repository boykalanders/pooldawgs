import type { Metadata, Viewport } from "next";
import { Providers } from "./providers";
import { SiteFooter, SiteHeader } from "@/components/SiteChrome";
import { PWA } from "@/components/PWA";
import "./globals.css";

export const metadata: Metadata = {
  title: "PoolDawgs — wagered pool for Deputy Dawgs",
  description:
    "Stake $DDawgs, rack 'em up. Premium 3D pool in the Deputy Dawgs ecosystem.",
  appleWebApp: { capable: true, statusBarStyle: "black-translucent", title: "PoolDawgs" },
};

// Golden Spec: mobile-first, fullscreen-friendly. viewport-fit=cover lets the
// game extend under notches; the safe-area insets (used in the game shell)
// keep the UI clear of them.
export const viewport: Viewport = {
  themeColor: "#0a0e0c",
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          href="https://fonts.googleapis.com/css2?family=Cinzel:wght@500;600;700;800&family=Inter:wght@400;500;600;700&display=swap"
          rel="stylesheet"
        />
      </head>
      <body>
        <Providers>
          <PWA />
          <SiteHeader />
          <main className="mx-auto w-full max-w-7xl px-4 py-3">{children}</main>
          <SiteFooter />
        </Providers>
      </body>
    </html>
  );
}
