// A circular edge on a BODY — a cylinder's rim, or the rim of an extruded
// circle — must be selectable as an edge, so it can be chamfered or filleted.
//
// Regression (two causes, both specific to faceted circles):
//   1. Round walls are 96-gons, so a rim is 96 STRAIGHT edges meeting
//      tangentially. Every chord junction is a genuine OCCT vertex ~1.3mm from
//      its neighbours, and vertex outranks edge in the pick order — so a click
//      anywhere near the rim returned a vertex instead. See realVertexNear:
//      a chain-interior junction is no longer offered as a vertex.
//   2. Body edges took intersectObjects()[0] — nearest by ray DEPTH. Seen down
//      a cylinder's axis the whole rim ties on depth, so an arbitrary chord came
//      back, typically a whole chord from the cursor, which then failed the
//      EDGE_PICK_PX gate. Now picked by pixel distance (nearestHitInPixels),
//      the same fix sketch lines already had.
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
  for (let i = 0; i < 120; i++) {
    const s = (await page.locator(".status").textContent())?.trim() ?? "";
    stable = /up to date|error|fail/i.test(s) ? stable + 1 : 0;
    if (stable >= 3) return s;
    await page.waitForTimeout(300);
  }
  return "TIMEOUT";
};
const apply = (op) => page.evaluate((o) => window.__openpoly.apply(o), op);
const read = (q) => page.evaluate((o) => window.__openpoly.read(o), q);

let failures = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}: ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

await waitIdle();
const canvas = await page.locator("canvas").first().boundingBox();
const clickWorld = async (w) => {
  const s = await page.evaluate((p) => window.__openpoly.worldToScreen(p), w);
  if (!s) return false;
  await page.mouse.click(canvas.x + s.x, canvas.y + s.y);
  await page.waitForTimeout(200);
  return true;
};
const selKind = async () => {
  const sel = await read({ read: "selection" });
  const one = (Array.isArray(sel) ? sel : sel?.selection ?? [])[0];
  return one?.kind ?? "none";
};
const pickAt = async (w) => {
  await apply({ op: "select", refs: [] });
  if (!(await clickWorld(w))) return "offscreen";
  return selKind();
};
const setView = async (digit) => {
  await page.evaluate(() => document.activeElement?.blur());
  await page.keyboard.press(digit);
  await page.waitForTimeout(500);
};

// The 96-gon's facet vertices are the WORST case for cause 1: they are the real
// vertices that used to steal every pick. Mid-chord angles are the worst case
// for cause 2 (furthest from any chord endpoint).
const FACETS = 96;
const ringPoint = (r, z, i, frac) => {
  const a = ((i + frac) * 2 * Math.PI) / FACETS;
  return [r * Math.cos(a), r * Math.sin(a), z];
};

// --- 1 & 2. A cylinder's top rim, at a facet vertex and mid-chord -------------
await apply({ op: "newDocument", name: "rim-pick" });
await waitIdle();
const R = 20;
const H = 40;
const cyl = await apply({ op: "addPrimitive", kind: "cylinder", params: { radius: String(R), height: String(H) } });
await waitIdle();

for (const [viewName, digit] of [["iso", "7"], ["top (down the axis — the depth-tie case)", "1"]]) {
  await setView(digit);
  for (const [where, frac] of [["at a facet vertex", 0], ["mid-chord", 0.5]]) {
    const got = [];
    for (const i of [0, 12, 24, 36, 48, 60, 72, 84]) {
      const k = await pickAt(ringPoint(R, H, i, frac));
      got.push(k === "edge" ? "•" : `✗${i}(${k})`);
    }
    check(`${viewName}: the top rim picks as an edge, ${where}`,
      got.every((g) => g === "•"), got.join(" "));
  }
}

// --- 3. Real corners must STILL be pickable as vertices -----------------------
// The fix suppresses tangent-chain junctions only; a box corner is a genuine
// corner and has to keep working, or the cure would be worse than the disease.
await apply({ op: "newDocument", name: "corner-pick" });
await waitIdle();
await apply({ op: "addPrimitive", kind: "box", params: { width: "40", depth: "40", height: "40" } });
await waitIdle();
await setView("7");
{
  // Corners from the real bbox, so this doesn't depend on the primitive's
  // origin convention.
  const b = (await read({ read: "sceneSummary" })).bodies[0].bbox;
  const [x0, y0, z0] = b.min;
  const [x1, y1, z1] = b.max;
  const got = [];
  for (const c of [[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1], [x0, y0, z0], [x1, y1, z0]]) {
    const k = await pickAt(c);
    got.push(k === "vertex" ? "•" : `✗${c.join(",")}(${k})`);
  }
  check("a box's corners still pick as vertices", got.every((g) => g === "•"), got.join(" "));
  // …and its edge mid-spans still pick as edges. Top edges only: an edge behind
  // a face is correctly rejected by the depth gate, so a hidden bottom edge
  // would fail for the right reason and tell us nothing.
  const mid = (a, c) => (a + c) / 2;
  const mids = [];
  for (const m of [[mid(x0, x1), y0, z1], [x1, mid(y0, y1), z1], [mid(x0, x1), y1, z1], [x0, mid(y0, y1), z1]]) {
    const k = await pickAt(m);
    mids.push(k === "edge" ? "•" : `✗${m.map((v) => v.toFixed(0)).join(",")}(${k})`);
  }
  check("…and its edge mid-spans still pick as edges", mids.every((g) => g === "•"), mids.join(" "));
}

// --- 4. The rim of an EXTRUDED CIRCLE (the other reported case) ---------------
await apply({ op: "newDocument", name: "extruded-circle-rim" });
await waitIdle();
await apply({ op: "addSketch", plane: { datum: "top" }, entities: [{ shape: "circle", c: [0, 0], r: String(R) }] });
await waitIdle();
const sketchId = (await read({ read: "document" })).features.find((f) => f.type === "sketch").id;
await apply({ op: "addExtrude", profile: { sketchId }, distance: "25" });
const exStatus = await waitIdle();
check("the extruded circle built", /up to date/i.test(exStatus), exStatus);
await setView("7");
{
  const got = [];
  for (const frac of [0, 0.5]) {
    for (const i of [0, 24, 48, 72]) {
      const k = await pickAt(ringPoint(R, 25, i, frac));
      got.push(k === "edge" ? "•" : `✗${i}+${frac}(${k})`);
    }
  }
  check("an extruded circle's rim picks as an edge", got.every((g) => g === "•"), got.join(" "));
}

// --- 5. The payoff: click the rim, then fillet it -----------------------------
// The user's actual complaint is that the bad pick "basically prevents chamfers
// or fillets on those edges", so drive the real flow: click → F → size → Enter.
// A rim is a tangent chain, so this goes to BRepFilletAPI (the boolean fast path
// is singletons only); r must stay under one facet chord (2πR/96 = 1.31mm).
{
  await apply({ op: "select", refs: [] });
  await clickWorld(ringPoint(R, 25, 30, 0.5));
  const kind = await selKind();
  check("a rim click leaves an edge selected, ready to dress up", kind === "edge", kind);
  const before = (await read({ read: "sceneSummary" })).bodies[0];
  await page.evaluate(() => document.activeElement?.blur());
  await page.keyboard.press("f");
  await page.waitForTimeout(400);
  const title = (await page.locator(".extrude-dialog .ed-title").textContent()) ?? "";
  check("F opens the Fillet dialog", /Fillet/.test(title), title || "no dialog");
  await page.locator(".extrude-dialog .ed-field input").first().fill("0.5");
  await page.keyboard.press("Enter");
  // Wait for the FEATURE to exist before waiting for idle: the status still
  // reads "up to date" for a moment after Enter, so waitIdle alone would return
  // on the pre-mutation state and read back the undressed body.
  await page.waitForFunction(
    async () => (await window.__openpoly.read({ read: "document" })).features.some((f) => f.type === "dressup"),
    null, { timeout: 20000 },
  ).catch(() => {});
  const st = await waitIdle();
  const feats = (await read({ read: "document" })).features.map((f) => f.type).join(" → ");
  console.log(`  features: ${feats}`);
  const banner = await page.locator(".error-banner, .banner").first().textContent().catch(() => null);
  if (banner) console.log(`  banner: ${banner.trim()}`);
  const after = (await read({ read: "sceneSummary" })).bodies[0];
  // 98 base faces (96 wall facets + 2 caps) + one fillet face per rim chord.
  check("filleting the clicked rim succeeds", /up to date/i.test(st), st);
  check("…and dresses the WHOLE circle: one fillet face per chord",
    after.faces.length === 98 + FACETS,
    `${before.faces.length} -> ${after.faces.length} faces (expected ${98 + FACETS})`);
}

console.log(failures === 0 ? "\n=== ALL CHECKS PASSED ===" : `\n=== ${failures} CHECK(S) FAILED ===`);
await browser.close();
process.exit(failures === 0 ? 0 : 1);
