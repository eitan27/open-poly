// Zero-size sketch geometry: it can't be drawn, and a stray one already in the
// sketch doesn't block everything else.
//
// Regression: a zero-length line is invisible AND unpickable, so once drawn
// (an easy double-click slip) it could never be selected or deleted. Worse, the
// "did this constraint collapse a line?" guard scanned the WHOLE sketch, so one
// stray segment made every dimension anywhere in that sketch fail with
// "can't be satisfied with the existing constraints" — with nothing in the
// constraints list to explain it.
import { launch, openPoly } from "./lib/harness.mjs";

const { page, close } = await launch({ deviceScaleFactor: 2, collectErrors: false, width: 1400, height: 900 });
const { waitIdle, apply, read } = openPoly(page);

let failures = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}: ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

let canvas, sketchId;
const clickWorld = async (w) => {
  const s = await page.evaluate((p) => window.__openpoly.worldToScreen(p), w);
  await page.mouse.click(canvas.x + s.x, canvas.y + s.y);
  await page.waitForTimeout(200);
};
const sketchNow = async () => (await read({ read: "document" })).features.find((f) => f.id === sketchId);
const openSketch = async (entities = []) => {
  await apply({ op: "newDocument" });
  await waitIdle();
  const sk = await apply({ op: "addSketch", plane: { datum: "top" }, entities });
  sketchId = sk.createdId ?? sk.id;
  await waitIdle();
  await page.locator(".tree-row", { hasText: "Sketch" }).first().dblclick();
  await page.waitForTimeout(600);
  canvas = await page.locator("canvas").first().boundingBox();
};

await waitIdle();

// --- 1. Zero-size entities can't be drawn ---------------------------------------
await openSketch();
const P = [20, 10, 0];
for (const [tool, key] of [
  ["line", "l"],
  ["rectangle", "r"],
  ["circle", "c"],
  ["polygon", "p"],
]) {
  await page.evaluate(() => document.activeElement?.blur());
  await page.keyboard.press(key);
  await page.waitForTimeout(200);
  await clickWorld(P);
  await clickWorld(P); // …and again, in the same spot
  await page.keyboard.press("Escape");
  await page.waitForTimeout(200);
}
await waitIdle();
const drawn = (await sketchNow()).entities;
check(
  "clicking twice in one spot draws nothing at all",
  drawn.length === 0,
  drawn.map((e) => e.type).join(", ") || "no entities",
);

// --- 2. A stray zero-length line doesn't block dimensioning ----------------------
const C = [30, 0],
  R = 20;
await openSketch([
  { shape: "circle", c: C, r: R },
  { shape: "line", a: [-40, 30], b: [-40, 30] }, // the invisible stray
]);
const circleId = (await sketchNow()).entities.find((e) => e.type === "circle").id;
await apply({ op: "select", refs: [] });
await clickWorld([C[0] + R * Math.cos(Math.PI * 0.9), C[1] + R * Math.sin(Math.PI * 0.9), 0]);
await page.evaluate(() => document.activeElement?.blur());
await page.keyboard.press("d");
await page.waitForTimeout(300);
const boxOpen = (await page.locator(".dim-input input").count()) === 1;
check("the circle is still dimensionable with a stray zero-length line present", boxOpen);
if (boxOpen) {
  await page.locator(".dim-input input").fill("35");
  await page.keyboard.press("Enter");
  await waitIdle();
  const s = await sketchNow();
  const circle = s.entities.find((e) => e.id === circleId);
  const msg = (await page.locator(".sketch-msg").count())
    ? (await page.locator(".sketch-msg").textContent())?.trim()
    : "";
  check(
    "…and the radius actually applies",
    Math.abs(circle.r - 35) < 0.01,
    `r=${circle.r.toFixed(2)}${msg ? ` | banner: ${msg}` : ""}`,
  );
}

// --- 3. A constraint that DOES collapse a line is still refused -----------------
// A second right angle in a triangle: planegcs "satisfies" it by collapsing a
// side to zero length, which must not be stored.
await openSketch([
  { shape: "line", a: [0, 0], b: [40, 0] },
  { shape: "line", a: [40, 0], b: [40, 30] },
  { shape: "line", a: [40, 30], b: [0, 0] },
]);
const tri = (await sketchNow()).entities;
const lengths = (es) => es.filter((e) => e.type === "line").map((e) => Math.hypot(e.b[0] - e.a[0], e.b[1] - e.a[1]));
const before = lengths(tri);
const perpendicular = async (a, b) => {
  await apply({
    op: "select",
    refs: [
      { kind: "sketchEntity", sketchId, entityId: a },
      { kind: "sketchEntity", sketchId, entityId: b },
    ],
  });
  await page.waitForTimeout(200);
  // Perpendicular lives in the grouped constraint flyout.
  await page.click(".constraint-group .constraint-arrow");
  await page.waitForTimeout(200);
  await page.locator(".constraint-flyout button", { hasText: "Perpendicular" }).click();
  await waitIdle();
};
await perpendicular(tri[0].id, tri[1].id); // already a right angle — fine
await perpendicular(tri[1].id, tri[2].id); // would collapse the third side
const after = await sketchNow();
const msg3 = (await page.locator(".sketch-msg").count())
  ? (await page.locator(".sketch-msg").textContent())?.trim()
  : "";
const shortest = Math.min(...lengths(after.entities));
check(
  "a constraint that would collapse a line is still rejected",
  shortest > 1,
  `shortest side ${shortest.toFixed(3)}mm (was ${Math.min(...before).toFixed(1)})${msg3 ? ` | ${msg3}` : ""}`,
);
check(
  "…and the sketch is left as it was",
  after.entities.length === 3,
  `${after.entities.length} entities, constraints: ${after.constraints.map((c) => c.type).join(", ") || "none"}`,
);

console.log(failures === 0 ? "\n=== ALL CHECKS PASSED ===" : `\n=== ${failures} CHECK(S) FAILED ===`);
await close();
process.exit(failures === 0 ? 0 : 1);
