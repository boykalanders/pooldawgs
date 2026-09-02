import Link from "next/link";

const VARIANTS = [
  { ball: "/assets/balls/ball-8.png", label: "8-Ball" },
  { ball: "/assets/balls/ball-9.png", label: "9-Ball" },
  { ball: "/assets/balls/ball-red.png", label: "Snooker" },
];

const FEATURES = [
  {
    icon: "🎟️",
    title: "NFT-gated",
    body: "Deputy Dawgs holders only. Your Dawg is your seat at the table.",
  },
  {
    icon: "⚖️",
    title: "Server-refereed",
    body: "Every shot is simulated by the house engine. Nobody's browser decides a wager.",
  },
  {
    icon: "⏱️",
    title: "4-minute shot clock",
    body: "Slow play forfeits. Resigning counts as a loss. No draws on this table.",
  },
];

export default function HomePage() {
  return (
    <div className="flex flex-col items-center gap-12 py-10 text-center">
      {/* ── Hero ── */}
      <section className="panel panel-gilt relative w-full max-w-4xl overflow-hidden bg-felt-radial px-6 py-14 shadow-felt-inset">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src="/assets/watermark.svg"
          alt=""
          className="pointer-events-none absolute left-1/2 top-1/2 w-[150%] max-w-none -translate-x-1/2 -translate-y-1/2 opacity-[0.06]"
          draggable={false}
        />
        <div className="relative flex flex-col items-center gap-7">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/assets/logo.svg" alt="Pool Dawgs" className="h-20 w-auto drop-shadow-[0_6px_18px_rgba(0,0,0,0.6)]" draggable={false} />
          <h1 className="heading-display text-5xl font-bold leading-tight sm:text-6xl">
            Rack &rsquo;em. <span className="text-cream">Stake &rsquo;em.</span>
          </h1>
          <p className="max-w-xl text-lg text-cream/70">
            Wagered 2D pool for the Deputy Dawgs pack. Stake{" "}
            <span className="text-gold-bright">$DDawgs</span>, sink the money ball, take the
            pot. Winner gets 80% — 10% to the house, 10%{" "}
            <span className="text-burn">burned forever</span>.
          </p>

          <div className="flex items-center gap-3">
            {VARIANTS.map((v) => (
              <span
                key={v.label}
                className="flex items-center gap-2 rounded-full border border-gold-dim/40 bg-emerald-deep/60 px-4 py-1.5 text-sm font-semibold text-cream/80"
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={v.ball} alt="" className="h-6 w-6 rounded-full object-cover" draggable={false} />
                {v.label}
              </span>
            ))}
          </div>

          <div className="mt-2 flex flex-wrap items-center justify-center gap-5">
            <Link
              href="/lobby"
              className="transition hover:scale-105 hover:drop-shadow-[0_0_18px_rgba(201,162,39,0.55)]"
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src="/assets/pooldawgs_ico/play_btn.png" alt="Play — choose your game" className="h-24 w-auto" draggable={false} />
            </Link>
            <Link href="/practice" className="btn-outline text-lg">
              Practice table
            </Link>
          </div>
        </div>
      </section>

      {/* ── Feature cards ── */}
      <div className="grid w-full max-w-4xl grid-cols-1 gap-5 text-left sm:grid-cols-3">
        {FEATURES.map((f) => (
          <div key={f.title} className="panel panel-gilt p-6 transition hover:border-gold/50">
            <div className="mb-3 flex h-11 w-11 items-center justify-center rounded-xl border border-gold-dim/40 bg-emerald-deep/60 text-xl shadow-gold-glow">
              {f.icon}
            </div>
            <h3 className="mb-1 font-display text-lg font-semibold text-gold">{f.title}</h3>
            <p className="text-sm text-cream/60">{f.body}</p>
          </div>
        ))}
      </div>
    </div>
  );
}
