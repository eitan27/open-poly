import { describe, expect, it } from "vitest";
import { animator, defaultSpec, phase, valueAt, type AnimateSpec } from "./animate";
import { defaultX, frameMatrix } from "./frames";
import { applyPoint, IDENTITY, type Vec3 } from "./placement";
import { solve } from "./solve";
import type { AssemblyDoc, Instance, Mat4, Mate, MateConnector, MateType } from "./types";

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
const lookupIn =
  (frames: Record<string, Mat4>) =>
  (c: MateConnector): Mat4 | string =>
    frames[c.ref.name] ?? `No ${c.ref.name}`;
const dist = (p: Vec3, q: Vec3) => Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
const at = (s: { placements: Map<string, Mat4> }, id: string, p: Vec3) => applyPoint(s.placements.get(id)!, p);

describe("phase", () => {
  it("runs once and stops at the end", () => {
    expect(phase(0, 2, "once")).toEqual({ u: 0, done: false });
    expect(phase(1, 2, "once")).toEqual({ u: 0.5, done: false });
    expect(phase(3, 2, "once")).toEqual({ u: 1, done: true });
  });
  it("loops back to the start", () => {
    expect(phase(2.5, 2, "loop").u).toBeCloseTo(0.25);
    expect(phase(4, 2, "loop").u).toBeCloseTo(0);
  });
  it("bounces back and forth", () => {
    expect(phase(1, 2, "bounce").u).toBeCloseTo(0.5);
    expect(phase(3, 2, "bounce").u).toBeCloseTo(0.5);
    expect(phase(3.5, 2, "bounce").u).toBeCloseTo(0.25);
    expect(phase(4, 2, "bounce").u).toBeCloseTo(0);
  });
  it("treats a zero duration as already at the end", () => {
    expect(phase(0, 0, "once")).toEqual({ u: 1, done: true });
    expect(phase(0, 0, "loop").done).toBe(false);
  });
});

describe("valueAt", () => {
  it("sweeps from `from` to `to`", () => {
    const spec: AnimateSpec = { mateId: "m", dof: "rz", from: 10, to: 30, seconds: 2, mode: "once" };
    expect(valueAt(spec, 1).value).toBeCloseTo(20);
    expect(valueAt(spec, 5)).toEqual({ value: 30, done: true });
  });
});

describe("defaultSpec", () => {
  const m = (extra: Partial<Mate> = {}) => mate("m", "cylindrical", conn("A", "x"), conn("B", "y"), extra);
  it("sweeps between the limits when both are set", () => {
    const s = defaultSpec(m({ limits: { tz: { min: "0", max: "w" } } }), "tz", 5, { w: 40 });
    expect(s).toMatchObject({ from: 0, to: 40, mode: "bounce" });
  });
  it("turns a rotation a full turn from where it is, looping", () => {
    expect(defaultSpec(m(), "rz", 30, {})).toMatchObject({ from: 30, to: 390, mode: "loop" });
  });
  it("moves a translation 20 mm from where it is, bouncing", () => {
    expect(defaultSpec(m(), "tz", 5, {})).toMatchObject({ from: 5, to: 25, mode: "bounce" });
  });
});

describe("animator", () => {
  it("turns a hinged part without writing the document", () => {
    const z: Vec3 = [0, 0, 1];
    const lookup = lookupIn({ O: frame([0, 0, 0], z) });
    const asm: AssemblyDoc = {
      instances: [inst("A", { grounded: true }), inst("B")],
      mates: [mate("r", "revolute", conn("A", "O"), conn("B", "O"), { flip: true })],
      variables: [],
    };
    const before = JSON.stringify(asm);
    const run = animator(asm, lookup, { mateId: "r", dof: "rz" });
    const s = run.at(90);
    const p = at(s, "B", [10, 0, 0]);
    expect(p[0]).toBeCloseTo(0, 5);
    expect(Math.abs(p[1])).toBeCloseTo(10, 5);
    expect(JSON.stringify(asm)).toBe(before);
  });

  it("ignores the mate's limits, which the sweep was chosen within", () => {
    const lookup = lookupIn({ O: frame([0, 0, 0], [0, 0, 1]) });
    const asm: AssemblyDoc = {
      instances: [inst("A", { grounded: true }), inst("B")],
      mates: [mate("s", "slider", conn("A", "O"), conn("B", "O"), { limits: { tz: { max: "5" } } })],
      variables: [],
    };
    const s = animator(asm, lookup, { mateId: "s", dof: "tz" }).at(8);
    expect(s.values.get("s")?.tz).toBe(8);
  });

  describe("a four-bar's crank", () => {
    // As in loops.test.ts: ground pins at (0,0) and (40,0), crank 10, rocker 30.
    const z: Vec3 = [0, 0, 1];
    const lookup = lookupIn({
      O1: frame([0, 0, 0], z),
      O2: frame([40, 0, 0], z),
      B1: frame([0, 0, 0], z),
      B2: frame([0, 10, 0], z),
      C1: frame([0, 10, 0], z),
      C2: frame([40, 30, 0], z),
      D1: frame([40, 0, 0], z),
      D2: frame([40, 30, 0], z),
    });
    const hinge = (id: string, a: MateConnector, b: MateConnector) => mate(id, "revolute", a, b, { flip: true });
    const asm: AssemblyDoc = {
      instances: [inst("A", { grounded: true }), inst("B"), inst("C"), inst("D")],
      mates: [
        hinge("r1", conn("A", "O1"), conn("B", "B1")),
        hinge("r2", conn("B", "B2"), conn("C", "C1")),
        hinge("r3", conn("C", "C2"), conn("D", "D2")),
        hinge("r4", conn("A", "O2"), conn("D", "D1")),
      ],
      variables: [],
    };

    it("drives the loop with a plain-number crank, a full turn, staying on its branch", () => {
      expect(solve(asm, lookup).loops).toHaveLength(1);
      const run = animator(asm, lookup, { mateId: "r1", dof: "rz" });
      for (let deg = 0; deg <= 360; deg += 15) {
        const s = run.at(deg);
        expect(s.problems.size).toBe(0);
        const r = (deg * Math.PI) / 180;
        // The crank is where the animation put it…
        expect(dist(at(s, "B", [0, 10, 0]), [-10 * Math.sin(r), 10 * Math.cos(r), 0])).toBeLessThan(1e-4);
        // …and every hinge still holds, the rocker elbow up.
        expect(dist(at(s, "B", [0, 10, 0]), at(s, "C", [0, 10, 0]))).toBeLessThan(1e-4);
        expect(dist(at(s, "C", [40, 30, 0]), at(s, "D", [40, 30, 0]))).toBeLessThan(1e-4);
        expect(at(s, "D", [40, 30, 0])[1]).toBeGreaterThan(0);
      }
    });
  });
});
