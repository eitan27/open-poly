// Google Drive sync, end to end, against the MOCK Google (no Google project or
// account needed). Two browser contexts are two devices of one user:
//   connect via the popup → first-connect upload with nothing to ask → same-name
//   collision on the second device (asked: rename) → open a Drive-only document
//   → an edit on one device reloads the open document on the other → offline
//   edits on both sides become a conflict, resolved "keep both" → access revoked
//   in "Google" surfaces as a reconnect → disconnect.
//
// Needs BOTH dev servers:
//   npm run dev:api        # Pages Functions + mock Google/Drive on :8788
//   npm run dev            # the app; proxies /api to :8788
//   node scripts/verify-drive-sync.mjs
import { chromium } from "playwright";
import { DEFAULT_URL, checker } from "./lib/harness.mjs";

const URL = DEFAULT_URL;
const EMAIL = `e2e-${Date.now()}@example.com`; // fresh account → fresh mock Drive
const { check, done } = checker();

const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});

async function device(label) {
  const context = await browser.newContext({ viewport: { width: 1500, height: 900 } });
  const page = await context.newPage();
  page.on("pageerror", (e) => console.log(`[${label} pageerror] ${e.message}`));
  await page.goto(URL, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.__openpoly, null, { timeout: 30000 });
  await waitIdle(page);
  return { label, context, page };
}

async function waitIdle(page) {
  let run = 0;
  for (let i = 0; i < 200; i++) {
    const s = (await page.locator(".status").textContent())?.trim() ?? "";
    run = /up to date|error|fail/i.test(s) ? run + 1 : 0;
    if (run >= 3) return s;
    await page.waitForTimeout(250);
  }
  return "TIMEOUT";
}

const apply = (page, op) => page.evaluate((x) => window.__openpoly.apply(x), op);
const featureTypes = async (page) =>
  (await page.evaluate(() => window.__openpoly.read({ read: "document" }))).features.map((f) =>
    f.kind ? `${f.type}:${f.kind}` : f.type,
  );
const features = async (page) => (await featureTypes(page)).length;
const title = (page) => page.locator(".doc-title").inputValue();

async function rename(page, name) {
  await page.locator(".doc-title").fill(name);
  await page.locator(".doc-title").press("Enter");
}

/** Wait until the Drive button reaches `state` (off/ok/busy/attention/problem). */
async function driveState(page, state, timeout = 20000) {
  try {
    await page.locator(`.drive-btn--${state}`).waitFor({ timeout });
    return true;
  } catch {
    return false;
  }
}

/** Connect through the mock consent popup. Assumes the Drive dialog is open. */
async function connect(dev) {
  const [popup] = await Promise.all([
    dev.context.waitForEvent("page"),
    dev.page.getByRole("button", { name: "Connect Google Drive" }).click(),
  ]);
  await popup.waitForLoadState("domcontentloaded");
  await popup.locator("#mock-email").fill(EMAIL);
  await popup.locator("#mock-allow").click();
  await popup.waitForEvent("close", { timeout: 10000 }).catch(() => {});
}

const openDriveDialog = (page) => page.locator(".drive-btn").click();
const closeDialog = (page) => page.keyboard.press("Escape");

// --- laptop: first connect --------------------------------------------------
const laptop = await device("laptop");
check("Drive button is shown when the API is up", await laptop.page.locator(".drive-btn--off").isVisible());
await rename(laptop.page, "Bracket");
await apply(laptop.page, { op: "addPrimitive", kind: "box" });
await waitIdle(laptop.page);
// New documents are seeded with a box, so count from what's there.
const laptopTypes = await featureTypes(laptop.page);

await openDriveDialog(laptop.page);
await connect(laptop);
// Nothing in Drive shares a name with it, so there's nothing to ask: it uploads.
check("first connect with no name clash uploads without asking", await driveState(laptop.page, "ok"));
check("…and shows no onboarding list", !(await laptop.page.locator(".drive-onboarding").isVisible()));
await closeDialog(laptop.page);

// --- desktop: same-name collision, then open the Drive-only doc --------------
const desktop = await device("desktop");
await rename(desktop.page, "Bracket");
await apply(desktop.page, { op: "addPrimitive", kind: "cylinder" });
await apply(desktop.page, { op: "addPrimitive", kind: "sphere" });
await waitIdle(desktop.page);
await openDriveDialog(desktop.page);
await connect(desktop);
await desktop.page.locator(".drive-onboarding").waitFor({ timeout: 15000 });
check(
  "the desktop's own “Bracket” is flagged as colliding with Drive's",
  await desktop.page.locator(".drive-collision").isVisible(),
);
const select = desktop.page.locator(".drive-ob-row select");
check("collision defaults to rename-and-upload", (await select.inputValue()) === "rename");
await desktop.page.locator(".drive-rename-input").fill("Bracket (desktop)");
await desktop.page.getByRole("button", { name: "Continue" }).click();
check("desktop synced after onboarding", await driveState(desktop.page, "ok"));
check("the renamed document is the open one", (await title(desktop.page)) === "Bracket (desktop)");
await closeDialog(desktop.page);

await desktop.page.locator(".docs-btn").click();
await desktop.page.locator(".docs-row.cloud-only").first().waitFor({ timeout: 10000 });
const cloudNames = await desktop.page.locator(".docs-row.cloud-only .docs-name").allTextContents();
check(
  "the laptop's Bracket is listed as in Drive, not on this device",
  cloudNames.includes("Bracket"),
  cloudNames.join(),
);
await desktop.page.locator(".docs-row.cloud-only").getByRole("button", { name: "Sync and Open" }).click();
await desktop.page.waitForFunction(() => document.querySelector(".doc-title")?.value === "Bracket", null, {
  timeout: 15000,
});
await waitIdle(desktop.page);
check(
  "opening it downloads the laptop's version",
  JSON.stringify(await featureTypes(desktop.page)) === JSON.stringify(laptopTypes),
);

// --- an edit on the desktop reloads the open doc on the laptop ----------------
await apply(desktop.page, { op: "addPrimitive", kind: "sphere" });
await waitIdle(desktop.page);
await desktop.page.waitForTimeout(5500); // edit debounce (4 s) + the pass
check("desktop pushed the edit", await driveState(desktop.page, "ok"));
await openDriveDialog(laptop.page);
await laptop.page.getByRole("button", { name: "Sync now" }).click();
const expected = laptopTypes.length + 1;
await laptop.page
  .waitForFunction((n) => window.__openpoly.read({ read: "document" }).features.length === n, expected, {
    timeout: 15000,
  })
  .catch(() => {});
check("the laptop's open document picked up the desktop's edit", (await features(laptop.page)) === expected);
await closeDialog(laptop.page);

// --- offline edits on both sides → conflict → keep both ----------------------
await laptop.context.setOffline(true);
await apply(laptop.page, { op: "addPrimitive", kind: "box" }); // laptop: 3 features
await waitIdle(laptop.page);
await laptop.page.waitForTimeout(5500);
check("an offline laptop says so on the button", await driveState(laptop.page, "problem"));
await apply(desktop.page, { op: "addPrimitive", kind: "cylinder" }); // desktop: same count, different
await waitIdle(desktop.page);
const desktopTypes = await featureTypes(desktop.page);
await desktop.page.waitForTimeout(5500);
await laptop.context.setOffline(false);
await laptop.page.evaluate(() => window.dispatchEvent(new Event("online")));
check("back online, the laptop flags a conflict", await driveState(laptop.page, "attention"));
await openDriveDialog(laptop.page);
const issue = laptop.page.locator(".drive-issue--conflict");
check("the conflict card names the document", (await issue.textContent())?.includes("“Bracket”") ?? false);
await issue.getByRole("button", { name: "Keep both" }).click();
check("resolved, the laptop is synced again", await driveState(laptop.page, "ok"));
await closeDialog(laptop.page);
await laptop.page.locator(".docs-btn").click();
const names = await laptop.page.locator(".docs-row:not(.cloud-only) .docs-name").allTextContents();
check(
  "keep both saved the laptop's version as a conflict copy",
  names.some((n) => n.startsWith("Bracket (conflict copy)")),
  names.join(" | "),
);
await waitIdle(laptop.page);
const laptopNow = await featureTypes(laptop.page);
check(
  "the open Bracket now holds Drive's (the desktop's) version",
  JSON.stringify(laptopNow) === JSON.stringify(desktopTypes),
  `${laptopNow.join(",")} vs ${desktopTypes.join(",")}`,
);
await closeDialog(laptop.page);

// --- access revoked at "Google" → reconnect prompt → reconnect ---------------
await laptop.page.evaluate(
  (email) => fetch(`/api/drive/mock/revoke?email=${encodeURIComponent(email)}`, { method: "POST" }),
  EMAIL,
);
await openDriveDialog(laptop.page);
// A routine pass (the keep-both above replaced the open document) may find
// the dead grant before this click does; either way the Connect view follows.
await laptop.page
  .getByRole("button", { name: "Sync now" })
  .click({ timeout: 3000 })
  .catch(() => {});
await laptop.page.getByRole("button", { name: "Connect Google Drive" }).waitFor({ timeout: 15000 });
check(
  "a revoked grant explains itself and offers Connect again",
  (await laptop.page.locator(".drive-dialog .docs-error").textContent())?.includes(
    "access to your Google Drive ended",
  ) ?? false,
);
await connect(laptop);
check("reconnecting resumes without asking to onboard again", await driveState(laptop.page, "ok"));
check("…and without reopening onboarding", !(await laptop.page.locator(".drive-onboarding").isVisible()));

// --- disconnect -------------------------------------------------------------
if (!(await laptop.page.locator(".drive-dialog").isVisible())) await openDriveDialog(laptop.page);
const beforeDisconnect = await features(laptop.page);
await laptop.page.getByRole("button", { name: "Disconnect this browser" }).click();
check("disconnect returns the button to its off state", await driveState(laptop.page, "off"));
check("documents stay on the device after disconnecting", (await features(laptop.page)) === beforeDisconnect);

await browser.close();
done();
