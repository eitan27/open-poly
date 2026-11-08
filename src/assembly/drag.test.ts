import { describe, expect, it } from "vitest";
import { dragAssembly } from "./drag";
import { defaultX, frameMatrix } from "./frames";
import { applyPoint, IDENTITY, multiply, translation, type Vec3 } from "./placement";
import { rotZ, solve } from "./solve";
import type { AssemblyDoc, Instance, Mat4, Mate, MateConnector, MateType } from "./types";

const frame = (origin: Vec3, z: Vec3): Mat4 => frameMatrix({ origin, z, x: defaultX(z) });

// A 20 mm cube from the origin: its top and bottom faces.
const FRAMES: Record<string, Mat4> = {
  top: frame([10, 10, 20], [0, 0, 1]),
  bottom: frame([10, 10, 0], [0, 0, -1]),
};
const frameOf = (c: MateConnector): Mat4 | string => FRAMES[c.ref.name] ?? `No ${c.ref.name}`;

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
/** `b`'s bottom on `a`'s top. */
const stack = (id: string, type: MateType, a: string, b: string, extra: Partial<Mate> = {}): Mate => ({
  id,
  name: id,
  type,
  a: conn(a, "top"),
  b: conn(b, "bottom"),
  ...extra,
});

/** Drag `id` by `motion` and solve the result: every instance's new placement. */
function drag(asm: AssemblyDoc, id: string, motion: Mat4) {
  const before = solve(asm, frameOf);
  const { next, error } = dragAssembly(asm, before, frameOf, id, motion);
  return { before: before.placements, after: next ? solve(next, frameOf).placements : null, next, error };
}
const closeV = (p: Vec3, q: Vec3) => p.forEach((v, i) => expect(v).toBeCloseTo(q[i], 6));
const at = (m: Map<string, Mat4> | null, id: string, p: Vec3 = [0, 0, 0]) => applyPoint(m!.get(id)!, p);

describe("dragAssembly", () => {
  const pair = (type: MateType = "planar"): AssemblyDoc => ({
    instances: [inst("A"), inst("B")],
    mates: [stack("m", type, "A", "B")],
    variables: [],
  });

  it("slides the part a mate is measured from under its neighbour, which stays put", () => {
    const r = drag(pair(), "A", translation([5, -3, 0]));
    closeV(at(r.after, "A"), [5, -3, 0]);
    closeV(at(r.after, "B"), at(r.before, "B"));
    expect(r.next!.mates[0].values).toEqual({ tx: "-5", ty: "3", rz: "0" });
  });

  it("carries the neighbour along for motion its mate forbids", () => {
    const r = drag(pair(), "A", translation([0, 0, 7]));
    closeV(at(r.after, "B"), [0, 0, 20 + 7]);
  });

  it("leaves the neighbour where it is when turned about the plane's normal", () => {
    const pivot: Vec3 = [10, 10, 0];
    const turn = multiply(translation(pivot), multiply(rotZ(Math.PI / 6), translation([-pivot[0], -pivot[1], 0])));
    const r = drag(pair(), "A", turn);
    for (const p of [
      [0, 0, 0],
      [20, 20, 20],
    ] as Vec3[])
      closeV(at(r.after, "B", p), at(r.before, "B", p));
  });

  it("carries a fastened neighbour whatever the motion", () => {
    const r = drag(pair("fastened"), "A", translation([5, 0, 0]));
    closeV(at(r.after, "B"), [5, 0, 20]);
  });

  it("slides the other side along its mate, leaving the first put", () => {
    const r = drag(pair(), "B", translation([4, 0, 9]));
    closeV(at(r.after, "A"), [0, 0, 0]);
    closeV(at(r.after, "B"), [4, 0, 20]); // the 9 up is off the plane: dropped
  });

  it("lets what is further along follow its own neighbour", () => {
    const asm: AssemblyDoc = {
      instances: [inst("A"), inst("B"), inst("C")],
      mates: [stack("m1", "planar", "A", "B"), stack("m2", "fastened", "B", "C")],
      variables: [],
    };
    const r = drag(asm, "A", translation([6, 0, 0]));
    closeV(at(r.after, "B"), at(r.before, "B"));
    closeV(at(r.after, "C"), at(r.before, "C"));
  });

  it("carries a neighbour whose mate value is an expression, rather than overwrite it", () => {
    const asm = pair();
    asm.mates[0] = { ...asm.mates[0], values: { tx: "2 * 3" } };
    const r = drag(asm, "A", translation([5, 0, 0]));
    expect(r.next!.mates[0].values).toEqual({ tx: "2 * 3" });
    closeV(at(r.after, "B"), [5 + 6, 0, 20]);
  });

  it("refuses to drag a part along a mate whose value is an expression", () => {
    const asm = pair();
    asm.mates[0] = { ...asm.mates[0], values: { tx: "2 * 3" } };
    const r = drag(asm, "B", translation([5, 0, 0]));
    expect(r.next).toBeNull();
    expect(r.error).toMatch(/set by "2 \* 3"/);
  });
});
