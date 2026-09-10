// A coincidence is a fact the sketch records, not an accident of position.
//
// The solver used to decide which vertices were "the same point" by rounding
// their coordinates and comparing: two endpoints that happened to sit on the
// same spot became one solver point. Nothing in the document said they were
// joined, so the joint lasted exactly as long as the coordinates agreed — and
// anything that moved one vertex without moving the other tore the sketch open
// with no warning. Dragging the corner where a line meets an arc did exactly
// that (a drag relocates a line's endpoint and an arc's CENTRE, so the arc's
// endpoint was left behind and silently detached).
//
// Point identity is referential now — one solver point per entity vertex — and
// geometry that arrives already joined has that joint written down as a
// `coincident` constraint.
//
// Checks:
//   1. drawn/authored geometry records its joints (chain, rectangle, arc-on-line)
//   2. a rectangle gets four joints, not six — no dead weight for the solver
//   3. vertices on the origin record none (the origin pins them as ground)
//   4. the joint survives a solve that MOVES the corner a long way
//   5. dragging the line/arc corner in the viewport keeps the arc attached
//      (the tear this fixes)
//   6. the joint is what holds them: remove it and they separate — which was
//      impossible when the joint was implied by position
//   7. two circles that share a centre are concentric on purpose, and stay so
//   8. dragging a rectangle's corner keeps all four corners closed
import { chromium } from "playwright";
const URL = process.env.URL ?? "http://localhost:5175/";
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
const page = await (await browser.newContext({ viewport: { width: 1660, height: 920 } })).newPage();
page.on("pageerror", (e) => console.log(`[pageerror] ${e.message}`));
await page.goto(URL, { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => window.__openpoly, null, { timeout: 30000 });

const waitIdle = async () => {
  let stable = 0;
  for (let i = 0; i < 250; i++) {
    const s = (await page.locator(".status").textContent())?.trim() ?? "";
    stable = /up to date|error|fail/i.test(s) ? stable + 1 : 0;
    if (stable >= 3) return s;
    await page.waitForTimeout(200);
  }
  return "TIMEOUT";
};
const apply = (o) => page.evaluate((x) => window.__openpoly.apply(x), o);
const read = (q) => page.evaluate((x) => window.__openpoly.read(x), q);
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
const joints = async (id) => (await sketchOf(id)).constraints.filter((c) => c.type === "coincident");
const entOf = async (sketchId, entId) => (await sketchOf(sketchId)).entities.find((e) => e.id === entId);
// Where an entity's named vertex actually is, right now.
const vertexAt = async (sketchId, entId, at) => {
  const e = await entOf(sketchId, entId);
  if (e.type === "line") return at === "b" ? e.b : e.a;
  if (e.type === "circle") return e.c;
  if (at === "c") return e.c;
  const ang = at === "a" ? e.start : e.end;
  return [e.c[0] + e.r * Math.cos(ang), e.c[1] + e.r * Math.sin(ang)];
};
const gap = (p, q) => +Math.hypot(p[0] - q[0], p[1] - q[1]).toFixed(4);
const makeSketch = async (datum, entities) => {
  const r = await apply({ op: "addSketch", plane: { datum }, entities });
  await waitIdle();
  return { id: r.createdId, ids: (await sketchOf(r.createdId)).entities.map((e) => e.id) };
};

await waitIdle();

// --- 1/2/3. geometry records the joints it arrives with -------------------
{
  // A chain that does NOT touch the origin, so nothing is pinned as ground.
  const chain = await makeSketch("top", [
    { shape: "line", a: [5, 5], b: [25, 5] },
    { shape: "line", a: [25, 5], b: [25, 25] },
  ]);
  const js = await joints(chain.id);
  check("a chained polyline records its corner", js.length === 1, `${js.length} joints: ${JSON.stringify(js)}`);

  const rect = await makeSketch("top", [
    { shape: "line", a: [40, 5], b: [60, 5] },
    { shape: "line", a: [60, 5], b: [60, 25] },
    { shape: "line", a: [60, 25], b: [40, 25] },
    { shape: "line", a: [40, 25], b: [40, 5] },
  ]);
  const rj = await joints(rect.id);
  check("a rectangle records four corners, not six", rj.length === 4, `${rj.length} joints`);

  const onOrigin = await makeSketch("front", [
    { shape: "line", a: [0, 0], b: [20, 0] },
    { shape: "line", a: [0, 0], b: [0, 20] },
  ]);
  check(
    "two vertices ON THE ORIGIN record none (the origin is ground)",
    (await joints(onOrigin.id)).length === 0,
    JSON.stringify(await joints(onOrigin.id)),
  );
}

// --- 4/6. the joint holds a corner, and IS what holds it ------------------
{
  const s = await makeSketch("top", [
    { shape: "line", a: [0, 0], b: [10, 0] },
    { shape: "arc", c: [10, 5], r: 5, start: -90, end: 0 },
  ]);
  const [lineId, arcId] = s.ids;
  const js = await joints(s.id);
  check("an arc drawn onto a line's end records the joint", js.length === 1, `${js.length} joints`);
  await apply({ op: "addConstraint", sketchId: s.id, constraint: { kind: "horizontal", entity: lineId } });
  await settle();
  // Driven by a variable, so the length can be changed later without adding a
  // second dimension (which this path would rightly refuse as a duplicate).
  await apply({ op: "setVariable", name: "reach", expression: "40" });
  await settle();
  await apply({ op: "addDimension", sketchId: s.id, dimension: { kind: "length", entity: lineId, value: "reach" } });
  await settle();
  const lineEnd = await vertexAt(s.id, lineId, "b");
  const arcStart = await vertexAt(s.id, arcId, "a");
  check(
    "lengthening the line drags the arc's endpoint with it",
    Math.abs(lineEnd[0] - 40) < 0.01 && gap(lineEnd, arcStart) < 0.01,
    `line end ${JSON.stringify(lineEnd)} vs arc start ${JSON.stringify(arcStart)}`,
  );

  // Remove the joint: the two vertices are now genuinely independent, which is
  // exactly what a positional merge could never express.
  if (js.length === 0) {
    check("removing the joint releases the arc — it stays put while the line shrinks", false, "no joint to remove");
  } else {
    await apply({ op: "removeConstraint", sketchId: s.id, constraintId: js[0].id });
    await settle();
    await apply({ op: "setVariable", name: "reach", expression: "15" });
    await settle();
    const end2 = await vertexAt(s.id, lineId, "b");
    const arc2 = await vertexAt(s.id, arcId, "a");
    check(
      "removing the joint releases the arc — it stays put while the line shrinks",
      Math.abs(end2[0] - 15) < 0.01 && gap(end2, arc2) > 1,
      `line end ${JSON.stringify(end2)} vs arc start ${JSON.stringify(arc2)}`,
    );
  }
}

// --- 7. two circles on one centre ----------------------------------------
{
  const s = await makeSketch("front", [
    { shape: "circle", c: [30, 30], r: 4 },
    { shape: "circle", c: [30, 30], r: 9 },
  ]);
  check("circles sharing a centre record it as a joint", (await joints(s.id)).length === 1);
  await apply({ op: "addDimension", sketchId: s.id, dimension: { kind: "radius", entity: s.ids[0], value: 6 } });
  await settle();
  const a = await vertexAt(s.id, s.ids[0], "c");
  const b = await vertexAt(s.id, s.ids[1], "c");
  check(
    "and they stay concentric through a re-solve",
    gap(a, b) < 0.01,
    `${JSON.stringify(a)} vs ${JSON.stringify(b)}`,
  );
}

// --- 5/8. dragging in the viewport ---------------------------------------
{
  const s = await makeSketch("top", [
    { shape: "line", a: [-40, -40], b: [-20, -40] },
    { shape: "arc", c: [-20, -35], r: 5, start: -90, end: 0 },
  ]);
  const [lineId, arcId] = s.ids;
  await page.locator(".tree-row", { hasText: "Sketch" }).last().dblclick();
  await page.waitForTimeout(800);
  const canvas = await page.locator("canvas").first().boundingBox();
  const screenOf = async (uv) => {
    const pt = await page.evaluate((q) => window.__openpoly.worldToScreen(q), [uv[0], uv[1], 0]);
    return { x: canvas.x + pt.x, y: canvas.y + pt.y };
  };
  const corner = await vertexAt(s.id, lineId, "b");
  const from = await screenOf(corner);
  const to = await screenOf([corner[0], corner[1] + 15]);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 12 });
  await page.waitForTimeout(300);
  await page.mouse.up();
  await settle();
  const movedEnd = await vertexAt(s.id, lineId, "b");
  const movedArc = await vertexAt(s.id, arcId, "a");
  check(
    "the drag actually moved the corner",
    gap(movedEnd, corner) > 3,
    `${JSON.stringify(corner)} → ${JSON.stringify(movedEnd)}`,
  );
  check(
    "dragging the line/arc corner keeps the arc attached (the tear this fixes)",
    gap(movedEnd, movedArc) < 0.05,
    `line end ${JSON.stringify(movedEnd)} vs arc start ${JSON.stringify(movedArc)}`,
  );
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
}

{
  const s = await makeSketch("top", [
    { shape: "line", a: [10, -40], b: [30, -40] },
    { shape: "line", a: [30, -40], b: [30, -20] },
    { shape: "line", a: [30, -20], b: [10, -20] },
    { shape: "line", a: [10, -20], b: [10, -40] },
  ]);
  await page.locator(".tree-row", { hasText: "Sketch" }).last().dblclick();
  await page.waitForTimeout(800);
  const canvas = await page.locator("canvas").first().boundingBox();
  const screenOf = async (uv) => {
    const pt = await page.evaluate((q) => window.__openpoly.worldToScreen(q), [uv[0], uv[1], 0]);
    return { x: canvas.x + pt.x, y: canvas.y + pt.y };
  };
  const from = await screenOf([30, -40]);
  const to = await screenOf([38, -46]);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 12 });
  await page.waitForTimeout(300);
  await page.mouse.up();
  await settle();
  // Every corner still closed: each line's end meets the next line's start.
  const ids = s.ids;
  let worst = 0;
  for (let i = 0; i < 4; i++) {
    const end = await vertexAt(s.id, ids[i], "b");
    const start = await vertexAt(s.id, ids[(i + 1) % 4], "a");
    worst = Math.max(worst, gap(end, start));
  }
  check("dragging a rectangle's corner leaves all four corners closed", worst < 0.05, `worst corner gap ${worst}`);
  await page.keyboard.press("Escape");
}

// --- 9. the real drawing path -------------------------------------------
// The checks above author geometry through the agent; a rectangle DRAWN with the
// tool also brings its own horizontal/vertical constraints, so this is where a
// joint that over-constrained the solver would show up.
{
  const r = await apply({ op: "addSketch", plane: { datum: "top" }, entities: [] });
  await waitIdle();
  const drawId = r.createdId;
  await page.locator(".tree-row", { hasText: "Sketch" }).last().dblclick();
  await page.waitForTimeout(800);
  const canvas = await page.locator("canvas").first().boundingBox();
  const clickUv = async (uv) => {
    const pt = await page.evaluate((q) => window.__openpoly.worldToScreen(q), [uv[0], uv[1], 0]);
    await page.mouse.click(canvas.x + pt.x, canvas.y + pt.y);
    await page.waitForTimeout(350);
  };
  await page.evaluate(() => document.activeElement?.blur());
  await page.keyboard.press("r"); // rectangle: 2 corners
  await page.waitForTimeout(300);
  await clickUv([50, 50]);
  await clickUv([80, 70]);
  await settle();
  const sk = await sketchOf(drawId);
  const js = (sk?.constraints ?? []).filter((c) => c.type === "coincident");
  const hv = (sk?.constraints ?? []).filter((c) => c.type === "horizontal" || c.type === "vertical");
  check(
    "a rectangle drawn with the tool records four corners",
    (sk?.entities?.length ?? 0) === 4 && js.length === 4,
    `${sk?.entities?.length} lines, ${js.length} joints, ${hv.length} h/v`,
  );
  // `.sketch-msg` is the transient complaint ("… conflicts with …") a rejected
  // constraint raises; nothing should have raised one.
  const msg = (await page.locator(".sketch-msg").allTextContents()).join(" ").trim();
  check("and the solver takes them without complaint", msg === "", `message="${msg}"`);
  // Closed: each edge's end meets the next edge's start.
  const ids = (sk?.entities ?? []).map((e) => e.id);
  let worst = 0;
  for (let i = 0; i < ids.length; i++) {
    const end = await vertexAt(drawId, ids[i], "b");
    const start = await vertexAt(drawId, ids[(i + 1) % ids.length], "a");
    worst = Math.max(worst, gap(end, start));
  }
  check("the drawn rectangle is closed", worst < 0.05, `worst corner gap ${worst}`);
  await page.keyboard.press("Escape");
}

console.log(`\n${failures === 0 ? "all checks passed" : `${failures} check(s) failed`}`);
await browser.close();
process.exit(failures ? 1 : 0);
