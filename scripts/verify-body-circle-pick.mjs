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
  const one = (Array.isArray(sel) ? sel : (sel?.selection ?? []))[0];
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

// The facet vertices are the WORST case for cause 1: they are the real vertices
// that used to steal every pick. Mid-chord angles are the worst case for cause 2
// (furthest from any chord endpoint). How finely walls are cut is the kernel's
// business (geom/circleFacets), so it is MEASURED off the body below rather than
// written down here — these checks are about picking, and must not have to be
// rewritten because the facet count moved.
let FACETS = 0;
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
const cylBody = (await read({ read: "sceneSummary" })).bodies[0];
FACETS = cylBody.edges.filter((e) => e.includes(`${cyl.createdId}/+z`)).length;
const CYL_FACES = cylBody.faces.length; // FACETS walls + 2 caps
check(
  "the cylinder's rim is a chain of chords",
  FACETS > 8 && CYL_FACES === FACETS + 2,
  `${FACETS} chords, ${CYL_FACES} faces`,
);

for (const [viewName, digit] of [
  ["iso", "7"],
  ["top (down the axis — the depth-tie case)", "1"],
]) {
  await setView(digit);
  for (const [where, frac] of [
    ["at a facet vertex", 0],
    ["mid-chord", 0.5],
  ]) {
    const got = [];
    for (const i of [0, 12, 24, 36, 48, 60, 72, 84]) {
      const k = await pickAt(ringPoint(R, H, i, frac));
      got.push(k === "edge" ? "•" : `✗${i}(${k})`);
    }
    check(
      `${viewName}: the top rim picks as an edge, ${where}`,
      got.every((g) => g === "•"),
      got.join(" "),
    );
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
  for (const c of [
    [x0, y0, z1],
    [x1, y0, z1],
    [x1, y1, z1],
    [x0, y1, z1],
    [x0, y0, z0],
    [x1, y1, z0],
  ]) {
    const k = await pickAt(c);
    got.push(k === "vertex" ? "•" : `✗${c.join(",")}(${k})`);
  }
  check(
    "a box's corners still pick as vertices",
    got.every((g) => g === "•"),
    got.join(" "),
  );
  // …and its edge mid-spans still pick as edges. Top edges only: an edge behind
  // a face is correctly rejected by the depth gate, so a hidden bottom edge
  // would fail for the right reason and tell us nothing.
  const mid = (a, c) => (a + c) / 2;
  const mids = [];
  for (const m of [
    [mid(x0, x1), y0, z1],
    [x1, mid(y0, y1), z1],
    [mid(x0, x1), y1, z1],
    [x0, mid(y0, y1), z1],
  ]) {
    const k = await pickAt(m);
    mids.push(k === "edge" ? "•" : `✗${m.map((v) => v.toFixed(0)).join(",")}(${k})`);
  }
  check(
    "…and its edge mid-spans still pick as edges",
    mids.every((g) => g === "•"),
    mids.join(" "),
  );
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
  check(
    "an extruded circle's rim picks as an edge",
    got.every((g) => g === "•"),
    got.join(" "),
  );
}

// --- 5. The payoff: click the rim, then fillet it -----------------------------
// The user's actual complaint is that the bad pick "basically prevents chamfers
// or fillets on those edges", so drive the real flow: click → F → size → Enter.
// A rim is a closed faceted circle, so it is dressed with one cross-section
// swept all the way round — ONE new face, not one per chord (revolvedRingTool).
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
  await page
    .waitForFunction(
      async () => (await window.__openpoly.read({ read: "document" })).features.some((f) => f.type === "dressup"),
      null,
      { timeout: 20000 },
    )
    .catch(() => {});
  const st = await waitIdle();
  const feats = (await read({ read: "document" })).features.map((f) => f.type).join(" → ");
  console.log(`  features: ${feats}`);
  const banner = await page
    .locator(".error-banner, .banner")
    .first()
    .textContent()
    .catch(() => null);
  if (banner) console.log(`  banner: ${banner.trim()}`);
  const after = (await read({ read: "sceneSummary" })).bodies[0];
  // 98 base faces (96 wall facets + 2 caps) + the one swept round.
  check("filleting the clicked rim succeeds", /up to date/i.test(st), st);
  // A picked rim stores its whole tangent chain, so the kernel has nothing to
  // expand and stays quiet. It used to store the single clicked chord, and the
  // kernel's "the stored selection covered 1 of 96 segments … re-pick the edge
  // to store it afresh" notice — meant for a STORED selection gone stale after
  // an upstream edit — fired on every freshly picked rim.
  const feat = (await read({ read: "document" })).features.find((f) => f.type === "dressup");
  check(
    "a picked rim stores its whole chain, so no stale-selection notice fires",
    (feat?.targets?.[0]?.edges?.length ?? 0) === FACETS,
    `stored ${feat?.targets?.[0]?.edges?.length} of ${FACETS} chords`,
  );
  check(
    "…and dresses the WHOLE circle, as one swept round",
    after.faces.length === before.faces.length + 1,
    `${before.faces.length} -> ${after.faces.length} faces (expected ${before.faces.length + 1}; ` +
      `${before.faces.length + FACETS} would mean one bevel per chord, ` +
      `${before.faces.length} that nothing was dressed)`,
  );
}

// --- 6. BOTH rims of a REVOLVED cylinder -------------------------------------
// A revolve whose profile touches the axis can't be lofted as facets, so it is
// built by analytic MakeRevol: one true gp_Cyl wall, two true circular rims. A
// closed face like that has its centre of mass on its own AXIS — off the
// surface — so `normalAt(centre)` has no unique projection and throws, and the
// wall's normal used to come from Newell over its boundary. That boundary is
// two opposed rim circles which nearly cancel, leaving an AXIS-aligned normal:
// parallel to one end cap, so that rim tested as a facet seam and was filtered
// out of the edge mesh entirely. Exactly one of the two rims was clickable.
await apply({ op: "newDocument", name: "revolved-cylinder-rims" });
await waitIdle();
{
  // A rectangle with one side ON the axis, revolved 360° about that side.
  await apply({
    op: "addSketch",
    plane: { datum: "front" },
    entities: [
      { shape: "line", a: [0, 0], b: [String(R), 0] },
      { shape: "line", a: [String(R), 0], b: [String(R), String(H)] },
      { shape: "line", a: [String(R), String(H)], b: [0, String(H)] },
      { shape: "line", a: [0, String(H)], b: [0, 0] },
    ],
  });
  await waitIdle();
  const sk = (await read({ read: "sceneSummary" })).sketches[0];
  // Symmetric, so the revolve STARTS half a turn from the profile plane and its
  // seam lands at −R on u — the far side from the sketch, which is coplanar with
  // the profile and would otherwise answer every pick along the seam itself.
  const rev = await apply({
    op: "addRevolve",
    profile: { sketchId: sk.id, regionId: sk.regions[0].id },
    axis: { sketchId: sk.id, entityId: sk.entities[3].id },
    angle: 360,
    symmetric: true,
  });
  const st = await waitIdle();
  check("the revolved cylinder built", /up to date/i.test(st) && rev.ok, st);
  const body = (await read({ read: "sceneSummary" })).bodies[0];
  const rims = body.edges.filter((e) => e.includes("side"));
  check("both of its rims survive into the edge mesh, named", rims.length === 2, `${rims.length}: ${rims.join(" ")}`);

  await setView("7");
  // The TOP rim is unoccluded all the way round from iso; the bottom one is
  // only visible on the arc facing the camera — the far half is correctly
  // rejected by the depth gate, so sampling it would fail for the wrong reason.
  for (const [label, z, angles] of [
    ["top", H, [10, 45, 100, 190, 260, 320]],
    ["bottom", 0, [10, 45, 260, 320]],
  ]) {
    const got = [];
    for (const a of angles) {
      const rad = (a * Math.PI) / 180;
      const k = await pickAt([R * Math.cos(rad), R * Math.sin(rad), z]);
      got.push(k === "edge" ? "•" : `✗${a}°(${k})`);
    }
    check(
      `the revolved cylinder's ${label} rim picks as an edge`,
      got.every((g) => g === "•"),
      got.join(" "),
    );
  }
  // …and the wall between them is seamless. A periodic surface closes back on
  // itself along a SEAM edge, which belongs to ONE face on both sides — so the
  // two-face crease test never saw it (the topology explorer yields each edge
  // once) and it drew as a stray line down an otherwise seamless wall. Seen from
  // the left the seam is the nearest surface point, dead centre, and the sketch
  // behind it is rejected by the depth gate — so a pick there is the wall face
  // when the seam is suppressed and the seam edge when it is not.
  await setView("5");
  const seam = await pickAt([-R, 0, H / 2]);
  check("its wall has no seam edge where the revolve closed", seam === "face", seam);

  // --- 7. …and extruding its cap leaves no ring where the extrude started -----
  // Extruding a body face rebuilds a curved profile as facets, so this fuses a
  // faceted prism onto an analytic wall of the same radius: tangent all the way
  // round, and the join should not be drawn at all. It was — but only for an
  // ARC of the ring, because the crease test compared each facet with ONE normal
  // sampled at the analytic wall's parametric middle. Facets within the crease
  // angle of that sample counted as tangent and the rest as a crease, so a wall
  // that is smooth the whole way round drew part of the join and hid the rest.
  const top = (await read({ read: "sceneSummary" })).bodies[0].faces.find((f) => f.endsWith("/f1"));
  await apply({
    op: "addExtrude",
    profile: { bodyId: rev.createdId, faceName: top },
    distance: "15",
    mode: "add",
    targetId: rev.createdId,
  });
  const exSt = await waitIdle();
  check("the cap extrudes", /up to date/i.test(exSt), exSt);
  // H = iso, zoomed to fit: the body just grew, and an unfitted view can push
  // the ring under the on-canvas view cube, where a click never reaches it.
  await setView("h");
  const join = [];
  for (const a of [260, 300, 340, 20]) {
    const rad = (a * Math.PI) / 180;
    const k = await pickAt([R * Math.cos(rad), R * Math.sin(rad), H]);
    join.push(k === "face" ? "•" : `✗${a}°(${k})`);
  }
  check(
    "…and the join to the extrusion is not drawn — the wall is tangent through it",
    join.every((g) => g === "•"),
    join.join(" "),
  );
}

console.log(failures === 0 ? "\n=== ALL CHECKS PASSED ===" : `\n=== ${failures} CHECK(S) FAILED ===`);
await browser.close();
process.exit(failures === 0 ? 0 : 1);
