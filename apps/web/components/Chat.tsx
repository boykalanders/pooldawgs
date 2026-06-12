"use client";

import { useEffect, useRef, useState } from "react";
import type { ChatMessage } from "@pooldawgs/shared";
import { shortAddress } from "@/lib/format";

interface ChatProps {
  messages: ChatMessage[];
  myAddress: string | null;
  onSend: (text: string) => void;
}

export default function Chat({ messages, myAddress, onSend }: ChatProps) {
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
    <div className="panel flex h-72 flex-col">
      <div className="border-b border-gold-dim/30 px-4 py-2 text-xs font-semibold uppercase tracking-widest text-gold">
        Table talk
      </div>
      <div ref={scrollRef} className="flex-1 space-y-1 overflow-y-auto px-4 py-2 text-sm">
        {messages.length === 0 && (
          <p className="text-amber-100/40">Say something to your opponent…</p>
        )}
        {messages.map((m, i) => {
          const mine = myAddress && m.from.toLowerCase() === myAddress.toLowerCase();
          return (
            <p key={i}>
              <span className={mine ? "text-gold-bright" : "text-amber-100/60"}>
                {mine ? "you" : shortAddress(m.from)}:
              </span>{" "}
              <span className="text-amber-50">{m.text}</span>
            </p>
          );
        })}
      </div>
      <form onSubmit={submit} className="flex gap-2 border-t border-gold-dim/30 p-2">
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          maxLength={280}
          placeholder="Message…"
          className="flex-1 rounded-lg border border-gold-dim/40 bg-mahogany-deep px-3 py-1.5 text-sm outline-none focus:border-gold"
        />
        <button type="submit" className="btn-gold py-1.5 text-sm">
          Send
        </button>
      </form>
    </div>
  );
}
