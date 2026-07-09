// End-to-end verification of sketch SUBREGION selection + extrusion:
//  1. A box with two edge-to-edge interior chords (T-junctions + an X crossing)
//     detects four granular cells, not one region.
//  2. REAL viewport clicks on two cells select them (and accumulate).
//  3. E + Enter extrudes exactly the selected cells (bbox = half the box).
//  4. A circle crossed by a line yields two half-disk regions.
import { chromium } from "playwright";

const URL = process.env.URL ?? "http://localhost:5173/";
const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 1660, height: 920 },
  deviceScaleFactor: 2,
});
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
  throw new Error("app never settled");
};
await waitIdle();

const apply = (op) => page.evaluate((o) => window.__openpoly.apply(o), op);
const read = (q) => page.evaluate((o) => window.__openpoly.read(o), q);

let failures = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}: ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

// Fresh document so counts below aren't polluted by whatever was last open.
const nd = await apply({ op: "newDocument" });
check("fresh document", nd.ok, JSON.stringify(nd).slice(0, 120));
await waitIdle();

// --- 1. Box + two interior edge-to-edge chords → 4 cells --------------------
// Box 40×20 centered on origin; vertical chord (0,-10)→(0,10) T-joins the
// bottom/top edges mid-span; horizontal chord (-20,0)→(20,0) T-joins the
// sides AND crosses the vertical chord at the origin.
const sk = await apply({
  op: "addSketch",
  plane: { datum: "top" },
  entities: [
    { shape: "rect", center: [0, 0], w: 40, h: 20 },
    { shape: "line", a: [0, -10], b: [0, 10] },
    { shape: "line", a: [-20, 0], b: [20, 0] },
  ],
});
check("sketch created", sk.ok, JSON.stringify(sk).slice(0, 150));
await waitIdle();

const scene1 = await read({ read: "sceneSummary" });
const sketchSummary = scene1.sketches.find((s) => s.id === sk.createdId);
const cells = sketchSummary?.regions ?? [];
check("four subregion cells detected", cells.length === 4, `regions: ${JSON.stringify(cells)}`);
check(
  "each cell is a 20×10 quarter (area 200)",
  cells.length === 4 && cells.every((r) => Math.abs(r.area - 200) < 1),
  cells.map((r) => r.area).join(", "),
);

// --- 2. Real viewport clicks select cells, accumulating ---------------------
const canvasBox = await page.locator("canvas").first().boundingBox();
const clickWorld = async (w) => {
  const s = await page.evaluate((p) => window.__openpoly.worldToScreen(p), w);
  if (!s) throw new Error("worldToScreen unavailable");
  await page.mouse.click(canvasBox.x + s.x, canvasBox.y + s.y);
  await page.waitForTimeout(150);
};

// Cell centers on the top plane (z=0): the four quadrant midpoints.
await clickWorld([-10, 5, 0]); // top-left cell
let sel = await read({ read: "selection" });
check(
  "clicking a cell selects one sketchFace",
  sel.length === 1 && sel[0].kind === "sketchFace",
  JSON.stringify(sel),
);
const firstRegion = sel[0]?.regionId;

await clickWorld([10, -5, 0]); // bottom-right cell
sel = await read({ read: "selection" });
check(
  "clicking a second cell ACCUMULATES (2 sketchFaces)",
  sel.length === 2 && sel.every((s) => s.kind === "sketchFace"),
  JSON.stringify(sel),
);
check(
  "the two selections are different regions",
  sel.length === 2 && sel[0].regionId !== sel[1].regionId,
  `${sel[0]?.regionId} vs ${sel[1]?.regionId}`,
);

// Re-clicking the first cell toggles it off.
await clickWorld([-10, 5, 0]);
sel = await read({ read: "selection" });
check(
  "re-clicking a selected cell deselects it",
  sel.length === 1 && sel[0].regionId !== firstRegion,
  JSON.stringify(sel),
);
await clickWorld([-10, 5, 0]); // back to two cells for the extrude

// --- 3. Extrude the two selected cells through the UI (E, then Enter) -------
await page.keyboard.press("e");
await page.waitForTimeout(300);
const dialogVisible = await page.locator(".extrude-dialog").count();
check("extrude dialog opened from the 2-cell selection", dialogVisible === 1);
await page.keyboard.press("Enter");
await waitIdle();

// One Extrude feature (and body) per selected cell, each a 20×10 quarter.
const scene2 = await read({ read: "sceneSummary" });
const bodies = scene2.bodies ?? [];
check("extrude produced two bodies (one per cell)", bodies.length === 2, `bodies: ${bodies.length}`);
check(
  "each body spans exactly one 20×10 cell",
  bodies.length === 2 &&
    bodies.every(
      (b) =>
        b.bbox &&
        Math.abs(b.bbox.max[0] - b.bbox.min[0] - 20) < 0.5 &&
        Math.abs(b.bbox.max[1] - b.bbox.min[1] - 10) < 0.5,
    ),
  JSON.stringify(bodies.map((b) => b.bbox)),
);
const doc = await read({ read: "document" });
const extrudes = doc.features.filter((f) => f.type === "extrude");
check("one extrude per selected cell (2 features)", extrudes.length === 2, `extrudes: ${extrudes.length}`);

// --- 4. A circle crossed by a line → two half-disks --------------------------
const sk2 = await apply({
  op: "addSketch",
  plane: { datum: "front" },
  entities: [
    { shape: "circle", c: [80, 0], r: 10 },
    { shape: "line", a: [80, -15], b: [80, 15] },
  ],
});
check("circle+cut sketch created", sk2.ok);
await waitIdle();
const scene3 = await read({ read: "sceneSummary" });
const circleRegions = scene3.sketches.find((s) => s.id === sk2.createdId)?.regions ?? [];
check(
  "crossed circle splits into two half-disks",
  circleRegions.length === 2 && circleRegions.every((r) => Math.abs(r.area - Math.PI * 50) < 2),
  JSON.stringify(circleRegions),
);

await page.screenshot({ path: "/tmp/openshape-subregions.png" });
console.log(failures === 0 ? "=== ALL CHECKS PASSED ===" : `=== ${failures} CHECK(S) FAILED ===`);
console.log("screenshot: /tmp/openshape-subregions.png");
await browser.close();
process.exit(failures === 0 ? 0 : 1);
