// The Interference panel (assembly toolbar → Interference): cubes placed to
// overlap by a known amount report exactly that volume; cubes that only touch
// don't count; the overlap is drawn red; a selection scopes the check. Then
// gears: a 12-tooth pinion in mesh with a rack clashes (undercut) unshifted,
// and doesn't with a 0.3 profile shift — teeth touching flank to flank don't
// count.
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

const real = errors.filter((e) => !/502|Bad Gateway/.test(e));
check("no page errors", real.length === 0, real.slice(0, 3).join(" | "));
await close();
done();
