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
  const one = (Array.isArray(sel) ? sel : (sel?.selection ?? []))[0];
  picked.push(one?.kind === "sketchEntity" ? "•" : `✗${deg}`);
}
check(
  "the rim is clickable all the way round",
  picked.every((p) => p === "•"),
  picked.join(" "),
);

// --- 2. Dimension the circle (needs the rim selected) ---------------------------
await apply({ op: "select", refs: [] });
await clickWorld(rim(30));
await page.keyboard.press("d");
await page.waitForTimeout(300);
const dimOpen = (await page.locator(".dim-input input").count()) === 1;
check(
  "D on a selected circle opens the radius dimension",
  dimOpen,
  dimOpen ? ((await page.locator(".dim-input label").textContent()) ?? "") : "no dim box",
);
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
  // The rim snap is parametric, not just positional: it records a
  // point-on-circle so the endpoint rides the rim afterwards.
  const onCircle = s2.constraints.filter((c) => c.type === "pointOnCircle");
  check(
    "the rim snap is recorded as a point-on-circle constraint",
    onCircle.length === 1,
    s2.constraints.map((c) => c.type).join(", ") || "none",
  );

  // …so growing the circle must grow the line with it.
  // Back to the Select tool first — the Line tool is still armed from drawing,
  // and a click would start another segment instead of selecting.
  await page.evaluate(() => document.activeElement?.blur());
  await page.keyboard.press("s");
  await page.waitForTimeout(200);
  await apply({ op: "select", refs: [] });
  await clickWorld(rim(200)); // away from the line's endpoint
  await page.keyboard.press("d");
  await page.waitForTimeout(300);
  await page.locator(".dim-input input").fill("35");
  await page.keyboard.press("Enter");
  await waitIdle();
  const s3 = (await read({ read: "document" })).features.find((f) => f.id === sketchId2);
  const c3 = s3.entities.find((e) => e.type === "circle");
  const l3 = s3.entities.find((e) => e.type === "line");
  const endR = Math.hypot(l3.b[0] - c3.c[0], l3.b[1] - c3.c[1]);
  const startOff = Math.hypot(l3.a[0] - c3.c[0], l3.a[1] - c3.c[1]);
  check(
    "re-dimensioning the circle keeps the line's end on the rim",
    Math.abs(c3.r - 35) < 0.01 && Math.abs(endR - 35) < 0.05,
    `r=${c3.r?.toFixed(2)} end at ${endR.toFixed(2)} from centre`,
  );
  check("…and its start still at the centre", startOff < 0.05, `off by ${startOff.toFixed(3)}mm`);
  check(
    "…so the line now spans the new radius",
    Math.abs(Math.hypot(l3.b[0] - l3.a[0], l3.b[1] - l3.a[1]) - 35) < 0.05,
    `length ${Math.hypot(l3.b[0] - l3.a[0], l3.b[1] - l3.a[1]).toFixed(2)}`,
  );
}

// --- 4. A SMALL circle is selectable without zooming in --------------------------
// The centre used to beat the rim on any click within the 12px snap radius, so a
// circle drawn smaller than that was unpickable until you zoomed in.
await apply({ op: "newDocument" });
await waitIdle();
const smallC = [10, 0];
const smallR = 1.5;
const sk3 = await apply({
  op: "addSketch",
  plane: { datum: "top" },
  entities: [{ shape: "circle", c: smallC, r: smallR }],
});
await waitIdle();
await page.locator(".tree-row", { hasText: "Sketch" }).first().dblclick();
await page.waitForTimeout(600);
{
  const px = await page.evaluate(
    ([a, b]) => {
      const p = window.__openpoly.worldToScreen(a);
      const q = window.__openpoly.worldToScreen(b);
      return Math.hypot(p.x - q.x, p.y - q.y);
    },
    [
      [smallC[0], smallC[1], 0],
      [smallC[0] + smallR, smallC[1], 0],
    ],
  );
  console.log(`\n  small circle: r=${smallR}mm ≈ ${px.toFixed(1)}px on screen (snap radius is 12px)`);
  const hits = [];
  for (const deg of [0, 90, 180, 270]) {
    await apply({ op: "select", refs: [] });
    const w = [
      smallC[0] + smallR * Math.cos((deg * Math.PI) / 180),
      smallC[1] + smallR * Math.sin((deg * Math.PI) / 180),
      0,
    ];
    const s = await page.evaluate((p) => window.__openpoly.worldToScreen(p), w);
    await page.mouse.click(canvas.x + s.x, canvas.y + s.y);
    await page.waitForTimeout(220);
    const sel = await read({ read: "selection" });
    const one = (Array.isArray(sel) ? sel : (sel?.selection ?? []))[0];
    hits.push(one?.kind === "sketchEntity" ? "•" : `✗${deg}(${one?.kind ?? "none"})`);
  }
  check(
    "a circle smaller than the snap radius is still selectable by its rim",
    hits.every((h) => h === "•"),
    hits.join(" "),
  );
  await apply({ op: "select", refs: [] });
  // NOT a check — a known gap, unchanged by this fix: the sketch-POINT branch of
  // the picker sits inside the "a sketch line is within EDGE_PICK_PX" gate, so a
  // circle's centre only resolves to a point when the rim is also within 6px.
  // Clicking a centre otherwise falls through to the enclosed region.
  const sc = await page.evaluate((p) => window.__openpoly.worldToScreen(p), [smallC[0], smallC[1], 0]);
  await page.mouse.click(canvas.x + sc.x, canvas.y + sc.y);
  await page.waitForTimeout(220);
  const sel = await read({ read: "selection" });
  const one = (Array.isArray(sel) ? sel : (sel?.selection ?? []))[0];
  console.log(
    `  note: clicking the circle's centre selects ${one?.kind ?? "nothing"} (point picking needs the rim in range too)`,
  );
}

console.log(failures === 0 ? "\n=== ALL CHECKS PASSED ===" : `\n=== ${failures} CHECK(S) FAILED ===`);
await browser.close();
process.exit(failures === 0 ? 0 : 1);
