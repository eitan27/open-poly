import { describe, expect, it } from "vitest";
import { alignRelation, placeGear, rackMesh, rackRelationValue, type GearGeom } from "./gearMesh";
import { multiply, translation } from "./placement";
import { IDENTITY } from "./placement";
import { placeRack, rackOffBy, rackTravelLimits, withTravelLimits } from "./rackPlace";
import { addRelation, phaseToCurrentPose } from "./relations";
import { solve } from "./solve";
import type { AssemblyDoc, Dof, Instance, Mat4, Mate, MateConnector } from "./types";

const M = 2;
// Column-major frames. Axle: Z up at the origin. Rail: z along +X at y = −15
// (3 mm too far from the pinion: its pitch line wants y = −12).
const FR: Record<string, Mat4> = {
  axle: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
  hub: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
  rail: [0, 1, 0, 0, 0, 0, 1, 0, 1, 0, 0, 0, 0, -15, 0, 1],
  shoe: [0, 1, 0, 0, 0, 0, 1, 0, 1, 0, 0, 0, 0, 0, 0, 1],
  // The rail turned round (teeth would face away).
  railFlip: [0, -1, 0, 0, 0, 0, 1, 0, -1, 0, 0, 0, 0, -15, 0, 1],
};
/** As the app's frames do: the connector's frame, then its offset within it. */
const lookup = (c: MateConnector) => {
  const f = FR[c.ref.name];
  if (!f) return `No ${c.ref.name}`;
  const o = c.offset ?? {};
  return multiply(f, translation([Number(o.x ?? 0), Number(o.y ?? 0), Number(o.z ?? 0)]));
};
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
const turn = { mateId: "rp", dof: "rz" as Dof };
const move = { mateId: "sr", dof: "tz" as Dof };

const assembly = (rail = "rail", rackSide: "a" | "b" = "b"): AssemblyDoc => {
  const hinge: Mate = {
    id: "rp",
    name: "rp",
    type: "revolute",
    a: conn("G", "axle"),
    b: conn("P", "hub"),
    flip: true,
    values: { rz: "7" },
  };
  const ends =
    rackSide === "b" ? { a: conn("G", rail), b: conn("R", "shoe") } : { a: conn("R", "shoe"), b: conn("G", rail) };
  const slide: Mate = { id: "sr", name: "sr", type: "slider", ...ends, flip: true, values: { tz: "1.3" } };
  return { instances: [inst("G", true), inst("P"), inst("R")], mates: [hinge, slide], variables: [] };
};

describe("placeRack", () => {
  it("moves a slider-mated rack to the pinion's pitch distance by its connector offset", () => {
    for (const side of ["a", "b"] as const) {
      const a0 = assembly("rail", side);
      expect(rackOffBy(a0, { driver: turn, driven: move }, gearOf, solveAt)).toBeCloseTo(3, 6);
      const placed = placeRack(a0, { driver: turn, driven: move }, gearOf, solveAt);
      if (typeof placed === "string") throw new Error(placed);
      expect(Math.abs(rackOffBy(placed, { driver: turn, driven: move }, gearOf, solveAt) as number)).toBeLessThan(0.01);
      // Only an offset changed: the slide's value is as it was.
      expect(placed.mates.find((m) => m.id === "sr")!.values).toEqual({ tz: "1.3" });
    }
  });

  it("then a relation aligns and keeps them in mesh", () => {
    const placed = placeRack(assembly(), { driver: turn, driven: move }, gearOf, solveAt) as AssemblyDoc;
    const v = rackRelationValue(placed, { driver: turn, driven: move }, gearOf, solveAt)!;
    const withRel = phaseToCurrentPose(
      addRelation(placed, {
        id: "k",
        name: "k",
        type: "rack",
        driver: turn,
        driven: move,
        value: v.value,
        ...(v.reverse ? { reverse: true } : {}),
      }),
      "k",
      solveAt(placed).values,
      {},
    );
    const aligned = alignRelation(withRel, "k", gearOf, solveAt) as AssemblyDoc;
    const s = solveAt(aligned);
    const mesh = rackMesh(placeGear(PIN, s.placements.get("P")!), placeGear(RACK, s.placements.get("R")!));
    if (typeof mesh === "string") throw new Error(mesh);
    expect(Math.abs(mesh.misfit)).toBeLessThan(2e-3);
  });

  it("refuses a rack whose teeth face away, saying so", () => {
    expect(placeRack(assembly("railFlip"), { driver: turn, driven: move }, gearOf, solveAt)).toMatch(/face away/);
  });
});

describe("rackTravelLimits", () => {
  it("bounds the driver so the pinion stays a tooth in from either end of the rack", () => {
    const placed = placeRack(assembly(), { driver: turn, driven: move }, gearOf, solveAt) as AssemblyDoc;
    const v = rackRelationValue(placed, { driver: turn, driven: move }, gearOf, solveAt)!;
    const a = phaseToCurrentPose(
      addRelation(placed, {
        id: "k",
        name: "k",
        type: "rack",
        driver: turn,
        driven: move,
        value: v.value,
        ...(v.reverse ? { reverse: true } : {}),
      }),
      "k",
      solveAt(placed).values,
      {},
    );
    const lim = rackTravelLimits(a, "k", gearOf, solveAt);
    if (typeof lim === "string") throw new Error(lim);
    expect(lim.mateId).toBe("rp");
    // 20 teeth of 2π mm, a tooth kept at each end: 18 pitches of travel =
    // 18 × 2π / 12 rad = 540° in all, around where it is now.
    expect(lim.max - lim.min).toBeGreaterThan(539.5);
    expect(lim.max - lim.min).toBeLessThanOrEqual(540);
    expect(lim.min).toBeLessThan(7);
    expect(lim.max).toBeGreaterThan(7);
    // At each limit, the pinion meets the rack a tooth (2π) in from an end.
    const limited = withTravelLimits(a, lim);
    for (const at of [lim.min, lim.max]) {
      const t = {
        ...limited,
        mates: limited.mates.map((m) => (m.id === "rp" ? { ...m, values: { rz: String(at) } } : m)),
      };
      const s = solveAt(t);
      const r = placeGear(RACK, s.placements.get("R")!);
      const u = 0 - r.center[0]; // the pinion's foot is at x = 0
      expect(Math.min(u, 40 * Math.PI - u)).toBeGreaterThan(2 * Math.PI - 0.05);
    }
    // Past them, the solver clamps.
    const past = {
      ...limited,
      mates: limited.mates.map((m) => (m.id === "rp" ? { ...m, values: { rz: String(lim.max + 90) } } : m)),
    };
    expect(solveAt(past).values.get("rp")?.rz).toBeCloseTo(lim.max, 6);
  });
});
