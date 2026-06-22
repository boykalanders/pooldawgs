# Babylon.js + Havok — recommendation

**Short version:** Yes to Babylon.js for **rendering** (the visual upgrade). **No**
to Havok as the **authoritative game physics** — for a *wagered* game it breaks
the security model. Keep the deterministic TypeScript engine as the referee;
let Babylon be the camera and the art. This is exactly what the physics spec
already calls for: *"Babylon becomes primarily a visual upgrade, ensuring Pool
Dawgs keeps the exact same satisfying gameplay players already tested."*

## Why Havok can't be the authority

PoolDawgs is server-authoritative because real $DDawgs is staked: the **server**
simulates every shot and decides the winner (`finishGame`), and each client
re-simulates the same shot to animate it. That only works if server and client
compute **bit-identical** outcomes from the same input. Our TS engine is built
for that — pure functions, fixed 120 Hz timestep, no `Math.random` in
resolution, a `stateHash` both sides compare.

Havok (and any production 3D physics engine) is **not deterministic across
machines**: it uses fast platform-specific floating point, SIMD, and solver
iteration orders that differ between the server's Node/WASM build and a phone
GPU/browser. Two players on different devices would diverge mid-rack, and the
server's result wouldn't match what either player saw. For a betting game that's
not a polish issue — it's "who actually won the pot" being unverifiable. Studios
that use Havok for pool do it in a **single-authority** setup (one machine
simulates, everyone else just watches the stream); they don't trust clients.

So the options are:
1. **Server runs Havok headless as the single authority; clients render the
   broadcast.** Workable, but it throws away client-side prediction (every shot
   waits a server round-trip before it animates) and adds a heavy native
   dependency to the backend. Big rewrite, worse feel on mobile latency.
2. **Keep the deterministic TS engine as authority; Babylon renders it.**
   Recommended. We already have #2's hard part done and tuned to the spec.

## Recommended architecture (when approved)

```
packages/engine  (unchanged)  ← authoritative, deterministic, server + client
        │ frames + endState
        ▼
apps/web/render-babylon         ← NEW: Babylon scene that PLAYS BACK engine frames
   • 3D table / balls / cue, lighting, camera        (visual only)
   • optional Havok purely for non-authoritative eye-candy (cloth, debris)
   • input → still {angle, power, spin} → server, same as today
```

The engine already emits exactly what a renderer needs: per-frame ball
positions (`simulateShot(..., { recordFrames: true })`) and collision/pocket
events for sound and effects. Babylon swaps in where the 2D `<canvas>` renderer
is today — same inputs, same authoritative state, just drawn in 3D. Nothing in
the contract, server, lobby, or rules changes.

## What we did instead, now (per the spec's "fork first" gate)

The spec says don't start Babylon until the 2D feel is approved. Addressing the
two concrete bits of feedback in the current fork:

- **"Hard on phone"** — reworked touch controls. Dragging the table now *only
  aims*; the **power slider** is the deliberate shoot trigger (drag up, release).
  Previously the same finger-press both aimed and charged power, which fought
  itself. Mouse keeps hold-to-charge / click / W-S / Space.
- **"The way it stops"** — softened the end-of-roll. Rolling resistance is now a
  small constant term plus speed-proportional drag, so balls *ease* to rest
  instead of braking hard into a snap-to-zero (full-power settle 1.8 s → 2.8 s,
  stop threshold 6 → 2.5 px/s). Full-power distance stays in spec (≈3.9 table
  lengths); all six playtest-checklist tests still pass.

When you're happy with the 2D feel, say the word and I'll scaffold
`render-babylon` as a drop-in 3D view over the same engine — low risk, because
the gameplay that's already tuned doesn't move.
