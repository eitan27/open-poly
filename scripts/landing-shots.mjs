// Generates landing-page hero PNGs by driving the app's dev-only window.__openpoly
// API to build each scene, hiding the datum planes for a clean model, then taking
// a FULL-PAGE screenshot at 2× (retina) — so the shots show the real app (toolbars,
// timeline panel, view controls) with the geometry. Outputs to landing/.
//
//   URL=http://localhost:5173/ node scripts/landing-shots.mjs
import { chromium } from "playwright";

const URL = process.env.URL ?? "http://localhost:5173/";
const BLUE = 0x0071e3; // Open Poly accent (favicon)
const RED = 0xe63950; // heart
const GRAY = 0xd8dae0; // gear (soft light gray, cohesive with the blue scheme)

// --- profile geometry -------------------------------------------------------
const loop = (pts) => pts.map((a, i) => ({ shape: "line", a, b: pts[(i + 1) % pts.length] }));

function heartEntities() {
  const S = 0.9,
    zc = 50,
    N = 48,
    pts = [];
  for (let i = 0; i < N; i++) {
    const t = (2 * Math.PI * i) / N;
    const x = 16 * Math.sin(t) ** 3;
    const y = 13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t);
    pts.push([+(S * x).toFixed(3), +(zc + S * y).toFixed(3)]);
  }
  return loop(pts);
}
function gearEntities() {
  const N = 18,
    ro = 44,
    rr = 35,
    p = (2 * Math.PI) / N,
    tipH = 0.18 * p,
    rootH = 0.3 * p,
    pts = [];
  const P = (r, a) => [+(r * Math.cos(a)).toFixed(3), +(r * Math.sin(a)).toFixed(3)];
  for (let i = 0; i < N; i++) {
    const a = i * p;
    pts.push(P(rr, a - rootH), P(ro, a - tipH), P(ro, a + tipH), P(rr, a + rootH));
  }
  return loop(pts);
}
// 5 lightening holes evenly on r=25, plus the central bore.
const cutCircles = () => {
  const holes = [];
  for (let i = 0; i < 5; i++) {
    const a = Math.PI / 2 + (i * 2 * Math.PI) / 5;
    holes.push({ shape: "circle", c: [+(25 * Math.cos(a)).toFixed(3), +(25 * Math.sin(a)).toFixed(3)], r: 6 });
  }
  return [{ shape: "circle", c: [0, 0], r: 9 }, ...holes];
};

// --- driver -----------------------------------------------------------------
const browser = await chromium.launch();

async function scene(name, build) {
  // A narrower CSS viewport makes the fixed-size app chrome occupy more of the
  // frame (the "browser zoom" effect); deviceScaleFactor 2 keeps it retina-crisp.
  const ctx = await browser.newContext({ viewport: { width: 1360, height: 860 }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.log(`[pageerror] ${e.message}`));
  await page.goto(URL, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => !!window.__openpoly, { timeout: 20000 });

  const apply = (op) => page.evaluate((o) => window.__openpoly.apply(o), op);
  const summary = () => page.evaluate(() => window.__openpoly.read({ read: "sceneSummary" }));
  const doc = () => page.evaluate(() => window.__openpoly.read({ read: "document" }));

  // Clear the seed document.
  const d = await doc();
  for (const f of [...d.features].reverse()) await apply({ op: "delete", featureId: f.id });

  await build({ apply, summary });

  // Hide the datum planes + origin for a clean render (keep the subtle grid).
  const eyes = page.locator(".datum-row .row-icon");
  for (let i = 0, n = await eyes.count(); i < n; i++) await eyes.nth(i).click();

  await page.getByRole("button", { name: "Iso", exact: true }).click();
  await page.waitForTimeout(700);

  // Full-page screenshot: the real app UI (toolbars, timeline panel, view
  // controls) framing the geometry — an app hero, not a bare model render.
  const out = `landing/${name}.png`;
  await page.screenshot({ path: out });
  console.log(`wrote ${out}`);
  await ctx.close();
}

await scene("hero-cube", async ({ apply }) => {
  const c = await apply({
    op: "addPrimitive",
    kind: "box",
    name: "Cube",
    params: { width: 40, depth: 40, height: 40 },
  });
  await apply({ op: "setAppearance", featureId: c.createdId, color: BLUE });
});

await scene("hero-heart", async ({ apply }) => {
  const c = await apply({
    op: "addPrimitive",
    kind: "box",
    name: "Cube",
    params: { width: 40, depth: 40, height: 40 },
  });
  await apply({ op: "setAppearance", featureId: c.createdId, color: BLUE });
  const s = await apply({
    op: "addSketch",
    plane: { datum: "front" },
    name: "HeartProfile",
    entities: heartEntities(),
  });
  const h = await apply({
    op: "addExtrude",
    profile: { sketchId: s.createdId },
    distance: 16,
    extent: "symmetric",
    mode: "new",
    name: "Heart",
  });
  // Color the originating body feature (a transform/boolean result inherits it
  // but doesn't own it), then spin the heart 45° about the vertical axis (its
  // centroid is on Z) so its face turns toward the iso camera.
  await apply({ op: "setAppearance", featureId: h.createdId, color: RED });
  await apply({ op: "transform", targetId: h.createdId, axis: "z", angle: 45 });
});

await scene("hero-gear", async ({ apply, summary }) => {
  const gs = await apply({ op: "addSketch", plane: { datum: "top" }, name: "GearProfile", entities: gearEntities() });
  const gear = await apply({
    op: "addExtrude",
    profile: { sketchId: gs.createdId },
    distance: 16,
    mode: "new",
    name: "Gear",
  });
  const hub = await apply({ op: "addPrimitive", kind: "cylinder", name: "Hub", params: { radius: 16, height: 24 } });
  const uni = await apply({ op: "boolean", kind: "union", operands: [gear.createdId, hub.createdId] });
  const cuts = await apply({ op: "addSketch", plane: { datum: "top" }, name: "Cuts", entities: cutCircles() });
  const sk = (await summary()).sketches.find((x) => x.id === cuts.createdId);
  let target = uni.createdId;
  for (const region of sk.regions) {
    const r = await apply({
      op: "addExtrude",
      profile: { sketchId: cuts.createdId, regionId: region.id },
      distance: 30,
      extent: "throughAll",
      mode: "remove",
      targetId: target,
    });
    target = r.createdId;
  }
  // A boolean union OWNS its color (unlike a transform, which inherits from its
  // source), and the later through-all removes inherit it — so set it on the
  // union feature.
  await apply({ op: "setAppearance", featureId: uni.createdId, color: GRAY });
});

await browser.close();
