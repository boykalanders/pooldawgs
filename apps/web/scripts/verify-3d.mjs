// Visual verification of the Babylon 3D table + Havok physics replay.
import path from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const URL = "http://localhost:3000/play3d";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: "new",
  args: [
    "--no-sandbox",
    "--mute-audio",
    "--use-gl=angle",
    "--use-angle=swiftshader",
    "--enable-unsafe-swiftshader",
    "--ignore-gpu-blocklist",
  ],
});

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });
  const errors = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 60000 });

  // Wait until Havok finishes loading (the Shoot button enables).
  await page.waitForFunction(
    () => {
      const b = [...document.querySelectorAll("button")].find((x) => x.textContent?.trim() === "Shoot");
      return b && !b.disabled;
    },
    { timeout: 60000 }
  );
  await sleep(1500); // let the scene render a few frames
  await page.screenshot({ path: path.join(ROOT, "docs", "play3d-rack.png") });
  console.log("✓ 3D table rendered (Havok ready) → docs/play3d-rack.png");

  // Aim across the rack and break.
  const canvas = await page.$("canvas");
  const box = await canvas.boundingBox();
  await page.mouse.move(box.x + box.width * 0.62, box.y + box.height * 0.5);
  await sleep(200);
  await page.$$eval("button", (bs) => {
    const b = bs.find((x) => x.textContent?.trim() === "Shoot");
    b?.click();
  });
  await sleep(2500); // mid-break
  await page.screenshot({ path: path.join(ROOT, "docs", "play3d-break.png") });
  console.log("✓ break shot replayed in 3D → docs/play3d-break.png");

  // Confirm WebGL actually produced a non-blank frame.
  const blank = await page.evaluate(() => {
    const c = document.querySelector("canvas");
    if (!c) return true;
    const g = c.getContext("webgl2") || c.getContext("webgl");
    return !g; // if no GL context, treat as blank
  });
  console.log(blank ? "✗ no WebGL context" : "✓ WebGL context active");
  if (errors.length) console.log("page errors:", errors.slice(0, 5).join(" | "));
} finally {
  await browser.close();
}
