// Coincident works against a circle's rim, not just a line.
//
// The reported bug, in the reporter's own steps: draw a circle, draw a line
// across it end to end (both endpoints snap to the rim, recording two "Point on
// Circle" constraints), delete one of them, then select that line endpoint plus
// the circle and press Coincident. The endpoint jumped to the ORIGIN.
//
// Cause: the coincident planner knew about selected LINES only. A selected
// circle wasn't an edge a point could land on, so the selection read as "one
// lone point" — and one lone point means "anchor it to the origin".
//
// Now a point + a circle/arc resolves to point-on-circle, the same relationship
// the drawing tool records when an endpoint is snapped onto a rim.
//
// Checks:
//   1. drawing a line rim-to-rim records two point-on-circle constraints
//   2. after deleting one, point + circle → point-on-circle, NOT an origin
//      coincidence, and the endpoint stays on the rim rather than jumping to 0,0
//   3. the constraint holds: resizing the circle carries the endpoint with it
//   4. point + arc does the same
//   5. a circle's own CENTRE + that circle is refused (it's a contradiction)
//   6. point + line still makes point-on-line, and a lone point still anchors
//      to the origin
//   7. a line's endpoint is a comfortable click target even though it sits on
//      the line itself
import { launch, openPoly } from "./lib/harness.mjs";

const { page, close } = await launch({ collectErrors: false });
const { waitIdle, apply, read } = openPoly(page);

const settle = async () => {
  await waitIdle();
  await page.waitForTimeout(400);
  await waitIdle();
};

let failures = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

const sketchOf = async (id) => (await read({ read: "document" })).features.find((f) => f.id === id);
const consOf = async (id) => (await sketchOf(id)).constraints;
const entOf = async (id, entId) => (await sketchOf(id)).entities.find((e) => e.id === entId);
const round = (p) => p.map((v) => +v.toFixed(3));
const radial = (p, c) => +Math.hypot(p[0] - c[0], p[1] - c[1]).toFixed(3);

let canvas = null;
const openSketch = async (entities) => {
  const r = await apply({ op: "addSketch", plane: { datum: "top" }, entities });
  await waitIdle();
  await page.locator(".tree-row", { hasText: "Sketch" }).last().dblclick();
  await page.waitForTimeout(800);
  canvas = await page.locator("canvas").first().boundingBox();
  return { id: r.createdId, ids: (await sketchOf(r.createdId)).entities.map((e) => e.id) };
};
const screenOf = async (uv) => {
  const pt = await page.evaluate((q) => window.__openpoly.worldToScreen(q), [uv[0], uv[1], 0]);
  return { x: canvas.x + pt.x, y: canvas.y + pt.y };
};
const clickUv = async (uv, opts = {}) => {
  const p = await screenOf(uv);
  await page.mouse.click(p.x, p.y, opts);
  await page.waitForTimeout(250);
};
// Coincident lives in the grouped constraint control: the primary button is
// whichever constraint was used last, so open the ▸ flyout and pick it by name.
// Returns false when the entry is disabled — which is itself worth asserting.
const pressCoincident = async () => {
  await page.locator("button.constraint-arrow").first().click();
  await page.waitForTimeout(250);
  const entry = page.locator(".constraint-flyout button", { hasText: "Coincident" }).first();
  const enabled = await entry.isEnabled();
  if (!enabled) {
    // Close the flyout with the arrow, not Escape — Escape would walk up the
    // app's own chain and leave the sketch.
    await page.locator("button.constraint-arrow").first().click();
    await page.waitForTimeout(200);
    return false;
  }
  await entry.click();
  await settle();
  return true;
};
// Back to the Select tool: after drawing, the line tool is still armed and a
// click would start another segment instead of selecting.
const selectTool = async () => {
  await page.evaluate(() => document.activeElement?.blur());
  await page.keyboard.press("s");
  await page.waitForTimeout(250);
};
const leaveSketch = async (sketchId) => {
  await page.keyboard.press("Escape");
  await page.waitForTimeout(200);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(400);
  await settle();
  if (sketchId) {
    await apply({ op: "delete", featureId: sketchId });
    await settle();
  }
};

await waitIdle();
await apply({ op: "newDocument", name: "coincident-circle harness" });
await settle();

// --- 1/2/3. the reported sequence ----------------------------------------
{
  // A circle at the origin would let an origin-anchor hide as "on the rim", so
  // the circle sits well away from it.
  const C = [30, 30];
  const R = 20;
  const s = await openSketch([{ shape: "circle", c: C, r: R }]);
  const circleId = s.ids[0];
  // DRAWN with the line tool, rim to rim — the snap is what records the two
  // point-on-circle constraints, so authoring the line through the agent
  // wouldn't reproduce the reported state at all.
  await page.evaluate(() => document.activeElement?.blur());
  await page.keyboard.press("l");
  await page.waitForTimeout(300);
  await clickUv([C[0] - R, C[1]]);
  await clickUv([C[0] + R, C[1]]);
  await settle();
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
  await selectTool();
  const lineId = (await sketchOf(s.id)).entities.find((e) => e.type === "line")?.id;
  check("the line was drawn", !!lineId, `${(await sketchOf(s.id)).entities.length} entities`);
  const onCircle = (await consOf(s.id)).filter((c) => c.type === "pointOnCircle");
  check("a line drawn rim-to-rim records two point-on-circle constraints", onCircle.length === 2, `${onCircle.length}`);

  // Delete the one on the `b` end, exactly as reported.
  const bOne = onCircle.find((c) => c.point.entity === lineId && c.point.at === "b");
  await apply({ op: "removeConstraint", sketchId: s.id, constraintId: bOne.id });
  await settle();
  check(
    "after deleting one, a single point-on-circle is left",
    (await consOf(s.id)).filter((c) => c.type === "pointOnCircle").length === 1,
  );

  // Select the freed endpoint, then the circle, then press Coincident.
  const line = await entOf(s.id, lineId);
  await clickUv(line.b);
  const sel = await read({ read: "selection" });
  check(
    "the line's endpoint is selectable",
    JSON.stringify(sel).includes("sketchPoint"),
    JSON.stringify(sel).slice(0, 140),
  );
  await clickUv([C[0], C[1] - R], { modifiers: ["Shift"] }); // the rim, bottom of the circle
  await pressCoincident();

  const cons = await consOf(s.id);
  const madeOrigin = cons.some((c) => c.type === "coincident" && [c.a, c.b].some((r) => "origin" in r));
  const madeOnCircle = cons.filter((c) => c.type === "pointOnCircle" && c.circle === circleId).length;
  check(
    "coincident with a circle does NOT anchor the point to the origin",
    !madeOrigin,
    JSON.stringify(cons.map((c) => c.type)),
  );
  check("it makes a point-on-circle instead", madeOnCircle === 2, `${madeOnCircle} point-on-circle`);

  const after = await entOf(s.id, lineId);
  check(
    "and the endpoint stays on the rim rather than jumping to 0,0",
    radial(after.b, (await entOf(s.id, circleId)).c) === R,
    `b = ${round(after.b)}, |b-c| = ${radial(after.b, (await entOf(s.id, circleId)).c)}`,
  );

  // It's a real constraint, not a one-off placement: grow the circle and the
  // endpoint has to come along.
  await apply({ op: "addDimension", sketchId: s.id, dimension: { kind: "diameter", entity: circleId, value: 70 } });
  await settle();
  const grown = await entOf(s.id, lineId);
  const circ = await entOf(s.id, circleId);
  check(
    "the endpoint follows the rim when the circle is resized",
    circ.r === 35 && radial(grown.b, circ.c) === 35,
    `r=${circ.r}, |b-c|=${radial(grown.b, circ.c)}`,
  );
  await leaveSketch(s.id);
}

// --- 4. an arc's rim is a rim too ----------------------------------------
{
  const s = await openSketch([
    { shape: "arc", c: [0, 0], r: 25, start: 0, end: 120 },
    { shape: "line", a: [-40, -30], b: [-10, -10] },
  ]);
  const [arcId, lineId] = s.ids;
  const l = await entOf(s.id, lineId);
  await clickUv(l.b);
  await clickUv([25 * Math.cos(Math.PI / 3), 25 * Math.sin(Math.PI / 3)], { modifiers: ["Shift"] }); // mid-arc
  await pressCoincident();
  const cons = await consOf(s.id);
  check(
    "point + arc makes a point-on-circle against the arc",
    cons.some((c) => c.type === "pointOnCircle" && c.circle === arcId),
    JSON.stringify(cons.map((c) => `${c.type}:${c.circle ?? ""}`)),
  );
  check(
    "and not an origin anchor",
    !cons.some((c) => c.type === "coincident" && [c.a, c.b].some((r) => "origin" in r)),
  );
  await leaveSketch(s.id);
}

// --- 5/6. the rules that must not have changed ---------------------------
{
  const s = await openSketch([
    { shape: "circle", c: [30, 30], r: 15 },
    { shape: "line", a: [-40, 0], b: [-10, 0] },
  ]);
  const [circleId, lineId] = s.ids;
  // A circle's own centre + that circle: a contradiction, so nothing is made.
  await clickUv([30, 30]);
  await clickUv([30, 45], { modifiers: ["Shift"] });
  const before = (await consOf(s.id)).length;
  const applied = await pressCoincident();
  check(
    "a circle's centre + its own rim is refused (the button is disabled)",
    applied === false && (await consOf(s.id)).length === before,
    `applied=${applied}, ${before} → ${(await consOf(s.id)).length}`,
  );

  check("the circle is still a circle", (await entOf(s.id, circleId)).type === "circle");
  await leaveSketch(s.id);
}

{
  // Two plain lines, nowhere near the circle case above, for the rules that
  // must not have changed.
  const s = await openSketch([
    { shape: "line", a: [-40, 10], b: [-20, 10] },
    { shape: "line", a: [-40, -10], b: [-20, -10] },
  ]);
  const [aId, bId] = s.ids;
  await clickUv([-20, 10]);
  await clickUv([-40, -10], { modifiers: ["Shift"] });
  await pressCoincident();
  let cons = await consOf(s.id);
  check(
    "two points still make a plain coincidence",
    cons.some((c) => c.type === "coincident" && !("origin" in c.a) && !("origin" in c.b)),
    JSON.stringify(cons.map((c) => c.type)),
  );

  // A point + a line is still point-on-line. Positions are re-read: the
  // coincidence above moved both lines, so the coordinates they were authored
  // with are stale.
  const la = await entOf(s.id, aId);
  const lb = await entOf(s.id, bId);
  await clickUv(la.a);
  await clickUv([(lb.a[0] + lb.b[0]) / 2, (lb.a[1] + lb.b[1]) / 2], { modifiers: ["Shift"] });
  await pressCoincident();
  cons = await consOf(s.id);
  check(
    "point + line is still point-on-line",
    cons.some((c) => c.type === "pointOnLine" && c.line === bId),
    JSON.stringify(cons.map((c) => `${c.type}:${c.line ?? ""}`)),
  );
  check("(and the first line is untouched)", (await entOf(s.id, aId)).type === "line");
  await leaveSketch(s.id);
}

// --- 7. the endpoint is a comfortable target -----------------------------
{
  const s = await openSketch([{ shape: "line", a: [-30, 0], b: [30, 0] }]);
  const lineId = s.ids[0];
  // Aim 5px short of the endpoint, along the line — the cursor is right on the
  // line, so before this the line itself won and the endpoint was unreachable
  // without pixel-perfect aim.
  const endPx = await screenOf([30, 0]);
  await page.mouse.click(endPx.x - 5, endPx.y);
  await page.waitForTimeout(300);
  const sel = await read({ read: "selection" });
  check(
    "clicking within a few px of a line's end selects the POINT, not the line",
    JSON.stringify(sel).includes("sketchPoint"),
    JSON.stringify(sel).slice(0, 160),
  );
  // And the middle of the line still selects the line.
  await page.keyboard.press("Escape");
  await page.waitForTimeout(200);
  await clickUv([0, 0]);
  const sel2 = await read({ read: "selection" });
  check(
    "the middle of the line still selects the line",
    JSON.stringify(sel2).includes("sketchEntity") && JSON.stringify(sel2).includes(lineId),
    JSON.stringify(sel2).slice(0, 160),
  );
  await leaveSketch(s.id);
}

// --- a small circle is still pickable by its rim -------------------------
{
  // The centre gate is the reason the vertex gate can't simply be widened for
  // everything: a small circle's centre would swallow every click on its rim.
  const s = await openSketch([{ shape: "circle", c: [0, 0], r: 6 }]);
  const circleId = s.ids[0];
  await clickUv([6, 0]);
  const sel = await read({ read: "selection" });
  check(
    "a small circle is still selectable by its rim (the centre doesn't swallow it)",
    JSON.stringify(sel).includes("sketchEntity") && JSON.stringify(sel).includes(circleId),
    JSON.stringify(sel).slice(0, 160),
  );
  await leaveSketch(s.id);
}

console.log(`\n${failures === 0 ? "all checks passed" : `${failures} check(s) failed`}`);
await close();
process.exit(failures ? 1 : 0);
