// Layout templates for the table artwork, drawn straight from the engine
// geometry: cloth, cushion band, pocket mouths with their facings, jaw tips,
// and the table markings. Hand these to whoever draws the table (or feed them
// to an image generator as the layout/control image) so the art matches the
// physics exactly.
//
//   node packages/engine/scripts/table-templates.mjs  →  docs/table-templates/*.svg
//
// Facings follow the WPA spec: the angle measured inside the cushion rubber,
// between the cushion nose line and the pocket facing, is 142° at a corner
// pocket and 104° at a side pocket. The facings therefore CONVERGE as they go
// back — the throat narrows behind the mouth — which is what makes a pocket a
// funnel rather than a notch.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { geomFor, MM, PX_PER_M } from "../dist/index.js";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "../../../docs/table-templates");
mkdirSync(OUT, { recursive: true });

const deg = (d) => (d * Math.PI) / 180;
const f = (n) => n.toFixed(1);

function template(gameType, canvasW, canvasH, opts) {
  const g = geomFor(gameType);
  const s = canvasW / g.TABLE_WIDTH; // uniform: the canvas has the table's shape
  const P = (x, y) => [x * s, y * s];
  const L = g.LEFT_BORDER_X, R = g.RIGHT_BORDER_X, T = g.TOP_BORDER_Y, B = g.BOTTOM_BORDER_Y;
  const cushion = MM(50); // cushion rubber, nose to rail
  const out = [];
  const add = (x) => out.push(x);

  add(`<svg xmlns="http://www.w3.org/2000/svg" width="${canvasW}" height="${canvasH}" viewBox="0 0 ${canvasW} ${canvasH}">`);
  add(`<rect width="${canvasW}" height="${canvasH}" fill="#5a3a22"/>`); // wood
  // cushion band, then the cloth inside the nose line
  const [cx0, cy0] = P(L - cushion, T - cushion);
  add(`<rect x="${f(cx0)}" y="${f(cy0)}" width="${f((R - L + 2 * cushion) * s)}" height="${f((B - T + 2 * cushion) * s)}" fill="#1f7a4d"/>`);
  const [nx0, ny0] = P(L, T);
  add(`<rect x="${f(nx0)}" y="${f(ny0)}" width="${f((R - L) * s)}" height="${f((B - T) * s)}" fill="#0f6b3f"/>`);

  // Pockets. Each facing leaves its jaw tip at the WPA angle, measured inside
  // the rubber from the nose line, and runs back through the cushion band.
  const drop = [];
  for (const h of g.HOLES) {
    const side = h.tx === 0;
    const interior = deg(side ? 104 : 142);
    const facings = h.jaws.map((jaw, k) => {
      // Direction along the nose line pointing AWAY from the mouth, i.e. into
      // the rubber on this side of the tip.
      const other = h.jaws[1 - k];
      let ax = jaw.x - other.x, ay = jaw.y - other.y;
      if (!side) {
        // Corner tips sit on different cushions: the rubber runs along that
        // tip's own cushion, away from the corner.
        const onHorizontal = Math.abs(jaw.y - T) < 1e-6 || Math.abs(jaw.y - B) < 1e-6;
        ax = onHorizontal ? -Math.sign(h.tx) : 0;
        ay = onHorizontal ? 0 : -Math.sign(h.ty);
      }
      const len = Math.hypot(ax, ay);
      ax /= len; ay /= len;
      // Rotate that direction by the interior angle toward the rail (outward,
      // along +tx/+ty).
      const outX = h.tx, outY = h.ty;
      const cross = ax * outY - ay * outX;
      const sign = cross >= 0 ? 1 : -1;
      const c = Math.cos(sign * interior), sn = Math.sin(sign * interior);
      const dx = ax * c - ay * sn, dy = ax * sn + ay * c;
      // Length: far enough to cross the cushion band.
      const depthPerLen = Math.abs(dx * outX + dy * outY) || 1e-6;
      const lenF = (cushion * 1.25) / depthPerLen;
      return { tip: jaw, back: { x: jaw.x + dx * lenF, y: jaw.y + dy * lenF } };
    });
    const [a, b] = facings;
    // Mouth (tip to tip) → facings → back of the throat. The cloth corner beyond
    // a corner's mouth line falls inside this shape, as it should.
    const pts = [a.tip, a.back, b.back, b.tip];
    add(`<polygon fill="#050505" points="${pts.map((p) => P(p.x, p.y).map(f).join(",")).join(" ")}"/>`);
    // The drop sits BEHIND the throat, pushed out along the pocket axis so it
    // never bulges back onto the cloth.
    const r = Math.hypot(a.back.x - b.back.x, a.back.y - b.back.y) / 2;
    const backMid = { x: (a.back.x + b.back.x) / 2, y: (a.back.y + b.back.y) / 2 };
    const dropC = { x: backMid.x + h.tx * r * 0.7, y: backMid.y + h.ty * r * 0.7 };
    add(`<circle cx="${f(dropC.x * s)}" cy="${f(dropC.y * s)}" r="${f(r * s)}" fill="#050505"/>`);
    drop.push({ h, a, b });
  }

  // Watermark placeholder: where the crest goes, at the requested opacity.
  add(`<circle cx="${f((g.TABLE_WIDTH / 2) * s)}" cy="${f(((T + B) / 2) * s)}" r="${f(opts.crestR)}" fill="none" stroke="#ffffff" stroke-opacity="0.3" stroke-width="3" stroke-dasharray="14 10"/>`);
  add(`<text x="${f((g.TABLE_WIDTH / 2) * s)}" y="${f(((T + B) / 2) * s)}" fill="#ffffff" fill-opacity="0.3" font-family="Arial" font-size="${f(canvasW / 60)}" text-anchor="middle" dominant-baseline="middle">POOL DAWGS crest · 0.3 opacity</text>`);

  // Markings.
  for (const m of opts.markings(g)) add(m(P, s));

  // Construction lines (red): mouth lines and jaw tips, plus a ball for scale.
  for (const { h, a, b } of drop) {
    const [x1, y1] = P(a.tip.x, a.tip.y), [x2, y2] = P(b.tip.x, b.tip.y);
    add(`<line x1="${f(x1)}" y1="${f(y1)}" x2="${f(x2)}" y2="${f(y2)}" stroke="#ff3b30" stroke-width="2"/>`);
    for (const [x, y] of [[x1, y1], [x2, y2]]) add(`<circle cx="${f(x)}" cy="${f(y)}" r="4" fill="#ff3b30"/>`);
  }
  const [bx, by] = P(g.TABLE_WIDTH / 2 - 140, (T + B) / 2 + 190);
  add(`<circle cx="${f(bx)}" cy="${f(by)}" r="${f((g.BALL_SIZE / 2) * s)}" fill="#ffffff" fill-opacity="0.85"/>`);
  add(`<text x="${f(bx + g.BALL_SIZE * s)}" y="${f(by + 6)}" fill="#ffffff" font-family="Arial" font-size="${f(canvasW / 90)}">ball ${f(g.BALL_SIZE * s)} px</text>`);
  add(`</svg>`);
  return out.join("\n");
}

const dot = (x, y, r = 4) => (P, s) => {
  const [px, py] = P(x, y);
  return `<circle cx="${f(px)}" cy="${f(py)}" r="${r}" fill="#ffffff"/>`;
};

const pool = template("8ball", 2000, 1100, {
  crestR: 310,
  markings: (g) => [dot(1022, (g.TOP_BORDER_Y + g.BOTTOM_BORDER_Y) / 2), dot(g.HEAD_STRING_X, (g.TOP_BORDER_Y + g.BOTTOM_BORDER_Y) / 2)],
});

const snooker = template("snooker", 2576, 1355, {
  crestR: 350,
  markings: (g) => {
    const cy = (g.TOP_BORDER_Y + g.BOTTOM_BORDER_Y) / 2;
    const baulk = g.LEFT_BORDER_X + MM(737); // regulation, not the current artwork
    const dR = MM(292);
    const blue = g.TABLE_WIDTH / 2;
    const pink = (blue + g.RIGHT_BORDER_X) / 2;
    const black = g.RIGHT_BORDER_X - MM(324);
    const line = (P, s) => {
      const [x, y1] = P(baulk, g.TOP_BORDER_Y), [, y2] = P(baulk, g.BOTTOM_BORDER_Y);
      return `<line x1="${f(x)}" y1="${f(y1)}" x2="${f(x)}" y2="${f(y2)}" stroke="#ffffff" stroke-width="3"/>`;
    };
    const d = (P, s) => {
      const [x, y] = P(baulk, cy);
      const r = dR * s;
      return `<path d="M ${f(x)} ${f(y - r)} A ${f(r)} ${f(r)} 0 0 0 ${f(x)} ${f(y + r)}" fill="none" stroke="#ffffff" stroke-width="3"/>`;
    };
    return [line, d, dot(baulk, cy - dR), dot(baulk, cy + dR), dot(baulk, cy), dot(blue, cy), dot(pink, cy), dot(black, cy)];
  },
});

writeFileSync(join(OUT, "pool-template.svg"), pool);
writeFileSync(join(OUT, "snooker-template.svg"), snooker);
console.log("wrote", join(OUT, "pool-template.svg"));
console.log("wrote", join(OUT, "snooker-template.svg"));
console.log("px per metre", PX_PER_M.toFixed(3));
