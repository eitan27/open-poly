// Drives the Gear dialog's Rack type end to end: the rack diagram and its
// length readout, Create builds it with named back/end faces, and a rack
// meshed with a spur pinion sits on the pinion's pitch circle and follows it
// when the pinion is resized. Screenshots go to $SHOTS (default: the OS temp dir).
//
//   URL=http://localhost:5180/ node scripts/verify-rack.mjs
import os from "node:os";
import path from "node:path";
import { launch, openPoly, checker } from "./lib/harness.mjs";

const SHOTS = process.env.SHOTS ?? os.tmpdir();
const { page, errors, close } = await launch({ deviceScaleFactor: 2 });
const op = openPoly(page);
const { check, done } = checker();
const shot = (name) => page.screenshot({ path: path.join(SHOTS, `rack-${name}.png`) });

await op.newDocument();
const dialog = page.locator(".gear-dialog");
const fieldInput = (label) => dialog.locator(".ed-field", { hasText: label }).locator("input").first();
const fieldSelect = (label) => dialog.locator(".ed-field", { hasText: label }).locator("select").first();
const openGear = async () => {
  await page
    .locator(".viewport canvas")
    .first()
    .hover({ position: { x: 5, y: 5 } });
  await page.keyboard.press("g");
  await dialog.waitFor({ timeout: 3000 });
};

// 1. A pinion first: 12 teeth, module 2.
await openGear();
await fieldInput("Teeth").fill("12");
await page.waitForTimeout(800);
await dialog.locator(".ed-primary").click();
await op.settle();
const pinion = (await op.features()).find((f) => f.type === "gear");

// 2. A rack on its own: the rack diagram, its length, no bore or pitch diameter.
await openGear();
await fieldSelect("Type").selectOption("rack");
await fieldInput("Teeth").fill("10");
await page.waitForTimeout(1200);
let text = await dialog.textContent();
check("the dialog draws the rack diagram", (await dialog.locator('svg[aria-label="Rack diagram"]').count()) === 1);
check("readout shows the rack's length", /Length 62\.83 mm/.test(text), text.slice(0, 300));
check("no bore or pitch diameter for a rack", !/Bore/.test(text) && !/Pitch Ø/.test(text));
check(
  "Size by has no pitch diameter",
  !(await fieldSelect("Size by").locator("option").allTextContents()).includes("Pitch diameter"),
);
check("a Direction field instead of Rotation", /Direction°/.test(text));
await fieldInput("End margin").fill("5");
await page.waitForTimeout(800);
text = await dialog.textContent();
check("end margins add to the length", /Length 72\.83 mm/.test(text));
await fieldInput("Height").focus();
check(
  "focusing Height lights its dimension",
  (await dialog.locator('.dg-active[data-dim="rackHeight"]').count()) === 1,
);
await shot("1-dialog");
await fieldInput("End margin").fill("0");

// 3. Mesh it with the pinion, below it.
await fieldSelect("Size by").selectOption({ label: pinion.name });
await page.waitForTimeout(600);
text = await dialog.textContent();
check("meshed rack shows the pinion's module", /Module 2 mm/.test(text));
check("and the pinion's distance to its pitch line", /Pinion center to pitch line 12 mm/.test(text), text);
check("Place beside is on", await dialog.locator(".gear-place-beside").isChecked());
check(
  "a 12-tooth pinion is told the shift that clears the rack's tips",
  /clash with the rack's tooth tips.*at least 0\.3 /.test(text),
);
await fieldInput("Angle").fill("-90");
await page.waitForTimeout(1500);
await shot("2-ghost");
await dialog.locator(".ed-primary").click();
await op.settle();
check("two bodies", (await op.bodyCount()) === 2);
check("pair builds without error", (await op.featureErrors()).length === 0, (await op.featureErrors()).join("; "));
const rack = (await op.features()).find((f) => f.type === "gear" && f.gearType === "rack");
const bbox = async (id) => (await op.scene()).bodies.find((b) => b.id === id)?.bbox;
let rb = await bbox(rack.id);
check(
  "the rack's tips reach 2 mm above its pitch line, 12 below the pinion's centre",
  Math.abs(rb.max[1] - -10) < 0.01,
  JSON.stringify(rb),
);
check("12 mm back face below the pitch line", Math.abs(rb.min[1] - -24) < 0.01, JSON.stringify(rb));
check("62.83 mm along X", Math.abs(rb.max[0] - rb.min[0] - 20 * Math.PI) < 0.01);

// Its back and ends are named faces.
const sc = await op.scene();
const faces = sc.bodies.find((b) => b.id === rack.id)?.faces ?? [];
for (const n of ["back", "end0", "end1"])
  check(`face ${n} is named`, faces.includes(`${rack.id}/${n}`), faces.slice(0, 8).join(", "));
await shot("3-pair");

// 4. Resize the pinion: the rack follows (module and pitch line).
await op.apply({ op: "setParam", featureId: pinion.id, name: "module", value: "1.5" });
await op.settle();
rb = await bbox(rack.id);
check("rack follows the pinion's module", Math.abs(rb.max[1] - (-9 + 1.5)) < 0.01, JSON.stringify(rb));
check("still builds", (await op.featureErrors()).length === 0, (await op.featureErrors()).join("; "));
await op.apply({ op: "setParam", featureId: pinion.id, name: "module", value: "2" });
await op.settle();

// 5. The kernel agrees they don't touch: intersecting the two bodies leaves
// nothing (an error or no body), where a rack slid half a tooth does leave one.
const intersect = async () => {
  const r = await op.apply({ op: "boolean", kind: "intersect", operands: [pinion.id, rack.id] });
  await op.settle();
  const out = {
    ok: r.ok,
    error: r.error,
    errs: await op.featureErrors(),
    bodies: (await op.bodies()).map((b) => b.bbox),
  };
  // Take the Intersect back out (it's in the timeline even when it fails).
  for (const f of await op.features()) if (f.type === "boolean") await op.apply({ op: "delete", featureId: f.id });
  await op.settle();
  return out;
};
// A 12-tooth pinion needs a 0.3 shift to clear a rack's tips (the note above).
await op.apply({ op: "setParam", featureId: pinion.id, name: "profileShift", value: "0.3" });
await op.settle();
const meshed = await intersect();
console.log("meshed ∩:", JSON.stringify(meshed));
await op.apply({ op: "setParam", featureId: rack.id, name: "slide", value: "0.5" });
await op.settle();
const clash = await intersect();
console.log("half a tooth ∩:", JSON.stringify(clash));
const empty = (r) => !r.ok && /empty result/.test(r.error ?? "");
check("in mesh: pinion ∩ rack is empty", empty(meshed));
check("control, half a tooth off: pinion ∩ rack is a body", !empty(clash));
await op.apply({ op: "setParam", featureId: rack.id, name: "slide", value: "0" });
await op.settle();

// The dev server has no Pages Functions, so their fetches 502 — not ours; and
// the in-mesh Intersect above fails on purpose.
const real = errors.filter((e) => !/502|Bad Gateway|empty result/.test(e));
check("no page errors", real.length === 0, real.slice(0, 3).join(" | "));
await close();
done();
