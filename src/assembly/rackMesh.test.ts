import { describe, expect, it } from "vitest";
import polygonClipping from "polygon-clipping";
import { addGear, createDocument } from "../document/document";
import { DEFAULT_GEAR_SETTINGS, type GearSettings } from "../document/gear";
import type { SketchPlaneRef } from "../document/planes";
import { gearOutline, rackOutline, type Vec2 } from "../geom/gearProfile";
import { alignRelation, gearGeomOf, placeGear, rackMesh, rackRelationValue, type GearGeom } from "./gearMesh";
import { IDENTITY } from "./placement";
import { addRelation, phaseToCurrentPose } from "./relations";
import { solve } from "./solve";
import type { AssemblyDoc, Dof, Instance, Mat4, Mate, MateConnector } from "./types";

const M = 2;
const spec = (teeth: number) => ({
  teeth,
  module: M,
  pressureAngle: 20,
  profileShift: 0,
  backlash: 0.1,
  rootFillet: 0.76,
});

const closed = (r: Vec2[]) => [...r, r[0]];
function shoelace(r: Vec2[]) {
  let s = 0;
  for (let i = 0; i < r.length - 1; i++) s += r[i][0] * r[i + 1][1] - r[i + 1][0] * r[i][1];
  return s / 2;
}
const overlap = (a: Vec2[][], b: Vec2[][]) =>
  polygonClipping
    .intersection([a.map(closed)] as never, [b.map(closed)] as never)
    .reduce(
      (s, poly) => s + poly.reduce((t, ring, i) => t + (i === 0 ? 1 : -1) * Math.abs(shoelace(ring as Vec2[])), 0),
      0,
    );

/** Outlines in XY of a placed pinion and rack (both lying in XY). */
function pinionRings(g: GearGeom): Vec2[][] {
  const rot = Math.atan2(g.tooth[1], g.tooth[0]) * Math.sign(g.axis[2]);
  const o = gearOutline(spec(g.teeth), { rotation: rot });
  return [o.outline.map(([x, y]) => [x + g.center[0], y + g.center[1]] as Vec2)];
}
function rackRings(g: GearGeom): Vec2[][] {
  const run = g.rack!.run;
  const rot = Math.atan2(run[1], run[0]);
  const half = (g.teeth * Math.PI * M) / 2;
  const o = rackOutline(spec(g.teeth), { height: 8, rotation: rot });
  // `center` is the −x end of the pitch line; the outline is centred.
  const cx = g.center[0] + half * run[0];
  const cy = g.center[1] + half * run[1];
  return [o.outline.map(([x, y]) => [x + cx, y + cy] as Vec2)];
}

describe("rackMesh", () => {
  const pinion = (rot: number): GearGeom => ({
    teeth: 12,
    module: M,
    internal: false,
    center: [0, 0, 0],
    axis: [0, 0, 1],
    tooth: [Math.cos(rot), Math.sin(rot), 0],
  });
  // A 20-tooth rack below the pinion, pitch line at y = −12, teeth up.
  const rack = (x0: number): GearGeom => ({
    teeth: 20,
    module: M,
    internal: false,
    center: [x0, -12, 0],
    axis: [0, 0, 1],
    tooth: [0, 1, 0],
    rack: { run: [1, 0, 0] },
  });

  it("slides the rack by -misfit into mesh from any start", () => {
    for (const [rot, x0] of [
      [0, -60],
      [0.3, -61.7],
      [-1.1, -58.2],
      [2.5, -63],
    ]) {
      const mesh = rackMesh(pinion(rot), rack(x0));
      if (typeof mesh === "string") throw new Error(mesh);
      expect(Math.abs(mesh.misfit)).toBeLessThanOrEqual(Math.PI + 1e-9); // half a pitch at most
      const moved = rack(x0 - mesh.misfit * mesh.t[0]);
      expect(overlap(pinionRings(pinion(rot)), rackRings(moved))).toBeLessThan(1e-3);
      expect(Math.abs((rackMesh(pinion(rot), moved) as { misfit: number }).misfit)).toBeLessThan(1e-9);
      // …or the pinion turned +misfit / r instead.
      const turned = pinion(rot + mesh.misfit / 12);
      expect(overlap(pinionRings(turned), rackRings(rack(x0)))).toBeLessThan(1e-3);
    }
    // Control: half a pitch out, they clash.
    const m = rackMesh(pinion(0), rack(-60)) as { misfit: number };
    expect(overlap(pinionRings(pinion(0)), rackRings(rack(-60 - m.misfit + Math.PI)))).toBeGreaterThan(0.5);
  });

  it("says why when they can't mesh", () => {
    expect(rackMesh(pinion(0), { ...rack(-60), center: [-60, -20, 0] })).toMatch(/20 mm from .* needs 12 mm/);
    expect(rackMesh(pinion(0), { ...rack(-60), tooth: [0, -1, 0] })).toMatch(/face away/);
    expect(rackMesh(pinion(0), { ...rack(-60), module: 3 })).toMatch(/modules/);
    expect(rackMesh({ ...pinion(0), internal: true }, rack(-60))).toMatch(/ring/);
    expect(rackMesh(rack(-60), rack(-60))).toMatch(/Two racks/);
    // A shifted pinion wants its pitch line further out.
    expect(rackMesh({ ...pinion(0), profileShift: 0.5 }, rack(-60))).toMatch(/needs 13 mm/);
  });
});

describe("rack relation: value, Reverse and Align teeth", () => {
  // Column-major frames. Axle: Z up at the origin. Rail: z along ±X at y = −12.
  const FR: Record<string, Mat4> = {
    axle: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
    hub: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
    // x = +Y, y = +Z, z = +X
    rail: [0, 1, 0, 0, 0, 0, 1, 0, 1, 0, 0, 0, 0, -12, 0, 1],
    // x = −Y, y = +Z, z = −X: the same rail, run the other way
    railBack: [0, -1, 0, 0, 0, 0, 1, 0, -1, 0, 0, 0, 0, -12, 0, 1],
    // On the rack part, at its origin, z along its run (local +X).
    shoe: [0, 1, 0, 0, 0, 0, 1, 0, 1, 0, 0, 0, 0, 0, 0, 1],
    shoeBack: [0, -1, 0, 0, 0, 0, 1, 0, -1, 0, 0, 0, 0, 0, 0, 1],
  };
  const lookup = (c: MateConnector) => FR[c.ref.name] ?? `No ${c.ref.name}`;
  const conn = (instanceId: string, name: string): MateConnector => ({
    instanceId,
    ref: { kind: "face", name },
    anchor: "center",
  });
  const inst = (id: string, grounded = false): Instance => ({
    id,
    name: id,
    source: { docId: "d", partId: id },
    transform: IDENTITY,
    ...(grounded ? { grounded: true } : {}),
  });
  // The rack part: pitch line along local X through its origin, teeth +Y.
  const RACK: GearGeom = {
    teeth: 20,
    module: M,
    internal: false,
    center: [-20 * Math.PI, 0, 0],
    axis: [0, 0, 1],
    tooth: [0, 1, 0],
    rack: { run: [1, 0, 0] },
  };
  const PIN: GearGeom = { teeth: 12, module: M, internal: false, center: [0, 0, 0], axis: [0, 0, 1], tooth: [1, 0, 0] };
  const gearOf = (id: string) => ({ P: PIN, R: RACK })[id as "P" | "R"] ?? null;
  const solveAt = (a: AssemblyDoc) => solve(a, lookup);

  function run(rail: string, shoe: string, rackDrives: boolean) {
    const hinge: Mate = {
      id: "rp",
      name: "rp",
      type: "revolute",
      a: conn("G", "axle"),
      b: conn("P", "hub"),
      flip: true,
      values: { rz: "7" },
    };
    const slide: Mate = {
      id: "sr",
      name: "sr",
      type: "slider",
      a: conn("G", rail),
      b: conn("R", shoe),
      flip: true,
      values: { tz: "1.3" },
    };
    const a0: AssemblyDoc = {
      instances: [inst("G", true), inst("P"), inst("R")],
      mates: [hinge, slide],
      variables: [],
    };
    const turn = { mateId: "rp", dof: "rz" as Dof };
    const move = { mateId: "sr", dof: "tz" as Dof };
    const ends = rackDrives ? { driver: move, driven: turn } : { driver: turn, driven: move };
    const v = rackRelationValue(a0, ends, gearOf, solveAt);
    expect(v).not.toBeNull();
    expect(v!.value).toBe("12");
    const withRel = phaseToCurrentPose(
      addRelation(a0, {
        id: "k",
        name: "k",
        type: "rack",
        ...ends,
        value: v!.value,
        ...(v!.reverse ? { reverse: true } : {}),
      }),
      "k",
      solveAt(a0).values,
      {},
    );
    const aligned = alignRelation(withRel, "k", gearOf, solveAt);
    if (typeof aligned === "string") throw new Error(aligned);
    // In mesh, and still in mesh wherever the driver goes.
    const driverId = ends.driver.mateId;
    const dof = ends.driver.dof;
    for (const val of ["0", "33", "-71.5"]) {
      const a = {
        ...aligned,
        mates: aligned.mates.map((m) => (m.id === driverId ? { ...m, values: { [dof]: val } } : m)),
      };
      const s = solveAt(a);
      const p = placeGear(PIN, s.placements.get("P")!);
      const r = placeGear(RACK, s.placements.get("R")!);
      const mesh = rackMesh(p, r);
      if (typeof mesh === "string") throw new Error(mesh);
      // Stored values round to 0.01° / 0.001 mm: microns off at most.
      expect(Math.abs(mesh.misfit)).toBeLessThan(2e-3);
    }
    return v!.reverse;
  }

  it("meshes a pinion driving a rack, and a rack driving a pinion", () => {
    const r1 = run("rail", "shoe", false);
    const r2 = run("rail", "shoe", true);
    expect(r1).toBe(r2);
  });

  it("measures Reverse: a rail run the other way flips it", () => {
    const fwd = run("rail", "shoe", false);
    const back = run("railBack", "shoeBack", false);
    expect(back).toBe(!fwd);
  });
});

describe("gearGeomOf for a rack", () => {
  const TOP: SketchPlaneRef = { kind: "datum", id: "plane-top" };
  it("reads its run, its teeth's direction and its first space", () => {
    const s: GearSettings = {
      ...DEFAULT_GEAR_SETTINGS,
      gearType: "rack",
      params: { ...DEFAULT_GEAR_SETTINGS.params, teeth: "10", rotation: "90", centerX: "5" },
    };
    const { doc, id } = addGear(createDocument(), TOP, s);
    const g = gearGeomOf(doc, id) as GearGeom;
    expect(g.rack).toBeDefined();
    const half = 10 * Math.PI;
    // Top plane: u = X, v = Y. Runs along +Y, teeth toward −X, space 0 at −Y end.
    expect(g.rack!.run[1]).toBeCloseTo(1);
    expect(g.tooth[0]).toBeCloseTo(-1);
    expect(g.center[0]).toBeCloseTo(5);
    expect(g.center[1]).toBeCloseTo(-half);
  });
});
