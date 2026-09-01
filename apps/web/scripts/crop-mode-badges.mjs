// The client's 8ball.png / 9ball.png / snooker.png are wide badges (numbered
// ball + "8 BALL" text baked into one black rounded-rect plaque), floating in
// a large transparent margin. Two outputs per file:
//   - "-badge.png": the whole plaque trimmed to its content box (wide, for
//     standalone display where no separate text label is shown alongside).
//   - "-icon.png": just the square ball-icon zone at the plaque's left end
//     (for spots that already show the variant name as separate text, where
//     the baked-in text would double up).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PNG } from "pngjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIR = path.join(ROOT, "public", "assets", "pooldawgs_ico");

function contentBox(png) {
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
  return { minX, minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

function crop(png, x, y, w, h) {
  const out = new PNG({ width: w, height: h });
  PNG.bitblt(png, out, x, y, w, h, 0, 0);
  return out;
}

for (const name of ["8ball.png", "9ball.png", "snooker.png"]) {
  const png = PNG.sync.read(fs.readFileSync(path.join(DIR, name)));
  const box = contentBox(png);

  const badge = crop(png, box.minX, box.minY, box.w, box.h);
  const badgeName = name.replace(".png", "-badge.png");
  fs.writeFileSync(path.join(DIR, badgeName), PNG.sync.write(badge));

  const icon = crop(png, box.minX, box.minY, box.h, box.h); // square, left end
  const iconName = name.replace(".png", "-icon.png");
  fs.writeFileSync(path.join(DIR, iconName), PNG.sync.write(icon));

  console.log(
    `${name}: content ${box.w}x${box.h} (ratio ${(box.w / box.h).toFixed(2)}:1) -> ${badgeName}, ${iconName} (${box.h}x${box.h})`
  );
}
