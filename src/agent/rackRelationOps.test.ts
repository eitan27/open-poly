// The agent's add_relation / edit_relation with gear parts on both ends: the
// value and direction from the teeth, the rack moved to its pinion, the teeth
// aligned and the travel limited — what the Relation dialog does.
import { describe, expect, it } from "vitest";
import { placeGear, rackMesh, type GearGeom } from "../assembly/gearMesh";
import { IDENTITY, multiply, translation } from "../assembly/placement";
import { rackOffBy } from "../assembly/rackPlace";
import { solve } from "../assembly/solve";
import type { AssemblyDoc, Dof, Instance, Mat4, Mate, MateConnector } from "../assembly/types";
import type { SourceState } from "../assembly/useAssemblySources";
import type { ShapeMeshPayload } from "../kernel/types";
import type { AssemblyAgentState } from "./assemblySummary";
import { planAddRelation, planEditRelation } from "./assemblyOps";

const M = 2;
const FR: Record<string, Mat4> = {
  axle: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
  hub: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
  rail: [0, 1, 0, 0, 0, 0, 1, 0, 1, 0, 0, 0, 0, -15, 0, 1], // 3 mm too far out
  shoe: [0, 1, 0, 0, 0, 0, 1, 0, 1, 0, 0, 0, 0, 0, 0, 1],
};
const frameOf = (c: MateConnector) => {
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
const mesh = {} as ShapeMeshPayload;
const SOURCES = new Map<string, SourceState>([
  [
    "d",
    {
      status: "ready",
      name: "Rack pair",
      updatedAt: 1,
      parts: [
        { partId: "G", name: "Frame", color: 0, opacity: 1, mesh },
        { partId: "P", name: "Pinion", color: 0, opacity: 1, mesh, gear: PIN },
        { partId: "R", name: "Rack", color: 0, opacity: 1, mesh, gear: RACK },
      ],
    },
  ],
]);
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
  a: conn("G", "rail"),
  b: conn("R", "shoe"),
  flip: true,
  values: { tz: "1.3" },
};
const A0: AssemblyDoc = { instances: [inst("G", true), inst("P"), inst("R")], mates: [hinge, slide], variables: [] };
const state = (a: AssemblyDoc): AssemblyAgentState => ({
  assembly: a,
  solution: solve(a, frameOf),
  sources: SOURCES,
  settled: true,
  warnings: new Map(),
  selection: [],
});
const turn = { mateId: "rp", dof: "rz" as Dof };
const move = { mateId: "sr", dof: "tz" as Dof };
const inMesh = (a: AssemblyDoc) => {
  const s = solve(a, frameOf);
  const m = rackMesh(placeGear(PIN, s.placements.get("P")!), placeGear(RACK, s.placements.get("R")!));
  if (typeof m === "string") throw new Error(m);
  return Math.abs(m.misfit) < 2e-3;
};

describe("add_relation between a pinion and a rack", () => {
  it("with no value: radius from the teeth, rack placed, teeth aligned, travel limited", () => {
    const r = planAddRelation(
      state(A0),
      { op: "addRelation", type: "rack", driver: turn, driven: move },
      () => "k",
      frameOf,
    );
    if ("error" in r) throw new Error(r.error);
    const rel = r.assembly.relations![0];
    expect(rel.value).toBe("12");
    expect(r.note).toMatch(/Pinion radius 12 from the teeth/);
    expect(r.note).toMatch(/Moved the rack 3\.00 mm/);
    expect(r.note).toMatch(/Limited the driver/);
    expect(
      Math.abs(
        rackOffBy(
          r.assembly,
          rel,
          (id) => ({ P: PIN, R: RACK })[id as "P"] ?? null,
          (a) => solve(a, frameOf),
        ) as number,
      ),
    ).toBeLessThan(0.01);
    expect(inMesh(r.assembly)).toBe(true);
    // Still in mesh as the pinion turns, within its new limits.
    const lim = r.assembly.mates.find((m) => m.id === "rp")!.limits!.rz!;
    for (const v of [lim.min!, "33", lim.max!]) {
      const t = {
        ...r.assembly,
        mates: r.assembly.mates.map((m) => (m.id === "rp" ? { ...m, values: { rz: v } } : m)),
      };
      expect(inMesh(t)).toBe(true);
    }
  });

  it("each step can be turned off; a given value and reverse are kept", () => {
    const r = planAddRelation(
      state(A0),
      {
        op: "addRelation",
        type: "rack",
        driver: turn,
        driven: move,
        value: "11",
        reverse: true,
        alignTeeth: false,
        placeRack: false,
        limitToRack: false,
      },
      () => "k",
      frameOf,
    );
    if ("error" in r) throw new Error(r.error);
    expect(r.assembly.relations![0]).toMatchObject({ value: "11", reverse: true });
    expect(r.note).toBeUndefined();
    expect(r.assembly.mates.find((m) => m.id === "rp")!.limits).toBeUndefined();
    expect(
      r.assembly.mates.find((m) => m.id === "sr")!.b.offset ?? r.assembly.mates.find((m) => m.id === "sr")!.a.offset,
    ).toBeUndefined();
  });

  it("asks for a value when the parts aren't gears", () => {
    const noGears: AssemblyAgentState = { ...state(A0), sources: new Map() };
    const r = planAddRelation(
      noGears,
      { op: "addRelation", type: "rack", driver: turn, driven: move },
      () => "k",
      frameOf,
    );
    expect("error" in r && r.error).toMatch(/Give a value: the pinion radius/);
  });

  it("edit_relation aligns, places and limits only when asked", () => {
    const made = planAddRelation(
      state(A0),
      {
        op: "addRelation",
        type: "rack",
        driver: turn,
        driven: move,
        alignTeeth: false,
        placeRack: false,
        limitToRack: false,
      },
      () => "k",
      frameOf,
    );
    if ("error" in made) throw new Error(made.error);
    const plain = planEditRelation(
      state(made.assembly),
      { op: "editRelation", relationId: "k", name: "Rack drive" },
      frameOf,
    );
    if ("error" in plain) throw new Error(plain.error);
    expect(plain.note).toBeUndefined();
    const fixed = planEditRelation(
      state(made.assembly),
      { op: "editRelation", relationId: "k", placeRack: true, alignTeeth: true, limitToRack: true },
      frameOf,
    );
    if ("error" in fixed) throw new Error(fixed.error);
    expect(inMesh(fixed.assembly)).toBe(true);
    expect(fixed.assembly.mates.find((m) => m.id === "rp")!.limits?.rz).toBeDefined();
  });
});
