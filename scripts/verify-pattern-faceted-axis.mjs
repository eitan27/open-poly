// A circular pattern can spin about a FACETED round wall.
//
// Cylinders here are 48-gon prisms (worker.ts facetedCylinderShape), so the
// "cylindrical face" a user clicks is one flat strip: geomType PLANE, no
// analytic axis. That pick used to be accepted and then fail in the kernel
// ("the axis face must be cylindrical or conical") with the feature already in
// the timeline. facetedWallAxis now fits the axis from the strip's smooth
// cluster — every facet plane is parallel to the axis and an apothem away from
// it — and the pick-time guard lets those strips through while still refusing a
// genuinely flat face.
//
// The test READS the fitted axis back out of the geometry rather than trusting
// a screenshot: one copy at 180° lands diametrically opposite the seed, so the
// axis is the midpoint of the two — recovered to 6 decimal places from the
// pattern body's bounding box, and compared with the cylinder's true axis. An
// axis on the facet plane instead of the centre line (8mm out, the obvious way
// to get this wrong) misses by 16mm.
import { launch, openPoly } from "./lib/harness.mjs";

const { page, close } = await launch({ deviceScaleFactor: 2, collectErrors: false, width: 1400, height: 900 });
const { waitIdle, apply, read } = openPoly(page);

let failures = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}: ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};
const dlg = page.locator(".feature-dialog");
const rows = () => dlg.locator(".bool-operand-name").allTextContents();
const msg = async () =>
  (await page
    .locator(".sketch-msg")
    .textContent()
    .catch(() => null)) ?? "none";
const noMsg = () => page.waitForFunction(() => !document.querySelector(".sketch-msg"), null, { timeout: 10000 });
const bodies = async () => (await read({ read: "sceneSummary" })).bodies ?? [];
const bboxOf = async (name) => (await bodies()).find((b) => b.name === name)?.bbox;
const errorsNow = async () => (await read({ read: "sceneSummary" })).errors ?? {};

// A faceted cylinder on the origin, and a box parked 40mm out to be repeated.
await apply({ op: "newDocument" });
await waitIdle();
await apply({ op: "addPrimitive", kind: "cylinder", params: { radius: 8, height: 40 } });
await waitIdle();
const box = await apply({ op: "addPrimitive", kind: "box", params: { width: 10, depth: 10, height: 10 } });
await waitIdle();
const moved = await apply({ op: "transform", targetId: box.createdId, tx: 40, ty: 0, tz: 0 });
await waitIdle();
check("the scene builds", moved.ok, JSON.stringify(moved).slice(0, 140));

// The seed's own centre, to mirror through the axis below.
const seed = (await bodies()).find((b) => b.name === "Box 1")?.bbox;
const mid = (bb) => [0, 1, 2].map((i) => (bb.min[i] + bb.max[i]) / 2);
console.log("seed bbox:", JSON.stringify(seed));

// --- 1. The reference answer: the same pattern about WORLD Z ------------------
// Same 180° copy, same reading — the cylinder is on the origin, so world Z IS
// its axis and this is what a correct fit has to reproduce.
const ref = await apply({
  op: "addPattern",
  targetId: box.createdId,
  kind: "circular",
  axis: { world: "z" },
  count: 2,
  angle: 180,
});
await waitIdle();
check("a world-Z pattern builds", ref.ok, JSON.stringify(ref).slice(0, 140));
const refBox = await bboxOf("Pattern 1");
console.log("world-Z copy bbox:", JSON.stringify(refBox));
await apply({ op: "delete", featureId: ref.createdId });
await waitIdle();

// --- 2. The same thing, armed in the dialog and picked off the faceted wall ---
await page.evaluate(() => document.activeElement?.blur());
await apply({ op: "select", refs: [] });
await page.keyboard.press("x");
await page.waitForTimeout(400);
await dlg.locator(".ed-modes button", { hasText: "Circular" }).click();
await page.waitForTimeout(300);
await dlg.locator(".ed-pick-btn", { hasText: "Select a body" }).click();
await page.waitForTimeout(200);

const canvas = await page.locator("canvas").first().boundingBox();
const clickWorld = async (w) => {
  const s = await page.evaluate((p) => window.__openpoly.worldToScreen(p), w);
  await page.mouse.click(canvas.x + s.x, canvas.y + s.y);
  await page.waitForTimeout(500);
};
await clickWorld([40, 0, 10]); // the parked box — the body to repeat
check("the body landed", (await rows()).length === 1, (await rows()).join(" | ") || "none");
check("…and the axis armed itself", (await dlg.locator(".ed-pick-btn.active").count()) === 1);

// The cylinder's wall. It is 48 flat strips; the pick has to take it anyway.
await clickWorld([0, -8, 20]);
const picked = await rows();
console.log("after the wall pick:", picked.join(" | "), "| msg:", JSON.stringify(await msg()));
check("a faceted round wall fills the axis", picked.length === 2 && /· face$/.test(picked[1]), picked.join(" | "));

// One copy, straight across the axis from the seed.
await dlg.locator(".ed-modes button", { hasText: "Angle" }).click();
await page.waitForTimeout(200);
const angleField = dlg.locator(".ed-field", { hasText: "Angle" }).locator("input");
await angleField.fill("180");
const countField = dlg.locator(".ed-field", { hasText: "Count" }).first().locator("input");
await countField.fill("2");
await page.waitForTimeout(300);
await dlg.locator(".ed-primary").click();
const st = await waitIdle();
check("…and the pattern BUILDS off it", /up to date/i.test(st) && Object.keys(await errorsNow()).length === 0, st);
const wallBox = await bboxOf("Pattern 1");
console.log("faceted-wall copy bbox:", JSON.stringify(wallBox));

// --- 3. It is the cylinder's OWN axis, read back from the geometry ------------
const axisFrom = (copy) => {
  const c = mid(copy),
    s0 = mid(seed);
  return [(c[0] + s0[0]) / 2, (c[1] + s0[1]) / 2];
};
const fitted = wallBox && axisFrom(wallBox);
const reference = refBox && axisFrom(refBox);
console.log("axis from the faceted wall:", JSON.stringify(fitted), "| from world Z:", JSON.stringify(reference));
check(
  "the fitted axis IS the cylinder's centre line",
  !!fitted && Math.hypot(fitted[0], fitted[1]) < 1e-6,
  JSON.stringify(fitted),
);
check(
  "…the same line world Z gives, to 6 decimals",
  !!fitted && !!reference && Math.hypot(fitted[0] - reference[0], fitted[1] - reference[1]) < 1e-6,
  `${JSON.stringify(fitted)} vs ${JSON.stringify(reference)}`,
);
check(
  "…and vertical: the copy never leaves the seed's z slab",
  !!wallBox && Math.abs(wallBox.min[2] - seed.min[2]) < 1e-6 && Math.abs(wallBox.max[2] - seed.max[2]) < 1e-6,
  `${JSON.stringify(wallBox?.min)}..${JSON.stringify(wallBox?.max)} vs ${JSON.stringify(seed.min)}..${JSON.stringify(seed.max)}`,
);
await page.screenshot({ path: "/tmp/openpoly-pattern-faceted-axis.png" });

// --- 4. A genuinely flat face is still refused, at pick time ------------------
await apply({ op: "select", refs: [] });
await page.waitForTimeout(200);
await page.keyboard.press("x");
await page.waitForTimeout(400);
await dlg.locator(".ed-modes button", { hasText: "Circular" }).click();
await page.waitForTimeout(300);
await dlg.locator(".ed-pick-btn", { hasText: "Select a body" }).click();
await page.waitForTimeout(200);
await clickWorld([0, 0, 40]); // the cylinder's flat top — picks it as the body
check("a second dialog took the cylinder", (await rows()).length === 1, (await rows()).join(" | ") || "none");
await noMsg().catch(() => {});
await clickWorld([0, 0, 40]); // …now that same flat top, as the AXIS
console.log("flat top →", JSON.stringify(await msg()));
check("a flat face is refused at pick time", /flat face has no axis/i.test(await msg()), await msg());
check("…with nothing written into the axis", (await rows()).length === 1, (await rows()).join(" | "));
check(
  "…and no broken feature left behind",
  Object.keys(await errorsNow()).length === 0,
  JSON.stringify(await errorsNow()),
);

console.log(failures ? `\n${failures} FAILED` : "\nAll checks passed");
await close();
process.exit(failures ? 1 : 0);
