// Interactive UI verification: drives the real practice page with mouse and
// keyboard via the installed Chrome (puppeteer-core, no browser download).
// Checks: viewport fit (no scroll), click-shoot, W+Space shoot, spin widget.
import path from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const URL = process.env.VERIFY_URL ?? "http://localhost:3000/practice";

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

  // 3. W charges power, Space fires.
  await page.keyboard.down("w");
  await sleep(600);
  await page.keyboard.up("w");
  await page.keyboard.press(" ");
  await sleep(6000);
  await page.mouse.move(aim.x, aim.y);
  await sleep(300);
  const afterKeys = await canvas.screenshot();
  check(
    "W key + Space takes a shot",
    Buffer.compare(afterClick, afterKeys) !== 0
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
  check("mobile: shell bottom nav visible", mNav !== "none");
  const mFit = await mobile.evaluate(() => ({
    scrollH: document.documentElement.scrollHeight,
    innerH: window.innerHeight,
  }));
  check(
    "mobile: fits the viewport without scrolling",
    mFit.scrollH <= mFit.innerH + 2,
    `scrollHeight ${mFit.scrollH} vs viewport ${mFit.innerH}`
  );
  await mobile.screenshot({ path: path.join(ROOT, "docs", "game-shell-mobile.png") });
  console.log("  screenshot → docs/game-shell-mobile.png");
} finally {
  await browser.close();
}

const failed = results.filter((r) => !r.ok);
if (failed.length) {
  console.error(`\n✗ ${failed.length} UI check(s) failed`);
  process.exit(1);
}
console.log("\n✓ UI verification passed");
