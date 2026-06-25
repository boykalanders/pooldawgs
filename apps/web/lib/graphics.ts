// Graphics quality settings for the 3D table. The client asked for visual
// effects "in balance without affecting performance", with desktop getting
// on/off switches for individual effects and phones defaulting to a sensible
// balanced preset. Settings persist in localStorage and seed from the device.

export interface GraphicsSettings {
  /** Environment reflections on balls / gold / rails (glossy vs matte). */
  reflections: boolean;
  /** Ball shadows cast on the cloth. */
  shadows: boolean;
  /** Render at the device pixel ratio (capped 2×) vs 1× — sharper but heavier. */
  highRes: boolean;
}

// v3: default is now shadows-OFF (clean, like the 2D table) with reflections +
// high-res on — bumping the key so existing visitors pick up the new default.
const KEY = "pooldawgs.graphics.v3";

/** Coarse "is this a phone/tablet" check (pointer:coarse ≈ touch primary). */
export function isTouchPrimary(): boolean {
  if (typeof window === "undefined") return false;
  return window.matchMedia?.("(pointer: coarse)").matches ?? false;
}

/** Default: shadows OFF for a clean look that matches the 2D table (client
 *  preference); reflections + high-res stay on for the glossy 3D look. Users can
 *  switch shadows on via the Quality gear. */
export function defaultGraphics(): GraphicsSettings {
  return {
    reflections: true,
    shadows: false, // matches the shadowless 2D table look
    highRes: true, // resolution "up a notch" (DPR is capped at 2× for perf)
  };
}

export function loadGraphics(): GraphicsSettings {
  const base = defaultGraphics();
  if (typeof window === "undefined") return base;
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return base;
    const saved = JSON.parse(raw) as Partial<GraphicsSettings>;
    return {
      reflections: saved.reflections ?? base.reflections,
      shadows: saved.shadows ?? base.shadows,
      highRes: saved.highRes ?? base.highRes,
    };
  } catch {
    return base;
  }
}

export function saveGraphics(g: GraphicsSettings): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(KEY, JSON.stringify(g));
  } catch {
    /* ignore quota / privacy-mode errors */
  }
}

/** Stable string used to re-key the 3D scene so it rebuilds when settings change. */
export function graphicsKey(g: GraphicsSettings): string {
  return `${g.reflections ? "r" : "-"}${g.shadows ? "s" : "-"}${g.highRes ? "h" : "-"}`;
}
