// Loads the running dev server in headless Chromium and reports console
// messages, page errors, and whether regeneration completed.
import { chromium } from "playwright";

const URL = process.env.URL ?? "http://localhost:5173/";
const browser = await chromium.launch();
// Mimic a Retina display + wide window to catch DPR-related sizing bugs.
const context = await browser.newContext({
  viewport: { width: 1660, height: 920 },
  deviceScaleFactor: 2,
});
const page = await context.newPage();

page.on("console", (m) => console.log(`[console.${m.type()}] ${m.text()}`));
page.on("pageerror", (e) => console.log(`[pageerror] ${e.message}`));
page.on("requestfailed", (r) => console.log(`[requestfailed] ${r.url()} :: ${r.failure()?.errorText}`));
page.on("worker", (w) => console.log(`[worker created] ${w.url()}`));

await page.goto(URL, { waitUntil: "domcontentloaded" });

// Poll until the status chip reads a *stable* "up to date" (two consecutive
// reads), so we don't capture during the StrictMode remount's regeneration.
let status = "";
let stable = 0;
for (let i = 0; i < 80; i++) {
  status = (await page.locator(".status").textContent())?.trim() ?? "";
  stable = /up to date/i.test(status) ? stable + 1 : 0;
  if (stable >= 3) break;
  await page.waitForTimeout(400);
}

const errorBox = await page.locator(".error-box").count();
const errorText = errorBox ? await page.locator(".error-box").textContent() : null;
const canvas = await page.evaluate(() => {
  const c = document.querySelector("canvas");
  return c ? `${c.width}x${c.height}` : "no-canvas";
});

await page.screenshot({ path: "/tmp/openshape.png" });

console.log("=== RESULT ===");
console.log("status chip:", JSON.stringify(status));
console.log("error box:", errorText);
console.log("canvas:", canvas);
console.log("screenshot: /tmp/openshape.png");

await browser.close();
