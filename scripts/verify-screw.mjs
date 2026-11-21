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

// Orientation: a spot on a side face goes into that face, head outside.
{
  const side = { bodyId: box, faceName: `${box}/-y` };
  const into = await op.applySettled({
    op: "addScrew",
    at: [{ plane: side, x: 0, y: 0 }],
    size: "M5",
    params: { length: 16 },
  });
  const i = (await op.scene()).bodies.find((x) => x.id === into.createdId)?.bbox;
  check(
    "on a side face: into it, along y (16 in, the 5 mm head outside)",
    i && Math.abs(i.max[1] - i.min[1] - 21) < 0.1 && Math.abs(i.min[1] + 25) < 0.1,
    JSON.stringify(i),
  );
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

// Locations, as Extrude's profiles: a row per screw with its ✕, and a button
// below — "Select locations (Esc to stop)" while listening, "Add more
// locations" after. It opened in the Hole (one hole: one row).
const rows = dialog.locator(".screw-rows .bool-operand-row");
const locBtn = dialog.locator(".ed-pick-btn", { hasText: /locations/ });
const rowTexts = async () => (await rows.allTextContents()).map((t) => t.replace(/✕$/, "").trim());
check(
  "a row for the Hole's screw",
  /^Hole 1 · hole 1$/.test((await rowTexts()).join("|")),
  (await rowTexts()).join("|"),
);
check(
  "…listening from the start, as a new Hole's Targets",
  ((await locBtn.textContent()) ?? "").includes("Select locations (Esc to stop)") &&
    (await locBtn.getAttribute("class")).includes("active"),
  (await locBtn.textContent()) ?? "",
);
check("no Center X / Y fields", (await dialog.locator(".ed-field", { hasText: "Center X" }).count()) === 0);
check("no On a plane button", (await dialog.locator("button", { hasText: "On a plane" }).count()) === 0);
// Its ✕: none left — still listening, and the hint says it's on Top until a pick.
await rows.first().locator(".bool-operand-x").click();
await page.waitForTimeout(300);
check("removing the last leaves no rows", (await rows.count()) === 0);
check("…still listening", ((await locBtn.textContent()) ?? "").includes("Esc to stop"));
check("…and on Top until a pick", /stays on Top/.test((await dialog.textContent()) ?? ""));
// Stopped with nothing picked: the default row, whose ✕ listens again.
await locBtn.click();
await page.waitForTimeout(200);
const defaultRow = dialog.locator(".bool-operand-row", { hasText: "Top plane (default)" });
check("stopped: a Top plane (default) row", (await defaultRow.count()) === 1);
await defaultRow.locator(".bool-operand-x").click();
await page.waitForTimeout(200);
check("…whose ✕ listens again", (await locBtn.getAttribute("class")).includes("active"));
// A spot: the plate top's back edge midpoint (a face click snaps to the
// face's centre — here, the hole's — as a Hole's target does).
await op.clickWorld([0, 19.9, 12]);
await page.waitForTimeout(400);
check("a face spot adds a row", /^Box 1 · face$/.test((await rowTexts()).join("|")), (await rowTexts()).join("|"));
check("…still listening", ((await locBtn.textContent()) ?? "").includes("Esc to stop"));
// The hole's centre: the hole's screw joins, numbered first.
await op.clickWorld([0, 0, 12]);
await page.waitForTimeout(400);
check(
  "a hole's centre adds its screw, first",
  (await rowTexts()).join("|") === "1. Hole 1 · hole 1|2. Box 1 · face",
  (await rowTexts()).join("|"),
);
// Another, at the front edge's midpoint.
await op.clickWorld([0, -19.9, 12]);
await page.waitForTimeout(400);
check("…and another spot", (await rows.count()) === 3, (await rowTexts()).join("|"));
// Picking a spot again removes it.
await op.clickWorld([0, -19.9, 12]);
await page.waitForTimeout(400);
check("picking a spot again removes it", (await rows.count()) === 2, (await rowTexts()).join("|"));
await page.waitForTimeout(1200);
await shot("locations");
// The ghost follows a pick at once, even with a modelled thread: one screw is
// built, then copied to every location without asking the kernel again.
await locBtn.click(); // stop listening
await modelThread.check();
await page.waitForTimeout(4000); // the one modelled screw, built once
await locBtn.click(); // listen again
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
  check("…three screws now", (await rows.count()) === 3, (await rowTexts()).join("|"));
  await page.mouse.down(); // and off again
  await page.mouse.up();
  await page.waitForTimeout(200);
}
await modelThread.uncheck();
await locBtn.click(); // stop listening
check("a row per screw", (await rows.count()) === 2, String(await rows.count()));
check("…numbered, the Hole's first", /^1\. Hole 1 · hole 1/.test((await rows.first().textContent()) ?? ""));
// Hovering a row lights its screw (the spot at the back edge's midpoint).
{
  const p = await op.screenOf([0, 20, 14]);
  const clip = { x: p.x - 50, y: p.y - 60, width: 100, height: 100 };
  const before = await page.screenshot({ clip });
  await rows.nth(1).hover();
  await page.waitForTimeout(300);
  const lit = await page.screenshot({ clip });
  await shot("row-hover");
  check("hovering a row lights its screw", !before.equals(lit));
  await page.mouse.move(5, 300);
  await page.waitForTimeout(300);
  check("…and leaving it puts it back", before.equals(await page.screenshot({ clip })));
}
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

// Removing one screw in the Parts panel: a Delete part step in the timeline,
// the Screw feature untouched; ✕ on Delete part's row brings it back.
{
  const partsOf = async () => (await op.scene()).bodies.filter((b) => b.id.split("#")[0] === made.id).length;
  const clickPartX = (name) =>
    page.evaluate((n) => {
      const row = [...document.querySelectorAll(".solid-row")].find((r) => r.querySelector(".solid-name")?.value === n);
      row?.querySelector('button[title="Delete"]')?.click();
      return !!row;
    }, name);
  check("the Parts panel lists the second screw", await clickPartX(`${made.name} (2)`));
  await op.settle();
  const feats = await op.features();
  const del = feats.at(-1);
  check(
    "…its ✕ adds a Delete part step",
    del?.type === "deletePart" && del.partIds?.[0] === `${made.id}#1`,
    JSON.stringify(del),
  );
  check(
    "…leaving the Screw feature",
    feats.some((f) => f.id === made.id),
  );
  check("…and one screw fewer", (await partsOf()) === 1, String(await partsOf()));
  await shot("delete-part");
  await op.apply({ op: "delete", featureId: del.id });
  await op.settle();
  check("deleting the Delete part brings it back", (await partsOf()) === 2);
  // The agent's delete_part does the same.
  const r = await op.applySettled({ op: "deletePart", partId: `${made.id}#1` });
  check("the agent's deletePart adds the step", r.ok && (await partsOf()) === 1, JSON.stringify(r));
  const bad = await op.apply({ op: "deletePart", partId: `${made.id}#7` }).catch((e) => ({ err: String(e) }));
  check("…and refuses a part that isn't there", !bad.ok, JSON.stringify(bad).slice(0, 160));
  await op.applySettled({ op: "delete", featureId: r.createdId });
}

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

// The timeline means the whole feature: one screw deleted (a Delete part
// step), that step deleted, then the Screw's ✕ in the timeline — every screw
// goes, not just the first (whose part id is the feature's own). Again with
// the step left in: it goes with the Screw. And the Delete key on a selected
// row does the same.
{
  const treeX = (name) =>
    page.evaluate((n) => {
      const row = [...document.querySelectorAll(".tree-row")].find((r) => r.textContent?.includes(n));
      row?.querySelector('button[title="Delete"]')?.click();
      return !!row;
    }, name);
  const partsOf = async () => (await op.scene()).bodies.filter((b) => b.id.split("#")[0] === made.id).length;
  await op.applySettled({ op: "deletePart", partId: `${made.id}#1` });
  const step = (await op.features()).at(-1);
  check("timeline: a Delete part row", step.type === "deletePart" && (await treeX(step.name)));
  await op.settle();
  check("…whose ✕ brings the screw back", (await partsOf()) === 2, String(await partsOf()));
  const snapshot = await op.features();
  check("the Screw's ✕ in the timeline", await treeX(made.name));
  await op.settle();
  let feats = await op.features();
  check("…deletes the feature", !feats.some((f) => f.id === made.id), JSON.stringify(feats.map((f) => f.type)));
  check("…and every screw", (await partsOf()) === 0, String(await partsOf()));
  // Undo, then with a Delete part step still there.
  await page.keyboard.press("Meta+z");
  await op.settle();
  check("undo brings it back", (await op.features()).length === snapshot.length);
  await op.applySettled({ op: "deletePart", partId: `${made.id}#1` });
  await page.locator(".tree-row", { hasText: made.name }).first().click();
  await page
    .locator(".viewport canvas")
    .first()
    .hover({ position: { x: 5, y: 5 } });
  await page.keyboard.press("Delete");
  await op.settle();
  feats = await op.features();
  check("Delete on its selected row deletes the feature", !feats.some((f) => f.id === made.id));
  check(
    "…and its Delete part step",
    !feats.some((f) => f.type === "deletePart"),
    JSON.stringify(feats.map((f) => f.type)),
  );
  check(
    "…without errors or warnings",
    (await op.featureErrors()).length === 0,
    JSON.stringify(await op.featureErrors()),
  );
}

// The modelled fit check's intersect is meant to come back empty.
const real = errors.filter((e) => !/Failed to load resource/.test(e) && !/"Intersect \d+".*empty result/.test(e));
check("no page errors", real.length === 0, real.join("\n"));
await close();
done();
