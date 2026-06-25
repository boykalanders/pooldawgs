// Synthesized UI jingles for the end-of-game modals — a triumphant fanfare for
// Victory, a somber fall for Defeat. Generated with the Web Audio API so no
// audio asset has to ship. Respects a module-level mute that GameShell keeps in
// sync with its Sound toggle (the table SFX use a separate per-call `muted`).

let soundsMuted = false;
export function setSoundsMuted(m: boolean): void {
  soundsMuted = m;
}

let ctx: AudioContext | null = null;
function getCtx(): AudioContext | null {
  if (typeof window === "undefined") return null;
  const AC = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AC) return null;
  if (!ctx) ctx = new AC();
  // Autoplay policy: resume after the user has interacted (they took a shot to
  // reach game over, so the context is unlocked).
  if (ctx.state === "suspended") void ctx.resume().catch(() => {});
  return ctx;
}

/** One enveloped note: quick attack, exponential decay — no clicks. */
function note(
  ac: AudioContext,
  freq: number,
  startAt: number,
  dur: number,
  gain: number,
  type: OscillatorType
): void {
  const t0 = ac.currentTime + startAt;
  const osc = ac.createOscillator();
  const g = ac.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t0);
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(gain, t0 + 0.02);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  osc.connect(g).connect(ac.destination);
  osc.start(t0);
  osc.stop(t0 + dur + 0.05);
}

/** Triumphant ascending C-major arpeggio capped by a bright chord. */
export function playVictory(): void {
  if (soundsMuted) return;
  const ac = getCtx();
  if (!ac) return;
  const arp = [523.25, 659.25, 783.99, 1046.5]; // C5 E5 G5 C6
  arp.forEach((f, i) => note(ac, f, i * 0.12, 0.45, 0.2, "triangle"));
  // Sustained chord underneath the final note.
  [523.25, 659.25, 783.99].forEach((f) => note(ac, f, 0.46, 0.8, 0.12, "sawtooth"));
}

/** Somber descending minor fall for a loss. */
export function playDefeat(): void {
  if (soundsMuted) return;
  const ac = getCtx();
  if (!ac) return;
  const fall = [392.0, 311.13, 261.63, 196.0]; // G4 → E♭4 → C4 → G3
  fall.forEach((f, i) => note(ac, f, i * 0.2, 0.7, 0.18, "sine"));
}
