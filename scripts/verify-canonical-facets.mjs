// Throwaway verification that a round wall built two different ways is the SAME
// wall, so the boolean between them has nothing to slice.
//
// The reported shape: a semicircle sketched on a cylinder's top face and
// extruded. The cylinder's wall and the extruded wall are meant to be the same
// surface, but each was discretised by its own code path — a 96-gon anchored at
// 0 degrees for the primitive, 48 equal pieces from wherever the arc started for
// the sketch. They disagreed by up to r(1-cos(pi/96)) = 0.016mm at r=30, leaving
// a ribbon of hair-thin crescent faces up the whole joint. Those crescents are
// what OCCT then refused to tessellate (holes you could see through), what shaded
// as a vertical streak, and what stopped a chamfer meeting the rim cleanly.
//
// The observable is the fused body's FACE COUNT, which is exact and needs no
// pixel argument. A clean join of a semicircular prism onto a 96-gon cylinder is
// 100 faces: the cylinder's 98, plus the prism's flat side and its top. Every
// extra face is a crescent. Before the fix, phase 0 happened to align and gave
// 100 while 0.9 degrees gave 245; the sweep below is over phases chosen to hit
// the worst cases (half a facet is 1.875 degrees).
import { chromium } from "playwright";

const URL = process.env.URL ?? "http://localhost:5175/";
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
const context = await browser.newContext({ viewport: { width: 1660, height: 920 }, deviceScaleFactor: 2 });
const page = await context.newPage();
page.on("pageerror", (e) => console.log(`[pageerror] ${e.message}`));

const unmeshed = [];
const recovered = [];
page.on("console", (m) => {
  const u = /mesh: UNMESHED (\d+) face/.exec(m.text());
  if (u) unmeshed.push(Number(u[1]));
  const r = /mesh: recovered (\d+) dropped face/.exec(m.text());
  if (r) recovered.push(Number(r[1]));
});

await page.goto(URL, { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => window.__openpoly, null, { timeout: 30000 });
const waitIdle = async () => {
  let stable = 0;
  for (let i = 0; i < 150; i++) {
    const s = (await page.locator(".status").textContent())?.trim() ?? "";
    stable = /up to date|error|fail/i.test(s) ? stable + 1 : 0;
    if (stable >= 3) return;
    await page.waitForTimeout(300);
  }
  throw new Error("app never settled");
};
await waitIdle();
const apply = (o) => page.evaluate((x) => window.__openpoly.apply(x), o);
const read = (q) => page.evaluate((x) => window.__openpoly.read(x), q);

let failures = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}: ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

const R = 30;
const rad = (d) => (d * Math.PI) / 180;
// A semicircle as DXF: the diameter as a LINE, the half-rim as an ARC. `a0` sets
// the phase — where the arc starts relative to the primitive's own stations.
const semiDxf = (a0) => {
  const p = (d) => [R * Math.cos(rad(d)), R * Math.sin(rad(d))];
  const [x0, y0] = p(a0), [x1, y1] = p(a0 + 180);
  return (
    `0\nSECTION\n2\nENTITIES\n` +
    `0\nLINE\n8\n0\n10\n${x1}\n20\n${y1}\n11\n${x0}\n21\n${y0}\n` +
    `0\nARC\n8\n0\n10\n0.0\n20\n0.0\n40\n${R}\n50\n${a0}\n51\n${a0 + 180}\n` +
    `0\nENDSEC\n0\nEOF\n`
  );
};

// The cylinder's 98 + the prism's flat side + its top. Reached exactly only when
// the arc's endpoints happen to land on stations.
const CLEAN = 100;
// An arc's endpoints are where they were DRAWN, not on stations, so a partial
// facet survives at each end however the sampling is aligned — a handful of
// faces, and no way around it short of moving the user's geometry. What must NOT
// survive is a ribbon along the whole joint: measured before the fix, the same
// phases gave 245, 245 and 148 faces, i.e. ~145 crescents.
const END_RESIDUE = 6;

// Half a facet (1.875 deg) is the worst case; the others are arbitrary phases a
// hand-drawn arc might land on, plus 0, which used to pass by luck.
const phases = [0, 0.9, 1.875, 7, 23.4];
const counts = [];
for (const a0 of phases) {
  unmeshed.length = 0;
  recovered.length = 0;
  await apply({ op: "newDocument", name: `phase-${a0}` });
  await waitIdle();
  const cyl = await apply({ op: "addPrimitive", kind: "cylinder", params: { radius: String(R), height: "60" } });
  await waitIdle();
  const cylFaces = (await read({ read: "sceneSummary" })).bodies.find((b) => b.id === cyl.createdId)?.faces?.length;

  // Sketch onto the cylinder's TOP FACE, as reported, and fuse the extrusion in.
  const sk = await apply({
    op: "importDxf", source: semiDxf(a0),
    plane: { bodyId: cyl.createdId, faceName: `${cyl.createdId}/+z` },
  });
  await waitIdle();
  const ex = await apply({
    op: "addExtrude", profile: { sketchId: sk.createdId },
    distance: "20", mode: "add", targetId: cyl.createdId,
  });
  await waitIdle();
  const fused = (await read({ read: "sceneSummary" })).bodies.find((b) => b.id === cyl.createdId);
  const n = fused?.faces?.length ?? -1;
  counts.push({ a0, n });
  check(
    `phase ${a0}deg: the walls coincide (no crescent ribbon)`,
    sk.ok && ex.ok && n >= CLEAN && n <= CLEAN + END_RESIDUE,
    `cylinder ${cylFaces} faces, fused ${n} — clean ${CLEAN}, +${n - CLEAN} end residue (was +145 before the fix)`,
  );
  check(`phase ${a0}deg: and it all meshes`, unmeshed.length === 0, `${unmeshed.reduce((a, b) => a + b, 0)} unmeshed`);

  // The concave joint — where the extrusion's flat wall meets the cylinder's top
  // — must be ONE edge. The crescent ribbon used to shred it into as many as 49,
  // which is why a chamfer along it didn't meet the rim cleanly: there was no
  // single rim to meet.
  const joint = (fused?.edges ?? []).filter((e) => /\/\+z/.test(e) && /\/side\d/.test(e));
  check(
    `phase ${a0}deg: the joint is a single edge`,
    joint.length === 1,
    `${joint.length} edge(s) (up to 49 before the fix)`,
  );

  // Chamfering it is reported, not asserted: it fails with the same OCCT
  // ConstructionError before this change as after, on every phase including the
  // one that was already clean — so it is a pre-existing limit of chamfering
  // this profile, not something the faceting fix causes or is expected to cure.
  unmeshed.length = 0;
  const ch = await apply({ op: "dressUp", kind: "chamfer", targetId: cyl.createdId, edges: joint, size: "2" });
  await waitIdle();
  console.log(
    `  note: chamfer on the joint at phase ${a0}deg -> ${ch.ok ? "ok" : (ch.error ?? "failed").slice(0, 60)}` +
    ` (identical before the change), ${unmeshed.reduce((a, b) => a + b, 0)} unmeshed`,
  );
  if (a0 === phases[phases.length - 1]) {
    await apply({ op: "select", refs: [] });
    await page.waitForTimeout(500);
    await page.screenshot({ path: "/tmp/openpoly-canonical-facets.png" });
  }
}

// The count barely moves with phase now; before, it swung from 100 to 245.
const spread = Math.max(...counts.map((c) => c.n)) - Math.min(...counts.map((c) => c.n));
check(
  "the count barely moves with phase — discretisation no longer follows the drawing",
  spread <= END_RESIDUE,
  `spread ${spread} across ${JSON.stringify(counts)} (was 145 before the fix)`,
);

console.log(failures === 0 ? "=== ALL CHECKS PASSED ===" : `=== ${failures} CHECK(S) FAILED ===`);
await browser.close();
process.exit(failures === 0 ? 0 : 1);
