// One-off: trim the transparent padding around the client's stick.png so it
// crops tight to the actual cue-stick artwork (needed for drawCueStick's
// aspect-ratio math, which assumes the sprite IS the stick, edge to edge).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PNG } from "pngjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIR = path.join(ROOT, "public", "assets", "pooldawgs_ico");

const file = path.join(DIR, "stick.png");
const png = PNG.sync.read(fs.readFileSync(file));
const { width, height, data } = png;
let minX = width, maxX = 0, minY = height, maxY = 0;
for (let y = 0; y < height; y++) {
  for (let x = 0; x < width; x++) {
    const a = data[(y * width + x) * 4 + 3];
    if (a > 8) {
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
}
const w = maxX - minX + 1;
const h = maxY - minY + 1;
const out = new PNG({ width: w, height: h });
PNG.bitblt(png, out, minX, minY, w, h, 0, 0);
fs.writeFileSync(path.join(DIR, "stick-trim.png"), PNG.sync.write(out));
console.log(`stick.png: content box [${minX},${minY} .. ${maxX},${maxY}] (${w}x${h}, aspect ${(w / h).toFixed(2)}:1) -> stick-trim.png`);
