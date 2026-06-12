import type { Metadata } from "next";
import { Providers } from "./providers";
import { SiteFooter, SiteHeader } from "@/components/SiteChrome";
import "./globals.css";

export const metadata: Metadata = {
  title: "PoolDawgs — wagered 8-ball for Deputy Dawgs",
  description:
    "Stake $DDawgs, rack 'em up. Premium 2D pool in the Deputy Dawgs ecosystem.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <Providers>
          <SiteHeader />
          <main className="mx-auto w-full max-w-7xl px-4 py-3">{children}</main>
          <SiteFooter />
        </Providers>
      </body>
    </html>
  );
}
