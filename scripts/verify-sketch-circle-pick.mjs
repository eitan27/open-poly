// Circles in a sketch must behave like any other entity: their rim is
// clickable (so they can be selected and dimensioned) and their centre/rim are
// snap targets while drawing.
//
// Regression: the pick took intersectObjects()[0], but a sketch is planar, so
// every segment within the raycaster's world threshold ties on ray depth and
// the array stays in buffer order. [0] was therefore an arbitrary segment near
// the cursor — on a tessellated entity a whole chord away — which then failed
// the EDGE_PICK_PX gate. Straight lines (one long segment) still worked, so
// only circles/arcs/splines/polygons/text looked "unselectable".
import { chromium } from "playwright";

const URL = process.env.URL ?? "http://localhost:5173/";
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1400, height: 900 }, deviceScaleFactor: 2 });
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
const apply = (op) => page.evaluate((o) => window.__openpoly.apply(o), op);
const read = (q) => page.evaluate((o) => window.__openpoly.read(o), q);

let failures = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}: ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

await waitIdle();
await apply({ op: "newDocument" });
await waitIdle();
const C = [30, 0];
const R = 20;
const sk = await apply({ op: "addSketch", plane: { datum: "top" }, entities: [{ shape: "circle", c: C, r: R }] });
const sketchId = sk.createdId ?? sk.id;
await waitIdle();
await page.locator(".tree-row", { hasText: "Sketch" }).first().dblclick();
await page.waitForTimeout(600);

const canvas = await page.locator("canvas").first().boundingBox();
const clickWorld = async (w) => {
  const s = await page.evaluate((p) => window.__openpoly.worldToScreen(p), w);
  await page.mouse.click(canvas.x + s.x, canvas.y + s.y);
  await page.waitForTimeout(220);
};
const sketchOf = async () => (await read({ read: "document" })).features.find((f) => f.id === sketchId);
const rim = (deg) => [C[0] + R * Math.cos((deg * Math.PI) / 180), C[1] + R * Math.sin((deg * Math.PI) / 180), 0];

// --- 1. The rim is selectable, all the way round --------------------------------
const picked = [];
for (const deg of [0, 45, 90, 135, 180, 225, 270, 315]) {
  await apply({ op: "select", refs: [] });
  await clickWorld(rim(deg));
  const sel = await read({ read: "selection" });
  const one = (Array.isArray(sel) ? sel : sel?.selection ?? [])[0];
  picked.push(one?.kind === "sketchEntity" ? "•" : `✗${deg}`);
}
check("the rim is clickable all the way round", picked.every((p) => p === "•"), picked.join(" "));

// --- 2. Dimension the circle (needs the rim selected) ---------------------------
await apply({ op: "select", refs: [] });
await clickWorld(rim(30));
await page.keyboard.press("d");
await page.waitForTimeout(300);
const dimOpen = (await page.locator(".dim-input input").count()) === 1;
check("D on a selected circle opens the radius dimension", dimOpen,
  dimOpen ? (await page.locator(".dim-input label").textContent()) ?? "" : "no dim box");
if (dimOpen) {
  await page.locator(".dim-input input").fill("12");
  await page.keyboard.press("Enter");
  await waitIdle();
  const s = await sketchOf();
  const circle = s.entities.find((e) => e.type === "circle");
  const radiusCon = s.constraints.filter((c) => c.type === "radius");
  check("the radius constraint is stored", radiusCon.length === 1, JSON.stringify(radiusCon.map((c) => c.value)));
  check("…and the circle resizes to it", Math.abs(circle.r - 12) < 0.01, `r=${circle.r?.toFixed(3)}`);
}

// --- 3. Draw a line from the circle's centre to its rim -------------------------
// Redo on a fresh circle so the dimension above doesn't constrain the drawing.
await apply({ op: "newDocument" });
await waitIdle();
const sk2 = await apply({ op: "addSketch", plane: { datum: "top" }, entities: [{ shape: "circle", c: C, r: R }] });
const sketchId2 = sk2.createdId ?? sk2.id;
await waitIdle();
await page.locator(".tree-row", { hasText: "Sketch" }).first().dblclick();
await page.waitForTimeout(600);
await page.keyboard.press("l");
await page.waitForTimeout(200);
// Aim a few px OFF both targets so the snap has to do the work.
const near = (w, dx, dy) => [w[0] + dx, w[1] + dy, 0];
await clickWorld(near([C[0], C[1]], 1.2, -0.8));
await clickWorld(near(rim(45), 1.0, 1.0));
await page.keyboard.press("Escape");
await waitIdle();
const s2 = (await read({ read: "document" })).features.find((f) => f.id === sketchId2);
const line = s2.entities.find((e) => e.type === "line");
check("a line was drawn", !!line, line ? `${JSON.stringify(line.a)}→${JSON.stringify(line.b)}` : "none");
if (line) {
  const dCentre = Math.hypot(line.a[0] - C[0], line.a[1] - C[1]);
  const dRim = Math.abs(Math.hypot(line.b[0] - C[0], line.b[1] - C[1]) - R);
  check("its start snapped exactly to the circle's centre", dCentre < 1e-6, `off by ${dCentre.toFixed(4)}mm`);
  check("its end snapped exactly onto the rim", dRim < 0.05, `radius off by ${dRim.toFixed(4)}mm`);
  // NOT a check: snapping to a sketch circle (centre or rim) is positional by
  // design — there's no point-on-circle constraint in the model, and pinning to
  // a fixed uv would fight the circle's own parameters when it moves or is
  // re-dimensioned. So the endpoint lands exactly on the rim but isn't tied to
  // it: re-dimensioning the circle later won't drag the line's end along.
  const attached = s2.constraints.map((c) => c.type);
  console.log(`  note: snap constraints recorded — ${attached.join(", ") || "none (positional snap, by design)"}`);
}

console.log(failures === 0 ? "\n=== ALL CHECKS PASSED ===" : `\n=== ${failures} CHECK(S) FAILED ===`);
await browser.close();
process.exit(failures === 0 ? 0 : 1);
