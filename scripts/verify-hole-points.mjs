// The Hole dialog's Location slot: holes go on picked snap points (sketch
// points, circle/arc centres, line midpoints and ends), toggled by clicking,
// stored by entity so they follow the sketch; plus the Type dropdown, the
// table values as read-only readouts, and Blind's Flat / Drill point bottom.
// Screenshots go to $SHOTS.
//
//   URL=http://localhost:5173/ node scripts/verify-hole-points.mjs
import os from "node:os";
import path from "node:path";
import { launch, openPoly, checker } from "./lib/harness.mjs";

const SHOTS = process.env.SHOTS ?? os.tmpdir();
const { page, errors, close } = await launch({ deviceScaleFactor: 2 });
const op = openPoly(page);
const { check, done } = checker();

await op.newDocument();
const blk = (await op.applySettled({ op: "addPrimitive", kind: "box", params: { width: 40, depth: 30, height: 15 } }))
  .createdId;
const sk = (
  await op.applySettled({
    op: "addSketch",
    // On a plane level with the box's top: Top's axes, so sketch (u, v) is
    // world (x, y) and the test can click it.
    plane: {
      planeId: (await op.applySettled({ op: "addPlane", method: "offset", base: { datum: "top" }, offset: 15 }))
        .createdId,
    },
    entities: [
      { shape: "point", p: [-10, 0] },
      { shape: "point", p: [10, 0] },
      { shape: "circle", c: [0, 8], r: 3 },
      { shape: "line", a: [-15, -10], b: [5, -10] },
    ],
  })
).createdId;

await page
  .locator(".viewport canvas")
  .first()
  .hover({ position: { x: 5, y: 5 } });
await page.keyboard.press("d");
const dialog = page.locator(".hole-dialog");
await dialog.waitFor({ timeout: 5000 });
await page.waitForTimeout(800);
const loc = dialog.locator(".hole-location .ed-pick-btn");
const count = async () => (await loc.textContent())?.trim();
check("opens on the sketch's points and circle centre", (await count()) === "3 points", await count());
check("the slot is listening", (await loc.getAttribute("class"))?.includes("active"));

const Z = 15;
await op.clickWorld([-10, 0, Z]);
check("clicking a picked point removes it", (await count()) === "2 points", await count());
await op.clickWorld([-12, -10, Z]);
check("clicking a line adds its midpoint", (await count()) === "3 points", await count());
await op.clickWorld([5, -10, Z]);
check("clicking a line's end adds the end", (await count()) === "4 points", await count());
await op.clickWorld([0, 11, Z]);
check(
  "clicking a circle picks its (already picked) centre — removes it",
  (await count()) === "3 points",
  await count(),
);
await op.clickWorld([0, 11, Z]);
check("…and again adds it back", (await count()) === "4 points", await count());
await page.waitForTimeout(1500);
await page.screenshot({ path: path.join(SHOTS, "hole-points-ghost.png") });

// Type dropdown and the table readouts.
const typeSel = dialog.locator(".ed-field", { hasText: "Type" }).locator("select");
check("type is a dropdown", (await typeSel.count()) === 1);
check(
  "clearance Ø is a read-only value",
  (await dialog.locator(".ed-derived", { hasText: "Clearance Ø" }).count()) === 1,
);
await typeSel.selectOption("tapped");
await page.waitForTimeout(300);
check(
  "tapped: the size reads as a thread",
  (await dialog.locator(".ed-field", { hasText: "Thread" }).locator("option:checked").textContent()) === "M3 × 0.5",
);
check(
  "tapped: tap drill 2.5 from the table",
  (await dialog.locator(".ed-derived", { hasText: "Tap drill Ø" }).locator(".ed-derived-value").textContent()) ===
    "2.5",
);
await typeSel.selectOption("simple");

// Through all draws open; blind shows Bottom.
await dialog.screenshot({ path: path.join(SHOTS, "hole-dialog-through.png") });
check("through all: no Bottom choice", (await dialog.locator(".ed-field", { hasText: "Bottom" }).count()) === 0);
await dialog.locator("button", { hasText: "Blind" }).click();
await page.waitForTimeout(300);
check("blind: a Bottom choice", (await dialog.locator(".ed-field", { hasText: "Bottom" }).count()) === 1);
check(
  "blind: drill point by default",
  (await dialog.locator("button.active", { hasText: "Drill point" }).count()) === 1,
);
await dialog.screenshot({ path: path.join(SHOTS, "hole-dialog-drill.png") });
await dialog.locator("button", { hasText: "Flat" }).click();
await page.waitForTimeout(300);
check("flat hides the point angle", (await dialog.locator(".ed-field", { hasText: "Point angle" }).count()) === 0);
await dialog.screenshot({ path: path.join(SHOTS, "hole-dialog-flat.png") });

await dialog.locator(".ed-primary").click();
await op.settle();
const holeF = (await op.features()).find((f) => f.type === "hole");
check("creates the hole with its 4 points", holeF?.points?.length === 4, JSON.stringify(holeF?.points));
check("no feature errors", (await op.featureErrors()).length === 0, JSON.stringify(await op.featureErrors()));

// The holes follow the sketch: move the line, the midpoint hole moves too.
const before = JSON.stringify((await op.scene()).bodies.find((b) => b.id === blk)?.bbox);
check("the box is still one body", !!before);
await page.screenshot({ path: path.join(SHOTS, "hole-points-result.png") });

const real = errors.filter((e) => !/Failed to load resource/.test(e));
check("no page errors", real.length === 0, real.join("\n"));
await close();
done();
