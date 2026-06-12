import Link from "next/link";

export default function HomePage() {
  return (
    <div className="flex flex-col items-center gap-10 py-16 text-center">
      <h1 className="heading-display text-6xl font-bold">
        Rack &rsquo;em. <span className="text-amber-50">Stake &rsquo;em.</span>
      </h1>
      <p className="max-w-xl text-lg text-amber-100/70">
        Wagered 2D 8-ball for the Deputy Dawgs pack. Stake{" "}
        <span className="text-gold-bright">$DDawgs</span>, sink the black, take
        the pot. Winner gets 80% — 10% to the house, 10%{" "}
        <span className="text-burn">burned forever</span>.
      </p>
      <div className="flex items-center gap-6">
        <Link href="/lobby" className="transition hover:scale-105 hover:drop-shadow-[0_0_16px_rgba(201,162,39,0.5)]">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/assets/play-btn.svg"
            alt="Play — choose your game"
            className="h-24 w-auto"
            draggable={false}
          />
        </Link>
        <Link href="/practice" className="btn-outline text-lg">
          Practice table
        </Link>
      </div>
      <div className="panel mt-8 grid max-w-3xl grid-cols-1 gap-6 p-8 text-left sm:grid-cols-3">
        <div>
          <h3 className="mb-1 font-semibold text-gold">NFT-gated</h3>
          <p className="text-sm text-amber-100/60">
            Deputy Dawgs holders only. Your Dawg is your seat at the table.
          </p>
        </div>
        <div>
          <h3 className="mb-1 font-semibold text-gold">Server-refereed</h3>
          <p className="text-sm text-amber-100/60">
            Every shot is simulated by the house engine. Nobody&rsquo;s browser
            decides who wins a wager.
          </p>
        </div>
        <div>
          <h3 className="mb-1 font-semibold text-gold">4-minute shot clock</h3>
          <p className="text-sm text-amber-100/60">
            Slow play forfeits. Resigning counts as a loss. No draws on this
            table.
          </p>
        </div>
      </div>
    </div>
  );
}
