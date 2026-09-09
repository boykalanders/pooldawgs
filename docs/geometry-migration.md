# Phase D — Geometry Migration: table image reference

Everything needed to migrate ball geometry (spec §2) without breaking the fitted
table artwork. Measured from source on 9 Sep 2026.

---

## The key result: the table images do NOT need re-fitting

The draw transform for each table photo is anchored to the **cushion nose**,
which is the engine's play boundary (`BORDER_SIZE` inset) — **not** to the ball.
Ball diameter does not appear anywhere in the fit.

> **The `dx/dy/dw/dh` transforms and the rail margins stay exactly as they are.**
> No re-measuring, no re-alignment of either photograph.

What *does* move with ball size is listed under "What actually changes" below.

---

## 1. Image specifications

| | Pool | Snooker |
|---|---|---|
| File | `apps/web/public/assets/tables/pool_table.png` | `apps/web/public/assets/tables/snooker_table.png` |
| Pixels | 1760 × 1328 | 1760 × 1328 |
| Format | PNG, 8-bit RGBA | PNG, 8-bit RGBA |
| Size | 2.40 MB | 1.67 MB |
| Source | `apps/web/images/` (originals) | `apps/web/images/` (originals) |

Both are top-down renders: wooden rails, gold pocket surrounds, green cushions,
green felt with the Pool Dawgs crest. Snooker additionally carries the baulk line
and the "D".

## 2. Current draw transform (keep these)

Defined in `apps/web/components/PoolCanvas.tsx` as `POOL_SKIN` / `SNOOKER_SKIN`.

| | Pool | Snooker |
|---|---|---|
| `dx` | −88 | −96 |
| `dy` | −160 | −262 |
| `dw` | 1670 | 2252 |
| `dh` | 1187 | 1687 |
| margins `ml / mr / mt / mb` | 33 / 39 / 26 / 64 | 27 / 34 / 19 / 53 |

**Mapping formulas** (W = 1760, H = 1328):

```
engine_x = dx + image_x * (dw / W)        image_x = (engine_x - dx) * W / dw
engine_y = dy + image_y * (dh / H)        image_y = (engine_y - dy) * H / dh
```

Concretely:

```
POOL      engine_x = -88 + image_x * 0.948864     engine_y = -160 + image_y * 0.893825
SNOOKER   engine_x = -96 + image_x * 1.279545     engine_y = -262 + image_y * 1.270331
```

## 3. Stable anchors, in IMAGE pixels

These are the physical features of each photograph. They are fixed properties of
the artwork and **do not change** when ball size changes — use them to re-derive
or sanity-check any transform.

### Cushion nose (the bounce line — maps to the engine play boundary)

| | Pool | Snooker |
|---|---|---|
| left / right (image x) | 152.8 / 1613.5 | 119.6 / 1641.2 |
| top / bottom (image y) | 242.8 / 1038.2 | 251.1 / 1014.7 |
| nose rect size | 1460.7 × 795.5 | 1521.6 × 763.6 |
| maps to engine | 57 / 1443, 57 / 768 | 57 / 2004, 57 / 1027 |

### Pocket centres (image px)

| Pocket | Pool image | Snooker image |
|---|---|---|
| corner TL | 158.1, 248.4 | 123.5, 255.1 |
| corner TR | 1605.1, 248.4 | 1637.3, 255.1 |
| corner BL | 158.1, 1031.5 | 123.5, 1010.8 |
| corner BR | 1605.1, 1031.5 | 1637.3, 1010.8 |
| middle TOP | 883.2, 219.3 | 880.0, 242.5 |
| middle BOT | 883.2, 1061.7 | 880.0, 1023.4 |

### Other measured features (image px)

| | Pool | Snooker |
|---|---|---|
| green bbox (cushion outer edge) | x 121–1646, y 213–1071 | x 90–1671, y 228–1044 |
| wood outer edge | L 58, R 1714, T 149, B 1174 | L 54, R 1713, T 191, B 1101 |

**Effective scale:** pool 0.949 engine-px per image-px (x) / 0.894 (y);
snooker 1.280 (x) / 1.270 (y). Slight x/y anisotropy is deliberate — it squares
the photo's perspective onto the engine's flat playfield.

---

## 4. What actually changes in Phase D

| Item | Pool | Snooker | Notes |
|---|---|---|---|
| Ball diameter | 38 → **31.2** | 35 → **28.65** | `BALL_SIZE`, `SNK_BALL_SIZE` |
| Ball radius | 19 → **15.6** | 17.5 → **14.325** | derived |
| Ball mass (Havok) | 0.170 kg | 0.17 → **0.142 kg** | **currently hard-coded `mass: 0.17` for both** — must become variant-aware |
| Rack row pitch | 38 → **31.2** | 35 → **28.65** | = one diameter (frozen triangle) |
| Rack column pitch | 33 → **27.1** | 30 → **24.9** | must stay ≥ diameter·cos30° so the pack never overlaps |
| Corner pocket radius | 46 → **37.8** | 34 → **27.8** | *see pocket options below* |
| Middle pocket radius | 64 → **52.5** | 42 → **34.4** | *see pocket options below* |
| Middle rail-gap half | 45 → **36.9** | 24.5 → **20.1** | computed as `radius − ballRadius` |

### Automatically correct — no action needed

These already derive from `G.BALL_SIZE` / `G.BALL_RADIUS` and follow the change:

- `SUBSTEP_TRAVEL_FRACTION * G.BALL_SIZE` (TS substep cap)
- `MAX_TRAVEL_PER_SUBSTEP = 0.2 * (2 * R)` (Havok adaptive substeps)
- Havok sphere collider radius `M(geom.BALL_RADIUS)`
- `railMouthHole()` gap, `isOutsideBorder()`, `overlapsBall()` placement checks
- Renderer ball size (`PoolCanvas`, `ballSphere.ts`) — both read the geometry
- Ball-ball contact distance, positional correction, penetration diagnostics

### Unaffected by ball size

`PX_PER_M` (545.67), table dimensions, `BORDER_SIZE` (57), cue-ball start,
`POCKET_MIN_INWARD` (35 px/s ≡ 0.064 m/s — already SI-correct), `CONTACT_SLOP`,
`MIN_COLLISION_SPEED`, and **the table image transforms above**.

---

## 5. Pocket sizing — a decision, not a calculation

If pocket radii are left alone while the ball shrinks, pockets get **more**
generous:

| | now | if unchanged | real |
|---|---|---|---|
| Pool corner | 2.42 ball-widths | **2.95** | 1.99 |
| Pool middle | 3.37 | **4.10** | 2.22 |
| Snooker corner | 1.94 | **2.37** | 1.64 |
| Snooker middle | 2.40 | **2.93** | 1.70 |

Three options:

1. **Preserve today's feel (recommended).** Scale radii by `newDia/oldDia` — the
   values in the table above (pool 37.8 / 52.5, snooker 27.8 / 34.4). Ball-width
   ratios stay exactly as they are now, so potting difficulty is unchanged.
2. **Go real.** Pool corner ≈ 1.99, middle ≈ 2.22 ball-widths; snooker 1.64 /
   1.70. Authentic but markedly harder — and it reverses the generous middle
   pockets that were specifically requested twice.
3. **Leave radii alone.** Simplest, but makes an already-forgiving table
   noticeably easier. Not recommended.

---

## 6. Migration order (spec §2.2)

1. Add a **geometry version** alongside `PHYSICS_VERSION`, so existing matches and
   replays keep the current geometry.
2. Change `BALL_SIZE` / `SNK_BALL_SIZE` **and** the Havok per-variant mass together.
3. Recompute the rack tables in `variants/eightball.ts`, `nineball.ts` and the
   snooker `buildReds()` pitch — keep the frozen-triangle rule (rows exactly one
   diameter; columns ≥ diameter·cos30°, never below, or the pack self-separates).
4. Apply the chosen pocket radii; the middle rail gap follows automatically.
5. Re-run every harness: `playtest.mjs`, `havok-playtest.mjs`, `rest-tests.mjs`,
   `contact-tests.mjs`, plus the 31 unit tests.
6. Re-tune only if a target misses — expect the full-power roll and draw/follow
   distances to shift, since a lighter/smaller ball carries differently.
7. Visually confirm against the photos: balls should sit inside the cushion noses
   and drop into the drawn pockets. **The transforms need no change** — if the
   balls look misaligned, something other than the transform moved.

## 7. Known caveat to re-check after migration

The rack sits on integer pixel coordinates today, which is what makes the frozen
triangle exact. At 31.2 / 28.65 px diameters the pitches are fractional, so the
rack tables must be regenerated from the diameter rather than hand-rounded —
rounding a column pitch *down* below diameter·cos30° makes the pack overlap at
rest, which the engine resolves by pushing balls apart on the first frame.
