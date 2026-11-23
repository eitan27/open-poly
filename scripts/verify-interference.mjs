// The Interference panel (assembly toolbar → Interference): cubes placed to
// overlap by a known amount report exactly that volume; cubes that only touch
// don't count; the overlap is drawn red; a selection scopes the check. Then
// gears: a 12-tooth pinion in mesh with a rack clashes (undercut) unshifted,
// and doesn't with a 0.3 profile shift — teeth touching flank to flank don't
// count. And over a motion: the Animate dialog's Check the motion finds
// where a turning cube runs into a grounded one, to the sampled degree.
//
//   URL=http://localhost:5180/ SHOTS=<dir> node scripts/verify-interference.mjs
import os from "node:os";
import path from "node:path";
import { launch, openPoly, checker } from "./lib/harness.mjs";

const SHOTS = process.env.SHOTS ?? os.tmpdir();
const { page, errors, close } = await launch({ deviceScaleFactor: 1 });
const op = openPoly(page);
const { check, done } = checker();
const shot = (name) => page.screenshot({ path: path.join(SHOTS, `interference-${name}.png`) });
const read = (q) => page.evaluate((x) => window.__openpoly.read(x), q);
const summary = () => read({ read: "sceneSummary" });
const docId = async (name) => (await read({ read: "documents" })).find((d) => d.name === name)?.id;

const panel = page.locator(".asm-interference");
async function runCheck() {
  if (!(await panel.isVisible())) await page.locator('button[title^="Interference"]').first().click();
  else await panel.locator(".asm-interference-check").click();
  await panel.waitFor();
  await page.waitForFunction(
    () => !/Checking…/.test(document.querySelector(".asm-interference")?.textContent ?? "Checking…"),
    null,
    { timeout: 60000 },
  );
  await page.waitForTimeout(300);
  const rows = await panel.locator(".asm-interference-list li").allTextContents();
  const status = (await panel.locator(".asm-interference-status").first().textContent()) ?? "";
  return {
    status,
    rows: rows.map((t) => {
      const m = /^(.*) ↔ (.*?)([\d,.]+) mm³$/.exec(t.trim());
      return m ? { a: m[1].trim(), b: m[2].trim(), volume: Number(m[3].replace(/,/g, "")) } : { raw: t };
    }),
  };
}

// --- Cubes: one at the origin, one overlapping it, one touching it.
await op.newDocument();
await op.apply({ op: "renameDocument", name: "Cube" });
await op.apply({ op: "addPrimitive", kind: "box", params: { width: "20", depth: "20", height: "20" } });
await op.settle();
await op.apply({ op: "newDocument", name: "Cubes", kind: "assembly" });
await op.settle();
const cube = await docId("Cube");
await op.apply({ op: "insertInstance", documentId: cube, position: [0, 0, 0], name: "A" });
await op.apply({ op: "insertInstance", documentId: cube, position: [12, 5, 3], name: "B" });
await op.apply({ op: "insertInstance", documentId: cube, position: [-20, 0, 0], name: "C" });
await page.waitForTimeout(1000);
let s = await summary();
const bb = Object.fromEntries(s.instances.map((i) => [i.name, i.bbox]));
const overlapOf = (p, q) =>
  [0, 1, 2].reduce((v, k) => v * Math.max(0, Math.min(p.max[k], q.max[k]) - Math.max(p.min[k], q.min[k])), 1);
const wantAB = overlapOf(bb.A, bb.B);
check(
  "set-up: A and B overlap, A and C only touch",
  wantAB > 100 && overlapOf(bb.A, bb.C) === 0 && Math.abs(bb.A.min[0] - bb.C.max[0]) < 1e-6,
  JSON.stringify(bb),
);

let r = await runCheck();
check(
  "one overlap: A ↔ B",
  r.rows.length === 1 && [r.rows[0].a, r.rows[0].b].sort().join() === "A,B",
  JSON.stringify(r),
);
check(
  "its volume is the boxes' overlap",
  Math.abs(r.rows[0]?.volume - wantAB) <= Math.max(0.5, wantAB * 1e-3),
  `${r.rows[0]?.volume} vs ${wantAB}`,
);
await page
  .locator(".viewport canvas")
  .first()
  .hover({ position: { x: 5, y: 5 } });
await page.keyboard.press("0"); // iso
await page.waitForTimeout(800);
await shot("1-cubes");

// Scoped: C selected → C against the rest: only touching, so none.
await page
  .locator(".asm-row:not(.asm-mate-row):not(.asm-relation-row)")
  .nth(2)
  .click({ position: { x: 6, y: 8 } });
await panel.locator("button", { hasText: "Close" }).click();
r = await runCheck();
const scopeText = (await panel.locator(".ed-hint").first().textContent()) ?? "";
check("scoped to the selection", /Checking C against the rest/.test(scopeText), scopeText);
check("C only touches: no interference", r.rows.length === 0 && /only touch/.test(r.status), JSON.stringify(r));
await panel.locator(".asm-interference-all").click();
await page.waitForFunction(() => !/Checking…/.test(document.querySelector(".asm-interference")?.textContent ?? ""));
r = await runCheck();
check("Check all finds A ↔ B again", r.rows.length === 1, JSON.stringify(r));

// Stale after a change.
const b = s.instances.find((i) => i.name === "B");
await op.apply({ op: "delete", featureId: b.id });
await page.waitForTimeout(600);
const staleText = (await panel.textContent()) ?? "";
check("the report says it's stale after a change", /changed since/.test(staleText), staleText);
r = await runCheck();
check("…and checking again: none", r.rows.length === 0, JSON.stringify(r));
await panel.locator("button", { hasText: "Close" }).click();

// --- Gears: a pinion and a rack placed in mesh, as one part document each
// way (unshifted, shifted), both parts inserted where they were made.
for (const [shift, clashes] of [
  [0, true],
  [0.3, false],
]) {
  const name = `Pair${shift}`;
  await op.apply({ op: "newDocument", name });
  const pin = await op.apply({ op: "addGear", params: { teeth: 12, profileShift: shift } });
  await op.apply({
    op: "addGear",
    gearType: "rack",
    meshWith: pin.createdId,
    placeBeside: true,
    params: { teeth: 10 },
  });
  await op.settle();
  await op.apply({ op: "newDocument", name: `Asm${shift}`, kind: "assembly" });
  await op.settle();
  await op.apply({ op: "insertInstance", documentId: await docId(name), position: [0, 0, 0] });
  await page.waitForTimeout(1200);
  s = await summary();
  r = await runCheck();
  if (clashes)
    check(
      "unshifted 12-tooth pinion: the rack's tips clash with it (undercut), a little",
      r.rows.length === 1 && r.rows[0].volume > 0 && r.rows[0].volume < 50,
      JSON.stringify(r),
    );
  else check("shifted 0.3: in mesh, teeth only touch — no interference", r.rows.length === 0, JSON.stringify(r));
  await page
    .locator(".viewport canvas")
    .first()
    .hover({ position: { x: 5, y: 5 } });
  await page.keyboard.press("7");
  await page.waitForTimeout(800);
  await shot(`2-gears-shift${shift}`);
  await panel.locator("button", { hasText: "Close" }).click();
}

// --- Over a motion (Animate → Check the motion): cube A turns about its
// centre on a revolute; grounded cube B's near face is 12 mm from the axis.
// A's corner reaches 10·(cos θ + sin θ) from the axis, so they overlap for
// 13.05° < θ < 76.95°: sampled every 2° over 0–90°, 14°–76°, worst at 44°.
await op.apply({ op: "newDocument", name: "Plate" });
await op.apply({ op: "addPrimitive", kind: "box", params: { width: "100", depth: "100", height: "6" } });
await op.settle();
await op.apply({ op: "newDocument", name: "Turn", kind: "assembly" });
await op.settle();
const plateR = await op.apply({
  op: "insertInstance",
  documentId: await docId("Plate"),
  position: [0, 0, 0],
  name: "Plate",
});
await op.apply({ op: "insertInstance", documentId: cube, position: [0, 0, 6], name: "A" });
await op.apply({ op: "insertInstance", documentId: cube, position: [22, 0, 6], name: "B" });
await page.waitForTimeout(1000);
s = await summary();
const inst = (n) => s.instances.find((i) => i.name === n);
await op.apply({ op: "groundInstance", instanceId: inst("Plate").id });
await op.apply({ op: "groundInstance", instanceId: inst("B").id });
const facesOfI = (i) => s.parts.find((p) => p.key === i.part).faces;
r = await op.apply({
  op: "addMate",
  type: "revolute",
  a: { instanceId: inst("Plate").id, face: facesOfI(inst("Plate")).find((f) => f.endsWith("/+z")) },
  b: { instanceId: inst("A").id, face: facesOfI(inst("A")).find((f) => f.endsWith("/-z")) },
});
check("set-up: A turns on the plate", r.ok, JSON.stringify(r));
await page.waitForTimeout(800);
s = await summary();
check(
  "set-up: A and B clear at 0°, 2 mm apart",
  Math.abs(inst("B").bbox.min[0] - inst("A").bbox.max[0] - 2) < 1e-6,
  JSON.stringify([inst("A").bbox, inst("B").bbox, plateR.ok]),
);
await page.locator(".asm-mate-animate").first().click();
const anim = page.locator(".asm-animate");
await anim.waitFor();
const field = (label) => anim.locator(".ed-field", { hasText: label }).locator("input");
await field("To").fill("90");
await field("To").press("Enter");
await page.waitForTimeout(400);
await anim.locator(".asm-clash-check").click();
await page.waitForFunction(() => !!document.querySelector(".asm-clash-status, .asm-animate .ed-warning"), null, {
  timeout: 120000,
});
const rows = await anim.locator(".asm-clash-list li").allTextContents();
const statusM = (await anim.locator(".asm-clash-status").textContent()) ?? "";
check("one clash, A ↔ B", rows.length === 1 && /A ↔ B|B ↔ A/.test(rows[0]), JSON.stringify({ statusM, rows }));
check("…from 14° to 76° (the sampled run inside 13.05°–76.95°)", /14°\s*–\s*76°/.test(rows[0] ?? ""), rows[0]);
const tip = (await anim.locator(".asm-clash-list button").first().getAttribute("title")) ?? "";
check("…worst at 44°", /Worst at 44°/.test(tip), tip);
await anim.locator(".asm-clash-list button").first().click();
await page.waitForTimeout(1500);
const live = (await anim.locator(".asm-animate-live").textContent()) ?? "";
check("Show poses the parts at the worst value", /44/.test(live), live);
await page
  .locator(".viewport canvas")
  .first()
  .hover({ position: { x: 5, y: 5 } });
await page.keyboard.press("0");
await page.waitForTimeout(800);
await shot("3-motion-worst");
// Short of the clash: none.
await field("To").fill("12");
await field("To").press("Enter");
await page.waitForTimeout(400);
await anim.locator(".asm-clash-check").click();
await page.waitForFunction(() => !!document.querySelector(".asm-clash-status"), null, { timeout: 60000 });
const none = (await anim.locator(".asm-clash-status").textContent()) ?? "";
check("0°–12°: no clashes over the motion", /No clashes over the motion/.test(none), none);

// --- The agent's check_interference read, on the same assembly.
await anim.locator(".asm-animate-close").click();
const hinge = s.mates[0];
const motion = await read({ read: "checkInterference", mateId: hinge.id, to: 90 });
const mc = motion.clashes?.[0];
check(
  "agent, motion: A ↔ B from 14 to 76, worst at 44",
  motion.clashes?.length === 1 && mc.from === 14 && mc.to === 76 && mc.worstAt === 44 && mc.volume > 0,
  JSON.stringify(motion),
);
check("agent, motion: 46 positions sampled", motion.motion?.samples === 46, JSON.stringify(motion.motion));
const now = await read({ read: "checkInterference" });
check("agent, static at 0°: nothing overlaps", now.clashes?.length === 0, JSON.stringify(now));
await op.apply({ op: "setMateValue", mateId: hinge.id, dof: "rz", value: 45 });
await page.waitForTimeout(500);
const at45 = await read({ read: "checkInterference", instanceIds: [inst("A").id] });
check(
  "agent, static at 45°, A against the rest: A ↔ B",
  at45.clashes?.length === 1 && [at45.clashes[0].a.name, at45.clashes[0].b.name].sort().join() === "A,B",
  JSON.stringify(at45),
);
const bad = await page.evaluate(() =>
  window.__openpoly.read({ read: "checkInterference", instanceIds: ["nope"] }).then(
    () => "no error",
    (e) => String(e.message ?? e),
  ),
);
check("agent: an unknown instance id says so", /No instance "nope"/.test(bad), bad);

const real = errors.filter((e) => !/502|Bad Gateway/.test(e));
check("no page errors", real.length === 0, real.slice(0, 3).join(" | "));
await close();
done();
