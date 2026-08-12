// Verifies the unified edit model: single-click = select (no params popup);
// double-click a timeline row opens the ONE editor for that feature —
//  • no-dialog features (primitive) → floating params panel;
//  • extrude/plane/etc → their creation dialog in edit mode ("Done" updates in place).
import { chromium } from "playwright";

const URL = process.env.URL ?? "http://localhost:5174/";
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1660, height: 920 }, deviceScaleFactor: 2 });
const page = await context.newPage();
page.on("pageerror", (e) => console.log(`[pageerror] ${e.message}`));
await page.goto(URL, { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => window.__openpoly, null, { timeout: 30000 });
const waitIdle = async () => {
  let stable = 0;
  for (let i = 0; i < 80; i++) {
    const s = (await page.locator(".status").textContent())?.trim() ?? "";
    stable = /up to date/i.test(s) ? stable + 1 : 0;
    if (stable >= 3) return;
    await page.waitForTimeout(300);
  }
};
await waitIdle();
const apply = (op) => page.evaluate((o) => window.__openpoly.apply(o), op);
const read = (q) => page.evaluate((o) => window.__openpoly.read(o), q);

let failures = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}: ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};
const row = (label) => page.locator(".tree-row", { hasText: label }).first();
const panel = page.locator(".edit-panel");
const anyDialog = page.locator(".extrude-dialog");

await apply({ op: "newDocument" });
await waitIdle();

// --- Box (primitive: no creation dialog) ---
const box = await apply({ op: "addPrimitive", kind: "box", params: { width: 40, depth: 30, height: 20 } });
await waitIdle();
const boxId = box.id ?? box.createdId;

// Single-click selects but shows NO params panel.
await row("Box").click();
await page.waitForTimeout(300);
check("single-click does not open the params panel", (await panel.count()) === 0);

// Double-click opens the floating params panel.
await row("Box").dblclick();
await page.waitForTimeout(300);
check("double-click a primitive opens the params panel", (await panel.count()) === 1);
check("params panel titled 'Box'", (await panel.locator(".ed-title").first().textContent()) === "Box");
// Edit width live.
const widthInput = panel.locator(".param-field", { hasText: "Width" }).locator("input");
await widthInput.fill("55");
await widthInput.blur();
await waitIdle();
let doc = await read({ read: "document" });
let boxFeat = (doc.document ?? doc).features.find((f) => f.id === boxId);
check("editing width in the panel updates the feature", boxFeat.params.width === "55", boxFeat.params.width);
// ✕ closes the panel.
await panel.locator(".ep-close").click();
await page.waitForTimeout(200);
check("✕ closes the params panel", (await panel.count()) === 0);

// --- Extrude (has a creation dialog → edit mode) ---
await apply({ op: "newDocument" });
await waitIdle();
await apply({ op: "addSketch", plane: { datum: "top" }, entities: [{ shape: "rect", corner: [0, 0], w: 40, h: 30 }] });
await waitIdle();
const ex = await apply({
  op: "addExtrude",
  profile: { sketchId: (await read({ read: "document" })).features?.[0]?.id ?? undefined },
  distance: "10",
});
// The above profile guess may fail; re-fetch the sketch id robustly.
await waitIdle();
doc = await read({ read: "document" });
const exId = (doc.document ?? doc).features.find((f) => f.type === "extrude")?.id;
check("extrude created", !!exId);

// Double-click the extrude row → edit dialog with "Edit extrude" title + "Done".
await row("Extrude").dblclick();
await page.waitForTimeout(400);
const edTitle = await anyDialog.locator(".ed-title").first().textContent();
check("double-click extrude opens its dialog in edit mode", (edTitle ?? "").includes("Edit extrude"), edTitle);
const doneBtn = anyDialog.locator("button", { hasText: "Done" }).first();
check("edit dialog primary button reads 'Done'", (await doneBtn.count()) >= 1);
// Change distance to 22 and confirm.
const distInput = anyDialog.locator(".ed-field", { hasText: "Distance" }).locator("input");
await distInput.fill("22");
await doneBtn.click();
await waitIdle();
doc = await read({ read: "document" });
const exFeat = (doc.document ?? doc).features.find((f) => f.id === exId);
check("editing extrude distance updates in place (no new feature)", exFeat.distance === "22", exFeat.distance);
check(
  "still exactly one extrude (updated, not duplicated)",
  (doc.document ?? doc).features.filter((f) => f.type === "extrude").length === 1,
);
await page.screenshot({ path: "/tmp/edit-extrude.png" });

await browser.close();
console.log(failures ? `\n${failures} FAILURE(S)` : "\nAll checks passed");
process.exit(failures ? 1 : 0);
