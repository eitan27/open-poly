// The numeric half of the hybrid solver (solve.ts): groups of parts joined by
// a loop of mates or by more than one mate between the same pair. These are
// the plan's acceptance cases.
import { describe, expect, it } from "vitest";
import { keepSolved, removeMates, updateMate } from "./assembly";
import { dragAssembly } from "./drag";
import { defaultX, frameMatrix } from "./frames";
import { applyPoint, IDENTITY, multiply, translation, type Vec3 } from "./placement";
import { rotZ, solve } from "./solve";
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

const closeV = (p: Vec3, q: Vec3, digits = 5) => p.forEach((v, i) => expect(v).toBeCloseTo(q[i], digits));
const dist = (p: Vec3, q: Vec3) => Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
const at = (s: { placements: Map<string, Mat4> }, id: string, p: Vec3) => applyPoint(s.placements.get(id)!, p);
const at_ = at;

describe("three planar mates hold a box in a corner", () => {
  // A: a floor (z = 0) with walls at x = 0 and y = 0. B: a 20 mm cube from
  // its own origin.
  const frames = {
    floor: frame([50, 50, 0], [0, 0, 1]),
    wallX: frame([0, 50, 25], [1, 0, 0]),
    wallY: frame([50, 0, 25], [0, 1, 0]),
    bottom: frame([10, 10, 0], [0, 0, -1]),
    left: frame([0, 10, 10], [-1, 0, 0]),
    front: frame([10, 0, 10], [0, -1, 0]),
  };
  const lookup = lookupIn(frames);
  // B starts off to one side, lifted and turned.
  const start = multiply(translation([30, 25, 5]), rotZ(0.4));
  const corner = (): AssemblyDoc => ({
    instances: [inst("A", { grounded: true }), inst("B", { transform: start })],
    mates: [
      mate("m1", "planar", conn("A", "floor"), conn("B", "bottom")),
      mate("m2", "planar", conn("A", "wallX"), conn("B", "left")),
      mate("m3", "planar", conn("A", "wallY"), conn("B", "front")),
    ],
    variables: [],
  });

  it("puts the box in the corner with nothing flagged", () => {
    const s = solve(corner(), lookup);
    expect(s.problems.size).toBe(0);
    closeV(at(s, "B", [0, 0, 0]), [0, 0, 0]);
    closeV(at(s, "B", [20, 20, 20]), [20, 20, 20]);
    expect(s.drivenBy.has("B")).toBe(false);
    expect(s.mated.has("B")).toBe(true);
  });

  it("keeps the box put when two of the mates are deleted", () => {
    const a = corner();
    const kept = keepSolved(a, solve(a, lookup));
    const after = solve(removeMates(kept, ["m2", "m3"]), lookup);
    closeV(at(after, "B", [0, 0, 0]), [0, 0, 0], 2);
    closeV(at(after, "B", [20, 20, 20]), [20, 20, 20], 2);
    // m1 is a tree mate again, and its stored values are where the box is.
    expect(after.drivenBy.get("B")?.mateId).toBe("m1");
  });
});

describe("dragging two parts locked together by three mates", () => {
  // The corner case again, with nothing grounded: B can't move against A, so
  // dragging either moves both.
  const frames = {
    floor: frame([50, 50, 0], [0, 0, 1]),
    wallX: frame([0, 50, 25], [1, 0, 0]),
    wallY: frame([50, 0, 25], [0, 1, 0]),
    bottom: frame([10, 10, 0], [0, 0, -1]),
    left: frame([0, 10, 10], [-1, 0, 0]),
    front: frame([10, 0, 10], [0, -1, 0]),
  };
  const lookup = lookupIn(frames);
  const locked = (grounded: boolean): AssemblyDoc => ({
    instances: [inst("A", { grounded }), inst("B")],
    mates: [
      mate("m1", "planar", conn("A", "floor"), conn("B", "bottom")),
      mate("m2", "planar", conn("A", "wallX"), conn("B", "left")),
      mate("m3", "planar", conn("A", "wallY"), conn("B", "front")),
    ],
    variables: [],
  });
  const move = translation([12, -7, 5]);

  for (const id of ["A", "B"])
    it(`moves both when ${id} is dragged`, () => {
      const a = locked(false);
      const before = solve(a, lookup);
      const { next } = dragAssembly(a, before, lookup, id, move);
      const after = solve(next!, lookup);
      expect(after.problems.size).toBe(0);
      for (const n of ["A", "B"]) {
        const off = dist(at(after, n, [0, 0, 0]), applyPoint(move, at(before, n, [0, 0, 0])));
        expect(off).toBeLessThan(0.01);
      }
      // Still in the corner.
      closeV(at(after, "B", [0, 0, 0]), at(after, "A", [0, 0, 0]), 5);
    });

  it("leaves both put when the one it's locked to is grounded", () => {
    const a = locked(true);
    const before = solve(a, lookup);
    const { next } = dragAssembly(a, before, lookup, "B", move);
    const after = solve(next!, lookup);
    closeV(at(after, "B", [0, 0, 0]), at(before, "B", [0, 0, 0]), 5);
  });
});

describe("one fastened mate on two vertices puts a box in a corner", () => {
  // Vertex connectors frame with the part's own axes (frames.ts): A's inner
  // corner at its origin, B's corner at its own. Flipped, the frames align, so
  // B sits in the corner the way both were modelled. "inset" is a corner
  // connector moved 3, 4 along A's axes — what an offset gives (the offset's
  // own arithmetic is connectorMatrix's, tested in frames.test.ts).
  const at = (o: Vec3): Mat4 => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, o[0], o[1], o[2], 1];
  const frames = { innerCorner: at([0, 0, 0]), boxCorner: at([0, 0, 0]), inset: at([3, 4, 0]) };
  const lookup = lookupIn(frames);
  const corner = (aRef: string): AssemblyDoc => ({
    instances: [inst("A", { grounded: true }), inst("B", { transform: multiply(translation([40, 30, 7]), rotZ(0.3)) })],
    mates: [mate("f", "fastened", conn("A", aRef), conn("B", "boxCorner"), { flip: true })],
    variables: [],
  });

  it("seats the box in the corner, square to it", () => {
    const s = solve(corner("innerCorner"), lookup);
    expect(s.problems.size).toBe(0);
    closeV(at_(s, "B", [0, 0, 0]), [0, 0, 0]);
    closeV(at_(s, "B", [20, 20, 20]), [20, 20, 20]);
  });

  it("sets it in by the corner's offset", () => {
    const s = solve(corner("inset"), lookup);
    closeV(at_(s, "B", [0, 0, 0]), [3, 4, 0]);
    closeV(at_(s, "B", [20, 0, 0]), [23, 4, 0]);
  });
});

describe("width + planar: a tab in a slot", () => {
  // A: a slot with walls at x = 0 and x = 20 (the width connector is their
  // mid-plane) and a floor at z = 0. B: a 6 mm tab, sides at x = 100 and 106,
  // bottom at z = 0, modelled far away.
  const frames = {
    slot: frame([10, 5, 8], [1, 0, 0]),
    slotFloor: frame([10, 5, 0], [0, 0, 1]),
    tab: frame([103, 40, 2], [1, 0, 0]),
    tabBottom: frame([103, 40, 0], [0, 0, -1]),
  };
  const lookup = lookupIn(frames);
  const slot = (): AssemblyDoc => ({
    instances: [inst("A", { grounded: true }), inst("B")],
    mates: [
      mate("w", "width", conn("A", "slot"), conn("B", "tab")),
      mate("p", "planar", conn("A", "slotFloor"), conn("B", "tabBottom")),
    ],
    variables: [],
  });

  it("centres the tab on the slot floor, the way up it was modelled", () => {
    const s = solve(slot(), lookup);
    expect(s.problems.size).toBe(0);
    const [x0, , z0] = at(s, "B", [100, 40, 0]);
    const [x1, , z1] = at(s, "B", [106, 40, 0]);
    expect(x0).toBeCloseTo(7, 5);
    expect(x1).toBeCloseTo(13, 5);
    expect(z0).toBeCloseTo(0, 5);
    expect(z1).toBeCloseTo(0, 5);
    // Up is still up.
    const up = at(s, "B", [100, 40, 10]);
    expect(up[2]).toBeCloseTo(10, 5);
  });

  it("drags along the slot, and not across it", () => {
    const a = keepSolved(slot(), solve(slot(), lookup));
    const before = solve(a, lookup);
    const { next } = dragAssembly(a, before, lookup, "B", translation([4, 15, 0]));
    const after = solve(next!, lookup);
    const p0 = at(before, "B", [103, 40, 0]);
    const p1 = at(after, "B", [103, 40, 0]);
    expect(p1[0]).toBeCloseTo(p0[0], 4); // still centred
    expect(p1[1] - p0[1]).toBeCloseTo(15, 2); // slid along
    expect(p1[2]).toBeCloseTo(0, 5);
  });
});

describe("a four-bar linkage", () => {
  // In the XY plane, every hinge about world Z. Ground pins at (0,0) and
  // (40,0); crank 10 up to (0,10); coupler to (40,30); rocker 30 down to the
  // ground. A crank-rocker (10 + 44.7 ≤ 40 + 30).
  const z: Vec3 = [0, 0, 1];
  const frames = {
    O1: frame([0, 0, 0], z),
    O2: frame([40, 0, 0], z),
    B1: frame([0, 0, 0], z),
    B2: frame([0, 10, 0], z),
    C1: frame([0, 10, 0], z),
    C2: frame([40, 30, 0], z),
    D1: frame([40, 0, 0], z),
    D2: frame([40, 30, 0], z),
    E: frame([20, 20, 0], z),
  };
  const lookup = lookupIn(frames);
  const hinge = (id: string, a: MateConnector, b: MateConnector, extra: Partial<Mate> = {}) =>
    mate(id, "revolute", a, b, { flip: true, ...extra });
  const fourBar = (crank?: string): AssemblyDoc => ({
    instances: [inst("A", { grounded: true }), inst("B"), inst("C"), inst("D")],
    mates: [
      hinge("r1", conn("A", "O1"), conn("B", "B1"), crank ? { values: { rz: crank } } : {}),
      hinge("r2", conn("B", "B2"), conn("C", "C1")),
      hinge("r3", conn("C", "C2"), conn("D", "D2")),
      hinge("r4", conn("A", "O2"), conn("D", "D1")),
    ],
    variables: [],
  });
  /** Every hinge holds: each pair of pins coincides. */
  const holds = (s: ReturnType<typeof solve>) => {
    expect(dist(at(s, "B", [0, 0, 0]), [0, 0, 0])).toBeLessThan(1e-5);
    expect(dist(at(s, "B", [0, 10, 0]), at(s, "C", [0, 10, 0]))).toBeLessThan(1e-5);
    expect(dist(at(s, "C", [40, 30, 0]), at(s, "D", [40, 30, 0]))).toBeLessThan(1e-5);
    expect(dist(at(s, "D", [40, 0, 0]), [40, 0, 0])).toBeLessThan(1e-5);
  };

  it("solves as one loop group, as built", () => {
    const s = solve(fourBar(), lookup);
    expect(s.problems.size).toBe(0);
    expect(s.loops).toHaveLength(1);
    expect([...s.loops[0].free].sort()).toEqual(["B", "C", "D"]);
    holds(s);
  });

  it("follows a crank angle given as an expression", () => {
    const s = solve(fourBar("15 * 2"), lookup);
    expect(s.problems.size).toBe(0);
    holds(s);
    // 30° anticlockwise about Z: (0, 10) → (−5, 8.66).
    closeV(at(s, "B", [0, 10, 0]), [-5, 10 * Math.cos(Math.PI / 6), 0]);
  });

  it("turns the crank all the way round without the rocker flipping over", () => {
    let a = fourBar("0");
    for (let deg = 0; deg <= 360; deg += 20) {
      a = updateMate(a, { ...a.mates[0], values: { rz: `${deg} + 0` } });
      const s = solve(a, lookup);
      expect(s.problems.size).toBe(0);
      holds(s);
      // The rocker's tip stays above the ground line (elbow up).
      expect(at(s, "D", [40, 30, 0])[1]).toBeGreaterThan(0);
      a = keepSolved(a, s);
    }
  });

  it("drags the coupler, taking crank and rocker with it", () => {
    const a = fourBar();
    const before = solve(a, lookup);
    const { next } = dragAssembly(a, before, lookup, "C", translation([-3, 2, 0]));
    const after = solve(next!, lookup);
    expect(after.problems.size).toBe(0);
    holds(after);
    // It moved (toward the drag), and the parts stayed in the plane.
    const was = at(before, "C", [20, 20, 0]);
    const now = at(after, "C", [20, 20, 0]);
    expect(now[0]).toBeLessThan(was[0] - 0.5);
    expect(now[2]).toBeCloseTo(0, 5);
    // The release is stable: solving again leaves it there.
    const again = solve(next!, lookup);
    closeV(at(again, "C", [20, 20, 0]), now);
  });

  it("composes a part fastened to the coupler as a tree edge", () => {
    const a = fourBar("40 + 0");
    a.instances.push(inst("E"));
    a.mates.push(mate("f", "fastened", conn("C", "E"), conn("E", "E"), { flip: true }));
    const s = solve(a, lookup);
    expect(s.problems.size).toBe(0);
    expect(s.drivenBy.get("E")?.mateId).toBe("f");
    closeV(at(s, "E", [20, 20, 0]), at(s, "C", [20, 20, 0]));
  });

  it("flags a fifth mate that fights the loop", () => {
    const a = fourBar();
    // The coupler's crank-end pin fastened onto the ground pin: it can't be
    // there while the crank (10 long) holds it at its own end.
    a.mates.push(mate("bad", "fastened", conn("A", "O1"), conn("C", "C1"), { flip: true }));
    const s = solve(a, lookup);
    expect(s.problems.get("bad")).toMatch(/Over-constrained/);
    holds(s);
  });
});

describe("a slider-crank", () => {
  // Crank 10 from (0,0) up to (0,10); rod 30 down to the piston on the X axis
  // at x = √800; the piston slides along X.
  const z: Vec3 = [0, 0, 1];
  const px = Math.sqrt(800);
  const frames = {
    O: frame([0, 0, 0], z),
    rail: frame([0, 0, 0], [1, 0, 0]),
    B1: frame([0, 0, 0], z),
    B2: frame([0, 10, 0], z),
    C1: frame([0, 10, 0], z),
    C2: frame([px, 0, 0], z),
    D1: frame([px, 0, 0], z),
    slide: frame([px, 0, 0], [1, 0, 0]),
  };
  const lookup = lookupIn(frames);
  const crank = (angle: string): AssemblyDoc => ({
    instances: [inst("A", { grounded: true }), inst("B"), inst("C"), inst("D")],
    mates: [
      mate("r1", "revolute", conn("A", "O"), conn("B", "B1"), { flip: true, values: { rz: angle } }),
      mate("r2", "revolute", conn("B", "B2"), conn("C", "C1"), { flip: true }),
      mate("r3", "revolute", conn("C", "C2"), conn("D", "D1"), { flip: true }),
      mate("s", "slider", conn("A", "rail"), conn("D", "slide"), { flip: true, values: { tz: String(px) } }),
    ],
    variables: [],
  });

  it("moves the piston as the crank turns", () => {
    let a = crank("0 + 0");
    for (const deg of [30, 60, 90]) {
      a = updateMate(a, { ...a.mates[0], values: { rz: `${deg} + 0` } });
      const s = solve(a, lookup);
      expect(s.problems.size).toBe(0);
      a = keepSolved(a, s);
      const c = (deg * Math.PI) / 180;
      const pin: Vec3 = [-10 * Math.sin(c), 10 * Math.cos(c), 0];
      const x = pin[0] + Math.sqrt(900 - pin[1] * pin[1]);
      closeV(at(s, "D", [px, 0, 0]), [x, 0, 0], 4);
      // The slider reports where the piston is.
      expect(s.values.get("s")!.tz).toBeCloseTo(x, 4);
    }
  });
});
