// A fillet on a straight edge between two perpendicular flat faces must build,
// at any radius the faces have room for, and must produce ONE round face.
//
// Two defects, one cause. BRepFilletAPI has to propagate the round's run-out onto
// whatever adjoins the edge's ends, and our round walls are polygons:
//
//  * On the concave joint where a semicircle extruded from a cylinder's top meets
//    that top face, it does not build AT ALL — measured on exactly concentric
//    geometry (so faceting alignment was not the issue) OCCT answers
//    "Standard_NotImplemented" at every radius tried, 0.5mm through 6mm.
//  * Where it does build, the size was capped at one facet chord, so the rounder
//    the wall the smaller the fillet you could ask for — backwards.
//
// Chamfers on this configuration became booleans for the same reason; this
// extends that to fillets, the cross-section being an arc tangent to both faces
// instead of a straight bevel (geom/chamferWedge.filletCrossSection, unit-tested
// there — the arc's midpoint must sit ON the arc, at r(sqrt2 - 1) from the corner,
// not on the chord at r/sqrt2).
//
// The observable is the FACE COUNT, which is exact and needs no pixel argument.
// It is also what distinguishes a true round from a faked one: a cross-section
// approximated by N chords sweeps to N flat faces, a real arc to a single
// cylindrical face. So "faces == expected + 1" is the whole claim, on each of a
// convex edge, a concave one, and the concave joint that could not be filleted at
// all — plus, in C, that a whole tangent CHAIN is handed back to OCCT rather than
// swept wedge by wedge.
import { chromium } from "playwright";
import { writeFileSync } from "node:fs";

const URL = process.env.URL ?? "http://localhost:5175/";
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
const context = await browser.newContext({ viewport: { width: 1660, height: 920 }, deviceScaleFactor: 2 });
const page = await context.newPage();
page.on("pageerror", (e) => console.log(`[pageerror] ${e.message}`));

const unmeshed = [];
const normalless = [];
page.on("console", (m) => {
  const u = /mesh: UNMESHED (\d+) face/.exec(m.text());
  if (u) unmeshed.push(Number(u[1]));
  const n = /mesh: NORMALLESS (\d+) face/.exec(m.text());
  if (n) normalless.push(Number(n[1]));
});

await page.goto(URL, { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => window.__openpoly, null, { timeout: 30000 });
const waitIdle = async () => {
  let stable = 0;
  for (let i = 0; i < 250; i++) {
    const s = (await page.locator(".status").textContent())?.trim() ?? "";
    stable = /up to date|error|fail/i.test(s) ? stable + 1 : 0;
    if (stable >= 3) return s;
    await page.waitForTimeout(300);
  }
  return "TIMEOUT";
};
await waitIdle();
const apply = (o) => page.evaluate((x) => window.__openpoly.apply(x), o);
const read = (q) => page.evaluate((x) => window.__openpoly.read(x), q);

let failures = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}: ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};
const sum = (a) => a.reduce((x, y) => x + y, 0);
const bodyOf = async (id) => (await read({ read: "sceneSummary" })).bodies.find((b) => b.id === id);
const errOf = (r, fid) => (r.ok ? (r.featureErrors?.[fid] ?? null) : (r.error ?? "failed"));

const shoot = async (path) => {
  await apply({ op: "select", refs: [] });
  for (const eye of await page.locator(".tree-row.datum-row .row-icon").all()) await eye.click();
  await page.waitForTimeout(700);
  const img = await page.evaluate(() => window.__openpoly.screenshot("iso"));
  writeFileSync(path, Buffer.from(String(img).replace(/^data:image\/\w+;base64,/, ""), "base64"));
  console.log("screenshot:", path);
};

// ---------------------------------------------------------------------------
// A — CONVEX, on a box. The baseline OCCT handles too, so it catches the boolean
// going in on the wrong side: a fillet on an outside corner must ROUND IT OFF
// (cut), and a box that grew a lump would still have 7 faces, so the screenshot
// at the end is part of this check rather than decoration.
// ---------------------------------------------------------------------------
await apply({ op: "newDocument", name: "fillet-convex-box" });
await waitIdle();
const box = await apply({ op: "addPrimitive", kind: "box", params: { width: 40, depth: 40, height: 40 } });
await waitIdle();
const boxBody = await bodyOf(box.createdId);
check("box built", (boxBody?.faces?.length ?? 0) === 6, `${boxBody?.faces?.length} faces`);

// The top/front edge: where +z meets -y.
const boxEdge = (boxBody?.edges ?? []).filter((e) => e.includes(`${box.createdId}/+z`) && e.includes(`${box.createdId}/-y`));
check("the convex edge is named", boxEdge.length === 1, JSON.stringify(boxEdge));

const bf = await apply({ op: "dressUp", kind: "fillet", targetId: box.createdId, edges: boxEdge, size: "4" });
const bst = await waitIdle();
let after = await bodyOf(box.createdId);
check(
  "a convex fillet builds and adds exactly ONE round face",
  bf.ok && !errOf(bf, bf.createdId) && after?.faces?.length === 7,
  `faces=${after?.faces?.length} (want 7: the box's 6 + one cylindrical round; a 12-chord ` +
  `approximation would give 18) ${errOf(bf, bf.createdId) ?? ""} status="${bst}"`,
);
check("and it meshes whole", unmeshed.length === 0 && normalless.length === 0, `${sum(unmeshed)} unmeshed, ${sum(normalless)} normalless`);

// Radius sweep: the face count must not move. Any radius that starts producing
// extra faces is a cross-section that stopped being a single arc.
for (const r of ["0.5", "2", "8", "15"]) {
  unmeshed.length = 0;
  const s = await apply({ op: "setParam", featureId: bf.createdId, name: "size", value: r });
  await waitIdle();
  after = await bodyOf(box.createdId);
  check(
    `convex fillet at r=${r} still 7 faces`,
    !errOf(s, bf.createdId) && after?.faces?.length === 7 && unmeshed.length === 0,
    `faces=${after?.faces?.length} ${errOf(s, bf.createdId) ?? ""}`,
  );
}

// A boolean cannot tell that a fillet is too big — it would happily gouge a 999mm
// round out of a 40mm box and report success. Over-large must be refused (the
// wedge builder's fit check declines, OCCT then rejects it with a message).
const over = await apply({ op: "setParam", featureId: bf.createdId, name: "size", value: "999" });
await waitIdle();
check(
  "a fillet larger than the face it runs along is refused, not silently gouged",
  !!errOf(over, bf.createdId),
  errOf(over, bf.createdId) ? String(errOf(over, bf.createdId)).slice(0, 70) : "it SUCCEEDED — a 999mm round on a 40mm box",
);
await apply({ op: "setParam", featureId: bf.createdId, name: "size", value: "4" });
await waitIdle();
await shoot("/tmp/openpoly-fillet-convex.png");

// ---------------------------------------------------------------------------
// B0 — CONCAVE, exact. A step: a narrower box sitting on a wider one, filleted
// along the re-entrant edge where the wall meets the tread. Both faces are
// rectangles spanning the full width, so nothing curved clips the round's ends and
// the count is exact — which is what makes this the place to assert "one round
// face" for the concave path (B, on a cylinder, cannot: see the note there).
// ---------------------------------------------------------------------------
await apply({ op: "newDocument", name: "fillet-concave-step" });
await waitIdle();
const base = await apply({ op: "addPrimitive", kind: "box", params: { width: 40, depth: 40, height: 20 } });
const step = await apply({ op: "addPrimitive", kind: "box", params: { width: 40, depth: 20, height: 20, y: 10, z: 20 } });
await waitIdle();
const L = await apply({ op: "boolean", kind: "union", operands: [base.createdId, step.createdId] });
await waitIdle();
const Lbody = await bodyOf(L.createdId);
check("the step body is an L-prism", Lbody?.faces?.length === 8, `${Lbody?.faces?.length} faces (want 8)`);

const stepEdge = (Lbody?.edges ?? []).filter((e) => e.includes(`${base.createdId}/+z`) && e.includes(`${step.createdId}/-y`));
check("the re-entrant edge is named", stepEdge.length === 1, JSON.stringify(stepEdge));

unmeshed.length = 0;
const sf = await apply({ op: "dressUp", kind: "fillet", targetId: L.createdId, edges: stepEdge, size: "5" });
const sst = await waitIdle();
let sAfter = await bodyOf(L.createdId);
check(
  "a concave fillet builds and adds exactly ONE round face",
  sf.ok && !errOf(sf, sf.createdId) && sAfter?.faces?.length === 9,
  `faces=${sAfter?.faces?.length} (want 9: the L's 8 + one cylindrical round) ` +
  `${errOf(sf, sf.createdId) ?? ""} status="${sst}"`,
);
check("and it meshes whole", unmeshed.length === 0 && normalless.length === 0, `${sum(unmeshed)} unmeshed, ${sum(normalless)} normalless`);
for (const r of ["1", "10", "18"]) {
  unmeshed.length = 0;
  const s = await apply({ op: "setParam", featureId: sf.createdId, name: "size", value: r });
  await waitIdle();
  sAfter = await bodyOf(L.createdId);
  check(
    `concave fillet at r=${r} still 9 faces`,
    !errOf(s, sf.createdId) && sAfter?.faces?.length === 9 && unmeshed.length === 0,
    `faces=${sAfter?.faces?.length} ${errOf(s, sf.createdId) ?? ""}`,
  );
}
await apply({ op: "setParam", featureId: sf.createdId, name: "size", value: "5" });
await waitIdle();
await shoot("/tmp/openpoly-fillet-step.png");

// ---------------------------------------------------------------------------
// B — CONCAVE, the reported case: a semicircle extruded from a cylinder's top,
// filleted along the straight joint underneath. This is the one that could not be
// built at any radius.
// ---------------------------------------------------------------------------
const R = 30;
await apply({ op: "newDocument", name: "fillet-concave-joint" });
await waitIdle();
const cyl = await apply({ op: "addPrimitive", kind: "cylinder", params: { radius: String(R), height: "60" } });
await waitIdle();
// Read the wall's facet count off the body: it belongs to the kernel
// (geom/circleFacets), and these checks are about the joint, not the faceting.
const CYL_FACES = (await bodyOf(cyl.createdId))?.faces?.length ?? -1;
const sk = await apply({
  op: "addSketch",
  plane: { bodyId: cyl.createdId, faceName: `${cyl.createdId}/+z` },
  entities: [
    { shape: "line", a: [0, R], b: [0, -R] },
    { shape: "arc", c: [0, 0], r: R, start: 90, end: 270 },
  ],
});
await waitIdle();
const ex = await apply({
  op: "addExtrude", profile: { sketchId: sk.createdId },
  distance: "20", mode: "add", targetId: cyl.createdId,
});
await waitIdle();
const fused = await bodyOf(cyl.createdId);
// The cylinder's own faces (its wall chords + 2 caps) plus the prism's flat side
// and top. The facet count is the kernel's business (geom/circleFacets), so it is
// measured off the cylinder rather than written down — this check is about the
// fuse being clean, not about how finely walls are cut.
const CLEAN = CYL_FACES + 2; // + the prism's flat side and its top
const BASE = fused?.faces?.length ?? -1;
check("the fused body is clean", BASE >= CLEAN && BASE <= CLEAN + 6,
  `${BASE} faces (clean ${CLEAN}, up to 6 end residue)`);

const joint = (fused?.edges ?? []).filter((e) => /\/\+z/.test(e) && /\/side\d/.test(e));
check("the concave joint is a single edge", joint.length === 1, `${joint.length} edge(s): ${JSON.stringify(joint)}`);

const ff = await apply({ op: "dressUp", kind: "fillet", targetId: cyl.createdId, edges: joint, size: "2" });
const st = await waitIdle();
after = await bodyOf(cyl.createdId);
check(
  "the concave joint fillets at all (it could not, at any radius)",
  ff.ok && !errOf(ff, ff.createdId),
  `${errOf(ff, ff.createdId) ?? "built"} status="${st}"`,
);
// Exactly one face, as on the step. It took the coplanar-seam merge to get here:
// the round's ends land ON the wall facets they run out onto, and before those
// seams were unified this came out at BASE + 3, growing to BASE + 7 by r = 6 as
// the ends spanned more facets.
const chord = 2 * R * Math.sin(Math.PI / 96);
check(
  "and adds exactly ONE round face",
  after?.faces?.length === BASE + 1,
  `faces=${after?.faces?.length}, was ${BASE}`,
);

// The old ceiling was one facet chord (2*30*sin(pi/96) = 1.96mm at r=30), so the
// sweep has to cross it. 6mm is three chords past.
console.log(`  the old ceiling here would have been one facet chord = ${chord.toFixed(3)} mm`);
for (const r of ["0.5", "1", "2", "3", "6"]) {
  unmeshed.length = 0;
  normalless.length = 0;
  const s = await apply({ op: "setParam", featureId: ff.createdId, name: "size", value: r });
  await waitIdle();
  after = await bodyOf(cyl.createdId);
  const e = errOf(s, ff.createdId);
  check(
    `concave fillet at r=${r}mm ${Number(r) > chord ? "(past the old chord ceiling)" : ""}`,
    !e && after?.faces?.length === BASE + 1 && unmeshed.length === 0 && normalless.length === 0,
    `faces=${after?.faces?.length} (want ${BASE + 1})` +
    `${e ? " " + String(e).slice(0, 56) : ""}` +
    `${unmeshed.length ? ` ${sum(unmeshed)} unmeshed` : ""}${normalless.length ? ` ${sum(normalless)} normalless` : ""}`,
  );
}
await apply({ op: "setParam", featureId: ff.createdId, name: "size", value: "4" });
await waitIdle();
await shoot("/tmp/openpoly-fillet-concave.png");

// ---------------------------------------------------------------------------
// C — a CLOSED FACETED CIRCLE is dressed with one tool swept all the way round.
//
// A wedge swept along one chord stops at its ends, so on a rim consecutive wedges
// meet at an angle and leave the corner between them uncut — a castellated crown
// of 96 leftover teeth (measured at 146 faces / 528 edges, at every radius alike;
// FEWER faces than a real bevel, since a tooth's flanks are not bevels, and nearly
// twice the edges). Handing all 96 chords to BRepFilletAPI instead avoided the
// crown but returned a top face whose boundary wire SELF-OVERLAPS: each inner edge
// keeps its original chord length rather than being trimmed to the mitre, so the
// ring's perimeter came out 188.46mm — the circumference of the r=30 rim it came
// from — on a ring at r=26 where a mitred 96-gon measures 163.3. That renders
// correctly and poisons whatever is built on the face: extruding it carried the
// bad wire up, and dressing THAT rim was what produced the crown in the wild.
//
// Revolving one cross-section has neither problem, and the result is exact: ONE
// analytic round, so 98 + 1 = 99 faces however finely the wall is cut. That is the
// assertion — "it changed" would not have caught either failure, since both were
// radius-independent. Chamfers take this path too, so both are checked.
// ---------------------------------------------------------------------------
const CROWN = { faces: 146, edges: 528 }; // measured, and radius-independent
for (const kind of ["fillet", "chamfer"]) {
  await apply({ op: "newDocument", name: `${kind}-chain-rim` });
  await waitIdle();
  const c2 = await apply({ op: "addPrimitive", kind: "cylinder", params: { radius: "20", height: "40" } });
  await waitIdle();
  const c2b = await bodyOf(c2.createdId);
  const rim = (c2b?.edges ?? []).filter((e) => e.includes(`${c2.createdId}/+z`));
  check(`${kind}: the top rim is a chain of chords`, rim.length > 1, `${rim.length} edge(s)`);

  unmeshed.length = 0;
  const rf = await apply({ op: "dressUp", kind, targetId: c2.createdId, edges: rim, size: "2" });
  const rst = await waitIdle();
  const counts = [];
  for (const r of ["1", "2", "3"]) {
    const s = await apply({ op: "setParam", featureId: rf.createdId, name: "size", value: r });
    await waitIdle();
    const b = await bodyOf(c2.createdId);
    counts.push({ r, faces: b?.faces?.length ?? -1, edges: b?.edges?.length ?? -1, err: errOf(s, rf.createdId) });
  }
  check(
    `${kind}: a rim chain builds`,
    rf.ok && counts.every((c) => !c.err),
    `${JSON.stringify(counts)} status="${rst}"`,
  );
  const want = (c2b?.faces?.length ?? 0) + 1; // ONE swept round, not one per chord
  check(
    `${kind}: the rim is one swept round — no crown, no per-chord bevels`,
    counts.every((c) => c.faces === want && c.faces !== CROWN.faces && c.edges !== CROWN.edges),
    `${JSON.stringify(counts.map((c) => [c.r, c.faces, c.edges]))}, want ${want} faces — ` +
    `the crown was ${CROWN.faces} faces / ${CROWN.edges} edges at every radius, and ` +
    `one bevel per chord (the old BRepFilletAPI answer) would be ${(c2b?.faces?.length ?? 0) + rim.length}`,
  );
  // The round is named, so downstream features can reference it. A nameless
  // round is how the first attempt failed: unifySameDomain's coplanar-parallel
  // matcher handed the new face's name to a flat neighbour.
  const rb = await bodyOf(c2.createdId);
  check(
    `${kind}: the swept round is a single named face`,
    (rb?.faces ?? []).filter((f) => f.includes(`/${kind}`)).length === 1,
    (rb?.faces ?? []).filter((f) => f.includes(`/${kind}`)).join(", ") || "none",
  );
  check(`${kind}: the rim result meshes whole`, unmeshed.length === 0, `${sum(unmeshed)} unmeshed`);
  await apply({ op: "setParam", featureId: rf.createdId, name: "size", value: "2" });
  await waitIdle();
  await shoot(`/tmp/openpoly-${kind}-chain-rim.png`);
}

console.log(failures === 0 ? "=== ALL CHECKS PASSED ===" : `=== ${failures} CHECK(S) FAILED ===`);
await browser.close();
process.exit(failures === 0 ? 0 : 1);
