// Thread feature end to end: every profile builds as a rod (1 and 2 starts,
// either hand) with every face meshed; an internal thread cuts a block; a rod
// threaded into it doesn't touch it (an oversized one does); and the dialog
// opens with its diagram. Screenshots go to $SHOTS.
//
//   URL=http://localhost:5173/ node scripts/verify-thread.mjs
import os from "node:os";
import path from "node:path";
import { launch, openPoly, checker } from "./lib/harness.mjs";

const SHOTS = process.env.SHOTS ?? os.tmpdir();
const { page, errors, close } = await launch({ deviceScaleFactor: 2 });
const op = openPoly(page);
const { check, done } = checker();
const unmeshed = [];
page.on("console", (m) => /UNMESHED|recovered \d+ dropped/.test(m.text()) && unmeshed.push(m.text()));
const shot = (name) => page.screenshot({ path: path.join(SHOTS, `thread-${name}.png`) });

await op.newDocument();
const points = (
  await op.applySettled({
    op: "addSketch",
    plane: { datum: "top" },
    entities: [{ shape: "point", p: [0, 0] }],
  })
).createdId;
let i = 0;
for (const profile of ["printable", "iso", "trapezoid"])
  for (const [starts, leftHand] of [
    [1, false],
    [2, true],
  ]) {
    const sk = (
      await op.applySettled({
        op: "addSketch",
        plane: { datum: "top" },
        entities: [{ shape: "point", p: [(i % 3) * 25 - 25, Math.floor(i / 3) * 25] }],
      })
    ).createdId;
    i++;
    const t0 = Date.now();
    const r = await op.applySettled({
      op: "addThread",
      sketchId: sk,
      profile,
      leftHand,
      params: { diameter: 16, pitch: 2.5, length: 20, starts },
    });
    const b = (await op.scene()).bodies.find((x) => x.id === r.createdId);
    const label = `${profile}, ${starts} start${leftHand ? ", left-hand" : ""}`;
    check(`${label}: builds (${Date.now() - t0} ms)`, r.ok && !!b, JSON.stringify(r));
    // Standing on Top, out along +z, 20 long; crest Ø16 − 2 × 0.15.
    if (b) {
      check(
        `${label}: 0 → 20 along z`,
        Math.abs(b.bbox.min[2]) < 0.05 && Math.abs(b.bbox.max[2] - 20) < 0.05,
        JSON.stringify(b.bbox),
      );
      const w = b.bbox.max[0] - b.bbox.min[0];
      check(`${label}: crest Ø15.7`, Math.abs(w - 15.7) < 0.1, String(w));
    }
  }
check("every face meshed", unmeshed.length === 0, unmeshed.join("\n"));
check("no feature errors", (await op.featureErrors()).length === 0, JSON.stringify(await op.featureErrors()));
void points;
await op.apply({ op: "screenshot", view: "iso" }).catch(() => {});
await shot("rods");

// Fit: an internal thread through a block, then a rod threaded down into it
// on the same sketch (flipped, so it runs into the block on the same axis).
for (const [diameter, expectOverlap] of [
  [16, false],
  [16.8, true],
]) {
  await op.newDocument();
  const blk = (await op.applySettled({ op: "addPrimitive", kind: "box", params: { width: 30, depth: 30, height: 15 } }))
    .createdId;
  const sk = (
    await op.applySettled({
      op: "addSketch",
      plane: { bodyId: blk, faceName: `${blk}/+z` },
      entities: [{ shape: "point", p: [0, 0] }],
    })
  ).createdId;
  const t0 = Date.now();
  const nut = await op.applySettled({
    op: "addThread",
    sketchId: sk,
    side: "internal",
    params: { diameter: 16, pitch: 2.5, length: 15 },
  });
  // (The kernel refuses a cut that took no material, so ok means it bit.)
  check(`internal: cuts the block (${Date.now() - t0} ms)`, nut.ok, JSON.stringify(nut));
  check(
    "internal: no feature errors",
    (await op.featureErrors()).length === 0,
    JSON.stringify(await op.featureErrors()),
  );
  const rod = await op.applySettled({
    op: "addThread",
    sketchId: sk,
    flip: true,
    params: { diameter, pitch: 2.5, length: 15 },
  });
  check(`rod Ø${diameter}: builds`, rod.ok, JSON.stringify(rod));
  const x = await op.applySettled({ op: "boolean", kind: "intersect", operands: [blk, rod.createdId] });
  check(
    `rod Ø${diameter} in the Ø16 internal thread: ${expectOverlap ? "overlaps" : "doesn't touch it"}`,
    x.ok === expectOverlap,
    JSON.stringify(x).slice(0, 160),
  );
  if (!expectOverlap) {
    await op.apply({ op: "delete", featureId: x.createdId }).catch(() => {});
    await op.settle();
    await op.apply({ op: "setSectionView", enabled: true, plane: { datum: "front" } }).catch(() => {});
    await op.settle();
    await shot("fit");
  }
}

// The dialog: J opens it on the newest sketch with points.
await op.newDocument();
await op.applySettled({ op: "addSketch", plane: { datum: "top" }, entities: [{ shape: "point", p: [0, 0] }] });
await page
  .locator(".viewport canvas")
  .first()
  .hover({ position: { x: 5, y: 5 } });
await page.keyboard.press("j");
const dialog = page.locator(".hole-dialog");
await dialog.waitFor({ timeout: 5000 });
await page.waitForTimeout(1500);
check("the dialog shows a diagram", (await dialog.locator("svg.dg").count()) === 1);
check("printable by default", (await dialog.locator("button.active", { hasText: "Printable" }).count()) === 1);
await dialog.locator(".ed-field", { hasText: "Pitch" }).locator("input").focus();
await page.waitForTimeout(300);
check("focusing Pitch lights its dimension", (await dialog.locator(".dg-active").count()) > 0);
for (const p of ["ISO 60°", "Trapezoid", "Printable"]) {
  await dialog.locator("button", { hasText: p }).click();
  await page.waitForTimeout(500);
  await dialog.screenshot({ path: path.join(SHOTS, `thread-dialog-${p.split(" ")[0].toLowerCase()}.png`) });
}
check("external hides the body picker", (await dialog.locator(".ed-field", { hasText: "Body" }).count()) === 0);
await dialog.locator("button", { hasText: "Internal" }).click();
await page.waitForTimeout(300);
check("internal shows it", (await dialog.locator(".ed-field", { hasText: "Body" }).count()) === 1);
await dialog.locator("button", { hasText: "External" }).click();
await page.waitForTimeout(2500);
await shot("ghost");
const before = (await op.features()).filter((f) => f.type === "thread").length;
await dialog.locator(".ed-primary").click();
await op.settle();
check("Create adds a thread", (await op.features()).filter((f) => f.type === "thread").length === before + 1);

// The fit check's intersect is meant to come back empty.
const real = errors.filter((e) => !/Failed to load resource/.test(e) && !/"Intersect \d+".*empty result/.test(e));
check("no page errors", real.length === 0, real.join("\n"));
await close();
done();
