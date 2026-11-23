// A pinion and a rack (both Gear features) in an assembly: the Relation
// dialog's Rack type fills the pinion radius and direction from their teeth,
// Align teeth slides the rack into mesh, and it stays in mesh as the pinion
// turns. The pinion turns on a revolute to a plate; the rack lies on the
// plate on a planar mate, its slide along the rack a translation DOF. The
// rack is made 1.3 mm out of phase on purpose, so Align has work to do.
// "In mesh" is checked in the world: the rack moves r·θ per turn θ.
//
//   URL=http://localhost:5180/ node scripts/verify-rack-relation.mjs
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
const shot = (name) => page.screenshot({ path: path.join(SHOTS, `rack-relation-${name}.png`) });
const read = (q) => page.evaluate((x) => window.__openpoly.read(x), q);
const summary = () => read({ read: "sceneSummary" });

// --- The part: a 12-tooth pinion (shifted 0.3 to clear a rack's tips) and a
// rack sized from it, placed by hand under it, 1.3 mm out of phase.
await op.newDocument();
await op.apply({ op: "renameDocument", name: "RackPair" });
const pin = await op.apply({ op: "addGear", params: { teeth: 12, profileShift: 0.3 } });
await op.apply({
  op: "addGear",
  gearType: "rack",
  meshWith: pin.createdId,
  params: { teeth: 20, centerY: -12.6, centerX: 1.3 },
});
await op.settle();
check("pinion and rack build", (await op.bodyCount()) === 2 && (await op.featureErrors()).length === 0);

await op.apply({ op: "newDocument", name: "Plate" });
await op.apply({ op: "addPrimitive", kind: "box", params: { width: "120", depth: "60", height: "6" } });
await op.settle();

// --- The assembly.
await op.apply({ op: "newDocument", name: "RackBox", kind: "assembly" });
await op.settle();
const docs = await read({ read: "documents" });
const idOf = (name) => docs.find((d) => d.name === name)?.id;
await op.apply({ op: "insertInstance", documentId: idOf("Plate") });
await op.apply({ op: "insertInstance", documentId: idOf("RackPair") });
await page.waitForTimeout(800);
let s = await summary();
const [plate, pinI, rackI] = s.instances;
check("three instances", s.instances.length === 3, JSON.stringify(s.instances.map((i) => i.name)));
const facesOf = (inst) => s.parts.find((p) => p.key === inst.part).faces;
const top = facesOf(plate).find((f) => f.endsWith("/+z"));
const startOf = (inst) => facesOf(inst).find((f) => f.endsWith("/start"));
let r = await op.apply({
  op: "addMate",
  type: "revolute",
  a: { instanceId: plate.id, face: top },
  b: { instanceId: pinI.id, face: startOf(pinI) },
});
check("revolute for the pinion", r.ok, JSON.stringify(r));
r = await op.apply({
  op: "addMate",
  type: "planar",
  a: { instanceId: plate.id, face: top },
  b: { instanceId: rackI.id, face: startOf(rackI) },
});
check("planar for the rack", r.ok, JSON.stringify(r));
await page.waitForTimeout(600);
s = await summary();
const box = (id) => s.instances.find((i) => i.id === id).bbox;
const mid = (b) => [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2];
const hinge = s.mates.find((m) => m.type === "revolute");
const plane = s.mates.find((m) => m.type === "planar");

// Put the rack's pitch line 12.6 mm from the pinion's centre, as in the part:
// find which of tx / ty moves it across, by trying each.
const setVal = async (mateId, dof, value) => {
  await op.apply({ op: "setMateValue", mateId, dof, value });
  await page.waitForTimeout(300);
  s = await summary();
};
const rackMid = () => mid(box(rackI.id));
const pinMid = () => mid(box(pinI.id));
const base = rackMid();
await setVal(plane.id, "tx", 1);
const dx = [rackMid()[0] - base[0], rackMid()[1] - base[1]];
await setVal(plane.id, "tx", 0);
// The run is world X in the part; which DOF moves the rack along X?
const along = Math.abs(dx[0]) > 0.5 ? "tx" : "ty";
const across = along === "tx" ? "ty" : "tx";
// Across: move the rack so its tips sit 12.6 − 2 = 10.6 mm below the pinion centre.
const want = pinMid()[1] - 10.6;
const tipNow = box(rackI.id).max[1];
await setVal(plane.id, across, 1);
const perUnit = box(rackI.id).max[1] - tipNow;
await setVal(plane.id, across, (want - tipNow) / perUnit);
check(
  "the rack sits at the pinion's pitch distance",
  Math.abs(box(rackI.id).max[1] - want) < 0.01,
  JSON.stringify({ want, got: box(rackI.id).max[1], along, across }),
);
await page
  .locator(".viewport canvas")
  .first()
  .hover({ position: { x: 5, y: 5 } });
await page.keyboard.press("7"); // top view
await page.waitForTimeout(900);
await shot("1-unaligned");

// --- The Relation dialog, Rack type: pinion's rz drives the rack's slide.
await page.locator(".asm-new-relation").click();
const dlg = page.locator(".asm-relation");
await dlg.waitFor();
await dlg.locator(".ed-modes button", { hasText: "Rack" }).click();
await dlg.locator(".asm-relation-driver").selectOption(`${hinge.id}:rz`);
await dlg.locator(".asm-relation-driven").selectOption(`${plane.id}:${along}`);
await page.waitForTimeout(500);
const value = await dlg.locator(".asm-relation-value").inputValue();
const line =
  (await dlg
    .locator(".asm-relation-gears")
    .first()
    .textContent()
    .catch(() => "")) ?? "";
check("the radius comes from the pinion's teeth", value === "12", value);
check("the dialog names the pinion and the rack", /12 teeth.*rack.*radius and direction/.test(line), line);
check("Align teeth is on", await dlg.locator(".asm-relation-align").isChecked());
await shot("2-dialog");
await dlg.locator(".ed-primary").click();
await page.waitForTimeout(800);
s = await summary();
const rel = s.relations?.[0];
check("the relation is made", rel?.type === "rack" && rel.value === "12", JSON.stringify(rel));

// Aligned: the rack slid off its 1.3 mm misfit. At rz = 0 the 12-tooth
// pinion's tooth 9 points straight down (tooth 0 along +X, 30° apart), and a
// 20-tooth rack has a space at its centre: in mesh, the two centres line up
// (mod a tooth pitch).
const pitch = 2 * Math.PI;
const wrap = (x) => x - pitch * Math.round(x / pitch);
const offset0 = wrap(rackMid()[0] - pinMid()[0]);
check("aligned: a rack space sits under the pinion's downward tooth", Math.abs(offset0) < 0.01, `${offset0}`);
await shot("3-aligned");

// In mesh as it turns: the rack moves r·θ for a turn θ, and stays in phase.
const x0 = rackMid()[0];
await setVal(hinge.id, "rz", 30);
const moved = rackMid()[0] - x0;
check("turning the pinion 30° moves the rack 2π mm (r·θ)", Math.abs(Math.abs(moved) - pitch) < 0.01, `${moved}`);
// (Which way it moves — Reverse — is measured, and checked by the mesh after
// turning in src/assembly/rackMesh.test.ts.)
await shot("4-turned");

const real = errors.filter((e) => !/502|Bad Gateway/.test(e));
check("no page errors", real.length === 0, real.slice(0, 3).join(" | "));
await close();
done();
