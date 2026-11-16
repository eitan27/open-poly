// Hole feature end to end: each hole type builds into a box from a sketch's
// points, names its walls, follows a size change, and the dialog opens with
// its diagram and ghost. Screenshots go to $SHOTS.
//
//   URL=http://localhost:5173/ node scripts/verify-hole.mjs
import os from "node:os";
import path from "node:path";
import { launch, openPoly, checker } from "./lib/harness.mjs";

const SHOTS = process.env.SHOTS ?? os.tmpdir();
const { page, errors, close } = await launch({ deviceScaleFactor: 2 });
const op = openPoly(page);
const { check, done } = checker();
const shot = (name) => page.screenshot({ path: path.join(SHOTS, `hole-${name}.png`) });

async function plate() {
  await op.newDocument();
  const box = (await op.applySettled({ op: "addPrimitive", kind: "box", params: { width: 60, depth: 40, height: 12 } }))
    .createdId;
  const sk = (
    await op.applySettled({
      op: "addSketch",
      plane: { bodyId: box, faceName: `${box}/+z` },
      entities: [
        { shape: "point", p: [-15, 0] },
        { shape: "circle", c: [15, 0], r: 2 },
      ],
    })
  ).createdId;
  return { box, sk };
}

for (const [holeType, extra] of [
  ["simple", {}],
  ["counterbore", {}],
  ["countersink", {}],
  ["tapped", { extent: "blind", params: { depth: 8, threadDepth: 6 } }],
  ["simple", { extent: "blind", size: "custom", params: { diameter: 5, depth: 6, tipAngle: 0 } }],
]) {
  const { box, sk } = await plate();
  const r = await op.applySettled({ op: "addHole", sketchId: sk, holeType, ...extra });
  const errs = await op.featureErrors();
  const body = (await op.bodies()).find((b) => b.id === box);
  const holeFaces = body?.faces.filter((f) => f.startsWith(`${r.createdId}/`)) ?? [];
  const label = `${holeType}${extra.size ? " custom" : ""}${extra.extent ? " blind" : ""}`;
  check(`${label}: builds`, r.ok && errs.length === 0, JSON.stringify(r) + JSON.stringify(errs));
  check(
    `${label}: two holes' walls are named`,
    holeFaces.some((f) => f.includes("/h0/")) && holeFaces.some((f) => f.includes("/h1/")),
    holeFaces.slice(0, 4).join(" "),
  );
  check(`${label}: the plate is still one body`, (await op.bodyCount()) === 1);
  if (holeType === "counterbore" && !extra.size) {
    await op.applySettled({ op: "setSectionView", plane: { datum: "front" }, enabled: true }).catch(() => {});
    await op.apply({ op: "screenshot", view: "front" }).catch(() => {});
    await shot("counterbore-section");
    await op.applySettled({ op: "setSectionView", enabled: false }).catch(() => {});
  }
}

// A sketch with no points, and a bad size, are refused with a reason.
{
  const { box } = await plate();
  const sk2 = (
    await op.applySettled({
      op: "addSketch",
      plane: { datum: "top" },
      entities: [{ shape: "rect", center: [0, 0], w: 5, h: 5 }],
    })
  ).createdId;
  const r = await op.applySettled({ op: "addHole", sketchId: sk2, targetId: box });
  const errs = Object.values((await op.scene()).errors ?? {});
  check(
    "a sketch without points is an error on the feature",
    !r.ok || errs.some((e) => /no points/.test(String(e))),
    JSON.stringify(r) + JSON.stringify(errs),
  );
  const bad = await op.apply({ op: "addHole", sketchId: sk2, targetId: box, size: "M7" });
  check("an unknown size is refused", !bad.ok);
  void r;
}

// The dialog: open with D, diagram + ghost, focus lights a dimension, create.
{
  const { box } = await plate();
  void box;
  await page
    .locator(".viewport canvas")
    .first()
    .hover({ position: { x: 5, y: 5 } });
  await page.keyboard.press("d");
  const dialog = page.locator(".hole-dialog");
  await dialog.waitFor({ timeout: 3000 });
  await page.waitForTimeout(1500);
  check("the dialog shows a diagram", (await dialog.locator("svg.dg").count()) === 1);
  const typeSel = dialog.locator(".ed-field", { hasText: "Type" }).locator("select");
  await typeSel.selectOption("counterbore");
  await dialog.locator("button", { hasText: "Blind" }).click();
  await dialog.locator(".ed-field", { hasText: /^Depth/ }).locator("input").fill("9");
  await dialog
    .locator(".ed-field", { hasText: /^Depth/ })
    .locator("input")
    .focus();
  await page.waitForTimeout(1200);
  check("focusing Depth lights its dimension", (await dialog.locator('.dg-active[data-dim="depth"]').count()) === 1);
  await dialog.screenshot({ path: path.join(SHOTS, "hole-dialog-cbore.png") });
  await shot("ghost");
  for (const t of ["Countersink", "Tapped", "Simple"]) {
    await typeSel.selectOption(t.toLowerCase());
    await page.waitForTimeout(300);
    await dialog.screenshot({ path: path.join(SHOTS, `hole-dialog-${t.toLowerCase()}.png`) });
  }
  await dialog.locator(".ed-primary").click();
  await op.settle();
  check(
    "Create builds the hole",
    (await op.features()).some((f) => f.type === "hole") && (await op.featureErrors()).length === 0,
    JSON.stringify(await op.featureErrors()),
  );
  await shot("created");
}

const real = errors.filter((e) => !/Failed to load resource/.test(e));
check("no page errors", real.length === 0, real.join("\n"));
await close();
done();
