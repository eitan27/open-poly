// Auto-named documents across devices, against the MOCK Google:
//   B (has work of its own): an untouched "Untitled" neither uploads nor
//     clashes with A's "Untitled"; once edited it renames itself "Untitled 2"
//     (keeping its undo history) and uploads.
//   C (nothing but the seed box): connecting opens the Drive document edited
//     most recently in place of the starter, which is removed, and says so;
//     the opened document's thumbnail fills in while Documents is open.
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
async function connect(d, { keepOpen = false } = {}) {
  await d.page.locator(".drive-btn").click();
  const [popup] = await Promise.all([
    d.context.waitForEvent("page"),
    d.page.getByRole("button", { name: "Connect Google Drive" }).click(),
  ]);
  await popup.locator("#mock-email").fill(EMAIL);
  await popup.locator("#mock-allow").click();
  await popup.waitForEvent("close", { timeout: 10000 }).catch(() => {});
  await d.page.locator(".drive-btn--ok").waitFor({ timeout: 20000 });
  if (!keepOpen) await d.page.keyboard.press("Escape");
}
const title = (p) => p.locator(".doc-title").inputValue();
const syncLabel = async (p) => {
  await p.locator(".docs-btn").click();
  await p.waitForTimeout(500);
  const t = (
    await p.locator(".docs-row.active .docs-sync, .docs-row:not(.cloud-only) .docs-sync").first().textContent()
  )?.trim();
  await p.keyboard.press("Escape");
  return t;
};

const a = await device();
await a.page.evaluate(() => window.__openpoly.apply({ op: "addPrimitive", kind: "sphere" }));
await a.page.waitForTimeout(1500);
await connect(a);
check("device A: its edited Untitled uploaded", (await syncLabel(a.page)) === "☁ In Drive");

// B has work of its own (the seed, renamed), so connecting opens nothing; its
// fresh New document is the untouched "Untitled".
const b = await device();
await b.page.locator(".doc-title").fill("Mine");
await b.page.locator(".doc-title").press("Enter");
await b.page.getByRole("button", { name: /New/ }).first().click();
await b.page.waitForFunction(() => document.querySelector(".doc-title")?.value === "Untitled", null, {
  timeout: 10000,
});
await b.page.waitForTimeout(800);
check("device B starts as Untitled", (await title(b.page)) === "Untitled");
await connect(b);
check("device B: with work of its own, connecting keeps it where it is", (await title(b.page)) === "Untitled");
check("device B: no onboarding list", !(await b.page.locator(".drive-onboarding").isVisible()));
check("device B: no amber badge", !(await b.page.locator(".drive-btn--attention").isVisible()));
const lbl = await syncLabel(b.page);
check("device B: the seed box is labelled empty", lbl === "Empty · syncs once edited", lbl);
check("device B: still Untitled", (await title(b.page)) === "Untitled");

await b.page.evaluate(() => window.__openpoly.apply({ op: "addPrimitive", kind: "cylinder" }));
await b.page
  .waitForFunction(() => document.querySelector(".doc-title")?.value === "Untitled 2", null, { timeout: 20000 })
  .catch(() => {});
check("device B: edited, it is renamed Untitled 2", (await title(b.page)) === "Untitled 2", await title(b.page));
await b.page
  .locator(".drive-btn--ok")
  .waitFor({ timeout: 20000 })
  .catch(() => {});
check("device B: now in Drive", (await syncLabel(b.page)) === "☁ In Drive");
const before = (await b.page.evaluate(() => window.__openpoly.read({ read: "document" }))).features.length;
await b.page
  .locator("canvas")
  .first()
  .click({ position: { x: 5, y: 5 } })
  .catch(() => {});
await b.page.keyboard.press("Meta+z");
await b.page.waitForTimeout(500);
const after = (await b.page.evaluate(() => window.__openpoly.read({ read: "document" }))).features.length;
check("device B: undo history survived the rename", after === before - 1, `${before}→${after}`);

await b.page.locator(".docs-btn").click();
await b.page.waitForTimeout(800);
const cloud = await b.page.locator(".docs-row.cloud-only .docs-name").allTextContents();
check("device B: A's Untitled is listed as in Drive", cloud.includes("Untitled"), cloud.join());
await b.page.keyboard.press("Escape");

// --- C: nothing but the seed box ---------------------------------------------
const c = await device();
await connect(c, { keepOpen: true });
await c.page
  .waitForFunction(() => document.querySelector(".doc-title")?.value === "Untitled 2", null, {
    timeout: 20000,
  })
  .catch(() => {});
check(
  "device C: opens the Drive document edited most recently",
  (await title(c.page)) === "Untitled 2",
  await title(c.page),
);
const notice =
  (await c.page
    .locator(".drive-info")
    .textContent()
    .catch(() => "")) ?? "";
check(
  "device C: says what it opened and where the rest are",
  /Opened “Untitled 2”.*more are in Open…/.test(notice),
  notice,
);
await c.page.keyboard.press("Escape");
await c.page.locator(".docs-btn").click();
await c.page.waitForTimeout(400);
const local = await c.page.locator(".docs-row:not(.cloud-only) .docs-name").allTextContents();
check("device C: the empty starter it replaced is gone", local.length === 1, local.join(" | "));
await c.page
  .locator(".docs-row.active img.docs-thumb")
  .waitFor({ timeout: 15000 })
  .catch(() => {});
check(
  "device C: the opened document's thumbnail fills in without reopening Documents",
  await c.page.locator(".docs-row.active img.docs-thumb").isVisible(),
);
await browser.close();
done();
