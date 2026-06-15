// Screenshots the practice table in each game variant by clicking the mode chips.
import path from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const URL = "http://localhost:3000/practice";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: "new",
  args: ["--no-sandbox", "--mute-audio"],
});
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1366, height: 768, deviceScaleFactor: 1.4 });
  await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForSelector("canvas", { timeout: 30000 });
  await sleep(2500);

  async function clickChip(label) {
    const clicked = await page.evaluate((lbl) => {
      const btn = [...document.querySelectorAll("button")].find((b) =>
        b.textContent?.trim().toUpperCase().startsWith(lbl)
      );
      if (btn) {
        btn.click();
        return true;
      }
      return false;
    }, label);
    return clicked;
  }

  for (const [label, file] of [
    ["8 BALL", "variant-8ball.png"],
    ["9 BALL", "variant-9ball.png"],
    ["SNOOKER", "variant-snooker.png"],
  ]) {
    const ok = await clickChip(label);
    console.log(`${label}: chip ${ok ? "clicked" : "NOT FOUND"}`);
    await sleep(1500);
    await page.screenshot({ path: path.join(ROOT, "docs", file) });
    console.log(`  → docs/${file}`);
  }
} finally {
  await browser.close();
}
