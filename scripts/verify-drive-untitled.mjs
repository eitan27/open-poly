// Auto-named documents across two devices, against the MOCK Google: a second
// device's untouched seed box neither uploads nor clashes with the first
// device's "Untitled"; once edited it renames itself "Untitled 2" (keeping its
// undo history) and uploads.
//
// Needs BOTH dev servers, like verify-drive-sync.mjs:
//   npm run dev:api
//   npm run dev
//   node scripts/verify-drive-untitled.mjs
import { chromium } from "playwright";
import { DEFAULT_URL, checker } from "./lib/harness.mjs";
const URL = DEFAULT_URL;
const EMAIL = `untitled-${Date.now()}@example.com`;
const { check, done } = checker();
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
async function device() {
  const context = await browser.newContext({ viewport: { width: 1500, height: 900 } });
  const page = await context.newPage();
  await page.goto(URL);
  await page.waitForFunction(() => window.__openpoly, null, { timeout: 30000 });
  await page.waitForTimeout(1500);
  return { context, page };
}
async function connect(d) {
  await d.page.locator(".drive-btn").click();
  const [popup] = await Promise.all([d.context.waitForEvent("page"), d.page.getByRole("button", { name: "Connect Google Drive" }).click()]);
  await popup.locator("#mock-email").fill(EMAIL);
  await popup.locator("#mock-allow").click();
  await popup.waitForEvent("close", { timeout: 10000 }).catch(() => {});
  await d.page.locator(".drive-btn--ok").waitFor({ timeout: 20000 });
  await d.page.keyboard.press("Escape");
}
const title = (p) => p.locator(".doc-title").inputValue();
const syncLabel = async (p) => {
  await p.locator(".docs-btn").click();
  await p.waitForTimeout(500);
  const t = (await p.locator(".docs-row.active .docs-sync, .docs-row:not(.cloud-only) .docs-sync").first().textContent())?.trim();
  await p.keyboard.press("Escape");
  return t;
};

const a = await device();
await a.page.evaluate(() => window.__openpoly.apply({ op: "addPrimitive", kind: "sphere" }));
await a.page.waitForTimeout(1500);
await connect(a);
check("device A: its edited Untitled uploaded", (await syncLabel(a.page)) === "☁ In Drive");

const b = await device();
check("device B starts as Untitled", (await title(b.page)) === "Untitled");
await connect(b);
check("device B: no onboarding list", !(await b.page.locator(".drive-onboarding").isVisible()));
check("device B: no amber badge", !(await b.page.locator(".drive-btn--attention").isVisible()));
const lbl = await syncLabel(b.page);
check("device B: the seed box is labelled empty", lbl === "Empty · syncs once edited", lbl);
check("device B: still Untitled", (await title(b.page)) === "Untitled");

await b.page.evaluate(() => window.__openpoly.apply({ op: "addPrimitive", kind: "cylinder" }));
await b.page.waitForFunction(() => document.querySelector(".doc-title")?.value === "Untitled 2", null, { timeout: 20000 }).catch(() => {});
check("device B: edited, it is renamed Untitled 2", (await title(b.page)) === "Untitled 2", await title(b.page));
await b.page.locator(".drive-btn--ok").waitFor({ timeout: 20000 }).catch(() => {});
check("device B: now in Drive", (await syncLabel(b.page)) === "☁ In Drive");
const before = (await b.page.evaluate(() => window.__openpoly.read({ read: "document" }))).features.length;
await b.page.locator("canvas").first().click({ position: { x: 5, y: 5 } }).catch(() => {});
await b.page.keyboard.press("Meta+z");
await b.page.waitForTimeout(500);
const after = (await b.page.evaluate(() => window.__openpoly.read({ read: "document" }))).features.length;
check("device B: undo history survived the rename", after === before - 1, `${before}→${after}`);

await b.page.locator(".docs-btn").click();
await b.page.waitForTimeout(800);
const cloud = await b.page.locator(".docs-row.cloud-only .docs-name").allTextContents();
check("device B: A's Untitled is listed as in Drive", cloud.includes("Untitled"), cloud.join());
await browser.close();
done();
