// Verifies the active-edit panel: Constraints + Parameters live in a movable
// dialog floating over the viewport, not in the left sidebar.
//   1. Nothing being edited → no panel at all.
//   2. Selection alone does NOT open it — selecting only highlights. (The
//      "params-on-select" surface was deliberately removed; every feature has
//      ONE editor, opened by double-click.)
//   3. Double-clicking a no-dialog feature (primitive / import / sweep / loft)
//      opens its parameters, titled with the feature type — no "Parameters"
//      heading, since the title already names it.
//   4. The panel is draggable by its title bar, and ✕ closes it.
//   5. Editing a sketch with constraints shows the Constraints section.
//   6. The sidebar no longer contains Parameters.
import { chromium } from "playwright";

const URL = process.env.URL ?? "http://localhost:5173/";
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

// 2. Selecting a feature highlights it but opens nothing.
const box = await apply({ op: "addPrimitive", kind: "box", params: { width: 40, depth: 30, height: 20 } });
const boxId = box.id ?? box.createdId;
await waitIdle();
await apply({ op: "select", refs: [{ kind: "feature", id: boxId }] });
await page.waitForTimeout(400);
check("selection alone does not open the panel", (await panel.count()) === 0);

// 3. Double-clicking the timeline row opens that feature's parameters.
await page.locator(".tree-row", { hasText: "Box" }).first().dblclick();
await page.waitForTimeout(400);
check("double-clicking a primitive opens its parameters", (await panel.count()) === 1);
check("panel is titled with the feature type", (await panel.locator(".ed-title").textContent()) === "Box");
const headings = await panel.locator(".ep-heading").allTextContents();
check(
  "no redundant 'Parameters' heading (the title names it)",
  !headings.includes("Parameters"),
  headings.join(", ") || "(none)",
);
const widthField = panel.locator(".param-field", { hasText: "Width" }).locator("input");
check(
  "parameter value is editable in the panel",
  (await widthField.inputValue()) === "40",
  `width=${await widthField.inputValue()}`,
);

// Editing a parameter through the panel drives a rebuild.
await widthField.fill("55");
await widthField.press("Enter");
await waitIdle();
const doc1 = await page.evaluate(() => window.__openpoly.read({ read: "document" }));
const boxFeature = (doc1.document ?? doc1).features.find((f) => f.id === boxId);
check(
  "editing a parameter updates the feature",
  String(boxFeature?.params?.width) === "55",
  `width=${boxFeature?.params?.width}`,
);
await page.screenshot({ path: "/tmp/edit-panel-feature.png" });

// 4. Drag by the title bar moves it; ✕ closes it.
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
await panel.locator(".ep-close").click();
await page.waitForTimeout(200);
check("✕ closes the panel", (await panel.count()) === 0);

// 5. A sketch with constraints shows the Constraints section.
const sk = await apply({
  op: "addSketch",
  plane: { datum: "front" },
  entities: [
    { shape: "line", a: [0, 0], b: [40, 0] },
    { shape: "line", a: [40, 0], b: [40, 30] },
  ],
});
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
check(
  "panel shows Constraints while editing a sketch",
  h2.some((t) => t.startsWith("Constraints")),
  h2.join(", "),
);
await page.screenshot({ path: "/tmp/edit-panel-sketch.png" });

// 6. The sidebar is clean.
const sidebar = await page.locator("aside.panel").textContent();
check("sidebar no longer lists Parameters", !/Parameters/.test(sidebar), sidebar.slice(0, 200));

await browser.close();
console.log(failures ? `\n${failures} FAILURE(S)` : "\nAll checks passed");
process.exit(failures ? 1 : 0);
