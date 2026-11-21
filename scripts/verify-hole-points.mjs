// The Hole dialog's Targets and Affected parts. Targets places points the way the
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
// The Targets slot (as Extrude's profiles): a row per target, then the button.
const loc = dialog.locator(".ed-pick-btn", { hasText: /targets/ });
const count = async () => {
  const n = await dialog.locator(".hole-targets .bool-operand-row").count();
  return `${n} ${n === 1 ? "target" : "targets"}`;
};
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
check("a click on a face's flat area adds a point", (await count()) === "1 target", await count());
// Near the back edge's midpoint, and near a corner: they snap.
await hover([0.4, 14.7, Z]);
await op.clickWorld([0.4, 14.7, Z]);
await hover([19.6, 14.6, Z]);
await op.clickWorld([19.6, 14.6, Z]);
check("an edge midpoint and a corner add points", (await count()) === "3 targets", await count());
await page.waitForTimeout(1200);
await page.screenshot({ path: path.join(SHOTS, "hole-points-ghost.png") });
// Clicking the corner again removes it.
await op.clickWorld([19.6, 14.6, Z]);
check("clicking a point again removes it", (await count()) === "2 targets", await count());

// Type dropdown and the table readouts.
const typeSel = dialog.locator(".ed-field", { hasText: "Type" }).locator("select");
check("type is a dropdown", (await typeSel.count()) === 1);
check("clearance Ø is a read-only value", (await dialog.locator(".ed-derived", { hasText: "Hole Ø" }).count()) === 1);
const fitSel = dialog.locator(".ed-field", { hasText: "Fit" }).locator("select");
check(
  "fit is a dropdown showing each gap, with Exact",
  (await fitSel.locator("option").allTextContents()).join("|") === "Exact (+0)|Close (+0.2)|Normal (+0.4)|Loose (+0.6)",
  (await fitSel.locator("option").allTextContents()).join("|"),
);
check("fit defaults to Normal", (await fitSel.inputValue()) === "normal");
await fitSel.selectOption("exact");
await page.waitForTimeout(200);
check(
  "exact: the hole is the screw's own diameter",
  (await dialog.locator(".ed-derived", { hasText: "Hole Ø" }).textContent()).includes("3") &&
    !(await dialog.locator(".ed-derived", { hasText: "Hole Ø" }).textContent()).includes("3.4"),
  await dialog.locator(".ed-derived", { hasText: "Hole Ø" }).textContent(),
);
await fitSel.selectOption("normal");
const modelHole = dialog.locator(".ed-field", { hasText: "Model the thread" }).locator("input");
await typeSel.selectOption("tapped");
await page.waitForTimeout(300);
check(
  "tapped: the size reads as a thread",
  (await dialog.locator(".ed-field", { hasText: "Thread" }).locator("option:checked").textContent()) === "M3 × 0.5",
);
const extentSel = dialog.locator(".ed-field", { hasText: "Extent" }).locator("select");
check("blind by default", (await extentSel.inputValue()) === "blind");
check(
  "extent offers up to next",
  (await extentSel.locator("option").allTextContents()).join("|") === "Blind|Up to next|Through all",
);
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
const bothWalls = async () =>
  (
    await dialog
      .locator("svg.dg path.dg-cut-edge")
      .evaluateAll((ps) => ps.map((p) => (p.getAttribute("d") ?? "").split("L").length))
  ).filter((n) => n >= 2).length === 2;
await extentSel.selectOption("throughAll");
await page.waitForTimeout(200);
check("through all: both walls of the bore drawn", await bothWalls());
check("through all: no Bottom choice", (await dialog.locator(".ed-field", { hasText: "Bottom" }).count()) === 0);
await extentSel.selectOption("upToNext");
await page.waitForTimeout(200);
check("up to next: both walls of the bore drawn", await bothWalls());
check("up to next: no Bottom choice either", (await dialog.locator(".ed-field", { hasText: "Bottom" }).count()) === 0);
check(
  "up to next: the diagram says so",
  (await dialog.locator("svg.dg text", { hasText: "up to next" }).count()) === 1,
);
await extentSel.selectOption("blind");
await page.waitForTimeout(300);
check(
  "blind: drill point by default",
  (await dialog.locator("button.active", { hasText: "Drill point" }).count()) === 1,
);
const depthIn = dialog.locator(".ed-field", { hasText: /^Depth/ }).locator("input");
const diaAnchor = () => dialog.locator('[data-dim="diameter"] text').getAttribute("text-anchor");
await depthIn.fill("15");
await depthIn.blur();
await page.waitForTimeout(200);
check("a deep, thin bore puts its Ø outside the walls", (await diaAnchor()) === "start");
await depthIn.fill("6");
await depthIn.blur();
await page.waitForTimeout(200);
check("a shallow one keeps it between them", (await diaAnchor()) === "middle");
await dialog.locator("button", { hasText: "Flat" }).click();
check("flat hides the point angle", (await dialog.locator(".ed-field", { hasText: "Point angle" }).count()) === 0);
await extentSel.selectOption("throughAll");
await dialog.screenshot({ path: path.join(SHOTS, "hole-dialog.png") });

await dialog.locator(".ed-primary").click();
await op.settle();
const holeF = (await op.features()).find((f) => f.type === "hole");
const world = (p) => {
  const f = p.plane.frame;
  return [0, 1, 2].map((k) => f.origin[k] + p.uv[0] * f.uAxis[k] + p.uv[1] * f.vAxis[k]);
};
const near = (a, b) => a.every((v, k) => Math.abs(v - b[k]) < 0.01);
const pts = (holeF?.points ?? []).map(world);
check(
  "on the plate's top face",
  (holeF?.points ?? []).every((p) => p.plane?.kind === "face" && p.plane.featureId === plate),
  JSON.stringify(holeF?.points),
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
check("a click on the post's top adds its centre", (await count()) === "1 target", await count());
const partsSel = dialog.locator(".ed-field", { hasText: "Affected parts" }).locator("select");
check("Affected parts: All parts by default", (await partsSel.inputValue()) === "all");
check("no part picker until Subset", (await dialog.locator(".ed-pick-btn", { hasText: /part/ }).count()) === 0);
await extentSel.selectOption("throughAll");
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
await extentSel.selectOption("throughAll");
await partsSel.selectOption("subset");
await page.waitForTimeout(200);
await op.clickWorld([10, 5, 15]);
check("Subset: a click picks a part", (await dialog.locator(".hole-parts .bool-operand-row").count()) === 1);
await dialog.screenshot({ path: path.join(SHOTS, "hole-dialog-subset.png") });
await dialog.locator(".ed-primary").click();
await op.settle();
const h3 = (await op.features()).find((f) => f.type === "hole");
check("Subset: cuts the plate", await cutByH(h3, plate));
check("Subset: leaves the post", !(await cutByH(h3, post)));

// Targets on different faces, one feature: the plate's top, the post's top
// (15 higher) and the plate's +x side — each drills into its own face.
await op.apply({ op: "delete", featureId: h3.id });
await op.settle();
await canvas.hover({ position: { x: 5, y: 5 } });
await page.keyboard.press("d");
await dialog.waitFor({ timeout: 5000 });
await hover([8, 6, Z]);
await op.clickWorld([8, 6, Z]);
await hover([-12, 0, 30]);
await op.clickWorld([-12, 0, 30]);
// The +x side (x = 20): hover it, then its flat area → its centre.
await hover([20, 6, 5]);
await op.clickWorld([20, 6, 5]);
check("targets on three faces at different levels", (await count()) === "3 targets", await count());
// The top's +x edge midpoint, first from the top (a fourth target)…
await hover([19.6, 0.4, Z]);
// The cursor is the hole's rim, flat on the face it would drill (look).
await page.screenshot({ path: path.join(SHOTS, "hole-cursor-top.png") });
await op.clickWorld([19.6, 0.4, Z]);
check("an edge's midpoint from the top adds a target", (await count()) === "4 targets", await count());
// …then from the side: the same spot, re-aimed to drill from the side.
await hover([20, 4, 10]);
await hover([20, 0.4, 14.6]);
await page.screenshot({ path: path.join(SHOTS, "hole-cursor-side.png") });
await op.clickWorld([20, 0.4, 14.6]);
check("the same spot from the edge's other face re-aims it", (await count()) === "4 targets", await count());
await extentSel.selectOption("blind");
await page.waitForTimeout(1200);
await page.screenshot({ path: path.join(SHOTS, "hole-multi-plane-ghost.png") });
await dialog.locator(".ed-primary").click();
await op.settle();
const h4 = (await op.features()).find((f) => f.type === "hole");
const normals = (h4?.points ?? []).map((p) => p.plane?.frame?.normal?.map((v) => Math.round(v)).join(","));
check(
  "each target keeps its face's normal",
  JSON.stringify(normals) === JSON.stringify(["0,0,1", "0,0,1", "1,0,0", "1,0,0"]),
  JSON.stringify(normals),
);
check("no feature plane", h4 && !h4.plane);
check(
  "multi-plane: no feature errors",
  (await op.featureErrors()).length === 0,
  JSON.stringify(await op.featureErrors()),
);
check("multi-plane: cuts the plate", await cutByH(h4, plate));
check("multi-plane: cuts the post", await cutByH(h4, post));
const holeWalls = ((await op.scene()).bodies.find((b) => b.id === plate)?.faces ?? []).filter((n) =>
  n.startsWith(h4.id),
);
check(
  "multi-plane: the plate has the top's and the side's holes",
  ["/h0/", "/h2/", "/h3/"].every((k) => holeWalls.some((n) => n.includes(k))),
  holeWalls.slice(0, 8).join(" "),
);
await page.screenshot({ path: path.join(SHOTS, "hole-multi-plane-result.png") });
// Screws in it: one per hole, each along its own hole.
const sc = await op.applySettled({ op: "addScrew", holeId: h4.id, head: "socket", params: { length: "8" } });
check(
  "screws in a multi-plane hole build",
  sc.ok && (await op.featureErrors()).length === 0,
  JSON.stringify(sc.error ?? (await op.featureErrors())),
);
const screwBody = (await op.scene()).bodies.find((b) => b.id === sc.createdId);
check("one screw per hole", (screwBody?.faces ?? []).filter((n) => /\/n\d+\//.test(n)).length > 0);
await page.screenshot({ path: path.join(SHOTS, "hole-multi-plane-screws.png") });
await op.apply({ op: "delete", featureId: sc.createdId });
await op.settle();

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
