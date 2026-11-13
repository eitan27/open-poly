// The viewport says what to do when the browser's 3D graphics fail, instead
// of a blank page: (1) WebGL that can't start (getContext refuses, as a
// Safari in a bad state effectively does) shows "couldn't start" and says to
// restart the browser; (2) a context lost while open (WEBGL_lose_context)
// shows "stopped working", says to reload, and Reload reloads.
import { chromium } from "playwright";

const URL = process.env.URL ?? "http://localhost:5173/";
const SHOTS = process.env.SHOTS;
const browser = await chromium.launch(process.env.PW_EXE ? { executablePath: process.env.PW_EXE } : {});
let failures = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}: ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

// (1) WebGL refuses to start.
{
  const context = await browser.newContext({ viewport: { width: 1400, height: 860 }, deviceScaleFactor: 2 });
  await context.addInitScript(() => {
    const get = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (type, ...rest) {
      return /webgl/.test(type) ? null : get.call(this, type, ...rest);
    };
  });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(URL, { waitUntil: "domcontentloaded" });
  const card = page.locator(".gl-failure");
  await card.waitFor({ timeout: 30000 });
  const text = await card.innerText();
  check("no WebGL: the view says it couldn't start", /couldn't start/.test(text), text.split("\n")[0]);
  check("…and says to quit and reopen the browser", /quit the browser completely/i.test(text) && /⌘Q/.test(text));
  check("…with the rest of the app still up", await page.locator(".doc-title").isVisible());
  check("…and no uncaught error", errors.length === 0, errors.join(" | "));
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/gl-start.png` });
  await context.close();
}

// (2) The context is lost while the app is open.
{
  const context = await browser.newContext({ viewport: { width: 1400, height: 860 }, deviceScaleFactor: 2 });
  const page = await context.newPage();
  await page.goto(URL, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.__openpoly, null, { timeout: 60000 });
  check("a working view shows no notice", (await page.locator(".gl-failure").count()) === 0);
  const lost = await page.evaluate(() => {
    const c = document.querySelector(".viewport canvas");
    const gl = c.getContext("webgl2") ?? c.getContext("webgl");
    const ext = gl?.getExtension("WEBGL_lose_context");
    ext?.loseContext();
    return !!ext;
  });
  check("the context can be lost on purpose", lost);
  const card = page.locator(".gl-failure");
  await card.waitFor({ timeout: 10000 });
  const text = await card.innerText();
  check("a lost context: the view says it stopped working", /stopped working/.test(text), text.split("\n")[0]);
  check("…and says to reload, then restart the browser", /Reload the page/.test(text) && /⌘Q/.test(text));
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/gl-lost.png` });
  await Promise.all([page.waitForEvent("load"), card.locator("button", { hasText: "Reload" }).click()]);
  await page.waitForFunction(() => window.__openpoly, null, { timeout: 60000 });
  check("Reload brings a working view back", (await page.locator(".gl-failure").count()) === 0);
  await context.close();
}

await browser.close();
console.log(failures ? `${failures} FAILED` : "ALL PASS");
process.exit(failures ? 1 : 0);
