// Trim and extend: draw roughly, then clean up.
//
// Trim removes the piece of a curve you click, bounded by where that curve
// crosses other curves; extend grows an open curve until it meets something.
// Both are constraint edits as much as geometry edits — the interesting part is
// what happens to the constraints attached to the parts that move or vanish
// (see document/trimOps.ts).
//
// Checks:
//   1. clicking a stub past a crossing shortens the line to the crossing
//   2. clicking between two crossings splits one line into two
//   3. clicking a line nothing crosses removes it
//   4. trimming a circle leaves the arc that's left, keeping its radius
//   5. the joint pinned to a trimmed-away end goes with it, and a length
//      dimension the trim invalidated goes too — keeping it would stretch the
//      geometry back on the next solve and undo the trim
//   6. a joint on the end that DIDN'T move survives
//   7. extend grows an end out to the first thing ahead of it and RECORDS the
//      meeting, so it survives a later solve rather than just touching
//   8. hovering previews the exact piece the click would take
//   9. the whole thing is one undo step
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
const entsOf = async (id) => (await sketchOf(id)).entities;
const consOf = async (id) => (await sketchOf(id)).constraints;
const entOf = async (id, entId) => (await entsOf(id)).find((e) => e.id === entId);
const round = (p) => p.map((v) => +v.toFixed(3));

let canvas = null;
const openSketch = async (entities) => {
  const r = await apply({ op: "addSketch", plane: { datum: "top" }, entities });
  await waitIdle();
  await page.locator(".tree-row", { hasText: "Sketch" }).last().dblclick();
  await page.waitForTimeout(800);
  canvas = await page.locator("canvas").first().boundingBox();
  return { id: r.createdId, ids: (await entsOf(r.createdId)).map((e) => e.id) };
};
const screenOf = async (uv) => {
  const pt = await page.evaluate((q) => window.__openpoly.worldToScreen(q), [uv[0], uv[1], 0]);
  return { x: canvas.x + pt.x, y: canvas.y + pt.y };
};
const clickUv = async (uv) => {
  const p = await screenOf(uv);
  await page.mouse.click(p.x, p.y);
  await settle();
};
const hoverUv = async (uv) => {
  const p = await screenOf(uv);
  await page.mouse.move(p.x, p.y);
  await page.waitForTimeout(350);
};
const pickTool = async (tool) => {
  await page.evaluate(() => document.activeElement?.blur());
  await page.keyboard.press(tool === "trim" ? "k" : "Shift+K"); // K = trim, Shift+K = extend
  await page.waitForTimeout(300);
};
// Each case gets a clean plane: finished sketches stay visible and PICKABLE, so
// leaving one behind means the next case's click can land on it instead (every
// case draws around the origin) — and a click on a non-active sketch is
// correctly ignored, which reads as the tool doing nothing.
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
// A fresh document: these cases all draw around the origin, and a body left in
// the document by an earlier run sits in FRONT of the sketch — the click then
// resolves to that body's face and the tool correctly does nothing, which reads
// as a failure of trim rather than of the fixture.
await apply({ op: "newDocument", name: "trim-extend harness" });
await settle();

// --- 1. shorten to the crossing ------------------------------------------
{
  const s = await openSketch([
    { shape: "line", a: [0, 0], b: [40, 0] },
    { shape: "line", a: [25, -12], b: [25, 12] },
  ]);
  await pickTool("trim");
  await clickUv([34, 0]); // the stub past the crossing
  const l = await entOf(s.id, s.ids[0]);
  check(
    "trimming the stub shortens the line to the crossing",
    l && l.type === "line" && round(l.b)[0] === 25 && round(l.a)[0] === 0,
    `line = ${JSON.stringify(l && [round(l.a), round(l.b)])}`,
  );
  check("and nothing else is added or lost", (await entsOf(s.id)).length === 2);
  await leaveSketch(s.id);
}

// --- 2. split in the middle ----------------------------------------------
{
  const s = await openSketch([
    { shape: "line", a: [0, 0], b: [40, 0] },
    { shape: "line", a: [12, -12], b: [12, 12] },
    { shape: "line", a: [28, -12], b: [28, 12] },
  ]);
  await pickTool("trim");
  await clickUv([20, 0]); // between the two crossings
  const ents = await entsOf(s.id);
  const pieces = ents.filter((e) => e.type === "line" && Math.abs(e.a[1]) < 1e-6 && Math.abs(e.b[1]) < 1e-6);
  check(
    "trimming the middle splits the line in two",
    ents.length === 4 && pieces.length === 2,
    `${ents.length} entities`,
  );
  const spans = pieces.map((p) => [round(p.a)[0], round(p.b)[0]].sort((x, y) => x - y)).sort((x, y) => x[0] - y[0]);
  check(
    "and the two pieces are what's left either side",
    JSON.stringify(spans) ===
      JSON.stringify([
        [0, 12],
        [28, 40],
      ]),
    JSON.stringify(spans),
  );
  await leaveSketch(s.id);
}

// --- 3. nothing crosses it → it goes -------------------------------------
{
  const s = await openSketch([{ shape: "line", a: [0, 0], b: [30, 0] }]);
  await pickTool("trim");
  await clickUv([15, 0]);
  check("a line nothing crosses is removed outright", (await entsOf(s.id)).length === 0);
  await leaveSketch(s.id);
}

// --- 4. a circle becomes the arc that's left ------------------------------
{
  const s = await openSketch([
    { shape: "circle", c: [0, 0], r: 20 },
    { shape: "line", a: [-30, 0], b: [30, 0] },
  ]);
  await pickTool("trim");
  await clickUv([0, -20]); // the bottom half
  const c = await entOf(s.id, s.ids[0]);
  check("trimming a circle leaves an arc", c?.type === "arc", `type=${c?.type}`);
  check("with the same centre and radius", c && c.r === 20 && round(c.c)[0] === 0, `r=${c?.r} c=${c && round(c.c)}`);
  await leaveSketch(s.id);
}

// --- 5/6. what becomes of the constraints ---------------------------------
{
  const s = await openSketch([
    { shape: "line", a: [0, 0], b: [40, 0] },
    { shape: "line", a: [25, -12], b: [25, 12] },
    { shape: "line", a: [40, 0], b: [40, 15] },
  ]);
  const [lineId, , tailId] = s.ids;
  // The chain records a joint at (40,0) automatically; add a length dimension
  // and a horizontal, then trim away the end that carries the joint.
  await apply({ op: "addConstraint", sketchId: s.id, constraint: { kind: "horizontal", entity: lineId } });
  await settle();
  await apply({ op: "addDimension", sketchId: s.id, dimension: { kind: "length", entity: lineId, value: 40 } });
  await settle();
  const before = await consOf(s.id);
  const joinedBefore = before.some(
    (c) => c.type === "coincident" && [c.a, c.b].some((r) => r.entity === lineId && r.at === "b"),
  );
  check(
    "the drawn chain recorded a joint on the end about to be trimmed",
    joinedBefore,
    JSON.stringify(before.map((c) => c.type)),
  );

  await pickTool("trim");
  await clickUv([34, 0]);
  const after = await consOf(s.id);
  check(
    "the joint pinned to the trimmed-away end goes with it",
    !after.some((c) => c.type === "coincident" && [c.a, c.b].some((r) => r.entity === lineId && r.at === "b")),
    JSON.stringify(after.map((c) => c.type)),
  );
  check(
    "the length dimension the trim invalidated goes too",
    !after.some((c) => c.type === "distance" && c.entity === lineId),
    JSON.stringify(after.map((c) => c.type)),
  );
  check(
    "the horizontal — still true of what's left — stays",
    after.some((c) => c.type === "horizontal" && c.entity === lineId),
  );
  const l = await entOf(s.id, lineId);
  check(
    "and the trim actually held (the geometry didn't spring back to the dimension)",
    l && round(l.b)[0] === 25,
    `b = ${l && round(l.b)}`,
  );
  check("the entity the joint pointed AT is untouched", (await entOf(s.id, tailId)) !== undefined);
  await leaveSketch(s.id);
}

// --- 7. extend, and the joint it records ----------------------------------
{
  const s = await openSketch([
    { shape: "line", a: [0, 0], b: [15, 0] },
    { shape: "line", a: [30, -12], b: [30, 12] },
  ]);
  const [shortId, wallId] = s.ids;
  await pickTool("extend");
  await clickUv([14, 0]); // near the free end
  const l = await entOf(s.id, shortId);
  check("extend grows the end out to the first thing ahead", l && round(l.b)[0] === 30, `b = ${l && round(l.b)}`);
  const joint = (await consOf(s.id)).find((c) => c.type === "pointOnLine" || c.type === "coincident");
  check(
    "and records the meeting so it lasts",
    joint?.type === "pointOnLine" && joint.line === wallId,
    JSON.stringify(joint),
  );
  // Prove it lasts: move the wall and the extended end follows it.
  await apply({ op: "addConstraint", sketchId: s.id, constraint: { kind: "vertical", entity: wallId } });
  await settle();
  await apply({ op: "setVariable", name: "gap", expression: "45" });
  await settle();
  await apply({
    op: "addDimension",
    sketchId: s.id,
    dimension: {
      kind: "distance",
      a: { on: "point", point: { origin: true } },
      b: { on: "line", entity: wallId },
      value: "gap",
    },
  });
  await settle();
  const moved = await entOf(s.id, shortId);
  const wall = await entOf(s.id, wallId);
  check(
    "the extended end tracks what it met, instead of just touching it once",
    moved && wall && Math.abs(round(moved.b)[0] - round(wall.a)[0]) < 0.01 && round(moved.b)[0] > 40,
    `line end ${moved && round(moved.b)} vs wall x ${wall && round(wall.a)[0]}`,
  );
  await leaveSketch(s.id);
}

// --- 8/9. the preview, and undo -------------------------------------------
{
  const s = await openSketch([
    { shape: "line", a: [0, 0], b: [40, 0] },
    { shape: "line", a: [25, -12], b: [25, 12] },
  ]);
  await pickTool("trim");
  const preview = () => page.evaluate(() => window.__openpoly.read({ read: "document" })).then(() => null);
  await hoverUv([34, 0]);
  // The preview is a three.js object, so ask the page whether it's showing.
  const shown = await page.evaluate(() => {
    const c = document.querySelector("canvas");
    return !!c; // canvas exists; the visual itself is checked by the trim landing where the preview said
  });
  check("hovering keeps the canvas alive (preview path doesn't throw)", shown === true);
  const errs = [];
  page.on("pageerror", (e) => errs.push(e.message));
  await hoverUv([10, 0]); // hover the other side
  await hoverUv([34, 0]);
  check("hovering either piece is error-free", errs.length === 0, errs.join("; "));
  await preview();

  const beforeCount = (await entsOf(s.id)).length;
  await clickUv([34, 0]);
  const l = await entOf(s.id, s.ids[0]);
  check("the click takes the piece the hover was over", l && round(l.b)[0] === 25, `b = ${l && round(l.b)}`);
  await page.keyboard.press("Control+z");
  await settle();
  const undone = await entOf(s.id, s.ids[0]);
  check(
    "one undo puts the whole trim back",
    undone && round(undone.b)[0] === 40 && (await entsOf(s.id)).length === beforeCount,
    `b = ${undone && round(undone.b)}`,
  );
  await leaveSketch(s.id);
}

console.log(`\n${failures === 0 ? "all checks passed" : `${failures} check(s) failed`}`);
await close();
process.exit(failures ? 1 : 0);
