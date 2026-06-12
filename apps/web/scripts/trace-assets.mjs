// Converts the client's raster design assets (white-background JPG/PNG) into
// transparent SVGs under public/assets/. Run: node scripts/trace-assets.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import jpeg from "jpeg-js";
import { PNG } from "pngjs";
import ImageTracer from "imagetracerjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(ROOT, "images");
const OUT = path.join(ROOT, "public", "assets");
fs.mkdirSync(OUT, { recursive: true });

function decode(file) {
  const buf = fs.readFileSync(file);
  if (file.toLowerCase().endsWith(".png")) {
    const png = PNG.sync.read(buf);
    return { width: png.width, height: png.height, data: png.data };
  }
  const img = jpeg.decode(buf, { useTArray: true, formatAsRGBA: true });
  return { width: img.width, height: img.height, data: img.data };
}

/**
 * Key out the white BACKGROUND only: flood-fill near-white pixels connected
 * to the image border. Interior whites (highlights, the 8-ball's "8", the
 * white POOL letters) are preserved.
 */
function keyOutBackground(img, threshold = 228) {
  const { width, height, data } = img;
  const nearWhite = (i) =>
    data[i] >= threshold && data[i + 1] >= threshold && data[i + 2] >= threshold;
  const visited = new Uint8Array(width * height);
  const queue = [];

  for (let x = 0; x < width; x++) {
    queue.push(x, x + (height - 1) * width);
  }
  for (let y = 0; y < height; y++) {
    queue.push(y * width, width - 1 + y * width);
  }

  while (queue.length) {
    const p = queue.pop();
    if (visited[p]) continue;
    visited[p] = 1;
    const i = p * 4;
    if (!nearWhite(i)) continue;
    data[i + 3] = 0;
    const x = p % width;
    const y = (p / width) | 0;
    if (x > 0) queue.push(p - 1);
    if (x < width - 1) queue.push(p + 1);
    if (y > 0) queue.push(p - width);
    if (y < height - 1) queue.push(p + width);
  }
}

/** Drop fully transparent layers and shrink coordinate precision noise. */
function clean(svg) {
  return svg
    .replace(/<path[^>]*\bopacity="0(\.0+)?"[^>]*\/>/g, "")
    .replace(/\s{2,}/g, " ");
}

/** Remove light paths entirely (for line art traced on its white paper). */
function stripLight(svg, threshold = 200) {
  return svg.replace(
    /<path fill="rgb\((\d+),(\d+),(\d+)\)"[^>]*\/>/g,
    (match, r, g, b) =>
      Number(r) >= threshold && Number(g) >= threshold && Number(b) >= threshold
        ? ""
        : match
  );
}

const ASSETS = [
  {
    src: "Pooldawgs-Logo.jpg",
    out: "logo.svg",
    options: { numberofcolors: 24, pathomit: 10, blurradius: 0 },
  },
  {
    src: "PoolDawgs-Watermark.png",
    out: "watermark.svg",
    // Monochrome line art: trace ink-on-paper at 2 colors, then strip the
    // paper paths (alpha keying confuses the tracer's palette here).
    keyBackground: false,
    stripLight: true,
    options: { numberofcolors: 2, pathomit: 6, ltres: 1.5, qtres: 1.5, blurradius: 0 },
  },
  {
    src: "Pooldawgs-Stick.png",
    out: "stick.svg",
    options: { numberofcolors: 16, pathomit: 4, blurradius: 0 },
  },
  {
    src: "play_btn.jpg",
    out: "play-btn.svg",
    options: { numberofcolors: 8, pathomit: 20, blurradius: 1, blurdelta: 30 },
  },
];

for (const asset of ASSETS) {
  const file = path.join(SRC, asset.src);
  const img = decode(file);
  if (asset.keyBackground !== false) keyOutBackground(img);
  const svg = ImageTracer.imagedataToSVG(img, {
    ltres: 1,
    qtres: 1,
    rightangleenhance: false,
    colorsampling: 0, // deterministic palette
    mincolorratio: 0,
    colorquantcycles: 3,
    strokewidth: 1,
    roundcoords: 1,
    viewbox: true,
    ...asset.options,
  });
  const cleaned = asset.stripLight ? stripLight(clean(svg)) : clean(svg);
  const outFile = path.join(OUT, asset.out);
  fs.writeFileSync(outFile, cleaned);
  console.log(
    `${asset.src} → ${asset.out} (${img.width}x${img.height}, ${(cleaned.length / 1024).toFixed(0)} KB)`
  );
}
