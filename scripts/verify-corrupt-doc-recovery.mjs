// Corrupt-document recovery (Phase 8.7 follow-up): if a stored document's
// `.doc` shape is malformed (migrateDocument throws), the app must never
// silently discard it or half-switch into a broken state. Covers:
//  1. Boot: the active doc is corrupt → app falls back to a fresh doc (never
//     adopts the corrupt id) + shows a dismissible recovery banner.
//  2. Documents dialog: clicking Open on a corrupt row shows an error banner
//     (not a silent no-op / unhandled rejection) and the dialog stays open.
//  3. The existing Export as JSON button still works on the corrupt row
//     (it never calls migrateDocument) — the actual "recovery" path.
//  4. Delete removes the corrupt row cleanly.
import { chromium } from "playwright";

const URL = process.env.URL ?? "http://localhost:5174/";
const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 1660, height: 920 },
  deviceScaleFactor: 2,
  acceptDownloads: true,
});
const page = await context.newPage();
page.on("pageerror", (e) => console.log(`[pageerror] ${e.message}`));
await page.goto(URL, { waitUntil: "domcontentloaded" });

const waitIdle = async () => {
  let stable = 0;
  for (let i = 0; i < 100; i++) {
    const s = (await page.locator(".status").textContent())?.trim() ?? "";
    stable = /up to date|error/i.test(s) ? stable + 1 : 0;
    if (stable >= 3) return;
    await page.waitForTimeout(300);
  }
  throw new Error("app never settled");
};
await waitIdle();
await page.waitForFunction(() => window.__openpoly);

let failures = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}: ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

// Name + tag the current doc, then corrupt it directly in IndexedDB (bypassing
// the app entirely — this simulates a bug or storage-layer bit-rot writing bad
// `doc.features`, not something reachable through normal UI actions).
await page.locator(".doc-title").click();
await page.locator(".doc-title-input").fill("VictimDoc");
await page.locator(".doc-title-input").press("Enter");
await page.waitForTimeout(800); // let the autosave land before we corrupt it
const victimId = await page.evaluate(() => localStorage.getItem("openpoly.activeDocId"));

await page.evaluate(
  (id) =>
    new Promise((resolve, reject) => {
      const req = indexedDB.open("open-poly");
      req.onsuccess = () => {
        const db = req.result;
        const t = db.transaction("documents", "readwrite");
        const get = t.objectStore("documents").get(id);
        get.onsuccess = () => {
          const rec = get.result;
          rec.doc = { ...rec.doc, features: "NOT_AN_ARRAY" }; // migrateDocument will throw
          t.objectStore("documents").put(rec);
        };
        t.oncomplete = () => {
          db.close();
          resolve();
        };
        t.onerror = () => reject(t.error);
      };
      req.onerror = () => reject(req.error);
    }),
  victimId,
);

// --- 1. Reload: boot must not adopt the corrupt doc, and must show a banner.
await page.reload({ waitUntil: "domcontentloaded" });
await waitIdle();
const titleAfterReload = (await page.locator(".doc-title").textContent())?.trim();
check("boot did NOT adopt the corrupt document", titleAfterReload !== "VictimDoc", titleAfterReload);
const newActiveId = await page.evaluate(() => localStorage.getItem("openpoly.activeDocId"));
check("active pointer moved OFF the corrupt id", newActiveId !== victimId);
check("recovery banner is shown", (await page.locator(".recovery-banner").count()) === 1);
const bannerText = (await page.locator(".recovery-banner span").textContent())?.trim();
check(
  "banner mentions the corrupt doc's name and points at Export/Delete",
  /VictimDoc/.test(bannerText) && /Export as JSON/.test(bannerText) && /Delete/.test(bannerText),
  bannerText,
);
check(
  '"Export as JSON" is bolded (a <strong> element, not just plain text)',
  (await page.locator(".recovery-banner strong", { hasText: "Export as JSON" }).count()) === 1,
);
check(
  'the "Documents" action is an inline text link, not a separate boxed button',
  (await page.locator(".recovery-banner .banner-link", { hasText: "Documents" }).count()) === 1 &&
    (await page.locator(".recovery-banner .text-btn").count()) === 0,
);

// The corrupt record is UNTOUCHED (not silently overwritten by the fresh seed).
const survivedRaw = await page.evaluate(
  (id) =>
    new Promise((resolve) => {
      const req = indexedDB.open("open-poly");
      req.onsuccess = () => {
        const get = req.result.transaction("documents").objectStore("documents").get(id);
        get.onsuccess = () => resolve(get.result ?? null);
      };
    }),
  victimId,
);
check("the corrupt record survived untouched (no silent overwrite)", survivedRaw?.doc?.features === "NOT_AN_ARRAY");

// --- 2. The inline "Documents" link jumps straight to the dialog, showing
// the corrupt doc in the list (metadata never required migrateDocument).
await page.locator(".recovery-banner .banner-link", { hasText: "Documents" }).click();
await page.waitForTimeout(300);
check("banner is gone after clicking through", (await page.locator(".recovery-banner").count()) === 0);
check(
  "corrupt doc still shows up in the list",
  (await page.locator(".docs-row", { hasText: "VictimDoc" }).count()) === 1,
);

// --- 3. Clicking Open on it surfaces an error banner INSIDE the dialog
// (not a silent no-op, not an unhandled rejection) and stays open.
const victimRow = page.locator(".docs-row", { hasText: "VictimDoc" });
await victimRow.locator(".text-btn", { hasText: "Open" }).click();
await page.waitForTimeout(400);
check("dialog stayed open after a failed Open", (await page.locator(".docs-dialog").count()) === 1);
const dialogErr = (await page.locator(".docs-error").last().textContent())?.trim();
check(
  "dialog shows a descriptive error, not a stack trace",
  /corrupted/.test(dialogErr) && /Export as JSON/.test(dialogErr),
  dialogErr,
);
check(
  '"Export as JSON" is bolded in the dialog error too',
  (await page.locator(".docs-error").last().locator("strong", { hasText: "Export as JSON" }).count()) === 1,
);
check("did NOT switch into the corrupt doc", (await page.locator(".doc-title").textContent())?.trim() !== "VictimDoc");

// --- 4. Export as JSON on the corrupt row still works (the real recovery
// path — it never calls migrateDocument, just re-serializes whatever's there).
const [download] = await Promise.all([
  page.waitForEvent("download"),
  page.locator(".docs-row", { hasText: "VictimDoc" }).locator(".text-btn", { hasText: "Export as JSON" }).click(),
]);
check(
  "Export as JSON succeeds on the corrupt document",
  download.suggestedFilename() === "VictimDoc.openpoly.json",
  download.suggestedFilename(),
);

// --- 5. Delete removes it cleanly.
const row = page.locator(".docs-row", { hasText: "VictimDoc" });
await row.locator(".text-btn", { hasText: "Delete" }).click();
await row.locator(".text-btn", { hasText: "Really delete?" }).click();
await page.waitForTimeout(300);
check("corrupt doc is gone after delete", (await page.locator(".docs-row", { hasText: "VictimDoc" }).count()) === 0);

await page.screenshot({ path: "/tmp/openshape-corrupt-recovery.png" });
console.log(failures === 0 ? "=== ALL CHECKS PASSED ===" : `=== ${failures} CHECK(S) FAILED ===`);
console.log("screenshot: /tmp/openshape-corrupt-recovery.png");
await browser.close();
process.exit(failures === 0 ? 0 : 1);
