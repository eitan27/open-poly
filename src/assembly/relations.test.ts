import { describe, expect, it } from "vitest";
import { keepSolved, migrateAssembly, removeInstances, removeMates } from "./assembly";
import { dragAssembly } from "./drag";
import { animator } from "./animate";
import { defaultX, frameMatrix } from "./frames";
import { applyPoint, IDENTITY, type Vec3 } from "./placement";
import {
  addRelation,
  phaseToCurrentPose,
  relationBlocker,
  relationFactor,
  removeRelations,
  routeToDriver,
} from "./relations";
import { solve } from "./solve";
import type { AssemblyDoc, Dof, Instance, Mat4, Mate, MateConnector, MateType, Relation } from "./types";

const frame = (origin: Vec3, z: Vec3): Mat4 => frameMatrix({ origin, z, x: defaultX(z) });
const inst = (id: string, extra: Partial<Instance> = {}): Instance => ({
  id,
  name: id,
  source: { docId: "d", partId: "p" },
  transform: IDENTITY,
  ...extra,
});
const conn = (instanceId: string, name: string): MateConnector => ({
  instanceId,
  ref: { kind: "face", name },
  anchor: "center",
});
const mate = (id: string, type: MateType, a: MateConnector, b: MateConnector, extra: Partial<Mate> = {}): Mate => ({
  id,
  name: id,
  type,
  a,
  b,
  ...extra,
});
const rel = (
  id: string,
  type: Relation["type"],
  driver: [string, Dof],
  driven: [string, Dof],
  value: string,
  extra: Partial<Relation> = {},
): Relation => ({
  id,
  name: id,
  type,
  driver: { mateId: driver[0], dof: driver[1] },
  driven: { mateId: driven[0], dof: driven[1] },
  value,
  ...extra,
});

// A grounded frame G with three axles along Z at x = 0, 30 and 60, and a
// slideway along X at y = −20. Each gear/part's own connector is at its origin.
const z: Vec3 = [0, 0, 1];
const FRAMES: Record<string, Mat4> = {
  axle0: frame([0, 0, 0], z),
  axle1: frame([30, 0, 0], z),
  axle2: frame([60, 0, 0], z),
  way: frame([0, -20, 0], [1, 0, 0]),
  hub: frame([0, 0, 0], z),
  rail: frame([0, 0, 0], [1, 0, 0]),
};
const lookup = (c: MateConnector): Mat4 | string => FRAMES[c.ref.name] ?? `No ${c.ref.name}`;
const hinge = (id: string, axle: string, part: string, rz?: string) =>
  mate(id, "revolute", conn("G", axle), conn(part, "hub"), { flip: true, ...(rz ? { values: { rz } } : {}) });

/** A part's turn about its axle, in degrees, from where its local +X points. */
const turn = (s: ReturnType<typeof solve>, id: string) => {
  const m = s.placements.get(id)!;
  return (Math.atan2(m[1], m[0]) * 180) / Math.PI;
};
const gears = (relations: Relation[], aTurn = "30"): AssemblyDoc => ({
  instances: [inst("G", { grounded: true }), inst("A"), inst("B"), inst("C")],
  mates: [hinge("ra", "axle0", "A", aTurn), hinge("rb", "axle1", "B"), hinge("rc", "axle2", "C")],
  variables: [{ id: "v", name: "teeth", expression: "2" } as AssemblyDoc["variables"][number]],
  relations,
});

describe("relationFactor", () => {
  it("turns a gear the other way, by its ratio", () => {
    expect(relationFactor(rel("g", "gear", ["a", "rz"], ["b", "rz"], "2"), {})).toBe(-2);
    expect(relationFactor(rel("g", "gear", ["a", "rz"], ["b", "rz"], "2", { reverse: true }), {})).toBe(2);
  });
  it("moves a rack by the pinion's radius per radian, either way round", () => {
    expect(relationFactor(rel("r", "rack", ["a", "rz"], ["b", "tx"], "10"), {})).toBeCloseTo((10 * Math.PI) / 180);
    expect(relationFactor(rel("r", "rack", ["b", "tx"], ["a", "rz"], "10"), {})).toBeCloseTo(180 / (10 * Math.PI));
  });
  it("moves a screw by its pitch per turn", () => {
    expect(relationFactor(rel("s", "screw", ["a", "rz"], ["a", "tz"], "1.5"), {})).toBeCloseTo(1.5 / 360);
  });
  it("names the assembly's variables, and refuses a zero", () => {
    expect(relationFactor(rel("g", "gear", ["a", "rz"], ["b", "rz"], "teeth / 4"), { teeth: 8 })).toBe(-2);
    expect(() => relationFactor(rel("g", "gear", ["a", "rz"], ["b", "rz"], "0"), {})).toThrow();
  });
});

describe("relations in the solver", () => {
  it("turns a meshed gear the other way, by the ratio", () => {
    const s = solve(gears([rel("g1", "gear", ["ra", "rz"], ["rb", "rz"], "2")]), lookup);
    expect(s.relationProblems.size).toBe(0);
    expect(turn(s, "A")).toBeCloseTo(30);
    expect(turn(s, "B")).toBeCloseTo(-60);
    expect(s.values.get("rb")?.rz).toBeCloseTo(-60);
  });

  it("adds the driven mate's own value as a phase", () => {
    const a = gears([rel("g1", "gear", ["ra", "rz"], ["rb", "rz"], "1")]);
    a.mates[1] = { ...a.mates[1], values: { rz: "15" } };
    expect(turn(solve(a, lookup), "B")).toBeCloseTo(15 - 30);
  });

  it("runs a gear train in order, whatever order the relations are in", () => {
    const s = solve(
      gears([
        rel("g2", "gear", ["rb", "rz"], ["rc", "rz"], "teeth"),
        rel("g1", "gear", ["ra", "rz"], ["rb", "rz"], "1"),
      ]),
      lookup,
    );
    expect(s.relationProblems.size).toBe(0);
    expect(turn(s, "B")).toBeCloseTo(-30);
    expect(turn(s, "C")).toBeCloseTo(60);
  });

  it("refuses a loop of relations, and a DOF driven twice", () => {
    const loop = solve(
      gears([rel("g1", "gear", ["ra", "rz"], ["rb", "rz"], "1"), rel("g2", "gear", ["rb", "rz"], ["ra", "rz"], "1")]),
      lookup,
    );
    expect(loop.relationProblems.get("g1")).toMatch(/loop of relations/);
    expect(loop.relationProblems.get("g2")).toMatch(/loop of relations/);
    const twice = solve(
      gears([rel("g1", "gear", ["ra", "rz"], ["rc", "rz"], "1"), rel("g2", "gear", ["rb", "rz"], ["rc", "rz"], "1")]),
      lookup,
    );
    expect(twice.relationProblems.get("g2")).toMatch(/g1 already drives/);
    expect(turn(twice, "C")).toBeCloseTo(-30);
  });

  it("says why a relation can't apply", () => {
    const p = (r: Relation, a = gears([r])) => solve(a, lookup).relationProblems.get(r.id);
    expect(p(rel("x", "gear", ["ra", "rz"], ["rb", "tz"], "1"))).toMatch(/rotation|no tz/);
    expect(p(rel("x", "rack", ["ra", "rz"], ["rb", "rz"], "1"))).toMatch(/rotation and a translation/);
    expect(p(rel("x", "gear", ["ra", "rz"], ["ra", "rz"], "1"))).toMatch(/drives itself/);
    expect(p(rel("x", "gear", ["ra", "rz"], ["gone", "rz"], "1"))).toMatch(/removed/);
    expect(p(rel("x", "gear", ["ra", "rz"], ["rb", "rz"], "nope"))).toMatch(/Bad ratio/);
    const driven = gears([rel("x", "gear", ["ra", "rz"], ["rb", "rz"], "1")]);
    driven.mates[1] = { ...driven.mates[1], values: { rz: "teeth * 10" } };
    expect(p(driven.relations![0], driven)).toMatch(/set by "teeth \* 10"/);
  });

  it("leaves a suppressed relation out", () => {
    const s = solve(gears([rel("g1", "gear", ["ra", "rz"], ["rb", "rz"], "1", { suppressed: true })]), lookup);
    expect(turn(s, "B")).toBeCloseTo(0);
  });

  it("drives a rack along its slideway from a pinion's turn", () => {
    const a: AssemblyDoc = {
      instances: [inst("G", { grounded: true }), inst("P"), inst("R")],
      mates: [
        hinge("rp", "axle0", "P", "90"),
        mate("sr", "slider", conn("G", "way"), conn("R", "rail"), { flip: true }),
      ],
      variables: [],
      relations: [rel("k", "rack", ["rp", "rz"], ["sr", "tz"], "10")],
    };
    const s = solve(a, lookup);
    expect(s.relationProblems.size).toBe(0);
    // A quarter turn of a 10 mm pinion: 5π mm along the way.
    expect(s.values.get("sr")?.tz).toBeCloseTo(5 * Math.PI);
    expect(applyPoint(s.placements.get("R")!, [0, 0, 0])[0]).toBeCloseTo(5 * Math.PI);
  });

  it("couples a cylindrical mate's turn to its own slide: a screw", () => {
    const a: AssemblyDoc = {
      instances: [inst("G", { grounded: true }), inst("N")],
      mates: [mate("c", "cylindrical", conn("G", "axle0"), conn("N", "hub"), { flip: true, values: { rz: "720" } })],
      variables: [],
      relations: [rel("s", "screw", ["c", "rz"], ["c", "tz"], "1.25")],
    };
    const s = solve(a, lookup);
    expect(s.values.get("c")?.tz).toBeCloseTo(2.5);
    expect(applyPoint(s.placements.get("N")!, [0, 0, 0])[2]).toBeCloseTo(2.5);
  });

  it("drives a loop group from outside it", () => {
    // B is held by two mates at once (a revolute and a planar on the same
    // axle), so it's solved numerically; the gear still turns it.
    const a = gears([rel("g1", "gear", ["ra", "rz"], ["rb", "rz"], "1")]);
    a.mates.push(mate("pb", "planar", conn("G", "axle1"), conn("B", "hub"), { flip: true }));
    const s = solve(a, lookup);
    expect(s.loops.length).toBe(1);
    expect(s.problems.size).toBe(0);
    expect(turn(s, "B")).toBeCloseTo(-30, 3);
  });

  it("turns a whole gear train when its driver is animated", () => {
    const run = animator(
      gears([rel("g1", "gear", ["ra", "rz"], ["rb", "rz"], "1"), rel("g2", "gear", ["rb", "rz"], ["rc", "rz"], "2")]),
      lookup,
      { mateId: "ra", dof: "rz" },
    );
    const s = run.at(45);
    expect(turn(s, "B")).toBeCloseTo(-45);
    expect(turn(s, "C")).toBeCloseTo(90);
  });
});

describe("routeToDriver", () => {
  const train = gears([
    rel("g1", "gear", ["ra", "rz"], ["rb", "rz"], "1"),
    rel("g2", "gear", ["rb", "rz"], ["rc", "rz"], "2"),
  ]);
  it("leaves a DOF nothing drives as it is", () => {
    expect(routeToDriver(train, "ra", "rz", 10, {})).toEqual({ mateId: "ra", dof: "rz", value: 10 });
  });
  it("follows a driven DOF back to the root of its gear train", () => {
    // C at 90° needs B at −45°, which needs A at 45°.
    const r = routeToDriver(train, "rc", "rz", 90, {});
    expect(r).toMatchObject({ mateId: "ra", dof: "rz" });
    expect((r as { value: number }).value).toBeCloseTo(45);
  });
  it("takes the driven DOF's phase off", () => {
    const a = gears([rel("g1", "gear", ["ra", "rz"], ["rb", "rz"], "1")]);
    a.mates[1] = { ...a.mates[1], values: { rz: "10" } };
    expect((routeToDriver(a, "rb", "rz", -20, {}) as { value: number }).value).toBeCloseTo(30);
  });
  it("refuses when the root is an expression", () => {
    const a = gears([rel("g1", "gear", ["ra", "rz"], ["rb", "rz"], "1")], "teeth * 5");
    expect(routeToDriver(a, "rb", "rz", 5, {})).toEqual({ error: expect.stringMatching(/set by "teeth \* 5"/) });
  });
});

describe("relations in the document", () => {
  const a = gears([rel("g1", "gear", ["ra", "rz"], ["rb", "rz"], "2")]);
  it("survive a save and load", () => {
    expect(migrateAssembly(JSON.parse(JSON.stringify(a))).relations).toEqual(a.relations);
    const { relations: _r, ...none } = a;
    expect(migrateAssembly(none).relations).toBeUndefined();
    expect(() => migrateAssembly({ ...a, relations: [{ id: "x", type: "cog" }] })).toThrow(/corrupt/);
  });
  it("go with the mates and instances they use", () => {
    expect(removeMates(a, ["rb"]).relations).toBeUndefined();
    expect(removeInstances(a, ["A"]).relations).toBeUndefined();
    expect(removeMates(a, ["rc"]).relations).toHaveLength(1);
  });
  it("are added and removed", () => {
    const b = addRelation(a, rel("g2", "gear", ["rb", "rz"], ["rc", "rz"], "1"));
    expect(b.relations).toHaveLength(2);
    expect(removeRelations(b, ["g1", "g2"]).relations).toBeUndefined();
  });
  it("keep their phase when the solve is kept", () => {
    const loopy = gears([rel("g1", "gear", ["ra", "rz"], ["rb", "rz"], "1")]);
    loopy.mates.push(mate("pb", "planar", conn("G", "axle1"), conn("B", "hub"), { flip: true }));
    const kept = keepSolved(loopy, solve(loopy, lookup));
    expect(kept.mates.find((m) => m.id === "rb")?.values?.rz).toBeUndefined();
  });
});

describe("dragging through a relation", () => {
  const about = (p: Vec3, deg: number): Mat4 => {
    const r = (deg * Math.PI) / 180;
    const [c, s] = [Math.cos(r), Math.sin(r)];
    // Rotation about Z through p.
    return [c, s, 0, 0, -s, c, 0, 0, 0, 0, 1, 0, p[0] - c * p[0] + s * p[1], p[1] - s * p[0] - c * p[1], p[2], 1];
  };
  const drag = (a: AssemblyDoc, id: string, motion: Mat4) => {
    const before = solve(a, lookup);
    const r = dragAssembly(a, before, lookup, id, motion);
    return { ...r, after: r.next ? solve(r.next, lookup) : null };
  };

  it("turns the driver when the driven gear is turned, so both turn", () => {
    const a = gears([rel("g1", "gear", ["ra", "rz"], ["rb", "rz"], "2")], "0");
    const r = drag(a, "B", about([30, 0, 0], -40));
    expect(r.error).toBeNull();
    expect(turn(r.after!, "B")).toBeCloseTo(-40, 1);
    expect(turn(r.after!, "A")).toBeCloseTo(20, 1);
    // B keeps its phase; A's value is what moved.
    expect(r.next!.mates.find((m) => m.id === "rb")?.values?.rz).toBeUndefined();
    expect(r.next!.mates.find((m) => m.id === "ra")?.values?.rz).toBe("20");
  });

  it("turns the driven gear along with a turned driver", () => {
    const a = gears([rel("g1", "gear", ["ra", "rz"], ["rb", "rz"], "1")], "0");
    const r = drag(a, "A", about([0, 0, 0], 25));
    expect(turn(r.after!, "B")).toBeCloseTo(-25, 1);
  });

  it("refuses when the driver is an expression", () => {
    const a = gears([rel("g1", "gear", ["ra", "rz"], ["rb", "rz"], "1")], "teeth * 5");
    expect(drag(a, "B", about([30, 0, 0], 10)).error).toMatch(/set by "teeth \* 5"/);
  });

  it("turns a screw's nut, which then slides by the pitch", () => {
    const a: AssemblyDoc = {
      instances: [inst("G", { grounded: true }), inst("N")],
      mates: [mate("c", "cylindrical", conn("G", "axle0"), conn("N", "hub"), { flip: true })],
      variables: [],
      relations: [rel("s", "screw", ["c", "rz"], ["c", "tz"], "2")],
    };
    const r = drag(a, "N", about([0, 0, 0], 90));
    expect(r.error).toBeNull();
    expect(r.after!.values.get("c")?.rz).toBeCloseTo(90, 1);
    expect(r.after!.values.get("c")?.tz).toBeCloseTo(0.5, 3);
  });
});

describe("relationBlocker", () => {
  const c = (i: string) => ({ instanceId: i, ref: { kind: "face" as const, name: "f" }, anchor: "center" as const });
  const m = (id: string, type: MateType) => mate(id, type, c("A"), c("B"));
  it("blocks with no mates, saying to add one that moves", () => {
    expect(relationBlocker([])).toMatch(/Add two moving mates/);
  });
  it("blocks a lone revolute, asking for a second mate", () => {
    expect(relationBlocker([m("r", "revolute")])).toMatch(/second mate/);
  });
  it("blocks sliders alone: nothing turns", () => {
    expect(relationBlocker([m("s1", "slider"), m("s2", "slider")])).toMatch(/turns/);
  });
  it("allows two mates that turn (a gear)", () => {
    expect(relationBlocker([m("r1", "revolute"), m("r2", "revolute")])).toBeNull();
    expect(relationBlocker([m("r", "revolute"), m("b", "ball")])).toBeNull();
  });
  it("allows one that turns and another that slides (a rack)", () => {
    expect(relationBlocker([m("r", "revolute"), m("s", "slider")])).toBeNull();
  });
  it("allows a lone cylindrical mate (a screw on its own turn and slide)", () => {
    expect(relationBlocker([m("c", "cylindrical")])).toBeNull();
  });
});

describe("phaseToCurrentPose", () => {
  it("keeps the driven gear where it is when a relation is switched back on", () => {
    // B was turned to 7° (teeth lined up) while the relation was off, and A
    // sits at 30°. Back on with a ratio of 2, B would read 0 + (−2 × 30) = −60°.
    const off = gears([rel("g", "gear", ["ra", "rz"], ["rb", "rz"], "2", { suppressed: true })]);
    off.mates = off.mates.map((m) => (m.id === "rb" ? { ...m, values: { rz: "7" } } : m));
    const before = solve(off, lookup);
    expect(turn(before, "B")).toBeCloseTo(7);

    const on = { ...off, relations: off.relations!.map((r) => ({ ...r, suppressed: undefined })) };
    expect(turn(solve(on, lookup), "B")).toBeCloseTo(-53); // the snap: 7 + (−2 × 30)

    const kept = phaseToCurrentPose(on, "g", before.values, {});
    const after = solve(kept, lookup);
    expect(turn(after, "B")).toBeCloseTo(7);
    // …and it still turns with A from there.
    const moved = { ...kept, mates: kept.mates.map((m) => (m.id === "ra" ? { ...m, values: { rz: "40" } } : m)) };
    expect(turn(solve(moved, lookup), "B")).toBeCloseTo(7 - 20);
  });

  it("leaves an expression phase, a suppressed relation and a bad ratio alone", () => {
    const values = solve(gears([]), lookup).values;
    const expr = gears([rel("g", "gear", ["ra", "rz"], ["rb", "rz"], "2")]);
    expr.mates = expr.mates.map((m) => (m.id === "rb" ? { ...m, values: { rz: "teeth * 3" } } : m));
    expect(phaseToCurrentPose(expr, "g", values, { teeth: 2 })).toBe(expr);
    const off = gears([rel("g", "gear", ["ra", "rz"], ["rb", "rz"], "2", { suppressed: true })]);
    expect(phaseToCurrentPose(off, "g", values, {})).toBe(off);
    const bad = gears([rel("g", "gear", ["ra", "rz"], ["rb", "rz"], "0")]);
    expect(phaseToCurrentPose(bad, "g", values, {})).toBe(bad);
  });
});
