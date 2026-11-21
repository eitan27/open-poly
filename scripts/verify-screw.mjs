// Screw feature end to end: every head builds on a plane, modelled and
// cosmetic (one mesh each, no booleans — geom/screwMesh.ts), a screw follows a metric hole's size and sits on its counterbore
// floor (one per hole), a modelled screw fits a modelled tapped hole without
// touching it (a cosmetic one doesn't), and the dialog opens with its diagram
// and ghost; its Locations slot takes a Hole's holes and spots on faces, and
// deleting the Hole leaves the screws where they were. Screenshots go to $SHOTS.
//
//   URL=http://localhost:5173/ node scripts/verify-screw.mjs
import os from "node:os";
import path from "node:path";
import { launch, openPoly, checker } from "./lib/harness.mjs";

const SHOTS = process.env.SHOTS ?? os.tmpdir();
const { page, errors, close } = await launch({ deviceScaleFactor: 2 });
const op = openPoly(page);
const unmeshed = [];
page.on("console", (m) => /UNMESHED|recovered \d+ dropped/.test(m.text()) && unmeshed.push(m.text()));
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

for (const thread of ["modelled", "cosmetic"])
  for (const [i, head] of ["socket", "button", "flat", "hex", "set", "none"].entries()) {
    const t0 = Date.now();
    const r = await op.applySettled({
      op: "addScrew",
      at: [{ plane: { datum: "top" }, x: -50 + i * 20, y: thread === "modelled" ? 40 : 60 }],
      head,
      thread,
      size: "M5",
      params: { length: 16 },
    });
    const b = (await op.scene()).bodies.find((x) => x.id === r.createdId);
    check(`${head}, ${thread}: builds on a plane (${Date.now() - t0} ms)`, r.ok && !!b, JSON.stringify(r));
    // On the Top datum the shank runs down from z = 0: 16 long (overall for
    // flat); a headless one ends flush at z = 0.
    if (b) check(`${head}, ${thread}: tip at -16`, Math.abs(b.bbox.min[2] + 16) < 0.05, JSON.stringify(b.bbox));
    if (b && (head === "set" || head === "none"))
      check(`${head}, ${thread}: no head above the plane`, Math.abs(b.bbox.max[2]) < 0.05, JSON.stringify(b.bbox));
  }
check("every face meshed", unmeshed.length === 0, unmeshed.join("\n"));

// Orientation: a spot on a side face stands upright (head up); one on an
// opening goes into the face.
{
  const side = { bodyId: box, faceName: `${box}/-y` };
  const up = await op.applySettled({
    op: "addScrew",
    at: [{ plane: side, x: 0, y: 0 }],
    size: "M5",
    params: { length: 16 },
  });
  const into = await op.applySettled({
    op: "addScrew",
    at: [{ plane: side, x: 10, y: 0, opening: true }],
    size: "M5",
    params: { length: 16 },
  });
  const bb = async (id) => (await op.scene()).bodies.find((x) => x.id === id)?.bbox;
  const u = await bb(up.createdId);
  const i = await bb(into.createdId);
  check(
    "on a side face, upright: 16 down and the head up",
    u && Math.abs(u.max[2] - u.min[2] - 21) < 0.1,
    JSON.stringify(u),
  );
  check(
    "on an opening, into the face: along y",
    i && Math.abs(i.max[1] - i.min[1] - 21) < 0.1 && i.max[1] > -20 + 15,
    JSON.stringify(i),
  );
  await op.applySettled({ op: "delete", featureId: up.createdId });
  await op.applySettled({ op: "delete", featureId: into.createdId });
}

const inHole = await op.applySettled({
  op: "addScrew",
  holeId: hole,
  head: "socket",
  thread: "modelled",
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
{
  const b = (await op.bodies()).find((x) => x.id === inHole.createdId);
  // The summary folds the run of facet names: `<id>/thread{n} (n = 0–3053)`.
  const run = b?.faces.find((f) => f.includes("/thread{n}")) ?? "";
  const n = Number(/(\d+)\)$/.exec(run)?.[1] ?? 0);
  check("the thread is modelled: hundreds of named thread facets", n > 500, run);
}
await op.apply({ op: "screenshot", view: "iso" }).catch(() => {});
await shot("built");

// Fit: an M6 modelled screw in an M6 modelled tapped hole leaves a gap all
// round (their intersection is empty); a cosmetic shank overlaps the crests.
for (const [thread, expectOverlap] of [
  ["modelled", false],
  ["cosmetic", true],
]) {
  await op.newDocument();
  const blk = (await op.applySettled({ op: "addPrimitive", kind: "box", params: { width: 14, depth: 14, height: 10 } }))
    .createdId;
  const s1 = (
    await op.applySettled({
      op: "addSketch",
      plane: { bodyId: blk, faceName: `${blk}/+z` },
      entities: [{ shape: "point", p: [0, 0] }],
    })
  ).createdId;
  const tapped = await op.applySettled({
    op: "addHole",
    sketchId: s1,
    holeType: "tapped",
    thread: "modelled",
    size: "M6",
  });
  check(`${thread}: the tapped hole builds`, tapped.ok, JSON.stringify(tapped));
  const sc = await op.applySettled({ op: "addScrew", holeId: tapped.createdId, thread, params: { length: 16 } });
  check(`${thread}: the screw builds`, sc.ok && (await op.bodyCount()) === 2, JSON.stringify(sc));
  const x = await op.applySettled({ op: "boolean", kind: "intersect", operands: [blk, sc.createdId] });
  check(
    `${thread} screw in a modelled M6 hole: ${expectOverlap ? "overlaps" : "doesn't touch it"}`,
    x.ok === expectOverlap,
    JSON.stringify(x).slice(0, 160),
  );
}
await op.newDocument();
{
  const blk = (await op.applySettled({ op: "addPrimitive", kind: "box", params: { width: 60, depth: 40, height: 12 } }))
    .createdId;
  const s1 = (
    await op.applySettled({
      op: "addSketch",
      plane: { bodyId: blk, faceName: `${blk}/+z` },
      entities: [{ shape: "point", p: [0, 0] }],
    })
  ).createdId;
  await op.applySettled({ op: "addHole", sketchId: s1, holeType: "counterbore", size: "M5" });
}

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
for (const h of ["Button", "Countersunk", "Hex", "Set screw", "No head", "Socket"]) {
  await dialog.locator("button", { hasText: h }).click();
  await page.waitForTimeout(400);
  await dialog.screenshot({ path: path.join(SHOTS, `screw-dialog-${h.toLowerCase()}.png`) });
}
await shot("ghost");
const modelThread = dialog.locator(".ed-field", { hasText: "Model the thread" }).locator("input");
check("cosmetic by default: no clearance", (await dialog.locator(".ed-field", { hasText: "Clearance" }).count()) === 0);
await modelThread.check();
await page.waitForTimeout(300);
check(
  "modelled thread offers a clearance",
  (await dialog.locator(".ed-field", { hasText: "Clearance" }).count()) === 1,
);
await modelThread.uncheck();
await page.waitForTimeout(300);
check("cosmetic hides it", (await dialog.locator(".ed-field", { hasText: "Clearance" }).count()) === 0);

// Locations: it opened in the Hole; no centre fields, no in-a-hole / on-a-plane toggle.
const locations = dialog.locator(".ed-field", { hasText: "Locations" });
const locText = async () => (await locations.textContent()) ?? "";
check("Locations names the Hole it opened in", /Hole 1/.test(await locText()), await locText());
check("no Center X / Y fields", (await dialog.locator(".ed-field", { hasText: "Center X" }).count()) === 0);
check("no On a plane button", (await dialog.locator("button", { hasText: "On a plane" }).count()) === 0);
// ✕: back to the default, listening.
await locations.locator(".bool-operand-x").click();
await page.waitForTimeout(300);
check("✕ goes back to Top plane (default)", /Top plane \(default\)/.test(await locText()), await locText());
check("…listening", (await locations.locator(".ed-pick-btn").getAttribute("class")).includes("active"));
// A spot: the plate top's back edge midpoint (a face click snaps to the
// face's centre — here, the hole's — as a Hole's target does).
await op.clickWorld([0, 19.9, 12]);
await page.waitForTimeout(400);
check("a face spot fills it", /face/.test(await locText()), await locText());
// The hole's centre: the hole's screws join the spot.
await op.clickWorld([0, 0, 12]);
await page.waitForTimeout(400);
check("a hole's centre adds the Hole", /Hole 1 \+ /.test(await locText()), await locText());
// Another, at the front edge's midpoint: two spots now.
await op.clickWorld([0, -19.9, 12]);
await page.waitForTimeout(400);
check("…and another spot", /Hole 1 \+ 2 spots/.test(await locText()), await locText());
// Picking a spot again removes it.
await op.clickWorld([0, -19.9, 12]);
await page.waitForTimeout(400);
check(
  "picking a spot again removes it",
  /Hole 1 \+ Block|Hole 1 \+ Box|Hole 1 \+ .*face/.test(await locText()),
  await locText(),
);
await page.waitForTimeout(1200);
await shot("locations");
// The ghost follows a pick at once, even with a modelled thread: one screw is
// built, then copied to every location without asking the kernel again.
await locations.locator(".ed-pick-btn").click(); // stop listening
await modelThread.check();
await page.waitForTimeout(4000); // the one modelled screw, built once
await locations.locator(".ed-pick-btn").click(); // listen again
{
  const spot = [-30, 0, 12]; // the plate top's left edge midpoint
  const p = await op.screenOf(spot);
  const clip = { x: p.x - 40, y: p.y - 70, width: 80, height: 90 };
  await page.mouse.move(p.x, p.y, { steps: 4 });
  await page.waitForTimeout(500);
  const before = await page.screenshot({ clip });
  await page.mouse.down();
  await page.mouse.up();
  // How long until it shows: poll the spot (a screenshot is ~50 ms itself).
  const t0 = Date.now();
  let ms = -1;
  while (Date.now() - t0 < 4000) {
    if (!before.equals(await page.screenshot({ clip }))) {
      ms = Date.now() - t0;
      break;
    }
  }
  // Rebuilding it in the kernel took 1.4 s here; the copy is ~1 ms, the rest
  // is drawing it and these screenshots.
  check(`a modelled ghost appears at a new spot at once (${ms} ms)`, ms >= 0 && ms < 800);
  await shot("modelled-ghost");
  check("…three spots now", /Hole 1 \+ 2 spots/.test(await locText()), await locText());
  await page.mouse.down(); // and off again
  await page.mouse.up();
  await page.waitForTimeout(200);
}
await modelThread.uncheck();
await locations.locator(".ed-pick-btn").click(); // stop listening
const before = (await op.features()).filter((f) => f.type === "screw").length;
await dialog.locator(".ed-primary").click();
await op.settle();
const screws = (await op.features()).filter((f) => f.type === "screw");
check("Create adds a screw", screws.length === before + 1);
const made = screws.at(-1);
check(
  "…in the Hole and at the spot, saving no size of its own",
  made?.holeId && made.points?.length === 1 && made.size === undefined,
  JSON.stringify(made),
);
const bodyOf = async () => (await op.scene()).bodies.filter((b) => b.id.split("#")[0] === made.id);
const tops = (bs) => bs.map((b) => b.bbox.max[2].toFixed(2)).sort();
const was = tops(await bodyOf());
check("two screws: one seated in the counterbore, one on the face", was.length === 2, JSON.stringify(was));

// Deleting the Hole leaves both where they are.
const holeId = (await op.features()).find((f) => f.type === "hole").id;
await op.applySettled({ op: "delete", featureId: holeId });
const now = (await op.features()).find((f) => f.id === made.id);
check(
  "deleting the Hole unlinks its screws",
  !now.holeId && now.points?.length === 2 && now.size === "M5",
  JSON.stringify(now),
);
check(
  "…which stay exactly where they were",
  JSON.stringify(tops(await bodyOf())) === JSON.stringify(was),
  JSON.stringify(tops(await bodyOf())),
);
check("…without errors", (await op.featureErrors()).length === 0, JSON.stringify(await op.featureErrors()));

// The modelled fit check's intersect is meant to come back empty.
const real = errors.filter((e) => !/Failed to load resource/.test(e) && !/"Intersect \d+".*empty result/.test(e));
check("no page errors", real.length === 0, real.join("\n"));
await close();
done();
