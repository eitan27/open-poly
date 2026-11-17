// The Hole dialog's Positions and Affected parts. Positions places points the way the
// sketch tools snap: hovering a flat face makes it the plane; a click that
// snaps to nothing lands on the face's centre; edge midpoints and corners
// snap. Affected parts: All parts by default, or a picked Subset. Also the
// Type dropdown, the table values as readouts, and Blind's Flat / Drill point
// bottom. Screenshots go to $SHOTS.
//
//   URL=http://localhost:5173/ node scripts/verify-hole-points.mjs
import os from "node:os";
import path from "node:path";
import { launch, openPoly, checker } from "./lib/harness.mjs";

const SHOTS = process.env.SHOTS ?? os.tmpdir();
const { page, errors, close } = await launch({ deviceScaleFactor: 2 });
const op = openPoly(page);
const { check, done } = checker();

// A 40 × 30 plate (z 0 → 15) and a 10 × 10 post through its middle (z 0 → 30).
await op.newDocument();
const plate = (await op.applySettled({ op: "addPrimitive", kind: "box", params: { width: 40, depth: 30, height: 15 } }))
  .createdId;
const post = (await op.applySettled({ op: "addPrimitive", kind: "box", params: { width: 6, depth: 6, height: 30 } }))
  .createdId;
await op.applySettled({ op: "transform", targetId: post, tx: "-12", ty: "0", tz: "0" });

const canvas = page.locator(".viewport canvas").first();
await canvas.hover({ position: { x: 5, y: 5 } });
await page.keyboard.press("d");
const dialog = page.locator(".hole-dialog");
await dialog.waitFor({ timeout: 5000 });
await page.waitForTimeout(500);
const loc = dialog.locator(".ed-field", { hasText: "Positions" }).locator(".ed-pick-btn");
const count = async () => (await loc.textContent())?.trim();
check("opens listening for points", (await loc.getAttribute("class"))?.includes("active"));
check("no Body dropdown", (await dialog.locator(".ed-field", { hasText: "Body" }).count()) === 0);

const Z = 15;
const hover = async (w) => {
  const p = await op.screenOf(w);
  await page.mouse.move(p.x, p.y, { steps: 4 });
  await page.waitForTimeout(250);
};
// Hover the plate's top, then click its flat area: its centre.
await hover([8, 6, Z]);
await op.clickWorld([8, 6, Z]);
check("a click on a face's flat area adds a point", (await count()) === "1 position", await count());
// Near the back edge's midpoint, and near a corner: they snap.
await hover([0.4, 14.7, Z]);
await op.clickWorld([0.4, 14.7, Z]);
await hover([19.6, 14.6, Z]);
await op.clickWorld([19.6, 14.6, Z]);
check("an edge midpoint and a corner add points", (await count()) === "3 positions", await count());
await page.waitForTimeout(1200);
await page.screenshot({ path: path.join(SHOTS, "hole-points-ghost.png") });
// Clicking the corner again removes it.
await op.clickWorld([19.6, 14.6, Z]);
check("clicking a point again removes it", (await count()) === "2 positions", await count());

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
check("blind by default", (await dialog.locator("button.active", { hasText: "Blind" }).count()) === 1);
const modelHole = dialog.locator(".ed-field", { hasText: "Model the thread" }).locator("input");
check("tapped: thread not modelled by default", !(await modelHole.isChecked()));
check(
  "a plain tapped bore has no thread depth",
  (await dialog.locator(".ed-field", { hasText: "Thread depth" }).count()) === 0,
);
await modelHole.check();
await page.waitForTimeout(300);
check("a modelled one does", (await dialog.locator(".ed-field", { hasText: "Thread depth" }).count()) === 1);
await modelHole.uncheck();
await typeSel.selectOption("simple");
await dialog.locator("button", { hasText: "Through all" }).click();
check("through all: no Bottom choice", (await dialog.locator(".ed-field", { hasText: "Bottom" }).count()) === 0);
await dialog.locator("button", { hasText: "Blind" }).click();
await page.waitForTimeout(300);
check(
  "blind: drill point by default",
  (await dialog.locator("button.active", { hasText: "Drill point" }).count()) === 1,
);
await dialog.locator("button", { hasText: "Flat" }).click();
check("flat hides the point angle", (await dialog.locator(".ed-field", { hasText: "Point angle" }).count()) === 0);
await dialog.locator("button", { hasText: "Through all" }).click();
await dialog.screenshot({ path: path.join(SHOTS, "hole-dialog.png") });

await dialog.locator(".ed-primary").click();
await op.settle();
const holeF = (await op.features()).find((f) => f.type === "hole");
const world = (uv) => {
  const f = holeF.plane.frame;
  return [0, 1, 2].map((k) => f.origin[k] + uv[0] * f.uAxis[k] + uv[1] * f.vAxis[k]);
};
const near = (a, b) => a.every((v, k) => Math.abs(v - b[k]) < 0.01);
const pts = (holeF?.points ?? []).map((p) => world(p.uv));
check(
  "on the plate's top face",
  holeF?.plane?.kind === "face" && holeF.plane.featureId === plate,
  JSON.stringify(holeF?.plane),
);
check("the first at the face's centre", near(pts[0] ?? [], [0, 0, Z]), JSON.stringify(pts));
check("the second at the edge's midpoint", near(pts[1] ?? [], [0, 15, Z]), JSON.stringify(pts));
check("no feature errors", (await op.featureErrors()).length === 0, JSON.stringify(await op.featureErrors()));
const cutBy = async (bodyId) =>
  ((await op.scene()).bodies.find((b) => b.id === bodyId)?.faces ?? []).some((n) => n.startsWith(holeF.id));
check("cuts the plate", await cutBy(plate));
await page.screenshot({ path: path.join(SHOTS, "hole-points-result.png") });

// All it reaches: a hole over the post cuts the post too; with only the
// plate picked, it leaves the post alone.
await op.apply({ op: "delete", featureId: holeF.id });
await op.settle();
await canvas.hover({ position: { x: 5, y: 5 } });
await page.keyboard.press("d");
await dialog.waitFor({ timeout: 5000 });
await hover([-12, 0, 30]);
await op.clickWorld([-12, 0, 30]);
check("a click on the post's top adds its centre", (await count()) === "1 position", await count());
const partsSel = dialog.locator(".ed-field", { hasText: "Affected parts" }).locator("select");
check("Affected parts: All parts by default", (await partsSel.inputValue()) === "all");
check("no part picker until Subset", (await dialog.locator(".ed-pick-btn", { hasText: /part/ }).count()) === 0);
await dialog.locator("button", { hasText: "Through all" }).click();
await dialog.locator(".ed-primary").click();
await op.settle();
const h2 = (await op.features()).find((f) => f.type === "hole");
check("all it reaches: cuts the post", await cutByH(h2, post));
check("all it reaches: and the plate below it", await cutByH(h2, plate));

// Subset: only the plate.
await op.apply({ op: "delete", featureId: h2.id });
await op.settle();
await canvas.hover({ position: { x: 5, y: 5 } });
await page.keyboard.press("d");
await dialog.waitFor({ timeout: 5000 });
await hover([-12, 0, 30]);
await op.clickWorld([-12, 0, 30]);
await dialog.locator("button", { hasText: "Through all" }).click();
await partsSel.selectOption("subset");
await page.waitForTimeout(200);
await op.clickWorld([10, 5, 15]);
check("Subset: a click picks a part", (await dialog.locator(".ed-pick-btn", { hasText: "1 part" }).count()) === 1);
await dialog.screenshot({ path: path.join(SHOTS, "hole-dialog-subset.png") });
await dialog.locator(".ed-primary").click();
await op.settle();
const h3 = (await op.features()).find((f) => f.type === "hole");
check("Subset: cuts the plate", await cutByH(h3, plate));
check("Subset: leaves the post", !(await cutByH(h3, post)));

// New document: an open dialog (and its ghost) goes with the old one.
await canvas.hover({ position: { x: 5, y: 5 } });
await page.keyboard.press("d");
await dialog.waitFor({ timeout: 5000 });
await hover([8, 6, Z]);
await op.clickWorld([8, 6, Z]);
await page.waitForTimeout(800);
await op.newDocument();
await page.waitForTimeout(800);
check("New closes the Hole dialog", (await dialog.count()) === 0);
check("New leaves no ghost", (await op.scene()).bodies.length === 0);
await page.screenshot({ path: path.join(SHOTS, "hole-new-doc.png") });

async function cutByH(h, bodyId) {
  return ((await op.scene()).bodies.find((b) => b.id === bodyId)?.faces ?? []).some((n) => n.startsWith(h.id));
}

const real = errors.filter((e) => !/Failed to load resource/.test(e));
check("no page errors", real.length === 0, real.join("\n"));
await close();
done();
