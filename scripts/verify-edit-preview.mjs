// Verifies the feedback the user asked for:
//  1. Editing a dialog feature previews LIVE (the doc updates as you change a
//     field, before Confirm) and Cancel reverts to the pre-edit state.
//  2. Reference planes are clickable in the viewport (select + highlight + the
//     timeline row lights up).
//  3. The params box (box/cylinder) is styled like the dialogs (flex ed-field rows).
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
const check = (label, ok, detail = "") => { console.log(`${ok ? "PASS" : "FAIL"}: ${label}${detail ? ` — ${detail}` : ""}`); if (!ok) failures++; };
const featRow = (label) => page.locator(".tree-row:not(.datum-row)", { hasText: label }).first();
const dialog = page.locator(".extrude-dialog");
const findFeat = (doc, pred) => (doc.document ?? doc).features.find(pred);

// --- 1. Live preview + cancel-revert on an extrude edit ---
await apply({ op: "newDocument" });
await waitIdle();
await apply({ op: "addSketch", plane: { datum: "top" }, entities: [{ shape: "rect", corner: [0, 0], w: 40, h: 30 }] });
await waitIdle();
await apply({ op: "addExtrude", profile: { sketchId: (await read({ read: "document" })).features[0].id }, distance: "10" }).catch(() => {});
await waitIdle();
let doc = await read({ read: "document" });
const exId = findFeat(doc, (f) => f.type === "extrude").id;

await featRow("Extrude").dblclick();
await page.waitForTimeout(400);
const distInput = dialog.locator(".ed-field", { hasText: "Distance" }).locator("input");
await distInput.fill("30");
await distInput.evaluate((el) => el.dispatchEvent(new Event("input", { bubbles: true })));
await page.waitForTimeout(700); // let the live-sync + regen settle
doc = await read({ read: "document" });
check("extrude edit previews live (doc updated before Confirm)", findFeat(doc, (f) => f.id === exId).distance === "30",
  findFeat(doc, (f) => f.id === exId).distance);

// Cancel reverts to the pre-edit distance (10).
await dialog.locator("button", { hasText: "Cancel" }).first().click();
await waitIdle();
doc = await read({ read: "document" });
check("Cancel reverts the live edit", findFeat(doc, (f) => f.id === exId).distance === "10",
  findFeat(doc, (f) => f.id === exId).distance);

// --- 2. Reference plane clickable in the viewport ---
await apply({ op: "newDocument" });
await waitIdle();
const pl = await apply({ op: "addPlane", method: "offset", base: { datum: "top" }, offset: "5" });
await waitIdle();
const planeId = pl.id ?? pl.createdId;
// Top view so the offset plane's quad faces the camera; click off-centre on it.
await page.keyboard.press("1");
await page.waitForTimeout(400);
const canvas = await page.locator("canvas").first().boundingBox();
await page.mouse.click(canvas.x + canvas.width / 2 + 90, canvas.y + canvas.height / 2 + 60);
await page.waitForTimeout(300);
const sel = await read({ read: "selection" });
const selArr = sel.selection ?? sel;
check("clicking a reference plane selects it", Array.isArray(selArr) && selArr.some((s) => s.id === planeId || s.featureId === planeId),
  JSON.stringify(selArr));
const planeRowClass = await featRow("Plane").getAttribute("class");
check("selected plane's timeline row is highlighted", /selected|active/.test(planeRowClass ?? ""), planeRowClass);
await page.screenshot({ path: "/tmp/plane-clickable.png" });

// --- 3. Params box styling ---
await apply({ op: "newDocument" });
await waitIdle();
await apply({ op: "addPrimitive", kind: "box", params: { width: 40, depth: 30, height: 20 } });
await waitIdle();
await featRow("Box").dblclick();
await page.waitForTimeout(300);
const flexed = await page.locator(".edit-panel .param-field").first().evaluate((el) => getComputedStyle(el).display);
check("params rows use the dialog-style flex layout", flexed === "flex", flexed);
await page.screenshot({ path: "/tmp/params-styled.png" });

await browser.close();
console.log(failures ? `\n${failures} FAILURE(S)` : "\nAll checks passed");
process.exit(failures ? 1 : 0);
