"use client";

import { useEffect, useRef, useState } from "react";
import type { ChatMessage } from "@pooldawgs/shared";
import { shortAddress } from "@/lib/format";
import { IconClose } from "@/components/icons";

interface ChatProps {
  messages: ChatMessage[];
  myAddress: string | null;
  onSend: (text: string) => void;
  /** Optional collapse handler — renders a × in the header when provided. */
  onClose?: () => void;
}

export default function Chat({ messages, myAddress, onSend, onClose }: ChatProps) {
  const [draft, setDraft] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages]);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const text = draft.trim();
    if (!text) return;
    onSend(text);
    setDraft("");
  }

  return (
    <div className="panel flex h-full min-h-0 flex-col overflow-hidden">
      <div className="flex items-center justify-between border-b border-gold-dim/30 px-4 py-2.5">
        <span className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.2em] text-gold">
          <span className="h-1.5 w-1.5 rounded-full bg-gold-bright shadow-gold-glow" />
          Table talk
        </span>
        {onClose && (
          <button
            onClick={onClose}
            aria-label="Close chat"
            className="rounded-md p-1 text-cream/50 transition hover:bg-gold/10 hover:text-gold-bright"
          >
            <IconClose className="h-4 w-4" />
          </button>
        )}
      </div>

      <div ref={scrollRef} className="flex-1 space-y-2 overflow-y-auto px-4 py-3 text-sm">
        {messages.length === 0 && (
          <p className="mt-2 text-center text-xs text-cream/35">
            Say something to your opponent…
          </p>
        )}
        {messages.map((m, i) => {
          const mine = myAddress && m.from.toLowerCase() === myAddress.toLowerCase();
          return (
            <div key={i} className={`flex flex-col ${mine ? "items-end" : "items-start"}`}>
              <span className="px-1 text-[10px] uppercase tracking-wider text-cream/40">
                {mine ? "You" : shortAddress(m.from)}
              </span>
              <span
                className={`max-w-[85%] rounded-2xl px-3 py-1.5 text-sm leading-snug ${
                  mine
                    ? "rounded-br-sm bg-gold/15 text-cream"
                    : "rounded-bl-sm bg-emerald-deep/70 text-cream/90"
                }`}
              >
                {m.text}
              </span>
            </div>
          );
        })}
      </div>

      <form onSubmit={submit} className="flex gap-2 border-t border-gold-dim/30 p-2.5">
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          maxLength={280}
          placeholder="Message…"
          className="min-w-0 flex-1 rounded-lg border border-gold-dim/40 bg-emerald-deep px-3 py-2 text-sm outline-none transition focus:border-gold"
        />
        <button type="submit" disabled={!draft.trim()} className="btn-gold px-4 py-2 text-sm">
          Send
        </button>
      </form>
    </div>
  );
}
