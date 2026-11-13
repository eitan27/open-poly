import { describe, expect, it } from "vitest";
import polygonClipping from "polygon-clipping";
import { gearOutline, type Vec2 } from "../geom/gearProfile";
import { alignRelation, alignTurn, gearRelationValue, placeGear, type GearGeom } from "./gearMesh";
import { IDENTITY } from "./placement";
import { addRelation, phaseToCurrentPose } from "./relations";
import { solve } from "./solve";
import type { AssemblyDoc, Instance, Mat4, Mate, MateConnector } from "./types";

const M = 2;
const spec = (teeth: number) => ({
  teeth,
  module: M,
  pressureAngle: 20,
  profileShift: 0,
  backlash: 0.1,
  rootFillet: 0.76,
});

/** A gear lying in XY at `c`, turned `rot` radians: its geometry and its outline. */
function gear(teeth: number, c: [number, number], rot: number, internal = false) {
  const o = gearOutline(spec(teeth), { internal, rotation: rot, rimWidth: 4 });
  const shift = (r: Vec2[]) => r.map(([x, y]) => [x + c[0], y + c[1]] as Vec2);
  const geom: GearGeom = {
    teeth,
    module: M,
    internal,
    center: [c[0], c[1], 0],
    axis: [0, 0, 1],
    tooth: [Math.cos(rot), Math.sin(rot), 0],
  };
  return { geom, rings: [shift(o.outline), ...o.holes.map(shift)] };
}

const closed = (r: Vec2[]) => [...r, r[0]];
function shoelace(r: Vec2[]) {
  let s = 0;
  for (let i = 0; i < r.length - 1; i++) s += r[i][0] * r[i + 1][1] - r[i + 1][0] * r[i][1];
  return s / 2;
}
const overlap = (a: Vec2[][], b: Vec2[][]) => {
  const res = polygonClipping.intersection([a.map(closed)] as never, [b.map(closed)] as never);
  return res.reduce(
    (s, poly) => s + poly.reduce((t, ring, i) => t + (i === 0 ? 1 : -1) * Math.abs(shoelace(ring as Vec2[])), 0),
    0,
  );
};

describe("alignTurn", () => {
  it("turns the second of an external pair so no tooth overlaps, from any start", () => {
    const cd = (M * (12 + 24)) / 2;
    for (const [rf, rm] of [
      [0, 0],
      [0.1, 0.7],
      [1.3, -2.2],
      [2.9, 0.05],
    ]) {
      // A 12T and a 24T, the second up and to the right at the meshing distance.
      const dir: [number, number] = [Math.cos(0.6), Math.sin(0.6)];
      const f = gear(12, [0, 0], rf);
      const m0 = gear(24, [cd * dir[0], cd * dir[1]], rm);
      const t = alignTurn(f.geom, m0.geom);
      expect(typeof t).toBe("number");
      expect(Math.abs(t as number)).toBeLessThanOrEqual(Math.PI / 24 + 1e-9); // the least turn
      const m = gear(24, [cd * dir[0], cd * dir[1]], rm + (t as number));
      expect(overlap(f.rings, m.rings)).toBeLessThan(1e-3);
    }
    // Control: unaligned, they do overlap.
    expect(overlap(gear(12, [0, 0], 0).rings, gear(24, [cd, 0], 0).rings)).toBeGreaterThan(0.5);
  });

  it("aligns a pinion inside a ring, turning either one", () => {
    const cd = (M * (60 - 18)) / 2;
    for (const [rp, rr] of [
      [0.3, 0.1],
      [-1, 2],
    ]) {
      const ring = gear(60, [0, 0], rr, true);
      const pin = gear(18, [0, -cd], rp);
      // Turn the pinion to the ring…
      const t = alignTurn(ring.geom, pin.geom) as number;
      expect(typeof t).toBe("number");
      expect(overlap(gear(18, [0, -cd], rp + t).rings, ring.rings)).toBeLessThan(1e-3);
      // …or the ring to the pinion.
      const u = alignTurn(pin.geom, ring.geom) as number;
      expect(overlap(pin.rings, gear(60, [0, 0], rr + u, true).rings)).toBeLessThan(1e-3);
    }
    // Control: a pinion half a tooth out of line does overlap the ring.
    const ring = gear(60, [0, 0], 0, true);
    const t = alignTurn(ring.geom, gear(18, [0, -cd], 0).geom) as number;
    expect(overlap(gear(18, [0, -cd], t + Math.PI / 18).rings, ring.rings)).toBeGreaterThan(0.5);
  });

  it("works whatever the placement: a flipped, moved gear meshes the same", () => {
    // The second gear's part is upside down (turned 180° about X) and moved.
    const flip: Mat4 = [1, 0, 0, 0, 0, -1, 0, 0, 0, 0, -1, 0, 36, 0, 5, 1];
    const f = gear(12, [0, 0], 0.4);
    const local: GearGeom = { ...gear(24, [0, 0], 0.9).geom };
    const placed = placeGear(local, flip);
    expect(placed.axis[2]).toBeCloseTo(-1);
    const t = alignTurn(f.geom, placed) as number;
    // In the world, the flipped gear's tooth 0 is at −0.9; turned by t (about +Z).
    const m = gear(24, [36, 0], -0.9 + t);
    expect(overlap(f.rings, m.rings)).toBeLessThan(1e-3);
  });

  it("says why when they can't mesh", () => {
    const a = gear(12, [0, 0], 0).geom;
    expect(alignTurn(a, gear(24, [50, 0], 0).geom)).toMatch(/50 mm apart; to mesh they need 36 mm/);
    expect(alignTurn(a, { ...gear(24, [36, 0], 0).geom, axis: [1, 0, 0] })).toMatch(/parallel/);
    expect(alignTurn(a, { ...gear(24, [36, 0], 0).geom, module: 3 })).toMatch(/modules/);
    expect(alignTurn(gear(60, [0, 0], 0, true).geom, gear(40, [10, 0], 0, true).geom)).toMatch(/ring/);
  });
});

describe("alignRelation", () => {
  // A grounded frame G with axles along Z; each gear part's hub connector is
  // at its own origin, its tooth 0 along local +X.
  const frameAt = (x: number, y: number, flipZ = false): Mat4 =>
    flipZ ? [1, 0, 0, 0, 0, -1, 0, 0, 0, 0, -1, 0, x, y, 0, 1] : [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, 0, 1];
  const FR: Record<string, Mat4> = {
    axleA: frameAt(0, 0),
    axleB: frameAt(36, 0),
    axleR: frameAt(0, 0),
    hub: frameAt(0, 0),
  };
  const lookup = (c: MateConnector) => FR[c.ref.name] ?? `No ${c.ref.name}`;
  const conn = (instanceId: string, name: string): MateConnector => ({
    instanceId,
    ref: { kind: "face", name },
    anchor: "center",
  });
  const hinge = (id: string, axle: string, part: string, rz: string): Mate => ({
    id,
    name: id,
    type: "revolute",
    a: conn("G", axle),
    b: conn(part, "hub"),
    flip: true,
    values: { rz },
  });
  const inst = (id: string, grounded = false): Instance => ({
    id,
    name: id,
    source: { docId: "d", partId: id },
    transform: IDENTITY,
    ...(grounded ? { grounded: true } : {}),
  });
  const local = (teeth: number, internal = false): GearGeom => ({
    teeth,
    module: M,
    internal,
    center: [0, 0, 0],
    axis: [0, 0, 1],
    tooth: [1, 0, 0],
  });

  function check(
    gears: Record<string, GearGeom>,
    axleB: string,
    aTurn: string,
    bTurn: string,
    want: { reverse: boolean },
  ) {
    const gearOf = (id: string) => gears[id] ?? null;
    const a0: AssemblyDoc = {
      instances: [inst("G", true), inst("A"), inst("B")],
      mates: [hinge("ra", "axleA", "A", aTurn), hinge("rb", axleB, "B", bTurn)],
      variables: [],
    };
    const ends = { driver: { mateId: "ra", dof: "rz" as const }, driven: { mateId: "rb", dof: "rz" as const } };
    const { value, reverse } = gearRelationValue(a0, ends, gearOf, (a) => solve(a, lookup))!;
    expect(value).toBe(`${gears.A.teeth}/${gears.B.teeth}`);
    expect(reverse).toBe(want.reverse);
    const withRel = phaseToCurrentPose(
      addRelation(a0, {
        id: "g",
        name: "g",
        type: "gear",
        driver: { mateId: "ra", dof: "rz" },
        driven: { mateId: "rb", dof: "rz" },
        value,
        ...(reverse ? { reverse: true } : {}),
      }),
      "g",
      solve(a0, lookup).values,
      {},
    );
    const aligned = alignRelation(withRel, "g", gearOf, (a) => solve(a, lookup));
    if (typeof aligned === "string") throw new Error(aligned);
    // In mesh now, and still in mesh after the driver turns any amount.
    for (const t of [aTurn, "47", "-133.3"]) {
      const a = { ...aligned, mates: aligned.mates.map((m) => (m.id === "ra" ? { ...m, values: { rz: t } } : m)) };
      const s = solve(a, lookup);
      const f = placeGear(gears.A, s.placements.get("A")!);
      const m = placeGear(gears.B, s.placements.get("B")!);
      expect(Math.abs(alignTurn(f, m) as number)).toBeLessThan(1e-6);
    }
  }

  it("meshes an external pair and keeps it meshed as the driver turns", () => {
    check({ A: local(12), B: local(24) }, "axleB", "10", "33", { reverse: false });
  });

  it("meshes a pinion turning a ring, and a ring turning a pinion", () => {
    FR.axleP = frameAt(0, -42); // (60 − 18) × 2 / 2 from the ring's centre
    check({ A: local(60, true), B: local(18) }, "axleP", "5", "-40", { reverse: true });
    FR.axleQ = frameAt(42, 0);
    check({ A: local(18), B: local(60, true) }, "axleQ", "71", "12", { reverse: true });
  });

  it("follows an upside-down axle: its angle turns the other way, so Reverse is on", () => {
    FR.axleF = frameAt(36, 0, true);
    check({ A: local(12), B: local(24) }, "axleF", "-15", "8", { reverse: true });
  });
});
