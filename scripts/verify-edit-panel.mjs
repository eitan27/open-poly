// Verifies the active-edit panel (Phase 8.5 #1): Constraints + Parameters moved
// out of the left sidebar into a movable dialog floating over the viewport.
//   1. Nothing selected + no sketch → no panel at all.
//   2. Selecting a feature → panel appears with that feature's Parameters.
//   3. Editing a sketch with constraints → panel shows the Constraints section.
//   4. The panel is draggable by its title bar.
//   5. The sidebar no longer contains Constraints/Parameters.
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

let failures = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}: ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

await apply({ op: "newDocument" });
await waitIdle();

const panel = page.locator(".edit-panel");

// 1. Empty document, nothing selected.
check("no panel when nothing is being edited", (await panel.count()) === 0);

// 2. A selected feature shows its parameters.
const box = await apply({ op: "addPrimitive", kind: "box", params: { width: 40, depth: 30, height: 20 } });
await waitIdle();
await apply({ op: "select", refs: [{ kind: "feature", id: box.id ?? box.createdId }] });
await page.waitForTimeout(400);
check("panel appears for a selected feature", (await panel.count()) === 1);
check("panel titled with the feature type", (await panel.locator(".ed-title").textContent()) === "Box");
const headings = await panel.locator(".ep-heading").allTextContents();
check("panel shows Parameters", headings.includes("Parameters"), headings.join(", "));
const widthVal = await panel.locator(".param-field", { hasText: "Width" }).locator("input").inputValue();
check("parameter value is editable in the panel", widthVal === "40", `width=${widthVal}`);
await page.screenshot({ path: "/tmp/edit-panel-feature.png" });

// 4. Drag by the title bar moves it.
const before = await panel.boundingBox();
const title = await panel.locator(".ed-title").boundingBox();
await page.mouse.move(title.x + title.width / 2, title.y + title.height / 2);
await page.mouse.down();
await page.mouse.move(title.x + title.width / 2 + 120, title.y + title.height / 2 + 80, { steps: 8 });
await page.mouse.up();
await page.waitForTimeout(150);
const after = await panel.boundingBox();
check(
  "panel drags by its title bar",
  Math.round(after.x - before.x) === 120 && Math.round(after.y - before.y) === 80,
  `moved ${Math.round(after.x - before.x)},${Math.round(after.y - before.y)}`,
);

// 3. A sketch with constraints shows the Constraints section.
const sk = await apply({ op: "addSketch", plane: { datum: "front" }, entities: [
  { shape: "line", a: [0, 0], b: [40, 0] },
  { shape: "line", a: [40, 0], b: [40, 30] },
] });
await waitIdle();
const sketchId = sk.id ?? sk.createdId;
const doc = await page.evaluate(() => window.__openpoly.read({ read: "document" }));
const sketch = (doc.document ?? doc).features.find((f) => f.id === sketchId);
await apply({ op: "addConstraint", sketchId, constraint: { kind: "horizontal", entity: sketch.entities[0].id } });
await waitIdle();
// Enter sketch edit mode via the timeline (double-click the sketch row).
await page.locator(".tree-row", { hasText: "Sketch" }).first().dblclick();
await page.waitForTimeout(600);
const h2 = await panel.locator(".ep-heading").allTextContents();
check("panel shows Constraints while editing a sketch", h2.some((t) => t.startsWith("Constraints")), h2.join(", "));
await page.screenshot({ path: "/tmp/edit-panel-sketch.png" });

// 5. The sidebar is clean.
const sidebar = await page.locator("aside.panel").textContent();
check("sidebar no longer lists Constraints/Parameters", !/Parameters/.test(sidebar), sidebar.slice(0, 200));

await browser.close();
console.log(failures ? `\n${failures} FAILURE(S)` : "\nAll checks passed");
process.exit(failures ? 1 : 0);
