// Shell on a FREEFORM LOFTED solid — the geometry class Shell is worst at.
//
// A box or cylinder is a handful of analytic faces; a loft through spline
// sections tessellates into ~100+ B-spline patches, and offsetting every one of
// them inward is where BRepOffsetAPI gives up. This matters more since sealed
// shells started going through MakeOffsetShape + a boolean cut: that path is
// exactly the outer−inner subtract that verify-loft-hollow.mjs showed can come
// back EMPTY on near-tangent spline pairs.
//
// Shell now HAS a path for this geometry: when the offset fails and the target
// is still the loft itself, it insets the loft's own sections in 2D and re-lofts
// them into the cavity to subtract (shellLoftSections). So the bar here is
// higher than it was — the loft is expected to hollow, not merely to fail
// honestly — but the old invariant still holds underneath it: the result is
// never a SILENT no-op. Either a genuinely hollowed body, or ok:false with
// actionable copy. An un-hollowed body reported as success is the failure mode
// this guards, and the one Shell actually shipped with.
//
// Named faces cannot prove any of that (sceneSummary lists names, not counts,
// and a cavity has no name-level signature), so hollowness and openings are
// tested by BOOLEAN PROBE: intersect the body with a small box parked in a
// region whose contents we can predict, and read off whether anything came
// back. An empty boolean leaves both operands standing and flags the feature,
// so "one body" means the probed region was material and "two bodies" means it
// was air. That distinguishes a cavity from a solid, which nothing else here
// can do.
//
// Run: `npm run dev`, then `URL=http://localhost:5174/ node scripts/verify-shell-loft.mjs`.
import { chromium } from "playwright";

const URL = process.env.URL ?? "http://localhost:5173/";
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
const page = await context.newPage();
page.on("pageerror", (e) => console.log(`[pageerror] ${e.message}`));

await page.goto(URL, { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => window.__openpoly, null, { timeout: 30000 });
const waitIdle = async () => {
  let stable = 0;
  let last = "";
  // Shelling a loft is slower than a box, so this waits longer than the other
  // harnesses (2 min) and reports what it was stuck on if it times out.
  for (let i = 0; i < 240; i++) {
    const s = (await page.locator(".status").textContent())?.trim() ?? "";
    if (s !== last) {
      console.log(`   [status] ${s}`);
      last = s;
    }
    // "N error(s)" is a SETTLED state too, not a stall: this harness exercises
    // shells that are expected to be refused, and waiting only for "up to date"
    // would spin out the timeout on exactly the cases under test.
    stable = /up to date|error/i.test(s) ? stable + 1 : 0;
    if (stable >= 3) return;
    await page.waitForTimeout(500);
  }
  throw new Error(`app never settled (last status: ${last})`);
};
await waitIdle();

const apply = (op) => page.evaluate((o) => window.__openpoly.apply(o), op);
const read = (q) => page.evaluate((o) => window.__openpoly.read(o), q);

let failures = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}: ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

// Deliberately irregular — no two sections are similar, and every wall is a
// spline, so the lofted surface has no analytic shortcut. Kept deliberately
// SMALL (3 sections of 5 points, not the 6×10 of the real mouse-shell model):
// this is a Shell test, not a loft stress test, and a 147-face loft turns each
// shell attempt into minutes of OCCT work.
const STATIONS = [
  [
    0.0,
    [
      [10, 0],
      [11, 6],
      [4, 12],
      [-6, 9],
      [-10, 0],
    ],
  ],
  [
    18.0,
    [
      [16, 0],
      [18, 10],
      [6, 20],
      [-10, 15],
      [-16, 0],
    ],
  ],
  [
    36.0,
    [
      [9, 0],
      [10, 5],
      [3, 11],
      [-7, 8],
      [-9, 0],
    ],
  ],
];
const WALL = 1.5;

const doc = await apply({ op: "newDocument", name: "verify-shell-loft" });
check("scratch document created", doc.ok, JSON.stringify(doc).slice(0, 160));
await waitIdle();

async function buildLoft(name, rings) {
  const profiles = [];
  for (const [y, ring] of rings) {
    const plane =
      y === 0
        ? { datum: "front" }
        : {
            planeId: (await apply({ op: "addPlane", method: "offset", base: { datum: "front" }, offset: y })).createdId,
          };
    const xR = ring[0][0];
    const xL = ring[ring.length - 1][0];
    const entities = [
      { shape: "spline", points: ring },
      { shape: "line", a: [xL, 0], b: [xR, 0] },
    ];
    const sk = await apply({ op: "addSketch", plane, entities, name: `${name}-${y}` });
    const scene = await read({ read: "sceneSummary" });
    const s = scene.sketches.find((q) => q.id === sk.createdId);
    if (!s || s.regions.length !== 1) throw new Error(`${name}@${y}: expected 1 region, got ${s?.regions.length}`);
    profiles.push({ sketchId: sk.createdId, regionId: s.regions[0].id });
  }
  const loft = await apply({ op: "addLoft", profiles, name });
  if (!loft.ok) throw new Error(`${name} loft failed: ${JSON.stringify(loft)}`);
  await waitIdle();
  return loft.createdId;
}

const loftId = await buildLoft("Hull", STATIONS);
let scene = await read({ read: "sceneSummary" });
const loft = scene.bodies.find((b) => b.id === loftId);
check("irregular loft built", Boolean(loft), `faces=${loft?.faces.length}`);
check(
  "…and it really is freeform (spline patches, not a handful of analytic faces)",
  (loft?.faces.length ?? 0) > 6,
  `faces=${loft?.faces.length}`,
);
const loftBBox = loft.bbox;
const loftFaceCount = loft.faces.length;

/** Shell `targetId` and classify the outcome: built / refused.
 *
 *  NOTE on what's observable: sceneSummary lists only NAMED faces, so the face
 *  count here can neither prove nor disprove a cavity. Hollowness is the
 *  KERNEL's job to verify, and it now does so by VOLUME (isHollowedSolid) —
 *  ByJoin on a loft returns a one-face-larger, zero-volume solid that the old
 *  face-count test waved through. So `ok` means really hollowed, and these
 *  checks cover what that guard can't see: identity, outer size, error copy. */
async function shellAndClassify(targetId, faces, thickness) {
  const res = await apply({ op: "shell", targetId, faces, thickness });
  await waitIdle();
  const after = (await read({ read: "sceneSummary" })).bodies.find((b) => b.id === targetId);
  return { kind: res.ok ? "built" : "refused", error: res.error ?? "", after };
}

/** Is the region occupied by a 2×2×`h` box at (0, 18, `tz`) MATERIAL in `bodyId`?
 *
 *  Intersects the body with that box and reads the outcome from the body COUNT,
 *  relative to what the document held before: an intersect that finds material
 *  consumes both operands and leaves one result in their place (count
 *  unchanged), while an empty one is refused and leaves both standing (count up
 *  by the probe box). CONSUMES `bodyId` when it hits material, so give each
 *  probe a body of its own. */
async function probeIsMaterial(bodyId, tz, h, tx = 0, ty = 18) {
  const before = (await read({ read: "sceneSummary" })).bodies.length;
  const box = await apply({ op: "addPrimitive", kind: "box", params: { width: 2, depth: 2, height: h } });
  await apply({ op: "transform", targetId: box.createdId, tx, ty, tz });
  await waitIdle();
  await apply({ op: "boolean", kind: "intersect", operands: [bodyId, box.createdId] });
  await waitIdle();
  const after = (await read({ read: "sceneSummary" })).bodies.length;
  if (after !== before && after !== before + 1) throw new Error(`probe: unreadable body count ${before} → ${after}`);
  return after === before;
}

// --- 1. Sealed shell of the loft (the tool's default path) -----------------
const sealed = await shellAndClassify(loftId, [], WALL);
console.log(`   sealed outcome: ${sealed.kind}${sealed.error ? ` — ${sealed.error.slice(0, 120)}` : ""}`);
check("a sealed shell of a freeform loft BUILDS", sealed.kind === "built", sealed.error.slice(0, 200));
if (sealed.kind === "refused") {
  check(
    "…and when refused it says so in actionable copy, not a raw OCCT exception",
    /thinner wall|subtracting an inner body/.test(sealed.error) && !/exception \d+/.test(sealed.error),
    sealed.error.slice(0, 200),
  );
} else {
  check(
    "a sealed loft shell names its inner faces '<face>/in'",
    (sealed.after?.faces ?? []).some((f) => f.endsWith("/in")),
    JSON.stringify(sealed.after?.faces?.slice(0, 4)),
  );
  check(
    "…leaving the outer size untouched (the wall grows inward)",
    Math.abs(sealed.after.bbox.max[2] - loftBBox.max[2]) < 1e-6 &&
      Math.abs(sealed.after.bbox.min[0] - loftBBox.min[0]) < 1e-6 &&
      Math.abs(sealed.after.bbox.max[1] - loftBBox.max[1]) < 1e-6,
    `before=${JSON.stringify(loftBBox)} after=${JSON.stringify(sealed.after.bbox)}`,
  );
}
check(
  "the body survives either way — a failed shell must not consume it",
  Boolean(sealed.after),
  JSON.stringify(sealed.after?.id),
);

// The check the name list can't make: the middle of the body is now AIR. This
// is what "hollow" means, and the whole point of the feature — the loft was
// solid there a moment ago, which case 4 confirms on an unshelled twin.
if (sealed.kind === "built") {
  check(
    "…and the inside really is a cavity — a probe in the middle of it hits air",
    (await probeIsMaterial(loftId, 6, 2)) === false,
    "probe at (0, 18, 6…8)",
  );
}

// --- 2. Open a face of the loft --------------------------------------------
// Fresh loft, so this is judged independently of whatever case 1 did.
const loft2Id = await buildLoft("Hull2", STATIONS);
scene = await read({ read: "sceneSummary" });
const loft2 = scene.bodies.find((b) => b.id === loft2Id);
// The flat base laid down by each section's closing line. `loftBody` names one
// side face per edge of the FIRST section's outline, in outline order, and the
// region walk starts on the spline — so the closing line is the LAST edge, and
// its face is the last `side{i}`. Nothing rides on that derivation being right:
// case 3 opens this face and case 4 leaves it sealed, and only the true base
// face makes both of those come out the way they're asserted to.
const sideCount = loft2.faces.filter((f) => /\/side\d+$/.test(f)).length;
const baseFace = `${loft2Id}/side${sideCount - 1}`;
check("picked the loft's flat base to open", loft2.faces.includes(baseFace), `${sideCount} side faces, ${baseFace}`);

const opened = await shellAndClassify(loft2Id, [baseFace], WALL);
console.log(`   opened outcome: ${opened.kind}${opened.error ? ` — ${opened.error.slice(0, 120)}` : ""}`);
if (opened.kind === "refused") {
  check(
    "…and it too refuses in actionable copy",
    /thinner wall|subtracting an inner body|re-pick/.test(opened.error) && !/exception \d+/.test(opened.error),
    opened.error.slice(0, 200),
  );
} else {
  // The opened face's NAME survives here, and should. This path doesn't delete
  // the face the way MakeThickSolidByJoin does — it cuts a cavity through it,
  // so what's left is the same face trimmed back to the rim around the opening,
  // and keeping its name keeps every downstream reference to it working. The
  // opening itself is proved by the probe in case 3, not by a missing name.
  check(
    "…and the opened face survives as the rim around the opening, name intact",
    opened.after.faces.includes(baseFace),
    `${opened.after.faces.length} faces remain`,
  );
  check(
    "…and every surviving outer face kept its identity",
    opened.after.faces.every((f) => f.startsWith(loft2Id)),
    JSON.stringify(opened.after.faces.slice(0, 3)),
  );
  // If it builds at all the cavity must be nameable: an inner wall with no
  // "<face>/in" names can't be referenced by any later feature.
  check(
    "an opened-face loft shell names its inner faces '<face>/in'",
    opened.after.faces.some((f) => f.endsWith("/in")),
    `${opened.after.faces.length} named faces`,
  );
  check(
    "…and the outer size is untouched",
    Math.abs(opened.after.bbox.max[2] - loftBBox.max[2]) < 1e-6 &&
      Math.abs(opened.after.bbox.min[0] - loftBBox.min[0]) < 1e-6,
    `before=${JSON.stringify(loftBBox)} after=${JSON.stringify(opened.after.bbox)}`,
  );
}

// --- 3. The opening is real: the wall behind the base face is gone ---------
if (opened.kind === "built") {
  check(
    "opening the base face cuts the cavity through it — the bottom wall is air",
    (await probeIsMaterial(loft2Id, 0, 1)) === false,
    "probe at (0, 18, 0…1)",
  );
}

// --- 4. Whatever happened, the document is still coherent ------------------
scene = await read({ read: "sceneSummary" });
// Errors are EXPECTED here, and they are the point rather than a smell: every
// probe that correctly found air left its intersect flagged as an empty
// boolean. A refused shell would show up here too, in its own actionable copy.
// What must not appear is a crash, or an error on anything but those.
const errs = Object.values(scene.errors ?? {});
check(
  "any feature left in error carries actionable copy, not a crash",
  errs.every((e) => /thinner wall|subtracting an inner body|re-pick|empty result/.test(String(e))),
  JSON.stringify(scene.errors),
);
check("nothing errored but the probes that found air", errs.length <= 4, `${errs.length} features in error`);
check(
  "no body came back with zero faces",
  scene.bodies.every((b) => b.faces.length > 0),
  JSON.stringify(scene.bodies.map((b) => [b.name, b.faces.length])),
);

// --- 5. The controls, so case 1 and case 3 mean something ------------------
// The same probes on bodies that must read the OTHER way round: a sealed shell
// keeps its bottom wall, and an unshelled loft is solid right through. Run in a
// FRESH document — four shelled 300-face lofts plus their probes in one
// timeline regenerates slower than this harness is willing to wait, and these
// two cases share nothing with the ones above anyway.
await apply({ op: "newDocument", name: "verify-shell-loft-controls" });
await waitIdle();
const loft3Id = await buildLoft("Hull3", STATIONS);
const sealed3 = await shellAndClassify(loft3Id, [], WALL);
check("the control's sealed shell builds too", sealed3.kind === "built", sealed3.error.slice(0, 160));
if (sealed3.kind === "built") {
  check(
    "…and a SEALED shell of the same loft KEEPS that bottom wall",
    (await probeIsMaterial(loft3Id, 0, 1)) === true,
    "probe at (0, 18, 0…1)",
  );
}
const loft4Id = await buildLoft("Hull4", STATIONS);
check(
  "…and the unshelled loft is solid where the cavity later is — the probe works",
  (await probeIsMaterial(loft4Id, 6, 2)) === true,
  "probe at (0, 18, 6…8)",
);

// --- 6. A loft between DIFFERENT profiles, with a side face opened ----------
// The case that shipped broken: a side face is named for an edge of the FIRST
// section, and that index means nothing on a section with a different point
// count — so every such loft refused every side pick, and the tool looked like
// it ignored the face. Worse, `ThruSections` names none of these faces
// `side{i}` at all (their history is lost, so they come out `f{n}`), which the
// name-matching refused a second time over. Both are traced geometrically now.
//
// `ok` is a strong claim here: the kernel refuses an opening that the wall
// closes back over, so a side-face shell that builds really did open something.
await apply({ op: "newDocument", name: "verify-shell-loft-mismatched" });
await waitIdle();
const square = [
  [-15, -15],
  [15, -15],
  [15, 15],
  [-15, 15],
];
const hexagon = Array.from({ length: 6 }, (_, i) => {
  const t = (i * 2 * Math.PI) / 6;
  return [18 * Math.cos(t), 18 * Math.sin(t)];
});
const section = async (plane, pts, name) => {
  const entities = pts.map((a, i) => ({ shape: "line", a, b: pts[(i + 1) % pts.length] }));
  const sk = await apply({ op: "addSketch", plane, entities, name });
  const s = (await read({ read: "sceneSummary" })).sketches.find((q) => q.id === sk.createdId);
  return { sketchId: sk.createdId, regionId: s.regions[0].id };
};
const base = await section({ datum: "top" }, square, "Square");
const lid = await section(
  { planeId: (await apply({ op: "addPlane", method: "offset", base: { datum: "top" }, offset: 30 })).createdId },
  hexagon,
  "Hexagon",
);
const mixed = await apply({ op: "addLoft", profiles: [base, lid], name: "Mixed" });
check("a loft between a square and a hexagon builds", mixed.ok, JSON.stringify(mixed).slice(0, 140));
await waitIdle();
const mixedBody = (await read({ read: "sceneSummary" })).bodies.find((b) => b.id === mixed.createdId);
const wall = (mixedBody?.faces ?? []).find((f) => !/\/(start|end)$/.test(f));
check("…with side faces the loft couldn't name from history", /\/f\d+$/.test(String(wall)), String(wall));
const mixedShell = await apply({ op: "shell", targetId: mixed.createdId, faces: [wall], thickness: 2 });
await waitIdle();
const mixedAfter = (await read({ read: "sceneSummary" })).bodies.find((b) => b.id === mixed.createdId);
check(
  "opening one of them hollows the body instead of refusing the pick",
  mixedShell.ok,
  (mixedShell.error ?? "").slice(0, 200),
);
check(
  "…and the cavity it cut is nameable",
  (mixedAfter?.faces ?? []).some((f) => f.endsWith("/in")),
  `${(mixedAfter?.faces ?? []).filter((f) => f.endsWith("/in")).length} inner faces`,
);

// --- 7. A loft between two SQUARES, with one side opened -------------------
// The plainest shape this feature has to hollow, and the one whose side walls a
// user most obviously expects to open: four points a section means each side of
// the loft is ONE face, not a run of tessellation slivers, so each is
// individually openable. `side0` is generated by edge 0 of the FIRST section —
// its bottom edge — so it is the −y wall, and opening it must breach that wall
// and no other. The 2D half of this is unit-tested in geom/loftInset.test.ts;
// what only the kernel can answer is whether the cavity really cuts through.
const SQUARE_WALL = 2;
const squareSection = (half) => [
  [-half, -half],
  [half, -half],
  [half, half],
  [-half, half],
];
async function buildSquareLoft(name) {
  const section = async (plane, pts, label) => {
    const entities = pts.map((a, i) => ({ shape: "line", a, b: pts[(i + 1) % pts.length] }));
    const sk = await apply({ op: "addSketch", plane, entities, name: label });
    const found = (await read({ read: "sceneSummary" })).sketches.find((q) => q.id === sk.createdId);
    return { sketchId: sk.createdId, regionId: found.regions[0].id };
  };
  const bottom = await section({ datum: "top" }, squareSection(15), `${name}-lo`);
  const top = await section(
    { planeId: (await apply({ op: "addPlane", method: "offset", base: { datum: "top" }, offset: 30 })).createdId },
    squareSection(10),
    `${name}-hi`,
  );
  const built = await apply({ op: "addLoft", profiles: [bottom, top], name });
  await waitIdle();
  return built.createdId;
}

await apply({ op: "newDocument", name: "verify-shell-loft-squares" });
await waitIdle();
const sqId = await buildSquareLoft("Tapered");
const sqBody = (await read({ read: "sceneSummary" })).bodies.find((b) => b.id === sqId);
check(
  "a loft between two squares names all four of its sides",
  ["side0", "side1", "side2", "side3", "start", "end"].every((n) => sqBody?.faces.includes(`${sqId}/${n}`)),
  JSON.stringify((sqBody?.faces ?? []).map((f) => f.split("/").pop())),
);
const sqShell = await apply({ op: "shell", targetId: sqId, faces: [`${sqId}/side0`], thickness: SQUARE_WALL });
await waitIdle();
const sqAfter = (await read({ read: "sceneSummary" })).bodies.find((b) => b.id === sqId);
check("…and opening one of them builds", sqShell.ok, (sqShell.error ?? "").slice(0, 200));
check(
  "…leaving three inner walls and two capped ends nameable",
  (sqAfter?.faces ?? []).filter((f) => f.endsWith("/in")).length === 5,
  JSON.stringify((sqAfter?.faces ?? []).filter((f) => f.endsWith("/in")).map((f) => f.split("/").slice(1).join("/"))),
);

// Each probe consumes its body, so every wall gets a loft of its own. The
// tapered sides slope inward, so sample low, where the section is still wide.
for (const [tx, ty, tag] of [
  [0, -14, "-y"],
  [0, 14, "+y"],
  [-14, 0, "-x"],
  [14, 0, "+x"],
]) {
  await apply({ op: "newDocument", name: `verify-shell-loft-squares-${tag}` });
  await waitIdle();
  const probeId = await buildSquareLoft("Tapered");
  await apply({ op: "shell", targetId: probeId, faces: [`${probeId}/side0`], thickness: SQUARE_WALL });
  await waitIdle();
  const material = await probeIsMaterial(probeId, 3, 3, tx, ty);
  check(
    `opening side0 breaches the ${tag} wall and no other — ${tag} is ${material ? "material" : "air"}`,
    material === (tag !== "-y"),
    `probe at (${tx}, ${ty}, 3…6)`,
  );
}

await page.screenshot({ path: "/tmp/openpoly-shell-loft.png" });
console.log(failures === 0 ? "=== ALL CHECKS PASSED ===" : `=== ${failures} CHECK(S) FAILED ===`);
console.log("screenshot: /tmp/openpoly-shell-loft.png");
await browser.close();
process.exit(failures === 0 ? 0 : 1);
