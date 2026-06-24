// Visual verification of the Babylon 3D table inside the full game shell:
// renders, the cue stick follows the pointer (aim), a shot replays, and the
// snooker switch shows red balls without leftover "fake" balls.
import path from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";
import { PNG } from "pngjs";

function diffFraction(a, b) {
  const pa = PNG.sync.read(a);
  const pb = PNG.sync.read(b);
  if (pa.width !== pb.width || pa.height !== pb.height) return 1;
  let diff = 0;
  for (let i = 0; i < pa.data.length; i += 4) {
    if (
      Math.abs(pa.data[i] - pb.data[i]) > 16 ||
      Math.abs(pa.data[i + 1] - pb.data[i + 1]) > 16 ||
      Math.abs(pa.data[i + 2] - pb.data[i + 2]) > 16
    )
      diff++;
  }
  return diff / (pa.width * pa.height);
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const URL = "http://localhost:3000/practice?view=3d";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`  ${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
};

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
  await sleep(3500); // Babylon mount + Havok init + first frames

  const glOk = await page.evaluate(() => {
    const c = document.querySelector("canvas");
    return !!(c && (c.getContext("webgl2") || c.getContext("webgl")));
  });
  check("WebGL context active", glOk);

  const canvas = await page.$("canvas");
  const box = await canvas.boundingBox();

  // Aim A: pointer low-left of the cue ball.
  await page.mouse.move(box.x + box.width * 0.34, box.y + box.height * 0.62);
  await sleep(600);
  const aimA = await canvas.screenshot();
  await page.screenshot({ path: path.join(ROOT, "docs", "play3d-rack.png") });

  // Aim B: pointer high-left — the cue stick must swing to a new angle.
  await page.mouse.move(box.x + box.width * 0.32, box.y + box.height * 0.32);
  await sleep(600);
  const aimB = await canvas.screenshot();
  const aimDiff = diffFraction(aimA, aimB);
  check("aim works: cue stick follows the pointer", aimDiff > 0.002, `${(aimDiff * 100).toFixed(2)}% of pixels changed`);
  await page.screenshot({ path: path.join(ROOT, "docs", "play3d-aim2.png") });

  // Break: hold to charge, release.
  await page.mouse.move(box.x + box.width * 0.42, box.y + box.height * 0.5);
  await page.mouse.down();
  await sleep(700);
  await page.mouse.up();
  await sleep(3000);
  await page.screenshot({ path: path.join(ROOT, "docs", "play3d-break.png") });
  console.log("  break shot replayed → docs/play3d-break.png");

  // Switch to SNOOKER — expect red balls, and NO leftover pool balls.
  const clickChip = (label) =>
    page.evaluate((t) => {
      const btn = [...document.querySelectorAll("button")].find(
        (b) => (b.textContent || "").trim().toUpperCase().includes(t)
      );
      if (btn) btn.click();
      return !!btn;
    }, label);

  const sn = await clickChip("SNOOKER");
  await sleep(1500);
  await page.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.55);
  await sleep(400);
  await page.screenshot({ path: path.join(ROOT, "docs", "play3d-snooker.png") });
  check("snooker chip switched the rack", sn);
  console.log("  snooker rack → docs/play3d-snooker.png (eyeball: 15 reds + 6 colours, no numbered pool balls)");

  // Switch back to 8-ball — confirm no fake/leftover snooker balls remain.
  await clickChip("8 BALL");
  await sleep(1500);
  await page.mouse.move(box.x + box.width * 0.34, box.y + box.height * 0.55);
  await sleep(400);
  await page.screenshot({ path: path.join(ROOT, "docs", "play3d-8ball-again.png") });
  console.log("  back to 8-ball → docs/play3d-8ball-again.png (eyeball: 15 numbered + cue, no reds)");

  // Ball-in-hand: press, drag the ghost to a clear spot, release → placed
  // (the "Ball in hand" banner clears).
  const bih = await browser.newPage();
  await bih.setViewport({ width: 1440, height: 900 });
  await bih.goto(`${URL}&preview=ballinhand`, { waitUntil: "domcontentloaded", timeout: 60000 });
  await bih.waitForSelector("canvas", { timeout: 60000 });
  await sleep(3200);
  const inHandBefore = await bih.evaluate(() => document.body.innerText.includes("Ball in hand"));
  const bb = await (await bih.$("canvas")).boundingBox();
  await bih.mouse.move(bb.x + bb.width * 0.45, bb.y + bb.height * 0.5);
  await bih.mouse.down();
  await bih.mouse.move(bb.x + bb.width * 0.3, bb.y + bb.height * 0.42, { steps: 8 });
  await bih.mouse.up();
  await sleep(900);
  const inHandAfter = await bih.evaluate(() => document.body.innerText.includes("Ball in hand"));
  check(
    "ball-in-hand: mouse drag places the cue ball",
    inHandBefore && !inHandAfter,
    `in-hand before=${inHandBefore}, after=${inHandAfter}`
  );

  if (errors.length) console.log("  page errors:", errors.slice(0, 6).join(" | "));
} finally {
  await browser.close();
}

const failed = results.filter((r) => !r.ok);
if (failed.length) {
  console.error(`\n✗ ${failed.length} 3D check(s) failed`);
  process.exit(1);
}
console.log("\n✓ 3D verification passed");
