import { ballStyle, type BallLike } from "@/lib/balls";

/**
 * Real rolling balls for the 2D table.
 *
 * A ball seen from above does NOT spin about the view axis when it rolls — its
 * SURFACE travels over the sphere while the lighting stays put. So each ball
 * carries a 3-D orientation and is rendered per-pixel as a lit sphere: the
 * screen-space normal is rotated by the ball's inverse orientation to look up
 * an equirectangular texture, then shaded by a FIXED light. Rolling therefore
 * carries the number/stripe over the top of the ball and around the back,
 * exactly like the real thing.
 *
 * Purely a renderer concern — the engine has no angular state, so none of this
 * can affect physics, outcomes or determinism.
 *
 * Math frame: X = screen right, Y = screen UP, Z = out of the screen.
 */

const TW = 256;
const TH = 128;

// ── equirectangular ball texture (flat albedo — lighting is added at render) ──
const texCache = new Map<string, Uint8ClampedArray>();

function texKey(ball: BallLike): string {
  const s = ballStyle(ball);
  return `${s.kind}|${s.color}|${s.number ?? "-"}`;
}

function buildTexture(ball: BallLike): Uint8ClampedArray {
  const s = ballStyle(ball);
  const cv = document.createElement("canvas");
  cv.width = TW;
  cv.height = TH;
  const g = cv.getContext("2d")!;

  const IVORY = "#f7f2e4";
  const base = s.kind === "stripe" || s.kind === "cue" ? IVORY : s.color;
  g.fillStyle = base;
  g.fillRect(0, 0, TW, TH);

  // Stripe: a colour band around the ball's equator, ivory poles.
  if (s.kind === "stripe") {
    g.fillStyle = s.color;
    g.fillRect(0, Math.round(TH * 0.27), TW, Math.round(TH * 0.46));
  }

  // Cue ball: faint "measle" spots, otherwise a white sphere shows no spin.
  if (s.kind === "cue") {
    g.fillStyle = "rgba(178, 54, 54, 0.5)";
    const spots: Array<[number, number]> = [
      [0.12, 0.5], [0.37, 0.5], [0.62, 0.5], [0.87, 0.5], [0.25, 0.22], [0.75, 0.78],
    ];
    for (const [u, v] of spots) {
      g.beginPath();
      g.arc(u * TW, v * TH, 6.5, 0, Math.PI * 2);
      g.fill();
    }
  }

  // Printed number in an ivory disc on two opposite sides, like a real ball.
  if (s.number !== null) {
    for (const u of [0.25, 0.75]) {
      const cx = u * TW;
      const cy = TH / 2;
      g.beginPath();
      g.arc(cx, cy, 25, 0, Math.PI * 2);
      g.fillStyle = IVORY;
      g.fill();
      g.fillStyle = "#17130d";
      g.font = "bold 30px Georgia, serif";
      g.textAlign = "center";
      g.textBaseline = "middle";
      g.fillText(String(s.number), cx, cy + 1);
    }
  }
  return g.getImageData(0, 0, TW, TH).data;
}

function texture(ball: BallLike): Uint8ClampedArray {
  const k = texKey(ball);
  let t = texCache.get(k);
  if (!t) {
    t = buildTexture(ball);
    texCache.set(k, t);
  }
  return t;
}

// ── per-radius sphere geometry + baked (fixed) lighting ──────────────────────
interface Sphere {
  size: number;
  nx: Float32Array;
  ny: Float32Array;
  nz: Float32Array;
  shade: Float32Array; // ambient + diffuse, from the FIXED light
  spec: Float32Array; // specular highlight, also fixed
  inside: Uint8Array;
}
const sphereCache = new Map<number, Sphere>();

function sphereFor(R: number): Sphere {
  let s = sphereCache.get(R);
  if (s) return s;
  const size = R * 2;
  const n = size * size;
  const nx = new Float32Array(n);
  const ny = new Float32Array(n);
  const nz = new Float32Array(n);
  const shade = new Float32Array(n);
  const spec = new Float32Array(n);
  const inside = new Uint8Array(n);
  // Fixed light from the upper-left, toward the viewer.
  const lx = -0.38, ly = 0.52, lz = 0.76;
  const ll = Math.hypot(lx, ly, lz);
  const Lx = lx / ll, Ly = ly / ll, Lz = lz / ll;
  // Blinn-Phong half-vector with the view along +Z.
  const hx = Lx, hy = Ly, hz = Lz + 1;
  const hl = Math.hypot(hx, hy, hz);
  const Hx = hx / hl, Hy = hy / hl, Hz = hz / hl;

  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      const k = j * size + i;
      const px = (i - R + 0.5) / R;
      const py = (j - R + 0.5) / R;
      const rr = px * px + py * py;
      if (rr > 1) {
        inside[k] = 0;
        continue;
      }
      inside[k] = 1;
      const x = px;
      const y = -py; // screen y is down; math frame Y is up
      const z = Math.sqrt(Math.max(0, 1 - rr));
      nx[k] = x; ny[k] = y; nz[k] = z;
      const diff = Math.max(0, x * Lx + y * Ly + z * Lz);
      shade[k] = 0.40 + 0.78 * diff;
      const nh = Math.max(0, x * Hx + y * Hy + z * Hz);
      spec[k] = 235 * Math.pow(nh, 34);
    }
  }
  s = { size, nx, ny, nz, shade, spec, inside };
  sphereCache.set(R, s);
  return s;
}

// ── orientation (rolling without slipping) ───────────────────────────────────
export type Orient = Float64Array; // 3x3 row-major

export function identityOrient(): Orient {
  return Float64Array.from([1, 0, 0, 0, 1, 0, 0, 0, 1]);
}

/**
 * Advance `m` for a step that moved the ball by (dxs, dys) in SCREEN pixels.
 * Rolling without slipping: omega = (-vy, vx, 0)/r in the math frame, which for
 * screen deltas gives the axis (dys, dxs, 0) and angle |d|/r.
 */
export function rollOrient(m: Orient, dxs: number, dys: number, r: number): void {
  const d = Math.hypot(dxs, dys);
  if (d < 1e-6) return;
  const ax = dys / d, ay = dxs / d, az = 0;
  const th = d / r;
  const c = Math.cos(th), s = Math.sin(th), t = 1 - c;
  // Rodrigues rotation R (az = 0 simplifies the terms).
  const r00 = t * ax * ax + c, r01 = t * ax * ay, r02 = s * ay;
  const r10 = t * ax * ay, r11 = t * ay * ay + c, r12 = -s * ax;
  const r20 = -s * ay, r21 = s * ax, r22 = c;
  // m = R * m
  const a = m[0], b = m[1], cc = m[2], dd = m[3], e = m[4], f = m[5], g = m[6], h = m[7], i = m[8];
  m[0] = r00 * a + r01 * dd + r02 * g;
  m[1] = r00 * b + r01 * e + r02 * h;
  m[2] = r00 * cc + r01 * f + r02 * i;
  m[3] = r10 * a + r11 * dd + r12 * g;
  m[4] = r10 * b + r11 * e + r12 * h;
  m[5] = r10 * cc + r11 * f + r12 * i;
  m[6] = r20 * a + r21 * dd + r22 * g;
  m[7] = r20 * b + r21 * e + r22 * h;
  m[8] = r20 * cc + r21 * f + r22 * i;
}

// ── render ───────────────────────────────────────────────────────────────────
let scratch: HTMLCanvasElement | null = null;
let scratchCtx: CanvasRenderingContext2D | null = null;
let scratchImg: ImageData | null = null;

const INV_2PI = 1 / (Math.PI * 2);
const INV_PI = 1 / Math.PI;

/** Draw a lit, correctly-rolling ball of radius `r` (engine px) centred at x,y. */
export function drawRollingBall(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  r: number,
  ball: BallLike,
  m: Orient
): void {
  const R = Math.max(3, Math.round(r));
  const sp = sphereFor(R);
  const size = sp.size;
  const tex = texture(ball);

  if (!scratch || scratch.width !== size || scratch.height !== size) {
    scratch = document.createElement("canvas");
    scratch.width = size;
    scratch.height = size;
    scratchCtx = scratch.getContext("2d");
    scratchImg = scratchCtx!.createImageData(size, size);
  }
  const img = scratchImg!;
  const out = img.data;

  const m0 = m[0], m1 = m[1], m2 = m[2], m3 = m[3], m4 = m[4], m5 = m[5], m6 = m[6], m7 = m[7], m8 = m[8];
  const n = size * size;
  for (let k = 0; k < n; k++) {
    const o = k << 2;
    if (!sp.inside[k]) {
      out[o + 3] = 0;
      continue;
    }
    const ax = sp.nx[k], ay = sp.ny[k], az = sp.nz[k];
    // texture direction = Mᵀ · n (inverse of a rotation is its transpose)
    const tx = m0 * ax + m3 * ay + m6 * az;
    const ty = m1 * ax + m4 * ay + m7 * az;
    const tz = m2 * ax + m5 * ay + m8 * az;
    let u = 0.5 + Math.atan2(tx, tz) * INV_2PI;
    if (u >= 1) u -= 1;
    const v = Math.acos(ty < -1 ? -1 : ty > 1 ? 1 : ty) * INV_PI;
    const ti = ((((v * TH) | 0) * TW) + ((u * TW) | 0)) << 2;
    const sh = sp.shade[k];
    const gl = sp.spec[k];
    let rr = tex[ti] * sh + gl;
    let gg = tex[ti + 1] * sh + gl;
    let bb = tex[ti + 2] * sh + gl;
    out[o] = rr > 255 ? 255 : rr;
    out[o + 1] = gg > 255 ? 255 : gg;
    out[o + 2] = bb > 255 ? 255 : bb;
    out[o + 3] = 255;
  }
  scratchCtx!.putImageData(img, 0, 0);
  ctx.drawImage(scratch!, x - r, y - r, r * 2, r * 2);
}
