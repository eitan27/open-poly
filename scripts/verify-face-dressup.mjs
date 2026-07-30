// Selecting a FACE and hitting Chamfer/Fillet dresses every boundary edge of
// that face. This is how you round a circular rim in practice: a faceted rim is
// 96 chords about a millimetre long, so hitting one with the cursor is fiddly,
// but the flat top it bounds is a big obvious target.
//
// A picked face means the whole smooth SURFACE it belongs to — all 96 facets of
// a round wall are one surface — so its boundary is the two rims, not one
// facet's four sides. Facet seams (interior to the surface) are excluded.
//
// Counts are the assertion, never pixels: they say exactly which edges got
// dressed. The screenshots are for eyeballing, not for passing. Note the scene
// summary's `faces` is a list of distinct NAMES, not a face count — equal here
// because every face of these bodies is named, and a missing name is itself a
// defect worth failing on.
import { chromium } from "playwright";
import { writeFileSync } from "node:fs";

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
const body = async () => (await read({ read: "sceneSummary" })).bodies[0];

let failures = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}: ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};
const shoot = async (path) => {
  await apply({ op: "select", refs: [] });
  for (const eye of await page.locator(".tree-row.datum-row .row-icon").all()) await eye.click();
  await page.waitForTimeout(600);
  const img = await page.evaluate(() => window.__openpoly.screenshot("iso"));
  writeFileSync(path, Buffer.from(String(img).replace(/^data:image\/\w+;base64,/, ""), "base64"));
  console.log(`  screenshot: ${path}`);
};

await waitIdle();
const FACETS = 96;

// --- 1. A cylinder's flat top → the whole rim rounds -------------------------
// 98 base faces (96 wall facets + 2 caps). The top cap has ONE boundary: its
// rim, 96 chords → 96 new faces. Radius stays under one facet chord
// (2π·20/96 = 1.31mm) so BRepFilletAPI can take the tangent chain.
await apply({ op: "newDocument", name: "face-fillet-cyl-top" });
await waitIdle();
const cyl = await apply({ op: "addPrimitive", kind: "cylinder", params: { radius: "20", height: "40" } });
await waitIdle();
{
  const b = await body();
  const top = b.faces.find((f) => /\+z/.test(f));
  check("the cylinder's top face is named", !!top, top ?? b.faces.slice(0, 6).join(", "));
  const before = b.faces.length;
  await apply({ op: "dressUp", kind: "fillet", targetId: cyl.createdId, edges: [], faces: [top], size: "1" });
  const st = await waitIdle();
  const after = await body();
  check("filleting the top FACE builds", /up to date/i.test(st), st);
  check("…and rounds the whole rim: one face per chord",
    after.faces.length === before + FACETS,
    `${before} -> ${after.faces.length} faces (expected ${before + FACETS})`);
  await shoot("/tmp/openpoly-face-fillet-cyl-top.png");
}

// --- 2. A cylinder's WALL → both rims round ----------------------------------
// The wall is one smooth surface of 96 facets; its boundary is the top AND
// bottom rims (192 chords), and the 96 vertical facet seams are interior to it
// and must NOT be dressed — dressing them would shred the wall.
await apply({ op: "newDocument", name: "face-fillet-cyl-wall" });
await waitIdle();
const cyl2 = await apply({ op: "addPrimitive", kind: "cylinder", params: { radius: "20", height: "40" } });
await waitIdle();
{
  const b = await body();
  const wall = b.faces.find((f) => /side/.test(f)) ?? b.faces.find((f) => !/\+z|-z/.test(f));
  check("the cylinder's wall face is named", !!wall, wall ?? b.faces.slice(0, 6).join(", "));
  const before = b.faces.length;
  await apply({ op: "dressUp", kind: "fillet", targetId: cyl2.createdId, edges: [], faces: [wall], size: "1" });
  const st = await waitIdle();
  const after = await body();
  check("filleting the WALL face builds", /up to date/i.test(st), st);
  check("…and rounds both rims, leaving the facet seams alone",
    after.faces.length === before + 2 * FACETS,
    `${before} -> ${after.faces.length} faces (expected ${before + 2 * FACETS}; ` +
    `+${FACETS} would be one rim, +${3 * FACETS} would mean the seams got dressed too)`);
  await shoot("/tmp/openpoly-face-fillet-cyl-wall.png");
}

// --- 3. A box's top face → its 4 edges ---------------------------------------
// The non-circular case the user also asked for. 6 base faces + 4 bevels = 10.
await apply({ op: "newDocument", name: "face-chamfer-box" });
await waitIdle();
const box = await apply({ op: "addPrimitive", kind: "box", params: { width: "40", depth: "40", height: "40" } });
await waitIdle();
{
  const b = await body();
  const top = b.faces.find((f) => /\+z/.test(f));
  const before = b.faces.length;
  await apply({ op: "dressUp", kind: "chamfer", targetId: box.createdId, edges: [], faces: [top], size: "3" });
  const st = await waitIdle();
  const after = await body();
  check("chamfering a box's top FACE builds", /up to date/i.test(st), st);
  check("…and bevels exactly its 4 edges",
    after.faces.length === before + 4,
    `${before} -> ${after.faces.length} faces (expected ${before + 4})`);
  await shoot("/tmp/openpoly-face-chamfer-box.png");
}

// --- 4. Through the UI: click a face, press F --------------------------------
// The flow the user actually performs. A flat cap is a big target, which is the
// whole point of the feature.
await apply({ op: "newDocument", name: "face-fillet-ui" });
await waitIdle();
await apply({ op: "addPrimitive", kind: "cylinder", params: { radius: "20", height: "40" } });
await waitIdle();
{
  await page.evaluate(() => document.activeElement?.blur());
  await page.keyboard.press("7");
  await page.waitForTimeout(500);
  const canvas = await page.locator("canvas").first().boundingBox();
  // Well inside the top cap — nowhere near the rim.
  const s = await page.evaluate((p) => window.__openpoly.worldToScreen(p), [4, 4, 40]);
  await apply({ op: "select", refs: [] });
  await page.mouse.click(canvas.x + s.x, canvas.y + s.y);
  await page.waitForTimeout(250);
  const sel = await read({ read: "selection" });
  check("clicking the middle of the top cap selects a face", sel[0]?.kind === "face", sel[0]?.kind ?? "none");

  const before = (await body()).faces.length;
  await page.keyboard.press("f");
  await page.waitForTimeout(400);
  const title = (await page.locator(".extrude-dialog .ed-title").textContent().catch(() => null)) ?? "";
  check("F opens the Fillet dialog on a face selection", /Fillet/.test(title), title || "no dialog");
  if (/Fillet/.test(title)) {
    await page.locator(".extrude-dialog .ed-field input").first().fill("1");
    await page.keyboard.press("Enter");
    // The document gains the feature synchronously on commit but the mesh only
    // after a regen, and the status still reads "up to date" in between — so
    // wait for the BODY to change, not for the feature or for idle. A genuine
    // failure just times out here and the assertion below still catches it.
    let after = before;
    for (let i = 0; i < 60 && after === before; i++) {
      await page.waitForTimeout(400);
      after = (await body()).faces.length;
    }
    const st = await waitIdle();
    after = (await body()).faces.length;
    check("…and committing it rounds the whole rim", /up to date/i.test(st) && after === before + FACETS,
      `${before} -> ${after} faces (expected ${before + FACETS}), status ${st}`);
  }
  await shoot("/tmp/openpoly-face-fillet-ui.png");
}

// --- 5. A face selection survives a size edit (it's stored, not one-shot) -----
{
  const f = (await read({ read: "document" })).features.find((x) => x.type === "dressup");
  check("the feature stores the FACE reference, not expanded edges",
    Array.isArray(f?.faces) && f.faces.length === 1 && (f.edges?.length ?? 0) === 0,
    JSON.stringify({ faces: f?.faces, edges: f?.edges }));
  await apply({ op: "setParam", featureId: f.id, name: "size", value: "2" });
  const st = await waitIdle();
  const after = (await body()).faces.length;
  check("…so changing its radius re-resolves the face and still dresses the whole rim",
    /up to date/i.test(st) && after === 98 + FACETS,
    `${after} faces (expected ${98 + FACETS}), status ${st}`);
}

console.log(failures === 0 ? "\n=== ALL CHECKS PASSED ===" : `\n=== ${failures} CHECK(S) FAILED ===`);
await browser.close();
process.exit(failures === 0 ? 0 : 1);
