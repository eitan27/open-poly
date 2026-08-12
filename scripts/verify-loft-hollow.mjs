// Verification for hollowing a FREEFORM LOFT by subtracting an inner offset loft
// — the standard recipe when shell can't handle the geometry. This is the case
// that silently produced nothing: two near-tangent B-spline surfaces held a
// uniform ~2.4mm apart make BRepAlgoAPI return an EMPTY shape at some fuzzy
// values, and an empty cut passes the "nothing to subtract" volume guard (its
// volume is 0, which is < the base's), so it was accepted as a body.
//
// Sections are the real vertical-mouse profiles: one 10-point spline per station
// running base-right -> over the ridge -> base-left, closed by a base line.
import { chromium } from "playwright";

const URL = process.env.URL ?? "http://localhost:5173/";
const EXE = process.env.PW_EXE || "/opt/pw-browsers/chromium";
const browser = await chromium.launch({ executablePath: EXE });
const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
const page = await context.newPage();
page.on("pageerror", (e) => console.log(`[pageerror] ${e.message}`));

await page.goto(URL, { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => window.__openpoly, null, { timeout: 30000 });
const waitIdle = async () => {
  let stable = 0;
  for (let i = 0; i < 120; i++) {
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

// Outer stations, and the inner ring offset inward by `wall` (deliberately
// NON-uniform per station in the real model; uniform here is the harder case).
const OUTER = [
  [0.0,   [[16,0],[17.5,7],[16.5,16],[13,25],[7,31],[-3,34],[-11,29],[-16,20],[-18.5,8],[-16,0]]],
  [22.0,  [[24,0],[26,12],[26.5,28],[22,44],[12.5,57],[-5,63],[-15,59],[-23,48],[-27,25],[-24,0]]],
  [47.0,  [[26,0],[28,14],[28,33],[24,52],[13.5,68],[-6,74],[-17,70],[-26,60],[-29,30],[-26,0]]],
  [72.0,  [[25,0],[27,13],[27,31],[23,50],[12.5,64],[-7,71],[-18,67],[-27,57],[-28.5,28],[-25,0]]],
  [95.0,  [[21,0],[23,11],[23,26],[19,40],[10,51],[-6,57],[-15,54],[-21,46],[-24,22],[-21,0]]],
  [116.0, [[15,0],[16,7],[16,16],[13,25],[7,31],[-4,34],[-11,29],[-15,20],[-17,9],[-15,0]]],
];
const WALL = 2.4;

function offsetRing(ring, wall) {
  const n = ring.length;
  return ring.map(([x, z], i) => {
    const [px, pz] = i > 0 ? ring[i - 1] : ring[i];
    const [nx, nz] = i < n - 1 ? ring[i + 1] : ring[i];
    let ax = 0, az = 0;
    for (const [[sx, sz], [ex, ez]] of [[[px, pz], [x, z]], [[x, z], [nx, nz]]]) {
      const dx = ex - sx, dz = ez - sz, L = Math.hypot(dx, dz);
      if (L < 1e-9) continue;
      ax += -dz / L; az += dx / L;            // inward normal of a CCW ring
    }
    const L = Math.hypot(ax, az) || 1;
    const ox = x + (ax / L) * wall;
    const oz = Math.abs(z) < 1e-9 ? 0 : z + (az / L) * wall;
    return [Number(ox.toFixed(3)), Number(oz.toFixed(3))];
  });
}

const doc = await apply({ op: "newDocument", name: "verify-loft-hollow" });
check("scratch document created", doc.ok, JSON.stringify(doc).slice(0, 160));
await waitIdle();

async function buildLoft(name, rings, skirt) {
  const profiles = [];
  for (const [y, ring] of rings) {
    const plane = y === 0 ? { datum: "front" } : { planeId: (await apply({ op: "addPlane", method: "offset", base: { datum: "front" }, offset: y })).createdId };
    const xR = ring[0][0], xL = ring[ring.length - 1][0];
    const entities = [{ shape: "spline", points: ring }];
    if (skirt) {
      entities.push({ shape: "line", a: [xL, 0], b: [xL, -3] });
      entities.push({ shape: "line", a: [xL, -3], b: [xR, -3] });
      entities.push({ shape: "line", a: [xR, -3], b: [xR, 0] });
    } else {
      entities.push({ shape: "line", a: [xL, 0], b: [xR, 0] });
    }
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

const outerId = await buildLoft("Outer", OUTER, false);
const innerRings = OUTER.map(([y, ring], i) => [i === 0 ? 2.4 : i === OUTER.length - 1 ? 113.6 : y, offsetRing(ring, WALL)]);
const innerId = await buildLoft("Cavity", innerRings, true);

let scene = await read({ read: "sceneSummary" });
const outer = scene.bodies.find((b) => b.id === outerId);
const inner = scene.bodies.find((b) => b.id === innerId);
check("outer loft built", Boolean(outer), `faces=${outer?.faces.length}`);
check("cavity loft built", Boolean(inner), `faces=${inner?.faces.length}`);
check(
  "cavity is strictly inside the outer in x/z",
  inner && outer && inner.bbox.min[0] > outer.bbox.min[0] && inner.bbox.max[0] < outer.bbox.max[0] &&
    inner.bbox.max[2] < outer.bbox.max[2],
  `outer=${JSON.stringify(outer?.bbox)} inner=${JSON.stringify(inner?.bbox)}`,
);

// --- the operation that used to silently produce nothing ---
const cut = await apply({ op: "boolean", kind: "subtract", operands: [outerId, innerId] });
check("loft − loft subtract reports ok", cut.ok, JSON.stringify(cut).slice(0, 300));
await waitIdle();

scene = await read({ read: "sceneSummary" });
check("exactly one body survives", scene.bodies.length === 1, `bodies=${scene.bodies.length}`);
const hollow = scene.bodies[0];
check("result is NOT degenerate (has faces)", (hollow?.faces ?? []).length > 0, `faces=${hollow?.faces.length}`);
check(
  "result has roughly outer+inner faces (a real wall, not a passthrough)",
  hollow && hollow.faces.length > (outer?.faces.length ?? 0) * 1.5,
  `result=${hollow?.faces.length} outer=${outer?.faces.length}`,
);
check(
  "outer dimensions unchanged by hollowing",
  hollow && Math.abs(hollow.bbox.max[2] - (outer?.bbox.max[2] ?? 0)) < 1e-6 &&
    Math.abs(hollow.bbox.min[0] - (outer?.bbox.min[0] ?? 0)) < 1e-6,
  JSON.stringify(hollow?.bbox),
);
check("no feature errors", Object.keys(scene.errors ?? {}).length === 0, JSON.stringify(scene.errors));

// --- the guard itself: a truly non-overlapping subtract must still ERROR ---
const far = await apply({ op: "addPrimitive", kind: "box", params: { width: 5, depth: 5, height: 5 } });
await apply({ op: "transform", targetId: far.createdId, tx: 500, ty: 500, tz: 500 });
await waitIdle();
const bogus = await apply({ op: "boolean", kind: "subtract", operands: [scene.bodies[0].id, far.createdId] });
check("a genuinely disjoint subtract still reports an error", bogus.ok === false, JSON.stringify(bogus).slice(0, 220));

console.log(failures === 0 ? "\n=== ALL CHECKS PASSED ===" : `\n=== ${failures} CHECK(S) FAILED ===`);
await browser.close();
process.exit(failures === 0 ? 0 : 1);
