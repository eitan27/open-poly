import { describe, expect, it } from "vitest";
import { evaluateVariables } from "../document/document";
import { keepSolved } from "./assembly";
import { defaultX, frameMatrix } from "./frames";
import { dragAssembly } from "./drag";
import { planLoopInput } from "./loopInput";
import { applyPoint, IDENTITY, multiply, translation, type Vec3 } from "./placement";
import { solve } from "./solve";
import type { AssemblyDoc, Instance, Mat4, Mate, MateConnector } from "./types";

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

// The four-bar of loops.test.ts: ground pins at (0,0) and (40,0), crank 10
// up to (0,10), coupler to (40,30), rocker 30 down to the ground.
const z: Vec3 = [0, 0, 1];
const FRAMES: Record<string, Mat4> = {
  O1: frame([0, 0, 0], z),
  O2: frame([40, 0, 0], z),
  B1: frame([0, 0, 0], z),
  B2: frame([0, 10, 0], z),
  C1: frame([0, 10, 0], z),
  C2: frame([40, 30, 0], z),
  D1: frame([40, 0, 0], z),
  D2: frame([40, 30, 0], z),
  S: frame([100, 0, 0], z),
};
const frameOf = (c: MateConnector): Mat4 | string => FRAMES[c.ref.name] ?? `No ${c.ref.name}`;
const hinge = (id: string, a: MateConnector, b: MateConnector, extra: Partial<Mate> = {}): Mate => ({
  id,
  name: id,
  type: "revolute",
  a,
  b,
  flip: true,
  ...extra,
});
const fourBar = (crank?: string): AssemblyDoc => ({
  instances: [inst("Ground", { grounded: true }), inst("Crank"), inst("Coupler"), inst("Rocker"), inst("Side")],
  mates: [
    hinge("r1", conn("Ground", "O1"), conn("Crank", "B1"), crank ? { values: { rz: crank } } : {}),
    hinge("r2", conn("Crank", "B2"), conn("Coupler", "C1")),
    hinge("r3", conn("Coupler", "C2"), conn("Rocker", "D2")),
    hinge("r4", conn("Ground", "O2"), conn("Rocker", "D1")),
    // Outside the loop: a part hinged on the ground on its own.
    hinge("side", conn("Ground", "S"), conn("Side", "B1")),
  ],
  variables: [{ id: "v", name: "angle", expression: "0" }] as AssemblyDoc["variables"],
});

/** Plan entries on `a` as it's solved now. */
function plan(a: AssemblyDoc, entries: { mateId: string; dof: "rz"; text: string }[]) {
  const s0 = solve(a, frameOf);
  const now = keepSolved(a, s0);
  const s = solve(now, frameOf);
  return { now, r: planLoopInput(now, s, frameOf, evaluateVariables(now.variables).scope, entries) };
}
const solved = (a: AssemblyDoc) => solve(a, frameOf);
const crankTip = (a: AssemblyDoc) => applyPoint(solved(a).placements.get("Crank")!, [0, 10, 0]);
const rz = (a: AssemblyDoc, id: string) => solved(a).values.get(id)!.rz!;

describe("planLoopInput", () => {
  it("drives the loop with a typed plain number, keeping the result as plain numbers", () => {
    const { r } = plan(fourBar(), [{ mateId: "r1", dof: "rz", text: "30" }]);
    expect(r && "next" in r && !("clears" in r)).toBe(true);
    const next = (r as { next: AssemblyDoc }).next;
    // The crank is where it was typed, the loop closed, and stays so on the
    // next ordinary solve (no drive).
    const tip = crankTip(next);
    expect(tip[0]).toBeCloseTo(-10 * Math.sin(Math.PI / 6), 4);
    expect(tip[1]).toBeCloseTo(10 * Math.cos(Math.PI / 6), 4);
    expect(solved(next).problems.size).toBe(0);
    expect(next.mates.find((m) => m.id === "r1")?.values?.rz).toBe("30");
    // Every other hinge now reports where it is, as a plain number.
    for (const id of ["r2", "r3", "r4"]) expect(Number(next.mates.find((m) => m.id === id)?.values?.rz)).not.toBeNaN();
  });

  it("lets a later entry override an earlier one where the loop forces it", () => {
    const { r } = plan(fourBar(), [{ mateId: "r1", dof: "rz", text: "30" }]);
    const after30 = (r as { next: AssemblyDoc }).next;
    const rocker = rz(after30, "r4");
    const { r: r2 } = plan(after30, [{ mateId: "r4", dof: "rz", text: String(Math.round(rocker) + 4) }]);
    const next = (r2 as { next: AssemblyDoc }).next;
    expect(rz(next, "r4")).toBeCloseTo(Math.round(rocker) + 4, 3);
    // One DOF: the crank had to move off its 30.
    expect(Math.abs(rz(next, "r1") - 30)).toBeGreaterThan(0.5);
  });

  it("asks before clearing an expression in the way, naming it", () => {
    const a = fourBar("angle");
    const rocker = rz(a, "r4");
    const { r } = plan(a, [{ mateId: "r4", dof: "rz", text: String(Math.round(rocker) + 5) }]);
    expect(r && "clears" in r).toBe(true);
    const c = r as { next: AssemblyDoc; clears: { mateId: string; expression: string }[]; message: string };
    expect(c.clears).toEqual([{ mateId: "r1", dof: "rz", expression: "angle" }]);
    expect(c.message).toBe(
      `To set the Angle of r4 (Ground ↔ Rocker) to ${Math.round(rocker) + 5}°, the expression \`angle\` on the Angle of r1 (Ground ↔ Crank) will be cleared: it becomes a plain number.`,
    );
    // The plan, applied: the crank's expression is a plain number, the rocker
    // where it was typed, nothing broken.
    expect(Number(c.next.mates[0].values?.rz)).not.toBeNaN();
    expect(rz(c.next, "r4")).toBeCloseTo(Math.round(rocker) + 5, 3);
    expect(solved(c.next).problems.size).toBe(0);
  });

  it("refuses a value the loop can't reach, asking nothing", () => {
    // At −90° the rocker's tip would be 70 mm from the crank's pivot; the
    // coupler (44.7) and crank (10) reach 54.7 at most. (170° is reachable:
    // the linkage's other, elbow-down, way of closing.)
    const { r } = plan(fourBar("angle"), [{ mateId: "r4", dof: "rz", text: "-90" }]);
    expect(r).toEqual({ error: expect.stringMatching(/^Can't set the Angle of r4 .* to -90°: Over-constrained/) });
  });

  it("drives with a typed expression too, which then stands", () => {
    const a = { ...fourBar(), variables: [{ id: "v", name: "angle", expression: "45" }] } as AssemblyDoc;
    const { r } = plan(a, [{ mateId: "r1", dof: "rz", text: "angle" }]);
    const next = (r as { next: AssemblyDoc }).next;
    expect(next.mates[0].values?.rz).toBe("angle");
    expect(rz(next, "r1")).toBeCloseTo(45, 3);
  });

  it("leaves a mate outside any loop, or one a relation drives, to the caller", () => {
    expect(plan(fourBar(), [{ mateId: "side", dof: "rz", text: "30" }]).r).toBeNull();
    const geared: AssemblyDoc = {
      ...fourBar(),
      relations: [
        {
          id: "g",
          name: "Gear 1",
          type: "gear",
          driver: { mateId: "side", dof: "rz" },
          driven: { mateId: "r1", dof: "rz" },
          value: "1",
        },
      ],
    };
    expect(plan(geared, [{ mateId: "r1", dof: "rz", text: "30" }]).r).toBeNull();
  });
});

describe("dragging inside a loop past an expression", () => {
  /** Turn the rocker about its ground pin by `deg`. */
  const turnRocker = (deg: number): Mat4 => {
    const r = (deg * Math.PI) / 180;
    const [c, s] = [Math.cos(r), Math.sin(r)];
    const spin: Mat4 = [c, s, 0, 0, -s, c, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    return multiply(translation([40, 0, 0]), multiply(spin, translation([-40, 0, 0])));
  };

  it("names the expression that holds the linkage, and moves once it's cleared", () => {
    const a = keepSolved(fourBar("angle"), solve(fourBar("angle"), frameOf));
    const s = solve(a, frameOf);
    const r = dragAssembly(a, s, frameOf, "Rocker", turnRocker(5));
    expect(r.error).toBeNull();
    expect(r.confirm).toBe(
      "To move Rocker there, the expression `angle` on the Angle of r1 (Ground ↔ Crank) will be cleared: it becomes a plain number.",
    );
    expect(Number(r.next!.mates[0].values?.rz)).not.toBeNaN();
    const before = rz(a, "r4");
    expect(Math.abs(rz(r.next!, "r4") - before)).toBeGreaterThan(3);
  });

  it("asks nothing when no expression is in the way", () => {
    const a = keepSolved(fourBar(), solve(fourBar(), frameOf));
    const r = dragAssembly(a, solve(a, frameOf), frameOf, "Rocker", turnRocker(5));
    expect(r.confirm).toBeUndefined();
  });
});
