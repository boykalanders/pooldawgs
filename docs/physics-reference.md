# PoolDawgs — Ball Physics Reference

Every physics constant currently in the engine, its exact value, which backend it
applies to, and the file it lives in. Values are read out of source (commit
`2a18f95`, 9 Sep 2026) — not from the spec doc — so this reflects what actually runs.

---

## 0. Read this first

### We run TWO physics backends, and they do not share values

| | Backend | Where | Used by |
|---|---|---|---|
| **TS** | Custom deterministic 2-D solver | `packages/engine/src/physics.ts` + `constants.ts` | Practice (in-browser), and the fallback backend |
| **HV** | **Havok** (Babylon v2 + Havok WASM, headless `NullEngine`) | `packages/engine/src/havok/simulator.ts` | **The server — this decides real wagered matches** |

The server picks Havok unless `PHYSICS_BACKEND=ts` (`apps/server/src/config.ts:47`).
Where a parameter differs, both values are listed below. **Tune the backend that
matches the surface you're testing.**

### Scale

| | |
|---|---|
| Pixel↔metre | **545.67 px/m** (`PX_PER_M` = play length 1386 px ÷ 2.54 m) |
| Tick rate | **120 Hz** (`PHYSICS_FPS`, `DELTA = 1/120`) |
| Pool table | 1500 × 825 px total; playfield 1386 × 711 px = 2.54 × 1.30 m |
| Snooker table | 2061 × 1084 px total; playfield 1947 × 970 px = 3.569 × 1.778 m |

### Two scale caveats before tuning anything

1. **Balls are deliberately oversized.** 38 px at 545.67 px/m is a **69.6 mm**
   ball, against a real 57.15 mm — a **≈1.22× oversize** inherited from the
   original fork's fixed geometry (rack layout, pocket positions and the renderer
   all depend on it). A real-world coefficient dropped straight into the TS engine
   will not behave like a real table.
2. **The backends are calibrated in different units.** TS is tuned in px/s to hit
   distance targets; Havok is tuned in SI. Full power is 9600 px/s (≈17.6 m/s at
   our scale) in TS but 8.5 m/s in Havok. They are not meant to match
   numerically — only to *feel* the same.

---

## 1. Ball

| Parameter | TS | Havok | Source |
|---|---|---|---|
| Ball diameter | **38 px** pool / **35 px** snooker (≡ 69.6 / 64.1 mm) | same geometry, converted to m | `BALL_SIZE`, `SNK_BALL_SIZE` |
| Ball radius | **19 px** pool / **17.5 px** snooker | `M(BALL_RADIUS)` = 0.0348 m pool | `BALL_RADIUS` |
| Ball mass | *n/a* — equal-mass assumption, mass never appears | **0.17 kg** | `simulator.ts` `setMassProperties` |
| Collision shape | analytic circle (contact when centre distance < `BALL_SIZE`) | `PhysicsShapeSphere` | `physics.ts` / `simulator.ts` |
| Collision margin | *n/a* | *n/a* (plugin default, never set) | — |
| Linear damping | **0.9897 ×/step** (`VISCOUS_DRAG`, multiplicative @120 Hz) | **0.24** | `VISCOUS_DRAG` / `LINEAR_DAMPING` |
| Angular damping | *n/a* — **no angular state at all** | **0.3** (low, so cue spin survives to first contact) | `ANGULAR_DAMPING` |
| Linear velocity limit | **9600 px/s** at launch, no clamp after | **8.5 m/s** at launch | `MAX_SHOT_SPEED` / `MAX_SPEED_MS` |
| Angular velocity limit | *n/a* | *n/a* (uncapped; set from power curve) | — |
| Sleep threshold | **2.5 px/s** (≈0.005 m/s) | **8 px/s ≈ 0.015 m/s** + 10 consecutive slow steps | `STOP_THRESHOLD` / `SLEEP_SPEED` |

## 2. Ball-to-ball

| Parameter | TS | Havok | Source |
|---|---|---|---|
| Restitution | **0.93** | **0.93** (MINIMUM combine) | `BALL_RESTITUTION` / `ballMaterial` |
| Friction | *n/a* — normal components exchange, tangential preserved untouched | **0.06** material; MAXIMUM combine → **0.06** ball↔ball (real 0.05–0.06) | `ballMaterial` |
| Rolling resistance | **240 px/s²** (`ROLL_DECEL`, ≈0.44 m/s² constant deceleration) | via damping + cloth friction (no separate term) | `ROLL_DECEL` |
| Static / dynamic friction | *n/a* | *n/a* — single coefficient, no split | — |
| Spin transfer ("throw") | **0.15** — object ball nudged off the contact tangent | emergent from real contact friction | `SPIN_TRANSFER` |
| Min collision speed | **≈10.9 px/s** — below this a contact resolves inelastically (anti-jitter) | *n/a* | `MIN_COLLISION_SPEED` |
| Linear / angular impulse | *n/a* — velocity assigned directly | *n/a* — `setLinearVelocity` / `setAngularVelocity` | `physics.ts shootBall` |

## 3. Table cloth

The TS engine has **no cloth surface** — cloth is modelled purely as deceleration on the ball.

| Parameter | TS | Havok | Source |
|---|---|---|---|
| Cloth friction | *n/a* (expressed as `ROLL_DECEL` + `VISCOUS_DRAG`) | **0.20** material → ball↔floor = **0.20** (MAXIMUM combine; real 0.15–0.25) | `clothMaterial` |
| Cloth restitution | *n/a* | **0** (MINIMUM combine → no vertical bounce) | `clothMaterial` |
| Rolling resistance | **240 px/s²** | via `LINEAR_DAMPING` | `ROLL_DECEL` |
| Surface damping | **0.9897 ×/step** | **0.24** | `VISCOUS_DRAG` / `LINEAR_DAMPING` |
| Static / dynamic friction | *n/a* | *n/a* | — |

## 4. Cushions / rails

| Parameter | TS | Havok | Source |
|---|---|---|---|
| Cushion restitution | **0.88** | **0.72** — deliberately below spec; 0.88 let a full-power ball ricochet ~9 s ("no pinball") | `CUSHION_RESTITUTION` / `railMaterial` |
| Cushion friction | **0.12** (tangential × (1 − 0.12) per bounce) | **0.20** material → ball↔rail = **0.20** (MAXIMUM combine; ≈ the previous effective 0.19, so bank angles are unchanged) | `CUSHION_FRICTION` / `railMaterial` |
| Cushion damping | *n/a* — restitution + tangential friction only | *n/a* | — |
| Cushion stiffness | *n/a* | *n/a* — rails are rigid statics, no soft-body | — |
| Collision geometry | 4 axis-aligned border lines, inset `BORDER_SIZE` = **57 px**, with a **gap at each middle pocket** | 6 static boxes (left, right, top ×2, bottom ×2 around the middle-pocket gap). Height 10 × ball radius, thickness 57 px | `physics.ts railMouthHole` / `simulator.ts buildRails` |
| Rail collision margin | *n/a* | *n/a* | — |

## 5. Pockets

Pockets are **analytic in both backends** — a capture test, not a collider. A ball
drops when it is inside the mouth, travelling into the throat, and above a minimum
inward speed.

| Parameter | TS | Havok | Source |
|---|---|---|---|
| Pocket radius — corner | **46 px** pool / **34 px** snooker | shared `HOLES` table | `HOLE_RADIUS` / `SNK_CORNER_R` |
| Pocket radius — middle | **64 px** pool / **42 px** snooker (bigger than corners by design) | shared | `MIDDLE_RADIUS` / `SNK_MIDDLE_R` |
| Acceptance cone (half-angle) | corner **52°**, middle **40°** (middle widened 26° → 31° → 40° on feedback) | same constants | `CORNER_ACCEPT` / `SIDE_ACCEPT` |
| Capture threshold | **35 px/s inward** — this, not the cone, rejects rail-skimmers | same (hard-coded 35) | `POCKET_MIN_INWARD` |
| Middle-pocket throat rule | centre past the rail line ⇒ drops at any angle | same rule | `capturingHole` / `capturedHole` |
| Magnetism | **0.02** per substep, range **1.35 ×** radius (steers on-line shots) | *n/a* — not applied in Havok | `POCKET_MAGNETISM`, `POCKET_MAGNET_RANGE` |
| Pocket depth / lip / damping | *n/a* — 2-D; a real **rail gap** at each middle pocket does the lip's job | *n/a* | — |
| Ball drop detection | per substep | per step; ball parked at `POCKETED_PARK` and made static | `POCKETED_PARK` |

## 6. Cue / shot

| Parameter | TS | Havok | Source |
|---|---|---|---|
| Power input range | **0 – 75** (UI shows 0–100 %) | same | `MAX_POWER` |
| Power curve | **speed = max × (p/75)^1.4** — non-linear so soft shots stay precise | same exponent | `POWER_EXPONENT` |
| Maximum shot speed | **9600 px/s** | **8.5 m/s** | `MAX_SHOT_SPEED` / `MAX_SPEED_MS` |
| Cue force / impulse | *n/a* — no cue body; velocity assigned directly | *n/a* | `physics.ts shootBall` |
| Shot direction | `angle` radians (vx = cos θ, vy = sin θ) | same | `ShotInput.angle` |
| Contact point — vertical | `spinY` **−1 … +1** (+ follow, − draw) | same input | `ShotInput.spinY` |
| Contact point — horizontal | `spinX` **−1 … +1** (side english) | same input | `ShotInput.spinX` |
| Shot accuracy / dispersion | *n/a* — shots are exact, no aim error injected | *n/a* | — |

## 7. Spin

This is where the backends differ most. **TS fakes spin** with scripted velocity
changes at known moments; **Havok gives the cue ball real angular velocity** and
lets contact friction do the work.

| Parameter | TS | Havok | Source |
|---|---|---|---|
| Topspin (follow) | **0.20** — fraction of cue speed added along travel at first contact | via `FOLLOW_DRAW_GAIN` | `TOP_SPIN` |
| Backspin (draw) | **0.22** — same mechanism, negative sign | via `FOLLOW_DRAW_GAIN` | `BACK_SPIN` |
| Follow / draw authority | see above | **2.0 ×** rolling rate: ω = (v/R) × 2.0 × spinY about the forward-roll axis | `FOLLOW_DRAW_GAIN` |
| Side english authority | **0.18** — tangential velocity added per cushion bounce | **1.5 ×** rolling rate, ω about the vertical axis | `SIDE_ENGLISH` / `ENGLISH_GAIN` |
| Spin decay | **0.985 /step** | `ANGULAR_DAMPING` **0.3** | `SPIN_DECAY` |
| Spin decay at cushion | **0.6** retained per bounce | emergent | `SPIN_SIDE_DECAY` |
| Spin → cloth | *n/a* — no rolling model, spin never touches the cloth | real — cloth friction converts spin to motion | `clothMaterial` |
| Stun assist | *n/a* | `\|spinY\| < 0.15` ⇒ kill the cue's forward roll at first contact, so a centre-ball hit stuns instead of trailing the object ball | `simulator.ts isStunShot` |

## 8. Solver & timestep

| Parameter | TS | Havok | Source |
|---|---|---|---|
| Physics timestep | **1/120 s** | **1/120 s** | `PHYSICS_FPS`/`DELTA`, `DT` |
| Sub-stepping | adaptive — subdivided until no ball travels > **12 px** between collision checks | fixed **2** (solver stepped at DT/2) | `SUBSTEP_TRAVEL` / `SUBSTEPS` |
| Maximum substeps | **16** | 2 (fixed) | `MAX_SUBSTEPS` |
| Continuous collision | via substepping (no swept tests — travel is capped) | via substepping (no Havok CCD flag set) | — |
| Solver / position / velocity iterations | *n/a* — not an iterative solver; pairs resolve once, in fixed order | *not set* — Havok plugin defaults | — |
| Collision groups / masks | *n/a* | *n/a* — rails carry a body id only so cushion events can be emitted | — |
| Settle cap | **12000 steps** | 12000 steps + 10-step slow streak to declare settle | `MAX_STEPS`, `SETTLE_STREAK` |

## 9. Game rules / state

| Parameter | Value | Source |
|---|---|---|
| Ball stopped threshold | 2.5 px/s (TS) · ≈8 px/s (HV) | `STOP_THRESHOLD` / `SLEEP_SPEED` |
| Shot completion | all balls below threshold; Havok additionally needs **10 consecutive slow steps** so a rebound isn't mistaken for a settle | `SETTLE_STREAK` |
| Foul / scratch / pocketed detection | per-variant rules — physics only emits ordered events, the rules plug-in decides meaning | `variants/eightball.ts`, `nineball.ts`, `snooker.ts` |
| Cue-ball start | **(413, 413)** pool; snooker 0.6 m off the baulk cushion, mid-height | `CUE_BALL_START` |
| Pocketed-ball park | **(0, 900)** pool; (0, H+120) snooker | `POCKETED_PARK` |
| Shot clock | **240 s**, off-chain, enforced by the server | `apps/server` |

## 10. Rendering & sync

| Parameter | Value | Source |
|---|---|---|
| Visual-to-physics scale | **1 : 1** — canvas draws in engine px; the table photo is fitted so its cushion noses land on the physics play boundary | `PoolCanvas.tsx` |
| Physics-to-render sync | Server simulates **once** and ships `{frames, events, endState}`. Clients **replay** — they never re-simulate, so visuals can't diverge from the settled result | `engine/src/world.ts` |
| Frame stride | **2** sim steps ≈ 16.7 ms per recorded frame; no interpolation between frames | `PoolCanvas FRAME_STRIDE` |
| Ball rotation sync | Renderer-derived. The engine holds **no angular state**; the renderer derives a 3-D orientation from position deltas (rolling without slipping) and shades a lit sphere. **Cannot affect physics or outcomes** | `apps/web/lib/ballSphere.ts` |
| Shadow sync | Static +2, +3 px offset — decorative, not physics-driven | `PoolCanvas drawBall` |
| Network physics sync | **none** — no networked stepping, prediction or reconciliation. The server is the sole authority and broadcasts the finished trajectory | `apps/server` |

---

## 11. Asked for, but not in our engine

Not oversights — the architecture doesn't have them.

- **Collision margin** — neither backend sets one.
- **Solver / position / velocity iterations** — TS isn't an iterative solver; Havok uses plugin defaults.
- **Collision groups & masks** — everything collides with everything.
- **Pocket depth, lip, damping** — 2-D game, analytic pockets; a real rail *gap* does the lip's job.
- **Static vs dynamic friction** — one coefficient per material pair, no stick-slip.
- **Cushion stiffness / damping** — rigid statics; loss is restitution + tangential friction only.
- **Cue force / impulse** — no cue rigid body; velocity assigned directly from the power curve.
- **Shot accuracy** — no dispersion or aim error is injected.

---

## 12. How to change any of this safely

1. **Decide which backend you're tuning.** Real matches run **Havok on the
   server**; Practice runs the **TS engine** in the browser. Changing one does not
   change the other.
2. **Determinism is money-critical for the TS engine.** Every value in
   `constants.ts` changes the simulated outcome. Server and client must run
   identical constants or replays desync — never patch one side only.
3. **Use the harnesses, not the eye.**
   - `node packages/engine/scripts/playtest.mjs` — the six TS spec targets
     (full-power roll ≈3–4 table lengths, 45° bank, thin cut pot, draw ≈22 cm,
     follow ≈25 cm, soft hanger).
   - `node packages/engine/scripts/havok-playtest.mjs` — the Havok 5/5 checklist.
4. **Two knobs dominate feel.** Distance and settle come from `VISCOUS_DRAG` +
   `ROLL_DECEL` (TS) or `LINEAR_DAMPING` + cloth friction (Havok). Bank liveliness
   is cushion restitution — 0.88 was too lively in Havok and became 0.72.
5. **Geometry costs more than coefficients.** Ball size, pocket radii and border
   inset feed the rack, the pocket capture *and* the fitted table art. Moving them
   means re-checking all three.

---

## 13. Changelog

**9 Sep 2026 — Havok contact friction made physically real.** Friction now uses a
`MAXIMUM` combine instead of a geometric mean, so each contact pair carries its own
real coefficient rather than one ball value leaking into all of them.

| Pair | Before | After | Real |
|---|---|---|---|
| ball ↔ ball | ≈0.35 | **0.06** | 0.05–0.06 |
| ball ↔ cloth | ≈0.32 | **0.20** | 0.15–0.25 |
| ball ↔ rail | ≈0.19 | **0.20** | unchanged in effect |

Measured result: object-ball throw with maximum side english is now **2.6°**
(real is 2–5°; it was roughly 6× that before), and a shot with no english departs
at **0.00°**. Havok checklist still 5/5, and draw *improved* 11.4 → 14.5 cm
because slipperier balls let cue spin survive to first contact.

Deliberately NOT changed: table/ball geometry, pocket sizes, and the TS engine.
