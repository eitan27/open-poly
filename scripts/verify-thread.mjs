// Thread feature end to end: a thread cut on a round face. Every profile cuts
// a rod (1 and 2 starts, either hand) with every face meshed; a partial thread
// starts at a rod's free end, not where it grows out of a block; a hole's
// thread matched to a rod's lets the rod through untouched (an oversized rod
// doesn't); and the dialog picks its face and a thread to match. Screenshots
// go to $SHOTS.
//
//   URL=http://localhost:5173/ SHOTS=… node scripts/verify-thread.mjs
import path from "node:path";
import { launch, openPoly, checker } from "./lib/harness.mjs";

const SHOTS = process.env.SHOTS;
if (!SHOTS) throw new Error("set SHOTS to a folder for the screenshots");
const { page, errors, close } = await launch({ deviceScaleFactor: 2 });
const op = openPoly(page);
const { check, done } = checker();
const unmeshed = [];
page.on("console", (m) => /UNMESHED|recovered \d+ dropped/.test(m.text()) && unmeshed.push(m.text()));
const shot = (name) => page.screenshot({ path: path.join(SHOTS, `thread-${name}.png`) });
const cyl = async (radius, height, z = 0, x = 0) =>
  (await op.applySettled({ op: "addPrimitive", kind: "cylinder", params: { radius, height, z, x } })).createdId;
const box = async (width, height) =>
  (await op.applySettled({ op: "addPrimitive", kind: "box", params: { width, depth: width, height } })).createdId;

// Every profile, on a free Ø12 rod.
await op.newDocument();
let i = 0;
for (const profile of ["printable", "iso", "trapezoid"])
  for (const [starts, leftHand] of [
    [1, false],
    [2, true],
  ]) {
    const rod = await cyl(6, 20, 0, i++ * 20);
    const t0 = Date.now();
    const r = await op.applySettled({
      op: "addThread",
      face: { bodyId: rod, faceName: `${rod}/f3` },
      profile,
      leftHand,
      params: { pitch: 2.5, starts },
    });
    const b = (await op.scene()).bodies.find((x) => x.id === rod);
    const label = `${profile}, ${starts} start${leftHand ? ", left-hand" : ""}`;
    check(`${label}: cuts the rod (${Date.now() - t0} ms)`, r.ok && !!b, JSON.stringify(r));
    if (b) {
      const w = b.bbox.max[1] - b.bbox.min[1];
      // Ø12 rod → a Ø12 thread, shrunk 2 × 0.15.
      check(`${label}: crest Ø11.7`, Math.abs(w - 11.7) < 0.1, String(w));
      check(`${label}: still 0 → 20`, Math.abs(b.bbox.min[2]) < 0.05 && Math.abs(b.bbox.max[2] - 20) < 0.05);
    }
  }
const f = (await op.features()).find((x) => x.type === "thread");
check("sized from the rod: Ø12", f?.params?.diameter === "12", JSON.stringify(f?.params));
check("every face meshed", unmeshed.length === 0, unmeshed.join("\n"));
check("no feature errors", (await op.featureErrors()).length === 0, JSON.stringify(await op.featureErrors()));
await op.apply({ op: "screenshot", view: "iso" }).catch(() => {});
await shot("rods");

// A partial thread starts at the rod's free end: a stud on a block, threaded
// 6 of its 15. A thin tube at the rod's surface (Ø11.9–13) misses the
// threaded top (turned down to Ø11.7) but meets the plain part below.
for (const [z, expectOverlap, where] of [
  [21, false, "top (threaded)"],
  [12, true, "bottom (plain)"],
]) {
  await op.newDocument();
  const blk = await box(30, 10);
  const stud = await cyl(6, 15, 10);
  const u = await op.applySettled({ op: "boolean", kind: "union", operands: [blk, stud] });
  const r = await op.applySettled({
    op: "addThread",
    face: { bodyId: u.createdId, faceName: `${stud}/f3` },
    params: { pitch: 2, length: 6 },
  });
  check(`stud on a block: threaded 6 (${where})`, r.ok, JSON.stringify(r));
  const outer = await cyl(6.5, 2, z);
  const inner = await cyl(5.95, 2, z);
  const tube = await op.applySettled({ op: "boolean", kind: "subtract", operands: [outer, inner] });
  const x = await op.applySettled({ op: "boolean", kind: "intersect", operands: [u.createdId, tube.createdId] });
  check(
    `stud: a tube at its ${where} ${expectOverlap ? "meets it" : "misses it"}`,
    x.ok === expectOverlap,
    JSON.stringify(x).slice(0, 160),
  );
  if (!expectOverlap) {
    await op.apply({ op: "delete", featureId: x.createdId }).catch(() => {});
    await op.settle();
    await op.apply({ op: "screenshot", view: "iso" }).catch(() => {});
    await shot("stud");
  }
}

// Fit: a plate with a Ø10.8 hole (a Ø12 × 2 printable thread's minor), the
// hole threaded to match a Ø12 rod standing flush with the plate's top — the
// two threads start at the same spot, so they're in phase.
for (const [diameter, expectOverlap] of [
  [12, false],
  [12.8, true],
]) {
  await op.newDocument();
  const plate = await box(30, 10);
  const bore = await cyl(5.4, 10);
  const p = (await op.applySettled({ op: "boolean", kind: "subtract", operands: [plate, bore] })).createdId;
  const rod = await cyl(6, 20, -10);
  const t0 = Date.now();
  const outside = await op.applySettled({
    op: "addThread",
    face: { bodyId: rod, faceName: `${rod}/f3` },
    params: { diameter, pitch: 2 },
  });
  check(`rod Ø${diameter}: cut (${Date.now() - t0} ms)`, outside.ok, JSON.stringify(outside));
  const t1 = Date.now();
  const inside = await op.applySettled({
    op: "addThread",
    face: { bodyId: p, faceName: `${bore}/f3` },
    match: outside.createdId,
    params: { diameter: 12 },
  });
  check(`hole: cut, matched (${Date.now() - t1} ms)`, inside.ok, JSON.stringify(inside));
  const hf = (await op.features()).find((x) => x.id === inside.createdId);
  check("hole: read as internal", hf?.side === "internal", JSON.stringify(hf));
  // (The oversized rod warns that a Ø12 rod is too thin for its thread.)
  check(
    "fit: no feature errors" + (expectOverlap ? "" : " or warnings"),
    (await op.featureErrors()).length === 0 && (expectOverlap || (!outside.warnings && !inside.warnings)),
    JSON.stringify(await op.featureErrors()) + JSON.stringify([outside.warnings, inside.warnings]),
  );
  const x = await op.applySettled({ op: "boolean", kind: "intersect", operands: [p, rod] });
  check(
    `rod Ø${diameter} in the matched hole: ${expectOverlap ? "overlaps" : "doesn't touch it"}`,
    x.ok === expectOverlap,
    JSON.stringify(x).slice(0, 160),
  );
  if (!expectOverlap) {
    await op.apply({ op: "delete", featureId: x.createdId }).catch(() => {});
    await op.settle();
    await op.apply({ op: "setSectionView", enabled: true, plane: { datum: "front" } }).catch(() => {});
    await op.settle();
    await shot("fit");
  }
}

// Too little material: a Ø10 hole for a Ø12 × 2 thread (minor Ø10.8) warns.
await op.newDocument();
{
  const plate = await box(30, 10);
  const bore = await cyl(5, 10);
  const p = (await op.applySettled({ op: "boolean", kind: "subtract", operands: [plate, bore] })).createdId;
  const r = await op.applySettled({
    op: "addThread",
    face: { bodyId: p, faceName: `${bore}/f3` },
    params: { diameter: 10, pitch: 2 },
  });
  check("thin thread in a wide hole: builds", r.ok, JSON.stringify(r));
  check("…and warns of short crests", /crests are/.test(JSON.stringify(r.warnings)), JSON.stringify(r.warnings));
}

// The dialog: J opens listening for a face; a click on the rod fills it.
await op.newDocument();
const rod = await cyl(6, 20);
await op.apply({ op: "screenshot", view: "front" }).catch(() => {});
await op.settle();
const canvas = page.locator(".viewport canvas").first();
await canvas.hover({ position: { x: 5, y: 5 } });
await page.keyboard.press("j");
const dialog = page.locator(".hole-dialog");
await dialog.waitFor({ timeout: 5000 });
check(
  "opens listening for the face",
  (await dialog.locator(".ed-pick-btn.active", { hasText: "rod's side" }).count()) === 1,
);
check("Create waits for a face", await dialog.locator(".ed-primary").isDisabled());
// The rod's middle, in the front view: the canvas centre.
const bb = await canvas.boundingBox();
await page.mouse.click(bb.x + bb.width / 2, bb.y + bb.height / 2);
await page.waitForTimeout(2500);
const row = dialog.locator(".bool-operand-row").first();
check("the face row names the rod", /Rod Ø12/.test((await row.textContent()) ?? ""), await row.textContent());
check(
  "the diameter is suggested from it",
  (await dialog.locator(".ed-field", { hasText: "Diameter" }).locator("input").inputValue()) === "12",
);
check("the dialog shows a diagram", (await dialog.locator("svg.dg").count()) === 1);
check(
  "Full length is on, so no Length field",
  (await dialog.locator(".ed-field", { hasText: /^Length/ }).count()) === 0,
);
await dialog.locator(".ed-field", { hasText: "Full length" }).locator("input").uncheck();
check("…off shows it", (await dialog.locator(".ed-field", { hasText: /^Length/ }).count()) === 1);
await dialog.locator(".ed-field", { hasText: "Full length" }).locator("input").check();
for (const p of ["ISO 60°", "Trapezoid", "Printable"]) {
  await dialog.locator("button", { hasText: p }).click();
  await page.waitForTimeout(500);
  await dialog.screenshot({ path: path.join(SHOTS, `thread-dialog-${p.split(" ")[0].toLowerCase()}.png`) });
}
await page.waitForTimeout(2500);
await shot("ghost");
await dialog.locator(".ed-primary").click();
await op.settle();
const made = (await op.features()).filter((x) => x.type === "thread");
check("Create adds a thread on the rod", made.length === 1 && made[0].face?.featureId === rod, JSON.stringify(made));
check(
  "no feature errors after Create",
  (await op.featureErrors()).length === 0,
  JSON.stringify(await op.featureErrors()),
);

// The fit check's intersect is meant to come back empty.
const real = errors.filter(
  (e) => !/Failed to load resource/.test(e) && !/"Intersect \d+".*empty result/.test(e) && !/502/.test(e),
);
check("no page errors", real.length === 0, real.join("\n"));
await close();
done();
