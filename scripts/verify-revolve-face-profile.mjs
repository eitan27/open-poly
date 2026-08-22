// Revolve accepts a PLANAR BODY FACE as its profile, not just a sketch region
// (option "C": the face reference is stored like an extrude's, and the kernel
// turns it into a region from its exact wire via facetedProfileFace, deriving the
// profile plane from the face itself).
//
// Checks, against the real OCCT kernel:
//   1. agent op: revolve a box's side face about a datum plane → a real solid;
//   2. the result is associative — resizing the box re-revolves the new face;
//   3. a CURVED face (a cylinder's wall) is rejected with a clear error;
//   4. UI: arming the profile in the dialog takes a face click, and the picked
//      face shows in the dialog as "<body> · face".
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
const apply = (o) => page.evaluate((x) => window.__openpoly.apply(x), o);
const read = (q) => page.evaluate((x) => window.__openpoly.read(x), q);

let failures = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}: ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};
const bodyOf = (summary, name) => (summary.bodies ?? []).find((b) => b.name === name);
const errorsOf = (summary) => summary.errors ?? {};
const volumeish = (b) => {
  // The summary reports a bbox; its diagonal is enough to tell "a solid was
  // built" from "nothing" and to see a resize take effect.
  if (!b?.bbox) return 0;
  const [min, max] = [b.bbox.min ?? b.bbox[0], b.bbox.max ?? b.bbox[1]];
  return Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]);
};

await apply({ op: "newDocument" });
await waitIdle();

// --- 1. Revolve a box's planar side face about a datum plane -----------------
const box = await apply({ op: "addPrimitive", kind: "box", params: { width: 40, depth: 30, height: 20 } });
await waitIdle();
const boxId = box.createdId ?? box.id;
let summary = await read({ read: "sceneSummary" });
const faces = bodyOf(summary, "Box 1")?.faces ?? [];
// The +y side face: planar, and its plane isn't parallel to the Right datum, so
// the revolve actually sweeps.
const faceName = faces.find((f) => f.endsWith("/+y")) ?? faces[0];
const rev = await apply({
  op: "addRevolve",
  profile: { bodyId: boxId, faceName },
  axis: { plane: { datum: "right" } },
  angle: 90,
});
await waitIdle();
check("agent accepts a body-face profile", rev.ok !== false, JSON.stringify(rev).slice(0, 160));
let doc = await read({ read: "document" });
const revFeat = (doc.document ?? doc).features.find((f) => f.type === "revolve");
check("the revolve stores a bodyFace profile", revFeat?.profile?.kind === "bodyFace", JSON.stringify(revFeat?.profile));
summary = await read({ read: "sceneSummary" });
const revBody = bodyOf(summary, revFeat?.name ?? "Revolve 1");
const size0 = volumeish(revBody);
check("it built a real solid", size0 > 1, `bbox diagonal ${size0.toFixed(2)}`);
check(
  "no feature errors",
  Object.keys(errorsOf(summary)).length === 0,
  JSON.stringify(errorsOf(summary)).slice(0, 200),
);
await page.screenshot({ path: "/tmp/revolve-face-profile.png" });

// --- 2. Associativity: resize the box, the revolve follows -------------------
await apply({ op: "setParam", featureId: boxId, name: "height", value: "40" });
await waitIdle();
summary = await read({ read: "sceneSummary" });
const size1 = volumeish(bodyOf(summary, revFeat?.name ?? "Revolve 1"));
check("the revolve re-builds off the resized face", size1 > size0 + 0.5, `${size0.toFixed(2)} → ${size1.toFixed(2)}`);

// --- 3. A CURVED face is rejected -------------------------------------------
// A cylinder primitive's wall is a 96-gon of planar facets (see geom/circleFacets),
// so the genuinely curved surface to test with is a sphere's.
const sph = await apply({ op: "addPrimitive", kind: "sphere", params: { radius: 10 } });
await waitIdle();
const sphId = sph.createdId ?? sph.id;
summary = await read({ read: "sceneSummary" });
const sphFace = (bodyOf(summary, "Sphere 1")?.faces ?? [])[0];
const bad = await apply({
  op: "addRevolve",
  profile: { bodyId: sphId, faceName: sphFace },
  axis: { plane: { datum: "right" } },
  angle: 90,
});
await waitIdle();
const msg = JSON.stringify(bad);
check("a curved face profile is rejected", bad.ok === false, msg.slice(0, 120));
check("…with a message naming the planarity rule", /must be planar/i.test(msg), msg.slice(0, 220));
// Clean the failed feature away so the last section starts from a good doc.
if (bad.createdId) await apply({ op: "delete", featureId: bad.createdId });
await waitIdle();

// --- 4. UI: the dialog's profile arming takes a face click -------------------
await apply({ op: "newDocument" });
await waitIdle();
await apply({ op: "addPrimitive", kind: "box", params: { width: 400, depth: 300, height: 200 } });
await waitIdle();
await page.keyboard.press("h");
await page.waitForTimeout(800);
await page.evaluate(() => document.activeElement?.blur());
await apply({ op: "select", refs: [] });
await page.keyboard.press("r");
await page.waitForTimeout(400);
const dlg = page.locator(".extrude-dialog");
check(
  "the profile button is armed on open",
  (await dlg.locator(".ed-pick-btn").allTextContents())[0] === "Selecting a profile…",
  (await dlg.locator(".ed-pick-btn").allTextContents()).join(" | "),
);
const canvas = await page.locator("canvas").first().boundingBox();
const s = await page.evaluate((p) => window.__openpoly.worldToScreen(p), [40, 30, 100]);
await page.mouse.click(canvas.x + s.x, canvas.y + s.y);
await page.waitForTimeout(500);
const operands = await dlg.locator(".bool-operand-name").allTextContents();
check(
  "clicking a planar face fills the profile",
  operands.length === 1 && /· face$/.test(operands[0]),
  operands.join(" | ") || "none",
);
await page.screenshot({ path: "/tmp/revolve-face-armed.png" });

// …and the dialog can finish the job: arm the axis, pick the Right datum plane,
// Create. A face profile has no sketch to hide, which is the path createRevolve
// used to take unconditionally.
await dlg.locator(".ed-pick-btn").last().click();
await page.waitForTimeout(300);
// The +x side face: perpendicular to the profile's top face, so their planes
// actually meet in a line (a parallel face is rejected, by design).
const axisFacePt = await page.evaluate((p) => window.__openpoly.worldToScreen(p), [200, 0, 100]);
await page.mouse.click(canvas.x + axisFacePt.x, canvas.y + axisFacePt.y);
await page.waitForTimeout(500);
check(
  "axis armed from the viewport",
  (await dlg.locator(".bool-operand-name").allTextContents()).length === 2,
  (await dlg.locator(".bool-operand-name").allTextContents()).join(" | ") || "none",
);
await dlg.locator(".ed-primary").click();
await waitIdle();
const uiDoc = await read({ read: "document" });
const uiRev = (uiDoc.document ?? uiDoc).features.find((f) => f.type === "revolve");
check(
  "Create builds the revolve from the face",
  uiRev?.profile?.kind === "bodyFace",
  JSON.stringify(uiRev?.profile ?? null),
);
const uiSummary = await read({ read: "sceneSummary" });
check(
  "no errors after creating from a face",
  Object.keys(errorsOf(uiSummary)).length === 0,
  JSON.stringify(errorsOf(uiSummary)).slice(0, 200),
);
check(
  "a second body exists",
  (uiSummary.bodies ?? []).length === 2,
  (uiSummary.bodies ?? []).map((b) => b.name).join(", "),
);
await page.screenshot({ path: "/tmp/revolve-face-created.png" });

// --- 5. The sketch-region path still works (guards the profile refactor) -----
await apply({ op: "newDocument" });
await waitIdle();
const sk = await apply({
  op: "addSketch",
  plane: { datum: "front" },
  entities: [
    { shape: "rect", center: [20, 15], w: 10, h: 20 },
    { shape: "line", a: [0, -20], b: [0, 40], construction: true },
  ],
});
await waitIdle();
const skId = sk.createdId ?? sk.id;
const skDoc = await read({ read: "document" });
const axisEntity = (skDoc.document ?? skDoc).features.find((f) => f.id === skId).entities.find((e) => e.construction);
const regionRev = await apply({
  op: "addRevolve",
  profile: { sketchId: skId },
  axis: { sketchId: skId, entityId: axisEntity.id },
  angle: 360,
});
await waitIdle();
summary = await read({ read: "sceneSummary" });
check(
  "a sketch-region revolve still builds",
  regionRev.ok !== false && (summary.bodies ?? []).length === 1,
  JSON.stringify(regionRev).slice(0, 140),
);
check("…with no errors", Object.keys(errorsOf(summary)).length === 0, JSON.stringify(errorsOf(summary)).slice(0, 200));
const regionDoc = await read({ read: "document" });
const regionFeat = (regionDoc.document ?? regionDoc).features.find((f) => f.type === "revolve");
check(
  "…and stores a sketchRegion profile",
  regionFeat?.profile?.kind === "sketchRegion",
  JSON.stringify(regionFeat?.profile ?? null),
);

console.log(failures ? `\n${failures} FAILED` : "\nAll checks passed");
await browser.close();
process.exit(failures ? 1 : 0);
