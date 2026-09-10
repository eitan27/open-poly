// A dimension typed as a variable must FOLLOW that variable.
//
// The bug: a dimension's typed text was evaluated once, at apply time, and only
// the number was stored. Set `w = 40`, dimension a line's length as `w`, and the
// line became 40 long — with nothing in the document left connecting it to `w`.
// Change `w` to 60 and the line stayed at 40 forever. Same for radius, angle,
// and the distance-between dimension, and the solids built on those sketches
// inherited the staleness.
//
// The fix stores the typed text as `expr` beside the number; when the variables
// change, expression-backed dimensions are re-evaluated and their sketches
// re-solved.
//
// Checks:
//   1. a length dimensioned as `w` moves when `w` moves (the original bug)
//   2. it also moves for an EXPRESSION over variables, not just a bare name
//   3. radius and angle follow too
//   4. a plainly-numeric dimension stores no link and never moves
//   5. the geometry a sketch feeds (an extrude) picks the change up
//   6. a variable that would collapse the geometry (0 / negative / deleted)
//      leaves the last good value in place rather than wrecking the sketch
//   7. the re-link adds no undo step of its own: one undo returns the variable
//      AND the geometry
//   8. the same through the UI — typing `w` into the dimension box stores the
//      link, and REOPENING that dimension offers `w` back, not its evaluation
//      (offering the number would silently cut the link on any edit)
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
  await page.waitForTimeout(500); // the re-solve is async and lands after the regen
  await waitIdle();
};

let failures = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

const sketchOf = async (id) => (await read({ read: "document" })).features.find((f) => f.id === id);
const entOf = async (sketchId, entId) => (await sketchOf(sketchId)).entities.find((e) => e.id === entId);
const lineLength = async (sketchId, entId) => {
  const l = await entOf(sketchId, entId);
  return +Math.hypot(l.b[0] - l.a[0], l.b[1] - l.a[1]).toFixed(3);
};
// Each case gets its OWN line/sketch: a second dimension of the same kind on the
// same entity is correctly refused as redundant through this path (the dialog
// replaces one; the agent op doesn't), which would otherwise look like the
// feature failing.
const dimension = async (sketchId, spec) => {
  const r = await apply({ op: "addDimension", sketchId, dimension: spec });
  if (r?.ok === false) check(`addDimension ${spec.kind} was accepted`, false, JSON.stringify(r).slice(0, 120));
  await settle();
  return r;
};
const lineSketch = async (datum, from, to) => {
  const r = await apply({ op: "addSketch", plane: { datum }, entities: [{ shape: "line", a: from, b: to }] });
  await waitIdle();
  return { id: r.createdId, lineId: (await sketchOf(r.createdId)).entities[0].id };
};
const setVar = async (name, expression) => {
  await apply({ op: "setVariable", name, expression });
  await settle();
};

await waitIdle();

// --- 1. a length dimensioned as a variable ------------------------------
await setVar("w", "40");
const sk = await apply({
  op: "addSketch",
  plane: { datum: "top" },
  entities: [{ shape: "line", a: [0, 0], b: [25, 0] }],
});
await waitIdle();
const lineId = (await sketchOf(sk.createdId)).entities[0].id;
await dimension(sk.createdId, { kind: "length", entity: lineId, value: "w" });
check("dimensioning as `w` sets the length to w", (await lineLength(sk.createdId, lineId)) === 40);

const stored = (await sketchOf(sk.createdId)).constraints.find((c) => c.type === "distance");
check("the typed text is kept as the link", stored?.expr === "w", `constraint=${JSON.stringify(stored)}`);

await setVar("w", "60");
check(
  "changing w moves the line (the original bug)",
  (await lineLength(sk.createdId, lineId)) === 60,
  `length=${await lineLength(sk.createdId, lineId)}`,
);

await setVar("w", "25.5");
check("and follows a non-integer too", (await lineLength(sk.createdId, lineId)) === 25.5);

// --- 2. an expression over variables -------------------------------------
await setVar("wall", "3");
const expr = await lineSketch("top", [0, 10], [20, 10]);
await dimension(expr.id, { kind: "length", entity: expr.lineId, value: "w - wall * 2" });
check(
  "an expression dimension evaluates",
  (await lineLength(expr.id, expr.lineId)) === 19.5,
  `w=25.5 wall=3 → ${await lineLength(expr.id, expr.lineId)}`,
);
await setVar("wall", "5");
check(
  "and re-evaluates when a variable inside it moves",
  (await lineLength(expr.id, expr.lineId)) === 15.5,
  `length=${await lineLength(expr.id, expr.lineId)} (want 25.5 - 10)`,
);

// --- 3. radius and angle -------------------------------------------------
const sk2 = await apply({
  op: "addSketch",
  plane: { datum: "front" },
  entities: [{ shape: "circle", c: [0, 0], r: 5 }],
});
await waitIdle();
const circId = (await sketchOf(sk2.createdId)).entities[0].id;
await setVar("r", "8");
await dimension(sk2.createdId, { kind: "radius", entity: circId, value: "r" });
const radius = async () => +(await entOf(sk2.createdId, circId)).r.toFixed(3);
check("radius follows its variable", (await radius()) === 8, `r=${await radius()}`);
await setVar("r", "12");
check("radius re-evaluates", (await radius()) === 12, `r=${await radius()}`);

const sk3 = await apply({
  op: "addSketch",
  plane: { datum: "right" },
  entities: [
    { shape: "line", a: [0, 0], b: [20, 0] },
    { shape: "line", a: [0, 0], b: [15, 8] },
  ],
});
await waitIdle();
const [la, lb] = (await sketchOf(sk3.createdId)).entities.map((e) => e.id);
await setVar("ang", "30");
await dimension(sk3.createdId, { kind: "angle", a: la, b: lb, value: "ang" });
const included = async () => {
  const s = await sketchOf(sk3.createdId);
  const [A, B] = [s.entities.find((e) => e.id === la), s.entities.find((e) => e.id === lb)];
  const ang = (l) => Math.atan2(l.b[1] - l.a[1], l.b[0] - l.a[0]);
  return +((Math.abs(ang(B) - ang(A)) * 180) / Math.PI).toFixed(1);
};
check("angle follows its variable", Math.abs((await included()) - 30) < 0.5, `angle=${await included()}`);
await setVar("ang", "55");
check("angle re-evaluates", Math.abs((await included()) - 55) < 0.5, `angle=${await included()}`);

// --- 4. a plain number stores no link ------------------------------------
const fixed = await lineSketch("top", [0, 20], [20, 20]);
await dimension(fixed.id, { kind: "length", entity: fixed.lineId, value: 30 });
const plain = (await sketchOf(fixed.id)).constraints.find((c) => c.type === "distance");
check("a numeric dimension stores no link", plain?.expr === undefined, `constraint=${JSON.stringify(plain)}`);
check("and sets the length", (await lineLength(fixed.id, fixed.lineId)) === 30);
await setVar("w", "99");
check(
  "and never moves on its own",
  (await lineLength(fixed.id, fixed.lineId)) === 30,
  `length=${await lineLength(fixed.id, fixed.lineId)}`,
);
check("while the linked one does", (await lineLength(sk.createdId, lineId)) === 99);

// --- 5. the solid built on the sketch follows ----------------------------
const sk4 = await apply({
  op: "addSketch",
  plane: { datum: "top" },
  entities: [{ shape: "circle", c: [0, 0], r: 5 }],
});
await waitIdle();
const holeId = (await sketchOf(sk4.createdId)).entities[0].id;
await setVar("bore", "6");
await dimension(sk4.createdId, { kind: "radius", entity: holeId, value: "bore" });
const ex = await apply({ op: "addExtrude", profile: { sketchId: sk4.createdId }, distance: 10 });
await settle();
const bboxWidth = async () => {
  const b = (await read({ read: "sceneSummary" })).bodies.find((x) => x.id === ex.createdId);
  return b ? +(b.bbox.max[0] - b.bbox.min[0]).toFixed(2) : null;
};
const before = await bboxWidth();
await setVar("bore", "11");
const after = await bboxWidth();
check(
  "an extrude of the sketch picks the change up",
  before !== null && after !== null && after > before + 8,
  `body width ${before} → ${after} (radius 6 → 11)`,
);

// --- 6. a value that would wreck the sketch is refused -------------------
await setVar("bore", "0");
check(
  "a variable at 0 leaves the last good value, not a collapsed sketch",
  (await bboxWidth()) === after,
  `body width stayed ${await bboxWidth()}`,
);
await setVar("bore", "-4");
check("a negative one too", (await bboxWidth()) === after, `body width ${await bboxWidth()}`);
await setVar("bore", "9");
check(
  "and it recovers when the variable is sane again",
  (await bboxWidth()) < after,
  `body width ${await bboxWidth()}`,
);

// --- 7. the re-link is not its own undo step -----------------------------
{
  const w0 = await lineLength(sk2.createdId, circId).catch(() => null);
  void w0;
  const r0 = await radius();
  await setVar("r", "20");
  check("setup: radius moved to 20", (await radius()) === 20);
  await page.keyboard.press("Control+z");
  await settle();
  const vars = (await read({ read: "document" })).variables;
  const rVar = vars.find((v) => v.name === "r")?.expression;
  check(
    "one undo takes back both the variable and the geometry",
    rVar === "12" && (await radius()) === r0,
    `r variable=${rVar} (want 12), radius=${await radius()} (want ${r0})`,
  );
}

// --- 8. the same through the dimension box, typed by hand ----------------
// The agent path and the dialog build the constraint separately, so the link has
// to be recorded in both.
{
  await apply({ op: "newDocument" });
  await waitIdle();
  await apply({ op: "setVariable", name: "len", expression: "35" });
  const uiSk = await apply({
    op: "addSketch",
    plane: { datum: "top" },
    entities: [{ shape: "line", a: [-20, 0], b: [10, 0] }],
  });
  await waitIdle();
  const uiId = uiSk.createdId;
  const uiLine = (await sketchOf(uiId)).entities[0].id;
  await page.locator(".tree-row", { hasText: "Sketch" }).first().dblclick();
  await page.waitForTimeout(700);
  const canvas = await page.locator("canvas").first().boundingBox();
  const clickWorld = async (w) => {
    const pt = await page.evaluate((q) => window.__openpoly.worldToScreen(q), w);
    await page.mouse.click(canvas.x + pt.x, canvas.y + pt.y);
    await page.waitForTimeout(250);
  };

  await clickWorld([-5, 0, 0]); // the line's midpoint
  await page.evaluate(() => document.activeElement?.blur());
  await page.keyboard.press("d");
  await page.waitForTimeout(400);
  const box = page.locator(".dim-value input");
  const opened = (await box.count()) === 1;
  check("the dimension box opens on the picked line", opened);
  if (opened) {
    await box.fill("len");
    await page.keyboard.press("Enter");
    await settle();
    const c = (await sketchOf(uiId)).constraints.find((x) => x.type === "distance");
    check("typing a variable into the box stores the link", c?.expr === "len", `constraint=${JSON.stringify(c)}`);
    check("and applies it", (await lineLength(uiId, uiLine)) === 35, `length=${await lineLength(uiId, uiLine)}`);

    await apply({ op: "setVariable", name: "len", expression: "50" });
    await settle();
    check(
      "a dimension typed in the UI follows its variable",
      (await lineLength(uiId, uiLine)) === 50,
      `length=${await lineLength(uiId, uiLine)}`,
    );

    // Reopen it: the box must offer the expression back, not the number.
    await page
      .locator(".dim-label, .dim-text")
      .first()
      .dblclick({ timeout: 3000 })
      .catch(() => {});
    await page.waitForTimeout(500);
    const reopened = (await page.locator(".dim-value input").count()) === 1;
    if (reopened) {
      const shown = await page.locator(".dim-value input").inputValue();
      check("reopening the dimension offers the expression, not its value", shown === "len", `showed "${shown}"`);
      await page.keyboard.press("Escape");
    } else {
      check("reopening the dimension offers the expression, not its value", false, "couldn't reopen the label");
    }
  }
}

console.log(`\n${failures === 0 ? "all checks passed" : `${failures} check(s) failed`}`);
await browser.close();
process.exit(failures ? 1 : 0);
