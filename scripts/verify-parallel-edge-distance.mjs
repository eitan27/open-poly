// End-to-end verification of the PARALLEL EDGE DISTANCE readout: selecting two
// parallel edges of a solid shows their separation in the bottom-right info pane.
//
// Edge pick ids are OCCT hashes (replicad's meshEdges stamps `edgeId: edgeHash`),
// so they can't be guessed or enumerated. Instead we DISCOVER them: click each of
// a box's 12 edge midpoints — computed from its bbox, so we know each edge's true
// axis and position — and record which hash the click selects. That gives a real
// id → real geometry map, from which every expected distance is derived.
//
// Reads the rendered DOM, not the model: the pane is the thing under test.
//
// Scope: this covers the INTEGRATION (real ids, real selection, real pane).
// The pure geometry rules — curved edges rejected, collinear, skew, multi-segment
// straight edges — are covered deterministically in src/selection/measure.test.ts;
// clicking a curved silhouette to select a rim is flaky and proves nothing extra.
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

/** The info pane's rows as {label: value}, straight from the DOM. */
const paneRows = async () => {
  const pane = page.locator(".selection-info");
  if ((await pane.count()) === 0) return null;
  const out = {};
  for (const r of await pane.locator(".si-row").all()) {
    out[(await r.locator(".si-label").textContent()).trim()] = (await r.locator(".si-value").textContent()).trim();
  }
  return out;
};

await apply({ op: "newDocument" });
await waitIdle();
const box = await apply({ op: "addPrimitive", kind: "box", params: { width: 20, depth: 12, height: 8 } });
check("box created", box.ok);
await waitIdle();
const boxId = box.createdId;
await page.evaluate(() => window.__openpoly.screenshot("iso")); // deterministic view
await page.waitForTimeout(300);

const bbox = (await page.evaluate(() => window.__openpoly.summary())).bodies.find((b) => b.id === boxId).bbox;
const [x0, y0, z0] = bbox.min;
const [x1, y1, z1] = bbox.max;
console.log(`  (box ${x1 - x0} x ${y1 - y0} x ${z1 - z0})`);

// The box's 12 edges, from its bbox: axis + the two fixed coords + midpoint.
const wanted = [];
for (const y of [y0, y1]) for (const z of [z0, z1]) wanted.push({ axis: "x", fixed: [y, z], mid: [(x0 + x1) / 2, y, z] });
for (const x of [x0, x1]) for (const z of [z0, z1]) wanted.push({ axis: "y", fixed: [x, z], mid: [x, (y0 + y1) / 2, z] });
for (const x of [x0, x1]) for (const y of [y0, y1]) wanted.push({ axis: "z", fixed: [x, y], mid: [x, y, (z0 + z1) / 2] });

// --- Discover real edge ids by clicking each midpoint ------------------------
const canvasBox = await page.locator("canvas").first().boundingBox();
let found = [];
const claims = new Map(); // edgeId → how many midpoints resolved to it
for (const w of wanted) {
  await apply({ op: "select", refs: [] });
  const s = await page.evaluate((p) => window.__openpoly.worldToScreen(p), w.mid);
  if (!s) continue;
  await page.mouse.click(canvasBox.x + s.x, canvasBox.y + s.y);
  await page.waitForTimeout(120);
  const sel = await read({ read: "selection" });
  // Only trust an unambiguous hit on a single edge of our box.
  if (sel.length === 1 && sel[0].kind === "edge" && sel[0].featureId === boxId) {
    claims.set(sel[0].edgeId, (claims.get(sel[0].edgeId) ?? 0) + 1);
    found.push({ ...w, edgeId: sel[0].edgeId });
  }
}
// In an isometric view a box's hidden back edges project onto the same screen
// lines as visible front ones, so two midpoints can resolve to the SAME edge —
// the visible one under the cursor. That's a correct pick but a useless data
// point: we can no longer say which geometry the id belongs to. Drop every id
// claimed twice (keeping the first claim would silently mislabel it, and every
// expected distance derived from it would be wrong).
const ambiguous = [...claims].filter(([, n]) => n > 1).map(([id]) => id);
if (ambiguous.length) {
  const dropped = found.filter((f) => ambiguous.includes(f.edgeId));
  console.log(`  (dropped ${dropped.length} ambiguous pick(s): ${dropped.map((f) => `${f.axis}@${f.fixed}`).join(", ")} — overlapping projections)`);
  found = found.filter((f) => !ambiguous.includes(f.edgeId));
}
console.log(`  (discovered ${found.length} of 12 edges by clicking; back edges are occluded)`);
check("discovered enough edges to test", found.length >= 6, `found ${found.length}`);
check("each discovered edge has a distinct id", new Set(found.map((f) => f.edgeId)).size === found.length);

// --- Check every pair of discovered edges against ground truth ---------------
const expectedFor = (a, b) => {
  if (a.axis !== b.axis) return null; // different axes → not parallel → no row
  const d = Math.hypot(a.fixed[0] - b.fixed[0], a.fixed[1] - b.fixed[1]);
  return d < 1e-9 ? null : d; // same edge (shouldn't happen) → skip
};
let parallelChecked = 0;
let nonParallelChecked = 0;
for (let i = 0; i < found.length; i++) {
  for (let j = i + 1; j < found.length; j++) {
    const a = found[i];
    const b = found[j];
    const expected = expectedFor(a, b);
    await apply({ op: "select", refs: [a, b].map((e) => ({ kind: "edge", featureId: boxId, edgeId: e.edgeId })) });
    await page.waitForTimeout(60);
    const rows = await paneRows();
    const label = `${a.axis}-edge @${a.fixed} + ${b.axis}-edge @${b.fixed}`;
    const shown = rows?.["Parallel distance"];
    if (expected === null) {
      check(`${label} → not parallel, no distance`, shown === undefined, `pane: ${JSON.stringify(rows)}`);
      nonParallelChecked++;
    } else {
      check(
        `${label} → parallel distance ${expected.toFixed(3)}`,
        shown !== undefined && Math.abs(Number(shown) - expected) < 1e-3,
        `pane showed ${JSON.stringify(shown)}`,
      );
      parallelChecked++;
    }
  }
}
console.log(`  (checked ${parallelChecked} parallel + ${nonParallelChecked} non-parallel pairs)`);
check("exercised both parallel and non-parallel pairs", parallelChecked > 0 && nonParallelChecked > 0);

// --- The pane's existing rows are untouched ---------------------------------
await apply({ op: "select", refs: [{ kind: "edge", featureId: boxId, edgeId: found[0].edgeId }] });
await page.waitForTimeout(80);
const one = await paneRows();
check("single edge still shows just its Length", one?.Length !== undefined && one?.["Parallel distance"] === undefined, JSON.stringify(one));

// A screenshot of the pane showing a real distance, for the record.
const pair = found.find((f) => f.axis === found[0].axis && f !== found[0]);
if (pair) {
  await apply({ op: "select", refs: [found[0], pair].map((e) => ({ kind: "edge", featureId: boxId, edgeId: e.edgeId })) });
  await page.waitForTimeout(80);
  await page.locator(".selection-info").screenshot({ path: "/tmp/parallel-edge-distance-pane.png" });
  console.log("  (pane screenshot → /tmp/parallel-edge-distance-pane.png)");
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
await browser.close();
process.exit(failures === 0 ? 0 : 1);
