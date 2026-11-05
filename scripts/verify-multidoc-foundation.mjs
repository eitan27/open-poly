// Multi-document foundation: editable topbar title (an always-live input), browser
// tab title, activeDocId pointer, rename persisted through autosave + reload.
import { chromium } from "playwright";

const URL = process.env.URL ?? "http://localhost:5174/";
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1660, height: 920 }, deviceScaleFactor: 2 });
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

let failures = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}: ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

// 1. Title chip renders and mirrors to the browser tab.
const initial = (await page.locator(".doc-title").inputValue()).trim();
check("topbar shows the document title", Boolean(initial), `"${initial}"`);
// An auto name ("Untitled", "Untitled N") is a placeholder, so the tab keeps
// the site's own title; a real name is shown.
const tab = await page.title();
check(
  "browser tab mirrors it",
  /^Untitled(?: \d+)?$/.test(initial) ? !tab.startsWith("Untitled") : tab === `${initial} — Open Poly`,
  tab,
);

// 2. Rename inline: the title is always an input — click, type, Enter.
await page.locator(".doc-title").click();
await page.locator(".doc-title").fill("Test Bracket");
await page.locator(".doc-title").press("Enter");
check("title commits on Enter", (await page.locator(".doc-title").inputValue()).trim() === "Test Bracket");
check("tab title follows the rename", (await page.title()) === "Test Bracket — Open Poly", await page.title());

// 3. Escape reverts a draft.
await page.locator(".doc-title").click();
await page.locator(".doc-title").fill("Should Not Stick");
await page.locator(".doc-title").press("Escape");
check("Escape reverts the draft", (await page.locator(".doc-title").inputValue()).trim() === "Test Bracket");

// 4. activeDocId pointer is set.
const activeId = await page.evaluate(() => localStorage.getItem("openpoly.activeDocId"));
check("activeDocId pointer set", Boolean(activeId), activeId ?? "");

// 5. Rename survives autosave + reload (dual-store write + restore path).
await page.waitForTimeout(1000); // let the 600 ms autosave debounce fire
await page.reload({ waitUntil: "domcontentloaded" });
await waitIdle();
check("rename survives reload", (await page.locator(".doc-title").inputValue()).trim() === "Test Bracket");
check(
  "same document restored (pointer, not just most-recent)",
  (await page.evaluate(() => localStorage.getItem("openpoly.activeDocId"))) === activeId,
);

// 6. The meta store exists and has this document's row (DB v2 migration ran).
const meta = await page.evaluate(
  (id) =>
    new Promise((resolve, reject) => {
      const req = indexedDB.open("open-poly");
      req.onsuccess = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains("meta")) return resolve(null);
        const get = db.transaction("meta").objectStore("meta").get(id);
        get.onsuccess = () => resolve(get.result ?? null);
        get.onerror = () => reject(get.error);
      };
      req.onerror = () => reject(req.error);
    }),
  activeId,
);
check("meta row exists with the new name", meta && meta.name === "Test Bracket", JSON.stringify(meta)?.slice(0, 160));

await page.screenshot({ path: "/tmp/openpoly-multidoc-foundation.png" });
console.log(failures === 0 ? "=== ALL CHECKS PASSED ===" : `=== ${failures} CHECK(S) FAILED ===`);
await browser.close();
process.exit(failures === 0 ? 0 : 1);
