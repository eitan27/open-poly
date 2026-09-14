// M3 verification: thumbnails captured into meta, .json export (envelope, no
// meshes), import (new id + deduped name + opens), corrupt-file error.
import { chromium } from "playwright";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

const apply = (op) => page.evaluate((o) => window.__openpoly.apply(o), op);
const featureCount = () => page.evaluate(() => window.__openpoly.read({ read: "document" }).features.length);
const title = async () => (await page.locator(".doc-title").textContent())?.trim();

let failures = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}: ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

// Baseline: a named doc with one box.
const doc0 = await page.evaluate(() => window.__openpoly.read({ read: "document" }));
for (const f of [...doc0.features].reverse()) await apply({ op: "delete", featureId: f.id });
await page.locator(".doc-title").click();
await page.locator(".doc-title-input").fill("ThumbDoc");
await page.locator(".doc-title-input").press("Enter");
await apply({ op: "addPrimitive", kind: "box" });
await waitIdle();
await page.waitForTimeout(800); // regen-settle thumb capture (300 ms delay + encode)

// 1. Thumbnail landed in meta.
const activeId = await page.evaluate(() => localStorage.getItem("openpoly.activeDocId"));
const thumbInfo = await page.evaluate(
  (id) =>
    new Promise((resolve) => {
      const req = indexedDB.open("open-poly");
      req.onsuccess = () => {
        const get = req.result.transaction("meta").objectStore("meta").get(id);
        get.onsuccess = () =>
          resolve(get.result?.thumb ? { size: get.result.thumb.size, type: get.result.thumb.type } : null);
      };
    }),
  activeId,
);
check("thumbnail captured on regen settle", Boolean(thumbInfo), JSON.stringify(thumbInfo));
check(
  "thumbnail is a small jpeg",
  thumbInfo && thumbInfo.type === "image/jpeg" && thumbInfo.size < 60_000,
  JSON.stringify(thumbInfo),
);

// 2. Dialog renders the real thumbnail (an <img>, not the dashed placeholder).
await page.locator(".docs-btn").click();
await page.waitForTimeout(300);
check("dialog shows the thumbnail image", (await page.locator(".docs-row.active img.docs-thumb").count()) === 1);

// 3. Export → valid envelope, no meshes.
const [download] = await Promise.all([
  page.waitForEvent("download"),
  page.locator(".docs-row.active .text-btn", { hasText: "Export" }).click(),
]);
const exportPath = await download.path();
const envelope = JSON.parse(await readFile(exportPath, "utf8"));
check("export filename", download.suggestedFilename() === "ThumbDoc.openpoly.json", download.suggestedFilename());
check(
  "export envelope shape",
  envelope.format === "openpoly-doc" &&
    envelope.version === 1 &&
    envelope.name === "ThumbDoc" &&
    Array.isArray(envelope.doc.features),
  Object.keys(envelope).join(","),
);
check("export excludes meshes", !("meshes" in envelope) && !("meshes" in envelope.doc));
check("export carries the box", envelope.doc.features.length === 1);

// 4. Import it back → NEW document (fresh id), deduped name, same content.
const importPath = join(tmpdir(), "openpoly-import-test.json");
await writeFile(importPath, JSON.stringify(envelope));
await page.locator('.docs-dialog input[type="file"]').setInputFiles(importPath);
await waitIdle();
// Poll for the title rather than sampling it once. An import is read, parsed and
// adopted OUTSIDE the regen the status chip reports, so waitIdle() can return
// while the new document is still arriving — which made this check fail about
// one run in two. Waiting for the condition removes the race without hiding a
// real failure: a title that never arrives still fails, just after the timeout.
await page
  .waitForFunction(() => document.querySelector(".doc-title")?.textContent?.trim() === "ThumbDoc 2", null, {
    timeout: 5000,
  })
  .catch(() => {});
check("import opened the new document", (await title()) === "ThumbDoc 2", await title());
check("imported content matches", (await featureCount()) === 1);
const importedId = await page.evaluate(() => localStorage.getItem("openpoly.activeDocId"));
check("import got a FRESH id (never overwrites)", importedId && importedId !== activeId);

// 5. Corrupt file → readable error, dialog stays.
const badPath = join(tmpdir(), "openpoly-bad.json");
await writeFile(badPath, '{"hello":"world"}');
await page.locator(".docs-btn").click();
await page.locator('.docs-dialog input[type="file"]').setInputFiles(badPath);
await page.waitForTimeout(300);
const err = (await page.locator(".docs-error").textContent())?.trim();
check("corrupt import shows a readable error", err === "Not an Open Poly document file.", err);
check("dialog stayed open", (await page.locator(".docs-dialog").count()) === 1);

await page.screenshot({ path: "/tmp/openshape-multidoc-m3.png" });
console.log(failures === 0 ? "=== ALL CHECKS PASSED ===" : `=== ${failures} CHECK(S) FAILED ===`);
await browser.close();
process.exit(failures === 0 ? 0 : 1);
