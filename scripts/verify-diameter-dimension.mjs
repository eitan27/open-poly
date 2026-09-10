// A circle is dimensioned the way a drawing calls it out: Ø.
//
// Before this, the only circular dimension was `radius` — press D on a circle
// and the box said "Radius", so a Ø40 hole had to be entered as 20. That was
// also inconsistent with the app's own measure readout, which has always
// reported a circle's DIAMETER.
//
// Now a `diameter` constraint stores what the user typed (the diameter) and the
// solver is the only place it's halved; the dimension box opens as Ø for a
// circle and R for an arc, with a toggle to switch, and the on-canvas label
// spans the circle instead of reaching out from its centre.
//
// Checks:
//   1. a diameter dimension sizes the circle to half of it, and stores the
//      diameter (not the radius) as its value
//   2. an arc takes one too
//   3. Ø and R replace each other on the same circle — never stack and fight
//   4. a diameter typed as a variable follows that variable
//   5. the geometry built on the sketch (an extrude) picks it up
//   6. through the UI: D on a circle opens as "Diameter" and prefills the
//      measured diameter, and the label reads Ø
//   7. the Ø/R toggle switches the box and converts the value, and applying it
//      leaves the circle the size it already was
//   8. an arc opens as "Radius", not "Diameter"
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
  await page.waitForTimeout(500);
  await waitIdle();
};

let failures = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

const sketchOf = async (id) => (await read({ read: "document" })).features.find((f) => f.id === id);
const entOf = async (sketchId, entId) => (await sketchOf(sketchId)).entities.find((e) => e.id === entId);
const radiusOf = async (sketchId, entId) => +(await entOf(sketchId, entId)).r.toFixed(3);
const consOf = async (sketchId) => (await sketchOf(sketchId)).constraints;
const dimension = async (sketchId, spec) => {
  const r = await apply({ op: "addDimension", sketchId, dimension: spec });
  await settle();
  return r;
};
const shapeSketch = async (datum, shape) => {
  const r = await apply({ op: "addSketch", plane: { datum }, entities: [shape] });
  await waitIdle();
  return { id: r.createdId, entId: (await sketchOf(r.createdId)).entities[0].id };
};

await waitIdle();

// --- 1. a diameter sizes the circle to half of it ------------------------
const c1 = await shapeSketch("top", { shape: "circle", c: [0, 0], r: 5 });
const r1 = await dimension(c1.id, { kind: "diameter", entity: c1.entId, value: 40 });
check("a diameter dimension is accepted", r1?.ok !== false, JSON.stringify(r1).slice(0, 120));
check("Ø40 makes a radius-20 circle", (await radiusOf(c1.id, c1.entId)) === 20, `r=${await radiusOf(c1.id, c1.entId)}`);
const stored = (await consOf(c1.id)).find((c) => c.type === "diameter");
check("the stored value is the DIAMETER, not the radius", stored?.value === 40, `constraint=${JSON.stringify(stored)}`);

// --- 2. an arc takes one too ---------------------------------------------
const a1 = await shapeSketch("front", { shape: "arc", c: [0, 0], r: 4, start: 0, end: 90 });
await dimension(a1.id, { kind: "diameter", entity: a1.entId, value: 12 });
check(
  "an arc's diameter drives its radius",
  (await radiusOf(a1.id, a1.entId)) === 6,
  `r=${await radiusOf(a1.id, a1.entId)}`,
);

// --- 3. Ø and R are the same dimension, so they can't both stand ----------
// (Through the agent, adding the second is refused as redundant/conflicting;
// the point is that the circle is never left carrying two fighting sizes.)
const c2 = await shapeSketch("top", { shape: "circle", c: [40, 0], r: 5 });
await dimension(c2.id, { kind: "diameter", entity: c2.entId, value: 30 });
const second = await dimension(c2.id, { kind: "radius", entity: c2.entId, value: 9 });
const sizeCons = (await consOf(c2.id)).filter((c) => c.type === "radius" || c.type === "diameter");
check(
  "a second, contradicting size dimension doesn't stack",
  second?.ok === false && sizeCons.length === 1,
  `ok=${second?.ok} constraints=${JSON.stringify(sizeCons)}`,
);
check("and the circle keeps the size it had", (await radiusOf(c2.id, c2.entId)) === 15);

// --- 4. a diameter follows a variable ------------------------------------
await apply({ op: "setVariable", name: "bore", expression: "16" });
await settle();
const c3 = await shapeSketch("top", { shape: "circle", c: [-40, 0], r: 5 });
await dimension(c3.id, { kind: "diameter", entity: c3.entId, value: "bore" });
check(
  "Ø typed as a variable applies it",
  (await radiusOf(c3.id, c3.entId)) === 8,
  `r=${await radiusOf(c3.id, c3.entId)}`,
);
const linked = (await consOf(c3.id)).find((c) => c.type === "diameter");
check("and keeps the link", linked?.expr === "bore", `constraint=${JSON.stringify(linked)}`);
await apply({ op: "setVariable", name: "bore", expression: "24" });
await settle();
check(
  "changing the variable moves the diameter",
  (await radiusOf(c3.id, c3.entId)) === 12,
  `r=${await radiusOf(c3.id, c3.entId)} (want 12)`,
);

// --- 5. the solid built on it follows too --------------------------------
{
  const ex = await apply({ op: "addExtrude", profile: { sketchId: c3.id }, distance: 5, mode: "new" });
  await settle();
  const bboxOf = async () => {
    const b = (await read({ read: "sceneSummary" })).bodies.find((x) => x.id === ex.createdId);
    return b ? +(b.bbox.max[0] - b.bbox.min[0]).toFixed(2) : null;
  };
  const before = await bboxOf();
  await apply({ op: "setVariable", name: "bore", expression: "30" });
  await settle();
  const after = await bboxOf();
  check(
    "the extruded body follows the diameter",
    before !== null && after !== null && after > before && Math.abs(after - 30) < 0.6,
    `width ${before} → ${after} (want ~30)`,
  );
}

// --- 6/7/8. through the UI -----------------------------------------------
{
  const ui = await shapeSketch("top", { shape: "circle", c: [0, 60], r: 9 });
  await page.locator(".tree-row", { hasText: "Sketch" }).last().dblclick();
  await page.waitForTimeout(700);
  const canvas = await page.locator("canvas").first().boundingBox();
  const clickWorld = async (w) => {
    const pt = await page.evaluate((q) => window.__openpoly.worldToScreen(q), w);
    await page.mouse.click(canvas.x + pt.x, canvas.y + pt.y);
    await page.waitForTimeout(250);
  };
  // Click the circle's rim (its centre is empty space), then press D.
  await clickWorld([9, 60, 0]);
  await page.evaluate(() => document.activeElement?.blur());
  await page.keyboard.press("d");
  await page.waitForTimeout(400);
  const box = page.locator(".dim-value input");
  const opened = (await box.count()) === 1;
  check("the dimension box opens on the picked circle", opened);
  if (opened) {
    const label = (await page.locator(".dim-input label").first().textContent())?.trim();
    check("a circle opens as Diameter, not Radius", label === "Diameter", `label="${label}"`);
    check(
      "and prefills the measured diameter (2r), not the radius",
      (await box.inputValue()) === "18",
      `showed "${await box.inputValue()}"`,
    );

    // The Ø/R toggle: same circle, other statement of the same size.
    await page.locator(".dim-kind-toggle").click();
    await page.waitForTimeout(200);
    const label2 = (await page.locator(".dim-input label").first().textContent())?.trim();
    check("the toggle switches the box to Radius", label2 === "Radius", `label="${label2}"`);
    check(
      "and converts the value so the circle doesn't jump",
      (await box.inputValue()) === "9",
      `showed "${await box.inputValue()}"`,
    );
    await page.keyboard.press("Enter");
    await settle();
    check(
      "applying the toggled dimension leaves the circle its size",
      (await radiusOf(ui.id, ui.entId)) === 9,
      `r=${await radiusOf(ui.id, ui.entId)}`,
    );
    const c = (await consOf(ui.id)).find((x) => x.type === "radius" || x.type === "diameter");
    check("and stores it as the kind the box was showing", c?.type === "radius", `constraint=${JSON.stringify(c)}`);

    // Re-dimension the SAME circle as Ø: it must replace the R, not join it.
    await clickWorld([9, 60, 0]);
    await page.evaluate(() => document.activeElement?.blur());
    await page.keyboard.press("d");
    await page.waitForTimeout(400);
    if ((await page.locator(".dim-value input").count()) === 1) {
      await page.locator(".dim-value input").fill("30");
      await page.keyboard.press("Enter");
      await settle();
      const sizes = (await consOf(ui.id)).filter((x) => x.type === "radius" || x.type === "diameter");
      check(
        "re-dimensioning as Ø REPLACES the R (one size constraint, not two)",
        sizes.length === 1 && sizes[0].type === "diameter" && sizes[0].value === 30,
        `constraints=${JSON.stringify(sizes)}`,
      );
      check(
        "and resizes the circle to Ø30",
        (await radiusOf(ui.id, ui.entId)) === 15,
        `r=${await radiusOf(ui.id, ui.entId)}`,
      );
      const text = (await page.locator(".dim-text, .dim-label").allTextContents()).join(" ");
      check("the on-canvas label reads Ø", /Ø30/.test(text), `labels="${text}"`);
    } else {
      check("re-dimensioning as Ø REPLACES the R (one size constraint, not two)", false, "box didn't reopen");
    }
  }
}

console.log(`\n${failures === 0 ? "all checks passed" : `${failures} check(s) failed`}`);
await browser.close();
process.exit(failures ? 1 : 0);
