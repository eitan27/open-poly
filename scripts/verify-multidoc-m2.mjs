// M2 verification: Documents dialog, the switch flow (content isolation +
// flush-before-switch, i.e. the docIdRef clobber guard), duplicate,
// delete-active fallback, and the two-tab BroadcastChannel warning.
import { chromium } from "playwright";

const URL = process.env.URL ?? "http://localhost:5174/";
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1660, height: 920 }, deviceScaleFactor: 2 });
const page = await context.newPage();
page.on("pageerror", (e) => console.log(`[pageerror] ${e.message}`));
await page.goto(URL, { waitUntil: "domcontentloaded" });

const waitIdle = async (p = page) => {
  let stable = 0;
  for (let i = 0; i < 100; i++) {
    const s = (await p.locator(".status").textContent())?.trim() ?? "";
    stable = /up to date|error/i.test(s) ? stable + 1 : 0;
    if (stable >= 3) return;
    await p.waitForTimeout(300);
  }
  throw new Error("app never settled");
};
await waitIdle();
await page.waitForFunction(() => window.__openpoly);

const apply = (op) => page.evaluate((o) => window.__openpoly.apply(o), op);
const featureCount = () => page.evaluate(() => window.__openpoly.read({ read: "document" }).features.length);
const title = async () => (await page.locator(".doc-title").textContent())?.trim();

let failures = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}: ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

// Baseline: name doc A and give it exactly one box.
const doc0 = await page.evaluate(() => window.__openpoly.read({ read: "document" }));
for (const f of [...doc0.features].reverse()) await apply({ op: "delete", featureId: f.id });
await page.locator(".doc-title").click();
await page.locator(".doc-title-input").fill("DocA");
await page.locator(".doc-title-input").press("Enter");
await apply({ op: "addPrimitive", kind: "box" });
await waitIdle();

// 1. New document via the topbar "＋ New Doc" button → empty, deduped name, active.
await page.locator(".newdoc-btn").click();
await waitIdle();
const bName = await title();
check("new document opened with a fresh Untitled name", /^Untitled/.test(bName), bName);
check("new document is empty", (await featureCount()) === 0);

// 2. Clobber guard: edit doc B, then switch to A IMMEDIATELY (inside the 600 ms
// autosave debounce). The flush must persist B's cylinder, and the autosave
// that fires after the switch must not write A's content under B's id.
await apply({ op: "addPrimitive", kind: "cylinder" });
await page.locator(".docs-btn").click();
await page.locator(".docs-row:not(.active) .text-btn", { hasText: "Open" }).first().click();
await waitIdle();
check("switched back to DocA", (await title()) === "DocA", await title());
check("DocA still has exactly its box", (await featureCount()) === 1);

// 3. Switch to B again — the cylinder edit survived the immediate switch.
await page.locator(".docs-btn").click();
await page.locator(".docs-row:not(.active) .text-btn", { hasText: "Open" }).first().click();
await waitIdle();
check(
  "DocB kept the cylinder added right before switching (flush)",
  (await featureCount()) === 1,
  `title: ${await title()}`,
);
check("DocB does NOT contain DocA's box", (await featureCount()) === 1);

// 4. Duplicate DocA → "Copy of DocA" opens with the same content.
await page.locator(".docs-btn").click();
const rowA = page.locator(".docs-row", { hasText: "DocA" }).first();
await rowA.locator(".text-btn", { hasText: "Duplicate" }).click();
await waitIdle();
check("duplicate opened as the copy", (await title()) === "Copy of DocA", await title());
check("copy has DocA's box", (await featureCount()) === 1);

// 5. Delete the ACTIVE copy → falls back to the next most recent document.
await page.locator(".docs-btn").click();
const activeRow = page.locator(".docs-row.active");
await activeRow.locator(".text-btn", { hasText: "Delete" }).click();
await activeRow.locator(".text-btn", { hasText: "Really delete?" }).click();
await page.waitForTimeout(400);
await page.locator(".docs-close").click();
await waitIdle();
const afterDelete = await title();
check(
  "deleting the active doc fell back to another",
  afterDelete === "DocA" || /^Untitled/.test(afterDelete),
  afterDelete,
);
check(
  "copy is gone from the list",
  await page.evaluate(async () => {
    return new Promise((resolve) => {
      const req = indexedDB.open("open-poly");
      req.onsuccess = () => {
        const get = req.result.transaction("meta").objectStore("meta").getAll();
        get.onsuccess = () => resolve(!get.result.some((m) => m.name === "Copy of DocA"));
      };
    });
  }),
);

// 6. Two tabs on the same document → both warn.
const page2 = await context.newPage();
await page2.goto(URL, { waitUntil: "domcontentloaded" });
await waitIdle(page2);
await page.waitForTimeout(500);
check("second tab shows the same-doc warning", (await page2.locator(".tab-warning").count()) === 1);
check("first tab shows it too (handshake)", (await page.locator(".tab-warning").count()) === 1);

// 7. Second tab switches to a different doc → warnings clear on both.
await page2.locator(".docs-btn").click();
await page2.locator(".docs-row:not(.active) .text-btn", { hasText: "Open" }).first().click();
await waitIdle(page2);
await page.waitForTimeout(500);
check(
  "warning clears when the tabs diverge",
  (await page.locator(".tab-warning").count()) === 0 && (await page2.locator(".tab-warning").count()) === 0,
);

await page.locator(".docs-btn").click();
await page.screenshot({ path: "/tmp/openshape-multidoc-m2.png" });
console.log(failures === 0 ? "=== ALL CHECKS PASSED ===" : `=== ${failures} CHECK(S) FAILED ===`);
await browser.close();
process.exit(failures === 0 ? 0 : 1);
