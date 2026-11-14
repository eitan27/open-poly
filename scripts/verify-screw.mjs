// Screw feature end to end: every head builds on a plane, a screw follows a
// metric hole's size and sits on its counterbore floor (one per hole), and the
// dialog opens with its diagram and ghost. Screenshots go to $SHOTS.
//
//   URL=http://localhost:5173/ node scripts/verify-screw.mjs
import os from "node:os";
import path from "node:path";
import { launch, openPoly, checker } from "./lib/harness.mjs";

const SHOTS = process.env.SHOTS ?? os.tmpdir();
const { page, errors, close } = await launch({ deviceScaleFactor: 2 });
const op = openPoly(page);
const { check, done } = checker();
const shot = (name) => page.screenshot({ path: path.join(SHOTS, `screw-${name}.png`) });

await op.newDocument();
const box = (await op.applySettled({ op: "addPrimitive", kind: "box", params: { width: 60, depth: 40, height: 12 } }))
  .createdId;
const sk = (
  await op.applySettled({
    op: "addSketch",
    plane: { bodyId: box, faceName: `${box}/+z` },
    entities: [-18, -6, 6, 18].map((x) => ({ shape: "point", p: [x, 0] })),
  })
).createdId;
const hole = (await op.applySettled({ op: "addHole", sketchId: sk, holeType: "counterbore", size: "M5" })).createdId;

for (const [head, x] of [
  ["socket", -30],
  ["button", -10],
  ["flat", 10],
  ["hex", 30],
]) {
  const r = await op.applySettled({
    op: "addScrew",
    plane: { datum: "top" },
    head,
    size: "M5",
    params: { length: 16, centerX: x, centerY: 40 },
  });
  const b = (await op.scene()).bodies.find((x) => x.id === r.createdId);
  check(`${head}: builds on a plane`, r.ok && !!b, JSON.stringify(r));
  // On the Top datum the shank runs down from z = 0: 16 long (overall for flat).
  if (b) check(`${head}: tip at -16`, Math.abs(b.bbox.min[2] + 16) < 0.05, JSON.stringify(b.bbox));
}

const inHole = await op.applySettled({
  op: "addScrew",
  holeId: hole,
  head: "socket",
  size: "M3",
  params: { length: 16 },
});
const parts = (await op.scene()).bodies.filter((b) => b.id.split("#")[0] === inHole.createdId);
check("in a hole: one screw per hole", parts.length === 4, String(parts.length));
const top = Math.max(...parts.map((b) => b.bbox.max[2]));
// Plate top z = 12, M5 counterbore 5.4 deep, socket head 5 tall → head top 11.6.
check("in a hole: seated on the counterbore floor", Math.abs(top - 11.6) < 0.05, String(top));
const w = parts[0] ? parts[0].bbox.max[0] - parts[0].bbox.min[0] : 0;
check("in a hole: takes the hole's M5 size (8.5 head)", Math.abs(w - 8.5) < 0.1, String(w));
check("no feature errors", (await op.featureErrors()).length === 0, JSON.stringify(await op.featureErrors()));
await op.apply({ op: "screenshot", view: "iso" }).catch(() => {});
await shot("built");

// The dialog: U opens it in the newest hole; diagram + ghost; focus lights a dimension.
await page
  .locator(".viewport canvas")
  .first()
  .hover({ position: { x: 5, y: 5 } });
await page.keyboard.press("u");
const dialog = page.locator(".hole-dialog");
await dialog.waitFor({ timeout: 3000 });
await page.waitForTimeout(1500);
check("the dialog shows a diagram", (await dialog.locator("svg.dg").count()) === 1);
check("it opens in the hole, size following it", (await dialog.locator("select").last().inputValue()) === "M5");
await dialog.locator(".ed-field", { hasText: "Length" }).locator("input").focus();
await page.waitForTimeout(300);
check("focusing Length lights its dimension", (await dialog.locator(".dg-active").count()) > 0);
for (const h of ["Button", "Countersunk", "Hex", "Socket"]) {
  await dialog.locator("button", { hasText: h }).click();
  await page.waitForTimeout(400);
  await dialog.screenshot({ path: path.join(SHOTS, `screw-dialog-${h.toLowerCase()}.png`) });
}
await shot("ghost");
await dialog.locator("button", { hasText: "On a plane" }).click();
await page.waitForTimeout(300);
check("on a plane offers centre fields", (await dialog.locator(".ed-field", { hasText: "Center X" }).count()) === 1);
const before = (await op.features()).filter((f) => f.type === "screw").length;
await dialog.locator(".ed-primary").click();
await op.settle();
check("Create adds a screw", (await op.features()).filter((f) => f.type === "screw").length === before + 1);

const real = errors.filter((e) => !/Failed to load resource/.test(e));
check("no page errors", real.length === 0, real.join("\n"));
await close();
done();
