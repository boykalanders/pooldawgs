// Crops the two Dawg avatar portraits out of the client's UI-kit sheet
// (photo_2026-06-11_21-01-19.jpg) into transparent-cornered PNGs.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import jpeg from "jpeg-js";
import { PNG } from "pngjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SHEET = path.join(ROOT, "images", "photo_2026-06-11_21-01-19.jpg");
const OUT = path.join(ROOT, "public", "assets");

const img = jpeg.decode(fs.readFileSync(SHEET), { useTArray: true, formatAsRGBA: true });
console.log(`sheet: ${img.width}x${img.height}`);

// Fractional rects of the framed avatar tiles (portrait incl. gold/red frame,
// excluding the star badge overhang).
const CROPS = [
  { name: "avatar-deputy.png", x0: 0.284, y0: 0.066, x1: 0.371, y1: 0.192 },
  { name: "avatar-outlaw.png", x0: 0.604, y0: 0.066, x1: 0.689, y1: 0.192 },
];

for (const crop of CROPS) {
  const x0 = Math.round(crop.x0 * img.width);
  const y0 = Math.round(crop.y0 * img.height);
  const w = Math.round((crop.x1 - crop.x0) * img.width);
  const h = Math.round((crop.y1 - crop.y0) * img.height);
  const png = new PNG({ width: w, height: h });
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const src = ((y0 + y) * img.width + (x0 + x)) * 4;
      const dst = (y * w + x) * 4;
      png.data[dst] = img.data[src];
      png.data[dst + 1] = img.data[src + 1];
      png.data[dst + 2] = img.data[src + 2];
      png.data[dst + 3] = 255;
    }
  }
  fs.writeFileSync(path.join(OUT, crop.name), PNG.sync.write(png));
  console.log(`${crop.name}: ${w}x${h}`);
}
