// Interactive UI verification: drives the real practice page with mouse and
// keyboard via the installed Chrome (puppeteer-core, no browser download).
// Checks: viewport fit (no scroll), click-shoot, W+Space shoot, spin widget.
import path from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";
import { PNG } from "pngjs";

/** Fraction of pixels that differ between two PNG screenshots (0..1), with a
 *  small per-channel tolerance so anti-aliasing jitter doesn't count. A real
 *  shot moves balls across the table → large fraction; a static aim → ~0. */
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
// Force the 2D canvas for the control/layout checks (deterministic, no WebGL);
// the 3D table is verified separately in verify-3d.mjs.
const URL = process.env.VERIFY_URL ?? "http://localhost:3000/practice?view=2d";

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`  ${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: "new",
  args: ["--no-sandbox", "--mute-audio"],
});

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1366, height: 768 });
  await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForSelector("canvas", { timeout: 30000 });
  await sleep(2500); // let SVG assets land

  // 1. The whole shell fits the viewport — no scrolling.
  const fit = await page.evaluate(() => ({
    scrollH: document.documentElement.scrollHeight,
    innerH: window.innerHeight,
  }));
  check(
    "table fits the viewport without scrolling",
    fit.scrollH <= fit.innerH + 2,
    `scrollHeight ${fit.scrollH} vs viewport ${fit.innerH}`
  );

  const canvas = await page.$("canvas");
  const box = await canvas.boundingBox();
  const aim = { x: box.x + box.width * 0.6, y: box.y + box.height * 0.5 };

  // 2. Click-and-hold charges, release shoots (table changes).
  const before = await canvas.screenshot();
  await page.mouse.move(aim.x, aim.y);
  await page.mouse.down();
  await sleep(700);
  await page.mouse.up();
  await sleep(6000); // animation + settle
  await page.mouse.move(aim.x, aim.y); // identical cursor spot for a fair diff
  await sleep(300);
  const afterClick = await canvas.screenshot();
  check(
    "hold-click + release takes a shot",
    Buffer.compare(before, afterClick) !== 0
  );

  // 3. W charges power, Space fires. Reload to a fresh rack first so this
  //    isolates the keyboard path (the prior shot may have left the cue in
  //    hand / potted, which would legitimately block the next shot).
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector("canvas", { timeout: 30000 });
  await sleep(2000);
  const canvas2 = await page.$("canvas"); // reload invalidates the old handle
  await page.mouse.move(aim.x, aim.y); // set aim
  const keysBefore = await canvas2.screenshot();
  await page.keyboard.down("w");
  await sleep(600);
  await page.keyboard.up("w");
  await page.keyboard.press(" ");
  await sleep(6000);
  await page.mouse.move(aim.x, aim.y);
  await sleep(300);
  const afterKeys = await canvas2.screenshot();
  check(
    "W key + Space takes a shot",
    Buffer.compare(keysBefore, afterKeys) !== 0
  );

  // 4. The spin widget dot follows a drag.
  const dotBefore = await page.$eval(
    '[data-testid="spin-dot"]',
    (el) => el.style.left + "/" + el.style.top
  );
  const spinBox = await (await page.$('[data-testid="spin-control"]')).boundingBox();
  const spinCenter = { x: spinBox.x + spinBox.width / 2, y: spinBox.y + spinBox.height / 2 };
  await page.mouse.move(spinCenter.x, spinCenter.y - 4);
  await page.mouse.down();
  await page.mouse.move(spinCenter.x + 10, spinCenter.y - 14, { steps: 4 });
  await page.mouse.up();
  await sleep(200);
  const dotAfter = await page.$eval(
    '[data-testid="spin-dot"]',
    (el) => el.style.left + "/" + el.style.top
  );
  check("spin widget sets the cue-ball hit point", dotBefore !== dotAfter, `${dotBefore} → ${dotAfter}`);

  // 5. PC chrome rules: site header visible, shell bottom nav hidden.
  const headerDisplay = await page.$eval(
    '[data-testid="site-header"]',
    (el) => getComputedStyle(el).display
  );
  check("desktop: site header visible", headerDisplay !== "none");
  const navDisplay = await page.$eval(
    '[data-testid="shell-nav"]',
    (el) => getComputedStyle(el).display
  );
  check("desktop: shell bottom nav hidden", navDisplay === "none");

  await page.screenshot({ path: path.join(ROOT, "docs", "game-shell-final.png") });
  console.log("  screenshot → docs/game-shell-final.png");

  // 6. Mobile pass: emulate a phone in landscape (touch → pointer: coarse).
  const mobile = await browser.newPage();
  await mobile.emulate({
    viewport: { width: 932, height: 430, isMobile: true, hasTouch: true },
    userAgent:
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
  });
  await mobile.goto(URL, { waitUntil: "domcontentloaded", timeout: 60000 });
  await mobile.waitForSelector("canvas", { timeout: 30000 });
  await sleep(2000);

  const mHeader = await mobile.$eval(
    '[data-testid="site-header"]',
    (el) => getComputedStyle(el).display
  );
  check("mobile: site header hidden", mHeader === "none");
  const mNav = await mobile.$eval(
    '[data-testid="shell-nav"]',
    (el) => getComputedStyle(el).display
  );
  // The bottom nav is now hidden on phones (moved into the top-left menu) so
  // the table gets the whole screen.
  check("mobile: bottom nav hidden (moved to menu)", mNav === "none");
  const mFit = await mobile.evaluate(() => ({
    scrollH: document.documentElement.scrollHeight,
    innerH: window.innerHeight,
  }));
  check(
    "mobile: fits the viewport without scrolling",
    mFit.scrollH <= mFit.innerH + 2,
    `scrollHeight ${mFit.scrollH} vs viewport ${mFit.innerH}`
  );

  // 7. Mobile controls: dragging the TABLE only aims (must NOT fire a shot);
  //    the POWER SLIDER is the shoot trigger. We detect an unwanted shot by
  //    the table animating between two post-gesture snapshots.
  const mCanvas = await mobile.$("canvas");
  const cbox = await mCanvas.boundingBox();
  // Touch-drag across the table to aim.
  await mobile.touchscreen.touchStart(cbox.x + cbox.width * 0.5, cbox.y + cbox.height * 0.5);
  await mobile.touchscreen.touchMove(cbox.x + cbox.width * 0.72, cbox.y + cbox.height * 0.4);
  await mobile.touchscreen.touchEnd();
  await sleep(700);
  const aimA = await mCanvas.screenshot();
  await sleep(1200);
  const aimB = await mCanvas.screenshot();
  // A fired shot would have balls mid-flight here (large frame-to-frame diff);
  // a pure aim leaves the table static (tolerant of AA jitter).
  const aimDiff = diffFraction(aimA, aimB);
  check(
    "mobile: dragging the table aims without shooting",
    aimDiff < 0.01,
    `${(aimDiff * 100).toFixed(2)}% of pixels changed (a shot would be far more)`
  );

  // Drag the power slider up and release → this fires the shot.
  const sbox = await (await mobile.$('[data-testid="power-slider"]')).boundingBox();
  const sx = sbox.x + sbox.width / 2;
  await mobile.touchscreen.touchStart(sx, sbox.y + sbox.height * 0.9);
  await mobile.touchscreen.touchMove(sx, sbox.y + sbox.height * 0.3);
  await mobile.touchscreen.touchEnd();
  await sleep(900);
  const shotC = await mCanvas.screenshot();
  check(
    "mobile: power slider fires the shot",
    Buffer.compare(aimA, shotC) !== 0
  );

  await mobile.screenshot({ path: path.join(ROOT, "docs", "game-shell-mobile.png") });
  console.log("  screenshot → docs/game-shell-mobile.png");

  // 8. Mobile ball-in-hand: drag the ghost cue ball to a clear spot and drop
  //    it. Placement clears the in-hand state (the banner disappears).
  const bih = await browser.newPage();
  await bih.emulate({
    viewport: { width: 932, height: 430, isMobile: true, hasTouch: true },
    userAgent:
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
  });
  const bihUrl = `${URL}${URL.includes("?") ? "&" : "?"}preview=ballinhand`;
  await bih.goto(bihUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
  await bih.waitForSelector("canvas", { timeout: 30000 });
  await sleep(1500);
  const inHandBefore = await bih.evaluate(() => document.body.innerText.includes("Ball in hand"));
  const bc = await (await bih.$("canvas")).boundingBox();
  // Drag from table centre to the empty baulk area (left of the rack) and drop.
  await bih.touchscreen.touchStart(bc.x + bc.width * 0.5, bc.y + bc.height * 0.5);
  await bih.touchscreen.touchMove(bc.x + bc.width * 0.28, bc.y + bc.height * 0.5);
  await bih.touchscreen.touchEnd();
  await sleep(600);
  const inHandAfter = await bih.evaluate(() => document.body.innerText.includes("Ball in hand"));
  check(
    "mobile: drag places the cue ball (ball-in-hand)",
    inHandBefore && !inHandAfter,
    `in-hand before=${inHandBefore}, after=${inHandAfter}`
  );
  await bih.screenshot({ path: path.join(ROOT, "docs", "ballinhand-mobile.png") });
} finally {
  await browser.close();
}

const failed = results.filter((r) => !r.ok);
if (failed.length) {
  console.error(`\n✗ ${failed.length} UI check(s) failed`);
  process.exit(1);
}
console.log("\n✓ UI verification passed");
