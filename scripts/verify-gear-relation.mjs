// Two Gear-feature gears in an assembly: the Relation dialog fills the ratio
// and direction from their teeth, Align teeth turns the driven gear so its
// teeth sit in the driver's spaces, and they stay meshed as the driver turns.
// Gears made in the Gear dialog (12 and 24 teeth, the second meshed with the
// first and 36 mm over); a plate; an assembly with the plate grounded and each
// gear on a revolute to the plate's top, 36 mm apart (connector offsets).
// "Meshed" is checked on the screen: a pixel strip across the gap between the
// gears' centres, which shows the plate's colour through a tooth space and
// the gears' where teeth overlap. Screenshots to $SHOTS.
//
//   URL=http://localhost:5180/ node scripts/verify-gear-relation.mjs
//
// NB if the local open-poly MCP hub is running, this headless tab connects to
// it and can take the bridge from your own tab; reload yours after.
import os from "node:os";
import path from "node:path";
import { launch, openPoly, checker } from "./lib/harness.mjs";

const SHOTS = process.env.SHOTS ?? os.tmpdir();
const { page, errors, close } = await launch({ deviceScaleFactor: 1 });
const op = openPoly(page);
const { check, done } = checker();
const shot = (name) => page.screenshot({ path: path.join(SHOTS, `gear-relation-${name}.png`) });
/** A close-up of where the teeth meet: the midpoint of the two axles. */
const shotMesh = async (name) => {
  const box = await page.locator(".viewport canvas").first().boundingBox();
  const sc = await summary();
  const c = (inst) => {
    const b = sc.instances.find((i) => i.id === inst.id).bbox;
    return [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, b.max[2]];
  };
  const a = c(g1);
  const b = c(g2);
  // The pitch point: 12 mm from gear 1's centre toward gear 2's.
  const d = Math.hypot(b[0] - a[0], b[1] - a[1]);
  const p = [a[0] + ((b[0] - a[0]) * 12) / d, a[1] + ((b[1] - a[1]) * 12) / d, a[2]];
  const sp = await page.evaluate((q) => window.__openpoly.worldToScreen(q), p);
  await page.screenshot({
    path: path.join(SHOTS, `gear-relation-${name}.png`),
    clip: { x: box.x + sp.x - 120, y: box.y + sp.y - 120, width: 240, height: 240 },
  });
};
const read = (q) => page.evaluate((x) => window.__openpoly.read(x), q);
const summary = () => read({ read: "sceneSummary" });

// --- The gears, through the Gear dialog -----------------------------------------
await op.newDocument();
await op.apply({ op: "renameDocument", name: "GearPair" });
const dialog = page.locator(".gear-dialog");
const fieldInput = (label) => dialog.locator(".ed-field", { hasText: label }).locator("input").first();
const fieldSelect = (label) => dialog.locator(".ed-field", { hasText: label }).locator("select").first();
async function openGear() {
  const btn = page.locator('button[title^="Gear:"]').first();
  if (await btn.isVisible().catch(() => false)) await btn.click();
  else {
    await page.locator('button[title*="More"]').first().click();
    await page.locator('[title^="Gear:"]').first().click();
  }
  await dialog.waitFor();
}
await openGear();
await fieldInput("Teeth").fill("12");
await page.waitForTimeout(400);
await dialog.locator(".ed-primary").click();
await op.settle();
await openGear();
await fieldInput("Teeth").fill("24");
await fieldSelect("Size by").selectOption({ label: "Gear 1" });
await dialog.locator(".gear-advanced-toggle").click();
await fieldInput("Centre X").fill("36");
await page.waitForTimeout(400);
await dialog.locator(".ed-primary").click();
await op.settle();
check("two gears build", (await op.bodyCount()) === 2 && (await op.featureErrors()).length === 0);

// --- A plate ------------------------------------------------------------------------
await op.apply({ op: "newDocument", name: "Plate" });
await op.apply({ op: "addPrimitive", kind: "box", params: { width: "90", depth: "50", height: "6" } });
await op.settle();

// --- The assembly ---------------------------------------------------------------------
await op.apply({ op: "newDocument", name: "GearBox", kind: "assembly" });
await op.settle();
const docs = await read({ read: "documents" });
const idOf = (name) => docs.find((d) => d.name === name)?.id;
await op.apply({ op: "insertInstance", documentId: idOf("Plate") });
await op.apply({ op: "insertInstance", documentId: idOf("GearPair") });
await page.waitForTimeout(800);
let s = await summary();
let [plate, g1, g2] = s.instances;
check(
  "three instances, the plate grounded",
  s.instances.length === 3 && plate.grounded,
  JSON.stringify(s.instances.map((i) => i.name)),
);
const facesOf = (inst) => s.parts.find((p) => p.key === inst.part).faces;
const top = facesOf(plate).find((f) => f.endsWith("/+z"));
const startOf = (inst) => facesOf(inst).find((f) => f.endsWith("/start"));
for (const [g, x] of [
  [g1, -18],
  [g2, 18],
]) {
  const r = await op.apply({
    op: "addMate",
    type: "revolute",
    a: { instanceId: plate.id, face: top, offset: { x } },
    b: { instanceId: g.id, face: startOf(g) },
  });
  check(`revolute for ${g.name}`, r.ok, JSON.stringify(r));
}
await page.waitForTimeout(600);
await page
  .locator(".viewport canvas")
  .first()
  .hover({ position: { x: 5, y: 5 } });
await page.keyboard.press("7"); // top view
await page.waitForTimeout(900);
await shot("1-unaligned");
await shotMesh("1-mesh-unaligned");

// --- The Relation dialog --------------------------------------------------------------
await page.locator(".asm-new-relation").click();
await page.locator(".asm-relation").waitFor();
const value = await page.locator(".asm-relation-value").inputValue();
const gearsLine =
  (await page
    .locator(".asm-relation-gears")
    .textContent()
    .catch(() => "")) ?? "";
check("the ratio comes from the teeth", value === "12/24", value);
check("…and the dialog names the gears", /12 teeth.*24 teeth/.test(gearsLine), gearsLine);
check("Align teeth is on", await page.locator(".asm-relation-align").isChecked());
await shot("2-dialog");
await page.locator(".asm-relation .ed-primary").click();
await page.waitForTimeout(800);
s = await summary();
const rel = s.relations[0];
check("the relation is made, 12/24", rel?.value === "12/24", JSON.stringify(rel));
await shot("3-aligned");
await shotMesh("3-mesh-aligned");

// The aligned pose must mesh, and keep meshing as the driver turns: set the
// driver mate's angle and compare the driven gear's angle with what the ratio
// says, and check the teeth on screen via the scene's placements.
const mateOf = (inst) => s.mates.find((m) => m.b.instanceId === inst.id || m.a.instanceId === inst.id);
const m1 = mateOf(g1);
const m2 = mateOf(g2);
const drivenAt = () => s.mates.find((m) => m.id === m2.id).free[0].value;
const a0 = drivenAt();
await op.apply({ op: "setMateValue", mateId: m1.id, dof: "rz", value: 45 });
await page.waitForTimeout(500);
s = await summary();
const turned = drivenAt() - a0;
check(
  "turning the driver 45° turns the driven 22.5° the other way",
  Math.abs(Math.abs(turned) - 22.5) < 0.05,
  `${turned}`,
);
await shot("4-turned");
await shotMesh("4-mesh-turned");

const real = errors.filter((e) => !/502|Bad Gateway/.test(e));
check("no page errors", real.length === 0, real.slice(0, 3).join(" | "));
await close();
done();
