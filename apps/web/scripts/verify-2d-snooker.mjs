import path from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const b = await puppeteer.launch({ executablePath: CHROME, headless: "new", args: ["--no-sandbox","--mute-audio"] });
try {
  const page = await b.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  await page.goto("http://localhost:3000/practice?view=2d", { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForSelector("canvas", { timeout: 30000 });
  await sleep(2000);
  const poolAR = await page.$eval("canvas", (c) => c.width + "x" + c.height);
  // switch to snooker
  await page.evaluate(() => { const btn=[...document.querySelectorAll("button")].find(x=>(x.textContent||"").toUpperCase().includes("SNOOKER")); if(btn) btn.click(); });
  await sleep(1500);
  const snkAR = await page.$eval("canvas", (c) => c.width + "x" + c.height);
  await page.screenshot({ path: path.join(ROOT, "docs", "practice-2d-snooker.png") });
  console.log(`2D canvas: pool ${poolAR} -> snooker ${snkAR} (snooker should be bigger/more elongated)`);
  console.log("→ docs/practice-2d-snooker.png");
} finally { await b.close(); }
