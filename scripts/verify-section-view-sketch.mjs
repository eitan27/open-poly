// Verifies sketching on an interior face while section view is active — the
// workflow BACKLOG.md calls out explicitly ("sketching on an interior face is
// a real use"): the section must stay on through sketch entry/exit, a face
// exposed only by the cut must be pickable (clip-aware picking), and a sketch
// started there must draw and extrude normally.
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
};
const apply = (op) => page.evaluate((o) => window.__openpoly.apply(o), op);
const read = (q) => page.evaluate((o) => window.__openpoly.read(o), q);

let failures = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}: ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

await apply({ op: "newDocument" });
await waitIdle();
const canvas = await page.locator("canvas").first().boundingBox();
const toScreen = (w) => page.evaluate((p) => window.__openpoly.worldToScreen(p), w);
const clickWorld = async (w) => {
  const s = await toScreen(w);
  await page.mouse.click(canvas.x + s.x, canvas.y + s.y);
  await page.waitForTimeout(140);
};
const clickPx = async (x, y) => {
  await page.mouse.click(x, y);
  await page.waitForTimeout(140);
};

// --- Build a 40x40x20 box with a blind pocket cut into its +X face ---------
// The pocket floor (a real interior face, x=8) is what section view exposes:
// with the box solid, it's hidden behind 12mm of material from every normal
// exterior view.
const box = await apply({ op: "addPrimitive", kind: "box", params: { width: "40", depth: "40", height: "20" } });
await waitIdle();
// A dev-only bridge quirk occasionally double-applies one call, independent of
// section view — dedupe defensively so this script stays deterministic.
let doc = await read({ read: "document" });
const extraBoxes = doc.features.filter((f) => f.type === "primitive").slice(1);
for (const f of extraBoxes) await apply({ op: "delete", featureId: f.id });
await waitIdle();

const pocketSketch = await apply({
  op: "addSketch",
  plane: { bodyId: box.createdId, faceName: `${box.createdId}/+x` },
  entities: [{ shape: "rect", center: [8, 8], w: 8, h: 8 }],
});
await apply({
  op: "addExtrude",
  profile: { sketchId: pocketSketch.createdId },
  mode: "remove",
  extent: "blind",
  distance: 12,
  targetId: box.createdId,
});
await waitIdle();

await apply({ op: "setSectionView", enabled: true, plane: { datum: "front" }, offset: 0, flip: false });
await page.waitForTimeout(400);
// Look straight down -X (the pocket floor's own normal) rather than the
// default iso: from iso, the ray to a point behind the Front-plane cut also
// crosses the (large, always-present) Front datum quad, which — being
// nearer along that ray — would shadow the real face and get picked instead.
// Looking straight into the cut removes that ambiguity, and is also just how
// you'd naturally orbit to inspect a section in practice.
await read({ read: "screenshot", view: "right" });
await page.waitForTimeout(700);

const toggleActive = await page.locator(".section-view-toggle").evaluate((el) => el.classList.contains("active"));
check("section view is on before sketching", toggleActive);

// --- Pick the pocket floor, exposed by the cut, and start a sketch on it ---
const floorPoint = [8, 8, 8]; // center of the pocket floor (x = 20 − 12mm depth)
await page.click('.model-toolbar button[title^="Sketch"]');
await page.waitForTimeout(150);
await clickWorld(floorPoint);
await page.waitForTimeout(300);

const sketchToolbarVisible = (await page.locator(".sketch-toolbar").count()) > 0;
check("clicking the section-exposed pocket floor starts a sketch", sketchToolbarVisible);

doc = await read({ read: "document" });
// pocketSketch is the first sketch (on the box's +x face); the one just
// started by the click is whichever OTHER sketch feature now exists.
const sk = doc.features.find((f) => f.type === "sketch" && f.id !== pocketSketch.createdId);
check(
  "the new sketch landed on the pocket floor (x=8), not the outer face or a datum",
  sk?.plane?.kind === "face" && Math.abs(sk.plane.frame.origin[0] - 8) < 0.01,
  JSON.stringify(sk?.plane),
);

const toggleActiveInSketch = await page.locator(".section-view-toggle").evaluate((el) => el.classList.contains("active"));
check("section view stays on while a sketch is being edited", toggleActiveInSketch);
const panelVisible = (await page.locator(".section-view-panel").count()) > 0;
check("the section-view panel stays visible during sketch edit", panelVisible);

// --- Draw a circle on the picked face ---------------------------------------
// Inside the sketch, clicks raycast onto the (infinite) active sketch plane —
// no need to compute the face's own uv axes. Center near the pick point,
// radius point a modest pixel offset away.
await page.keyboard.press("c"); // circle (center + radius)
await page.waitForTimeout(150);
const center = await toScreen(floorPoint);
await clickPx(canvas.x + center.x, canvas.y + center.y);
await clickPx(canvas.x + center.x + 30, canvas.y + center.y);
await page.waitForTimeout(200);

doc = await read({ read: "document" });
const sketchNow = doc.features.find((f) => f.id === sk?.id);
const circleCount = (sketchNow?.entities ?? []).filter((e) => e.type === "circle").length;
check("a circle entity was drawn on the interior-face sketch", circleCount === 1, `circles: ${circleCount}`);

// --- Finish the sketch; section view must be untouched ----------------------
await page.locator(".sketch-banner button", { hasText: "Finish sketch" }).click();
await waitIdle();

const toggleActiveAfter = await page.locator(".section-view-toggle").evaluate((el) => el.classList.contains("active"));
check("section view is still on after finishing the sketch", toggleActiveAfter);
const offsetAfter = await page.inputValue(".section-view-offset").catch(() => null);
check("section-view offset is unchanged by the sketch (0.00)", offsetAfter === "0.00", `offset: ${offsetAfter}`);

// --- The interior-face sketch's region extrudes normally --------------------
doc = await read({ read: "document" });
const sketchFinal = doc.features.find((f) => f.id === sk?.id);
const circle = (sketchFinal?.entities ?? []).find((e) => e.type === "circle");
check("the drawn circle persisted after finishing the sketch", !!circle, JSON.stringify(sketchFinal?.entities));
if (sk && circle) {
  const ex = await apply({ op: "addExtrude", profile: { sketchId: sk.id }, mode: "add", distance: 5, extent: "blind" });
  await waitIdle();
  check("the interior-face sketch's region extrudes without error", ex.ok === true, JSON.stringify(ex));
  const summary = await read({ read: "sceneSummary" });
  check("no regen errors after extruding from the interior sketch", !summary?.errors || Object.keys(summary.errors).length === 0, JSON.stringify(summary?.errors));
}

await page.screenshot({ path: "/tmp/verify-section-view-sketch.png" });
console.log(failures === 0 ? "=== ALL CHECKS PASSED ===" : `=== ${failures} CHECK(S) FAILED ===`);
console.log("screenshot: /tmp/verify-section-view-sketch.png");
await browser.close();
process.exit(failures === 0 ? 0 : 1);
