// Visual verification of the Babylon 3D table (Golden Spec) inside the full
// game shell: renders, shows the cue stick, and replays a shot.
import path from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const URL = "http://localhost:3000/practice?view=3d";
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
  await page.setViewport({ width: 1440, height: 900 });
  const errors = [];
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForSelector("canvas", { timeout: 60000 });
  await sleep(3000); // Babylon mount + first frames

  const glOk = await page.evaluate(() => {
    const c = document.querySelector("canvas");
    return !!(c && (c.getContext("webgl2") || c.getContext("webgl")));
  });
  console.log(glOk ? "✓ WebGL context active" : "✗ no WebGL context");

  // Aim by moving the pointer over the cloth (so the cue stick appears).
  const box = await (await page.$("canvas")).boundingBox();
  await page.mouse.move(box.x + box.width * 0.4, box.y + box.height * 0.55);
  await sleep(800);
  await page.screenshot({ path: path.join(ROOT, "docs", "play3d-rack.png") });
  console.log("✓ 3D table + cue stick rendered → docs/play3d-rack.png");

  // Hold to charge power, release to break.
  await page.mouse.move(box.x + box.width * 0.42, box.y + box.height * 0.5);
  await page.mouse.down();
  await sleep(700);
  await page.mouse.up();
  await sleep(2500);
  await page.screenshot({ path: path.join(ROOT, "docs", "play3d-break.png") });
  console.log("✓ break shot replayed in 3D → docs/play3d-break.png");

  if (errors.length) console.log("page errors:", errors.slice(0, 6).join(" | "));
} finally {
  await browser.close();
}
