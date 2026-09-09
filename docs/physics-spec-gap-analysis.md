# Physics Fix Spec — Implementation Gap Analysis

Audited against source on 9 Sep 2026 (`9f6bdb3`). Every row was checked in the
code, not from memory; "not found" means a grep across `packages/engine/src` and
`apps/server/src` returned nothing.

---

## ⚠️ STATUS UPDATE — Phases A, B and C(13) are now implemented

The audit below describes the state **before** the fix work. Implemented since,
in three verified commits:

| Phase | Commit | What landed |
|---|---|---|
| **A** | `a116080` | §1.2 physics versioning · §4 rolling resistance + static-stop hysteresis (both backends) · §8 adaptive substepping · §13 diagnostics · §12 speed/restitution parity |
| **B** | `b91c63e` | §6 iterative impulse contacts with Coulomb tangential friction + positional correction · §7.4 duplicate contact-event filtering |
| **C** | `06fc6ce` | §5.3 Havok cue-spin gains reduced to the spec range |

**Two real bugs were found and fixed while verifying**, both of which would have
affected wagered matches:

1. **Balls could be pocketed mid-table.** Static-stop hysteresis could leave a
   ball at exactly zero speed while still flagged moving; the next step computed
   `0/0 = NaN`. Every comparison in `capturingHole()` is false for NaN, so it
   returned the *first* hole and silently pocketed the ball wherever it stood.
2. **Pocket magnetism was frame-rate dependent.** It was applied once per
   *substep* at fixed strength, so making the solver finer multiplied the assist.
   Now scaled by `dt`.

**Verification standing (all green):** 31/31 engine unit tests · 6/6 TS playtest
· 5/5 Havok playtest · 20/20 `rest-tests.mjs` (spec §14 rest/cloth + diagnostics)
· 20/20 `contact-tests.mjs` (spec §14 ball collisions + cushions), each across
both backends and both variants.

**Measured effect on the reported symptoms:**

| Symptom | Before | After |
|---|---|---|
| Balls keep moving after a shot | damping-only cloth, creeping at low speed | residual speed **exactly 0**, settle 0.85–2.5 s |
| Balls drift toward cushions after the break | one-pass solver, residual overlap | in-shot penetration **1.61 px → 0.00 px**, zero final overlap |
| Cut shots / throw unreliable | tangential velocity untouched by contacts | Coulomb tangential impulse; throw 2.6° at max english |

### Still outstanding

- **§5 C10–C12 — real angular state in the TS backend** (sliding/rolling
  transitions, removing the scripted spin nudges). Deliberately deferred. The
  spec itself sanctions this (§5): *"Keep Havok as the outcome authority. Use TS
  only as a visual/practice approximation, **or** replace the TS solver with a
  deterministic angular solver."* Havok **is** the authority for wagered matches
  and now has real contact physics; TS runs Practice only. A full angular
  rewrite would change every TS outcome again for no effect on match results.
  **TS spin remains a scripted approximation — it should not be described as
  physical.**
- **§2 / Phase D — geometry migration** (pool 38 → 31.2 px, snooker 35 → 28.65 px
  and 0.142 kg). Not started, and it **needs a decision**: it was explicitly
  declined earlier in favour of "coefficients only", and it would require
  rebuilding racks, pocket mouths, cushion noses and re-fitting both table
  photographs. The spec's own advice is to do it last, behind a geometry version.
- **§7.1 cushion-nose profile.** Not implemented, deliberately: balls are
  constrained to the table plane, so a vertical wall face already yields the
  correct horizontal contact normal. Pocket-mouth rail gaps are verified
  symmetric by the new tests.
- **§8 solver iterations / CCD in Havok.** Not available — Babylon's Havok plugin
  exposes only `setTimeStep`. The spec's mandatory fallback (travel-limited
  adaptive substepping) is implemented instead.
- **§12 parity tests** and **Phase E release gate.** Not started.

---

## Headline: the assumption is inverted

> *"I think most of them have been implemented except a few recommendations on how
> to use Havok as main authority."*

It is the other way round.

**"Havok as the main authority" is the one thing that is already fully done** — it
has been the server default since before this spec was written
(`apps/server/src/config.ts:47`, `apps/server/src/index.ts:17-18`).

**Most of the substantive recommendations are not implemented.** Of the 14
implementation sections (§15–16 are process, not code), **0 are fully complete,
5 are partial, and 9 are not started**. Critically, the spec's own top-priority
item — explicit **rolling resistance** (§4.2), described as "the fastest
meaningful improvement" — **does not exist in the codebase at all**.

| Status | Count | Sections |
|---|---|---|
| 🟡 Partial | 5 | §1, §3, §9, §11, §14 |
| ❌ Not started | 9 | §2, §4, §5, §6, §7, §8, §10, §12, §13 |

Within those partials, exactly three **items** are fully done: **§1.1** (Havok
authoritative), **§3.3** (per-pair friction combine, shipped 9 Sep), and the
**pool** material values in §3.1. Everything else in those sections is open.

---

## Section-by-section

### §1 Architecture

| Item | Status | Evidence |
|---|---|---|
| 1.1 Havok authoritative | ✅ **Done** | `config.ts:47` defaults to `havok`; `index.ts` calls `initHavok()` + `setSimulator()` |
| 1.2 `PHYSICS_VERSION` versioning | ❌ **Not started** | grep for `PHYSICS_VERSION` / `pooldawgs-v`: **no matches**. Matches and replays carry no physics version |
| 1.3 Variant presets (`POOL_8BALL_V2`, `SNOOKER_V2`) | ❌ **Not started** | Havok has exactly one `clothMaterial`, one `railMaterial`, one `ballMaterial` (`simulator.ts:205-224`), shared by all variants. `geomKey` switches **geometry only** (table + ball size), never materials |

### §2 Geometry corrections

| Item | Status | Evidence |
|---|---|---|
| Pool ball → 31.2 px | ❌ **Not started** | still `BALL_SIZE = 38` |
| Snooker ball → 28.65 px | ❌ **Not started** | still `SNK_BALL_SIZE = 35` |

Deliberately deferred — the client chose "coefficients only" on 9 Sep, because a
size change ripples through rack, pockets, cushion noses, capture radii and the
fitted table art.

### §3 Material presets

| Item | Spec | Ours | Status |
|---|---|---|---|
| Pool ball mass | 0.170 kg | 0.17 | ✅ |
| Pool ball restitution | 0.93 | 0.93 | ✅ |
| Pool ball↔ball friction | 0.055 | 0.06 | ✅ close |
| Pool cloth dynamic friction | 0.18 | 0.20 | ✅ close |
| Pool cloth **static** friction | 0.24 | — | ❌ no static/dynamic split exists |
| Pool rolling resistance | 0.022 | — | ❌ not implemented |
| Pool rail restitution | 0.70 | 0.72 | ✅ close |
| Pool rail tangent friction | 0.16 | 0.20 | 🟡 a little high |
| **All snooker values (§3.2)** | separate preset | **uses pool's** | ❌ **not started** |
| §3.3 per-pair combine rules | explicit pairs | MAXIMUM combine | ✅ **Done 9 Sep** |

**Snooker is the biggest single gap here.** `setMassProperties({ mass: 0.17 })`
(`simulator.ts:303`) is hard-coded — a snooker ball currently weighs a *pool*
ball's 0.17 kg instead of 0.142 kg, on a 64 mm-equivalent diameter, with pool's
restitution (0.93 vs 0.91) and pool's cloth and cushions. This is exactly the
"snooker feels like pool" symptom in §16.

### §4 Stopping and table drag — **the top-priority gap**

| Item | Spec | Ours | Status |
|---|---|---|---|
| 4.1 Havok linear damping | 0.02–0.06 | **0.24** | ❌ 4–12× the recommended value |
| 4.2 Explicit rolling resistance | required | **none** | ❌ **not implemented** |
| 4.3 Static-stop hysteresis | required | **none** | ❌ no per-ball static stop |
| 4.4 TS equivalent | required | `VISCOUS_DRAG` + `ROLL_DECEL` | ❌ still the old model |

grep for `rollingResistance` / `applyRollingResistance` / `staticStop`: **no
matches anywhere.** We currently do exactly what §4.1 says not to do — use linear
damping as the cloth model. This is the direct cause of the reported
"balls keep moving / drift toward cushions" symptom.

*Note:* we do have `SETTLE_STREAK = 10` for **shot settlement**, which is not the
same thing as per-ball static-stop hysteresis.

### §5 Sliding / rolling / spin states

| Item | Status | Evidence |
|---|---|---|
| TS angular state | ❌ **Not started** | grep for `angularVelocity` in `physics.ts`: **0 matches**. TS spin is still scripted |
| Sliding↔rolling transitions | ❌ **Not started** | — |
| 5.3 `FOLLOW_DRAW_GAIN` → 1.0–1.4 | ❌ **Not done** | still `2.0` (`simulator.ts:71`) |
| `ENGLISH_GAIN` → 1.0–1.3 | ❌ **Not done** | still `1.5` (`simulator.ts:72`) |

### §6 Ball-to-ball collision

| Item | Status |
|---|---|
| Impulse-based contact resolution | ❌ TS still exchanges normal components only, tangential untouched |
| Iterative solving (8–12 / 4–8 iterations) | ❌ TS resolves each pair once, fixed order |
| Contact slop + positional correction | 🟡 a positional push-apart exists (`physics.ts:164`), but no slop/correction-factor model |

### §7 Cushions and rails

| Item | Status |
|---|---|
| Cushion-nose profile (bevel/round) | ❌ rails are plain `PhysicsShapeBox` walls |
| Correct nose height / rail body behind nose | ❌ |
| Pocket-mouth gaps preserved | ✅ middle-pocket rail gaps exist in both backends |
| No hidden faces behind pockets | 🟡 unverified — no test covers it |
| Tangential response + spin throw at cushion | ❌ Havok is emergent only; TS multiplies tangent by `1 − 0.12` |
| 7.4 Rail event dedup / cooldown | ❌ no contact-id guard |

### §8 CCD and timestep

| Item | Spec | Ours | Status |
|---|---|---|---|
| Havok base substeps | 4 | **2 (fixed)** | ❌ |
| Havok max substeps | 12 | none (not adaptive) | ❌ |
| Position iterations | 10 | not set | ❌ |
| Velocity iterations | 6 | not set | ❌ |
| CCD enabled | if supported | not set | ❌ |
| TS substep travel | 0.20 × diameter (7.6 px) | **12 px** | ❌ |
| TS max substeps | 24 | **16** | ❌ |

### §9 Pockets

| Item | Status | Note |
|---|---|---|
| Throat-plane crossing before capture | 🟡 **Partial** | Implemented for **middle** pockets in both backends; corners still use cone + inward speed only |
| Magnetism = 0 in competitive | ✅ **Done** | Havok contains no magnetism at all (grep: 0 matches), and competitive = Havok |
| Scale-aware inward speed | 🟡 | Fixed `35 px/s`. That happens to be **0.064 m/s**, inside the spec's 0.04–0.08 band for pool — but it is the same px value for snooker's smaller balls, so it is not scale-aware |
| Lip rejection for rail-skimmers | ❌ | Not implemented; rejection relies on the min-inward-speed gate |
| Recalculate mouths after size migration | ❌ | Blocked on §2 |

### §10 Game-specific presets

❌ **Not started.** 8-ball and 9-ball correctly share material properties, but
snooker does too — which the spec explicitly forbids.

### §11 Settlement

| Item | Status |
|---|---|
| Settle streak ≥ 10 steps | ✅ `SETTLE_STREAK = 10` |
| All balls below static-stop speed | 🟡 uses `SLEEP_SPEED`, not a static-stop threshold |
| No active contacts / not airborne / not in cushion window | ❌ none of these conditions are checked |
| Log shots that hit the step cap | ❌ `MAX_STEPS` is silent |

### §12 Backend parity

❌ **Not started.** No parity test compares TS and Havok on pocket order, fouls,
final positions or settle state. The two backends currently use materially
different models (Havok: real contacts; TS: scripted spin, no angular state).

### §13 Observability / debug mode

❌ **Not started.** No penetration, substep, settle-time or contact-count
instrumentation exists. grep for `penetration` / `debugPhysics` / `settleTimeout`:
no matches.

### §14 Validation harness

🟡 **Partial.** Both harnesses exist and pass:

- `playtest.mjs` — 6 TS spec targets
- `havok-playtest.mjs` — 5 Havok checks (currently **5/5**)

But only ~5 of the spec's **28** required tests are covered. Missing entirely:
bank angles at 30/45/60°, cluster-overlap checks, tunnelling checks, spin decay,
pocket-jaw symmetry, snooker-specific tests, and all 3 determinism/parity tests.

---

## §16 Reported symptoms — are the fixes in place?

| Symptom | Spec's prescribed fix | Implemented? |
|---|---|---|
| Balls keep moving after a shot | rolling resistance + static-stop hysteresis | ❌ **No** |
| Balls drift toward cushions after the break | iterative cluster resolution, penetration correction, fast-shot substeps | ❌ **No** |
| Cushion rebounds feel wrong | cushion-nose profile, then tune | ❌ **No** (still box rails) |
| Snooker feels like pool | snooker diameter + mass + inertia + cloth + cushion together | ❌ **No** (shares pool's everything but table size) |
| TS and Havok feel different | shared contact model + angular state in TS | ❌ **No** |

**None of the five reported symptoms have had their prescribed fix implemented.**
The friction work done on 9 Sep improved *throw* and *cut-shot* realism — a real
improvement, and it satisfies §3.3 — but it does not address any of the five
symptoms above.

---

## Recommended next step

Follow the spec's own Phase A / Phase 2, which is also the lowest-risk work
because **it needs no geometry change** (so racks, pockets and the fitted table
art all stay put):

1. **§4.2 explicit rolling resistance** in Havok — `a = μ_r · g` applied opposite
   horizontal velocity, `μ_r ≈ 0.022`, using `dt` (never a per-frame multiplier).
2. **§4.3 static-stop hysteresis** — zero horizontal + angular velocity after
   ~10 consecutive steps below 0.004 m/s, skipped while a ball has an active
   contact or is airborne.
3. **§4.1 drop `LINEAR_DAMPING`** from 0.24 toward 0.02–0.06 once (1) carries the
   cloth model.
4. **§8 raise Havok substeps** to 4 base / adaptive to 12, and set position/velocity
   iterations.

That combination is what the spec says will fix "balls keep moving" and "drift
toward cushions" — the two symptoms actually being reported. Everything else
(geometry migration, cushion-nose profile, TS angular state) is larger work that
should follow once these are measured and stable.

A caution worth repeating from the spec: **§1.2 physics versioning should land
before any of this ships to wagered matches**, so live matches and existing replays
are not silently re-simulated under new constants.
