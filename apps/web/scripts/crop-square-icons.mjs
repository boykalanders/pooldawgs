// Trim transparent padding around square badge icons so they fill their
// button edge-to-edge via object-cover instead of floating with a visible
// margin (source canvas and container are both square, so CSS cover can't
// crop the padding away on its own).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PNG } from "pngjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIR = path.join(ROOT, "public", "assets", "pooldawgs_ico");

for (const name of ["cues_ico.png", "aim_ico.png"]) {
  const png = PNG.sync.read(fs.readFileSync(path.join(DIR, name)));
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
  const outName = name.replace(".png", "-trim.png");
  fs.writeFileSync(path.join(DIR, outName), PNG.sync.write(out));
  console.log(`${name}: content ${w}x${h} -> ${outName}`);
}
