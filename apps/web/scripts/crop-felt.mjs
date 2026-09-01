// One-off: find the green felt's bounding box inside poolboard.png /
// snookerboard.png (which include the wood rail + pockets baked in) and
// export a felt-only crop for use as the in-game cloth texture.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PNG } from "pngjs";
import jpeg from "jpeg-js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIR = path.join(ROOT, "public", "assets", "pooldawgs_ico");

function isFelt(r, g, b) {
  // Green cloth: G clearly dominant over R and B, and not too dark (skip
  // near-black pocket shadows) or too bright (skip gold trim highlights).
  return g > 60 && g > r * 1.25 && g > b * 1.25;
}

for (const name of ["poolboard.png", "snookerboard.png"]) {
  const file = path.join(DIR, name);
  const png = PNG.sync.read(fs.readFileSync(file));
  const { width, height, data } = png;
  let minX = width, maxX = 0, minY = height, maxY = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      if (isFelt(data[i], data[i + 1], data[i + 2])) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  // Pull in a touch further so no rail/pocket-lip pixels sneak in at the crop edge.
  const pad = 6;
  minX += pad; minY += pad; maxX -= pad; maxY -= pad;
  const w = maxX - minX;
  const h = maxY - minY;
  const out = new PNG({ width: w, height: h });
  PNG.bitblt(png, out, minX, minY, w, h, 0, 0);
  // Opaque photo content — JPEG at high quality is a fraction of the PNG
  // size for the same look, and this texture loads on every game/practice
  // session (not just once in a lobby list).
  const { data: jpegData } = jpeg.encode({ data: out.data, width: w, height: h }, 88);
  const outName = name.replace(".png", "-felt.jpg");
  fs.writeFileSync(path.join(DIR, outName), jpegData);
  console.log(`${name}: felt box [${minX},${minY} .. ${maxX},${maxY}] (${w}x${h}) -> ${outName} (${(jpegData.length / 1024).toFixed(0)} KB)`);
}
