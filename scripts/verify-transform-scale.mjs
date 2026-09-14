// Transform · Scale tab:
//  • the dialog offers Move / Rotate / Scale, and each shows its own fields;
//  • typing a factor scales the body uniformly about its centre (bbox extents
//    scale, centre stays put);
//  • the factor round-trips into the timeline's parameter editor;
//  • a non-positive factor is rejected rather than collapsing the body.
import { launch, openPoly } from "./lib/harness.mjs";

const { page, close } = await launch({ deviceScaleFactor: 2, collectErrors: false });
const { waitIdle, apply, read } = openPoly(page);
await waitIdle();
let failures = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}: ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};
const near = (a, b, eps = 0.05) => Math.abs(a - b) <= eps;
const dialog = page.locator(".extrude-dialog");
const row = (label) => page.locator(".tree-row", { hasText: label }).first();
const size = (b) => [b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]];
const centre = (b) => [0, 1, 2].map((i) => (b.min[i] + b.max[i]) / 2);
const bodyBox = async () => (await read({ read: "sceneSummary" })).bodies[0].bbox;

await apply({ op: "newDocument" });
await waitIdle();
const box = await apply({ op: "addPrimitive", kind: "box", params: { width: 40, depth: 30, height: 20 } });
await waitIdle();
const before = await bodyBox();
check(
  "box built",
  near(size(before)[0], 40) && near(size(before)[1], 30) && near(size(before)[2], 20),
  String(size(before)),
);

// Open the gizmo dialog on a transform of that box.
await apply({ op: "transform", targetId: box.id ?? box.createdId });
await waitIdle();
await row("Transform").dblclick();
await page.waitForTimeout(500);

const modes = await dialog.locator(".ed-modes").first().locator("button").allTextContents();
check("dialog offers Move / Rotate / Scale", modes.join(",") === "Move,Rotate,Scale", modes.join(","));

const fieldLabels = async () => (await dialog.locator(".ed-field > span").allTextContents()).join(",");
check(
  "Move tab shows the three translations",
  (await fieldLabels()).startsWith("Move X,Move Y,Move Z"),
  await fieldLabels(),
);
await dialog.locator("button", { hasText: "Rotate" }).first().click();
check(
  "Rotate tab shows the along-axis picker + angle",
  (await fieldLabels()).startsWith("Along,Angle°"),
  await fieldLabels(),
);
await dialog.locator("button", { hasText: "Scale" }).first().click();
check("Scale tab shows a single factor", (await fieldLabels()).startsWith("Factor"), await fieldLabels());

// Type a factor of 2: every extent doubles, the centre stays put.
const factor = dialog.locator(".ed-field", { hasText: "Factor" }).locator("input");
await factor.fill("2");
await waitIdle();
const scaled = await bodyBox();
check(
  "factor 2 doubles every extent",
  size(scaled).every((v, i) => near(v, size(before)[i] * 2)),
  `${size(before)} -> ${size(scaled)}`,
);
check(
  "the body scales about its own centre",
  centre(scaled).every((v, i) => near(v, centre(before)[i], 0.6)),
  `${centre(before)} -> ${centre(scaled)}`,
);

// A non-positive factor is refused (the body is left as it was, with an error).
await factor.fill("0");
await page.waitForTimeout(800);
const zeroed = await bodyBox();
check(
  "factor 0 leaves the body alone instead of collapsing it",
  size(zeroed).every((v) => v > 1),
  String(size(zeroed)),
);
await factor.fill("1.5");
await waitIdle();
await dialog.locator("button", { hasText: "Done" }).first().click();
await page.waitForTimeout(400);

// The committed factor shows up in the timeline's parameter editor.
await row("Transform").dblclick();
await page.waitForTimeout(400);
await dialog.locator("button", { hasText: "Scale" }).first().click();
const committed = await dialog.locator(".ed-field", { hasText: "Factor" }).locator("input").inputValue();
check("the factor is kept after Done", committed === "1.5", committed);
await page.keyboard.press("Escape");
await waitIdle();
const reverted = await bodyBox();
check("Escape reverts the re-edit to the committed 1.5", near(size(reverted)[0], 60), String(size(reverted)));

// The scale gizmo offers ONE handle (the uniform box at the centre) and dragging
// it can never produce a non-finite factor — three derives a uniform scale as
// |pointEnd| / |pointStart|, both measured from that very centre, so an
// unconditioned press there divides 0/0 and a near-centre one explodes.
await row("Transform").dblclick();
await page.waitForTimeout(500);
await dialog.locator("button", { hasText: "Scale" }).first().click();
await page.waitForTimeout(300);
const fac = dialog.locator(".ed-field", { hasText: "Factor" }).locator("input");
// A drag that MISSES every grip orbits the camera, which moves the gizmo. So the
// view goes back to iso+fit before each drag, making every sample independent.
const home = page.locator('button[title^="Home"]');
const resetView = async () => {
  await home.click();
  await page.waitForTimeout(350);
};
const dragFrom = async (x, y, dx, dy) => {
  await fac.fill("1");
  await waitIdle();
  await resetView();
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx, y + dy, { steps: 6 });
  const during = await fac.inputValue();
  await page.mouse.up();
  await page.waitForTimeout(300);
  return { during, after: await fac.inputValue() };
};

// The grips are found by HOVERING, not by dragging: the gizmo sets a "grab"
// cursor over a grip, so a miss can't orbit the view out from under the next
// sample. The whole grid is swept INSIDE the page — one round trip for ~26k
// points (~200ms) instead of one per point (which took minutes).
await fac.fill("1");
await waitIdle();
await resetView();
const hits = await page.evaluate(() => {
  const canvas = document.querySelector("canvas");
  const out = [];
  for (let x = 420; x <= 1620; x += 6) {
    for (let y = 110; y <= 900; y += 6) {
      canvas.dispatchEvent(new PointerEvent("pointermove", { clientX: x, clientY: y, bubbles: true }));
      if (canvas.style.cursor === "grab") out.push([x, y]);
    }
  }
  return out;
});
const clusters = [];
for (const [x, y] of hits) {
  const c = clusters.find((k) => Math.hypot(k.x - x, k.y - y) < 30);
  if (c) {
    c.n++;
    c.x = (c.x * (c.n - 1) + x) / c.n;
    c.y = (c.y * (c.n - 1) + y) / c.n;
  } else clusters.push({ x, y, n: 1 });
}
const spanX = Math.max(...clusters.map((c) => c.x)) - Math.min(...clusters.map((c) => c.x));
const spanY = Math.max(...clusters.map((c) => c.y)) - Math.min(...clusters.map((c) => c.y));
// A box gizmo puts a grip on each corner of the body's bounds: several grips,
// spread right across the body — not one handle parked on the pivot.
// A box gizmo puts a grip on each corner of the body's bounds: eight of them,
// spread right across the body — not one handle parked on the pivot.
check(
  "a grip sits on each of the eight corners of the body's bounds",
  clusters.length === 8 && spanX > 150 && spanY > 150,
  `${clusters.length} grips, span ${Math.round(spanX)}x${Math.round(spanY)}px`,
);

// Drag the outermost grip along the line from the body's centre through it:
// outward grows, back inward shrinks.
const mid = {
  x: clusters.reduce((a, c) => a + c.x, 0) / clusters.length,
  y: clusters.reduce((a, c) => a + c.y, 0) / clusters.length,
};
const far = clusters.reduce((a, c) =>
  Math.hypot(c.x - mid.x, c.y - mid.y) > Math.hypot(a.x - mid.x, a.y - mid.y) ? c : a,
);
const len = Math.hypot(far.x - mid.x, far.y - mid.y);
const unit = { x: (far.x - mid.x) / len, y: (far.y - mid.y) / len };
// Drag distances are a FRACTION OF THE GRIP'S OWN RADIUS, not a pixel count, so
// the expected factor is the same whatever the view happens to be framing: half
// the radius further out is 1.5x, half of it back in is 0.5x.
const grow = await dragFrom(far.x, far.y, unit.x * len * 0.5, unit.y * len * 0.5);
check(
  "dragging a corner away from the body grows it",
  Number.isFinite(Number(grow.after)) && Number(grow.after) > 1.35 && Number(grow.after) < 1.65,
  `during=${grow.during} committed=${grow.after}`,
);
const shrink = await dragFrom(far.x, far.y, -unit.x * len * 0.5, -unit.y * len * 0.5);
check(
  "dragging a corner toward the body shrinks it",
  Number.isFinite(Number(shrink.after)) && Number(shrink.after) > 0.35 && Number(shrink.after) < 0.65,
  `during=${shrink.during} committed=${shrink.after}`,
);
// Dragging clean through the pivot and out the far side used to flip the sign of
// the factor, which mirrored the body and threw the handle to the opposite side.
// It has to bottom out instead.
const through = await dragFrom(far.x, far.y, -unit.x * len * 2.2, -unit.y * len * 2.2);
const t = Number(through.after);
check(
  "dragging through the pivot bottoms out instead of flipping",
  Number.isFinite(t) && t > 0 && t <= 0.1,
  `during=${through.during} committed=${through.after}`,
);

await fac.fill("1");
await waitIdle();

// A move or a rotate drag must leave the factor completely alone. three fills in
// pointStart/pointEnd on every pointerDown whatever the mode, so a scale derived
// from them without checking the mode makes moving or turning the body resize it.
for (const mode of ["Move", "Rotate"]) {
  await dialog.locator("button", { hasText: mode }).first().click();
  await page.waitForTimeout(250);
  for (const [dx, dy] of [
    [0, 0],
    [-60, 0],
    [60, 40],
  ]) {
    await resetView();
    await page.mouse.move(972 + dx, 433 + dy);
    await page.mouse.down();
    await page.mouse.move(972 + dx + 70, 433 + dy - 50, { steps: 6 });
    await page.mouse.up();
    await page.waitForTimeout(200);
  }
  await waitIdle();
  await dialog.locator("button", { hasText: "Scale" }).first().click();
  await page.waitForTimeout(250);
  const after = await fac.inputValue();
  check(`${mode} drags leave the scale factor untouched`, after === "1", after);
  await fac.fill("1");
  await waitIdle();
}

await dialog.locator("button", { hasText: "Done" }).first().click();
await page.waitForTimeout(300);

// Scale composes with the rotation and the translation the same way the kernel
// does (scale about the pivot, then rotate about it, then translate): a 40x30x20
// box centred at (0,0,10), x2 about that centre, turned 90 deg about Z and moved
// +5 in X, lands on x[-25,35] y[-40,40] z[-10,30].
await apply({ op: "newDocument" });
await waitIdle();
const box2 = await apply({ op: "addPrimitive", kind: "box", params: { width: 40, depth: 30, height: 20 } });
await waitIdle();
await apply({ op: "transform", targetId: box2.id ?? box2.createdId });
await waitIdle();
await row("Transform").dblclick();
await page.waitForTimeout(500);
await dialog.locator("button", { hasText: "Scale" }).first().click();
await dialog.locator(".ed-field", { hasText: "Factor" }).locator("input").fill("2");
await dialog.locator("button", { hasText: "Rotate" }).first().click();
await dialog.locator(".ed-field", { hasText: "Axis" }).locator("button", { hasText: "Z" }).click();
await dialog.locator(".ed-field", { hasText: "Angle" }).locator("input").fill("90");
await dialog.locator("button", { hasText: "Move" }).first().click();
await dialog.locator(".ed-field", { hasText: "Move X" }).locator("input").fill("5");
await waitIdle();
const composed = await bodyBox();
const want = { min: [-25, -40, -10], max: [35, 40, 30] };
check(
  "scale composes with rotate + move exactly as the kernel builds it",
  [0, 1, 2].every((i) => near(composed.min[i], want.min[i], 0.2) && near(composed.max[i], want.max[i], 0.2)),
  JSON.stringify(composed),
);
await dialog.locator("button", { hasText: "Done" }).first().click();
await page.waitForTimeout(300);

await page.screenshot({ path: "/tmp/openshape-transform-scale.png" });
console.log(failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`);
await close();
process.exit(failures === 0 ? 0 : 1);
