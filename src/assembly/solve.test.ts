import { describe, expect, it } from "vitest";
import { applyPoint, IDENTITY, multiply, translation, type Vec3 } from "./placement";
import { frameMatrix, defaultX } from "./frames";
import { invertRigid, logRot, MATE_DOFS, mateRelative, rotVec, rotZ, solve, valuesForPose } from "./solve";
import type { AssemblyDoc, Instance, Mat4, Mate, MateConnector, MateType } from "./types";

const frame = (origin: Vec3, z: Vec3): Mat4 => frameMatrix({ origin, z, x: defaultX(z) });

/** Connectors in these tests name their frame directly: `ref.name` is a key
 *  into this table, standing in for frames.ts reading a mesh. */
const FRAMES: Record<string, Mat4> = {
  // A 20 mm cube from the origin: its top and bottom faces.
  top: frame([10, 10, 20], [0, 0, 1]),
  bottom: frame([10, 10, 0], [0, 0, -1]),
  // A hinge pin axis along +Y through (0, 0, 5).
  pin: frame([0, 0, 5], [0, 1, 0]),
};
const lookup = (c: MateConnector): Mat4 | string => FRAMES[c.ref.name] ?? `No ${c.ref.name}`;

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
const asm = (instances: Instance[], mates: Mate[]): AssemblyDoc => ({ instances, mates, variables: [] });

const closeM = (p: Mat4, q: Mat4) => p.forEach((v, i) => expect(v).toBeCloseTo(q[i], 6));
const closeV = (p: Vec3, q: Vec3) => p.forEach((v, i) => expect(v).toBeCloseTo(q[i], 6));

describe("solve", () => {
  it("fastens one cube on top of another, face to face", () => {
    const s = solve(
      asm(
        [inst("A", { grounded: true }), inst("B", { transform: translation([500, 0, 0]) })],
        [mate("m", "fastened", conn("A", "top"), conn("B", "bottom"))],
      ),
      lookup,
    );
    expect(s.problems.size).toBe(0);
    // B's bottom-face centre lands on A's top-face centre; B's own top is 20 higher.
    const b = s.placements.get("B")!;
    closeV(applyPoint(b, [10, 10, 0]), [10, 10, 20]);
    closeV(applyPoint(b, [10, 10, 20]), [10, 10, 40]);
    expect(s.drivenBy.get("B")).toEqual({ mateId: "m", reversed: false });
  });

  it("places the mate's `a` side when only `b` is grounded", () => {
    const s = solve(
      asm(
        [inst("A"), inst("B", { grounded: true, transform: translation([0, 0, 100]) })],
        [mate("m", "fastened", conn("A", "top"), conn("B", "bottom"))],
      ),
      lookup,
    );
    // A sits under B: A's top at B's bottom (z = 100).
    closeV(applyPoint(s.placements.get("A")!, [10, 10, 20]), [10, 10, 100]);
    expect(s.drivenBy.get("A")).toEqual({ mateId: "m", reversed: true });
  });

  it("turns a revolute about its axis by its value", () => {
    const s = solve(
      asm(
        [inst("A", { grounded: true }), inst("B")],
        [mate("m", "revolute", conn("A", "pin"), conn("B", "pin"), { values: { rz: "90" }, flip: true })],
      ),
      lookup,
    );
    // Flipped (axes aligned), so at 0° B coincides with A; at 90° about +Y a
    // point 10 along +Z from the pin swings to +X.
    const b = s.placements.get("B")!;
    closeV(applyPoint(b, [0, 0, 5]), [0, 0, 5]);
    closeV(applyPoint(b, [0, 0, 15]), [10, 0, 5]);
  });

  it("slides a slider along its axis, clamped to its limits", () => {
    const s = solve(
      asm(
        [inst("A", { grounded: true }), inst("B")],
        [
          mate("m", "slider", conn("A", "top"), conn("B", "bottom"), {
            values: { tz: "50" },
            limits: { tz: { min: "0", max: "30" } },
          }),
        ],
      ),
      lookup,
    );
    expect(s.values.get("m")).toEqual({ tz: 30 });
    closeV(applyPoint(s.placements.get("B")!, [10, 10, 0]), [10, 10, 50]);
  });

  it("evaluates values as expressions", () => {
    const s = solve(
      asm(
        [inst("A", { grounded: true }), inst("B")],
        [mate("m", "slider", conn("A", "top"), conn("B", "bottom"), { values: { tz: "2 * 5 + 1" } })],
      ),
      lookup,
    );
    expect(s.values.get("m")).toEqual({ tz: 11 });
  });

  it("chains: a part mated to a mated part follows it", () => {
    const s = solve(
      asm(
        [inst("A", { grounded: true }), inst("B"), inst("C")],
        [
          mate("m1", "fastened", conn("A", "top"), conn("B", "bottom")),
          mate("m2", "slider", conn("B", "top"), conn("C", "bottom"), { values: { tz: "5" } }),
        ],
      ),
      lookup,
    );
    closeV(applyPoint(s.placements.get("C")!, [10, 10, 0]), [10, 10, 45]);
  });

  it("accepts redundant mates on one pair, and reports a plain value where the part is", () => {
    const base = [inst("A", { grounded: true }), inst("B")];
    const m1 = mate("m1", "fastened", conn("A", "top"), conn("B", "bottom"));
    // A slider alongside a fastened mate is redundant; its typed 3 only
    // reports, so it reads back 0 rather than fighting the fastened mate.
    const s = solve(
      asm(base, [m1, mate("m2", "slider", conn("A", "top"), conn("B", "bottom"), { values: { tz: "3" } })]),
      lookup,
    );
    expect(s.problems.size).toBe(0);
    expect(s.values.get("m2")!.tz).toBeCloseTo(0, 6);
    expect(s.loops).toEqual([{ anchor: "A", free: ["B"], mateIds: ["m1", "m2"] }]);
    expect(s.mated.has("B")).toBe(true);
  });

  it("flags the later of two mates that disagree", () => {
    const base = [inst("A", { grounded: true }), inst("B")];
    const s = solve(
      asm(base, [
        mate("m1", "fastened", conn("A", "top"), conn("B", "bottom")),
        mate("m2", "fastened", conn("A", "top"), conn("B", "bottom"), { turns: 1 }),
      ]),
      lookup,
    );
    expect(s.problems.get("m2")).toMatch(/Over-constrained/);
    expect(s.problems.has("m1")).toBe(false);
    // The rest still holds: B sits on A as m1 says.
    closeV(applyPoint(s.placements.get("B")!, [10, 10, 0]), [10, 10, 20]);
  });

  it("checks a mate between two grounded instances instead of moving one", () => {
    const s = solve(
      asm(
        [inst("A", { grounded: true }), inst("B", { grounded: true, transform: translation([0, 0, 99]) })],
        [mate("m", "fastened", conn("A", "top"), conn("B", "bottom"))],
      ),
      lookup,
    );
    closeM(s.placements.get("B")!, translation([0, 0, 99]));
    expect(s.problems.get("m")).toMatch(/Over-constrained/);
  });

  it("skips a mate whose connector can't be found, leaving its parts where they are", () => {
    const s = solve(
      asm(
        [inst("A", { grounded: true }), inst("B", { transform: translation([7, 0, 0]) })],
        [mate("m", "fastened", conn("A", "top"), conn("B", "gone"))],
      ),
      lookup,
    );
    expect(s.problems.get("m")).toBe("No gone");
    closeM(s.placements.get("B")!, translation([7, 0, 0]));
    expect(s.drivenBy.has("B")).toBe(false);
  });

  it("places a mated group nothing grounds from its first instance", () => {
    const s = solve(
      asm(
        [inst("A", { transform: translation([0, 100, 0]) }), inst("B")],
        [mate("m", "fastened", conn("A", "top"), conn("B", "bottom"))],
      ),
      lookup,
    );
    closeV(applyPoint(s.placements.get("B")!, [10, 10, 0]), [10, 110, 20]);
  });

  it("centres a tab between a slot's walls with a width mate", () => {
    // A slot in A with walls at x = 0 and x = 20 (facing in); a 6 mm tab in B
    // with sides at x = 100 and x = 106 (facing out), modelled far away.
    const walls: Record<string, Mat4> = {
      slot: frame([10, 5, 8], [1, 0, 0]),
      tab: frame([103, 40, 2], [1, 0, 0]),
    };
    const s = solve(
      asm(
        [inst("A", { grounded: true }), inst("B")],
        [mate("m", "width", conn("A", "slot"), conn("B", "tab"), { values: { tx: "4" } })],
      ),
      (c) => walls[c.ref.name],
    );
    expect(s.problems.size).toBe(0);
    const b = s.placements.get("B")!;
    // The tab's sides land 3 mm either side of the slot's middle, the same
    // way round (not flipped over). An X offset slides it within the
    // mid-plane: along the frame's X, which for a normal along world X is
    // world Y.
    closeV(applyPoint(b, [100, 40, 2]), [7, 5 + 4, 8]);
    closeV(applyPoint(b, [106, 40, 2]), [13, 5 + 4, 8]);
  });

  it("ignores a suppressed mate", () => {
    const s = solve(
      asm(
        [inst("A", { grounded: true }), inst("B", { transform: translation([7, 0, 0]) })],
        [mate("m", "fastened", conn("A", "top"), conn("B", "bottom"), { suppressed: true })],
      ),
      lookup,
    );
    closeM(s.placements.get("B")!, translation([7, 0, 0]));
  });
});

describe("valuesForPose (dragging along a mate)", () => {
  const ca = FRAMES.pin;
  const cb = frame([3, 4, 5], [1, 0, 0]);
  const ta = translation([10, -20, 30]);

  for (const type of Object.keys(MATE_DOFS) as MateType[]) {
    it(`round-trips a ${type} mate's values`, () => {
      const v = { tx: 7, ty: -3, tz: 12, rx: 20, ry: -35, rz: 50 };
      const want = Object.fromEntries(MATE_DOFS[type].map((d) => [d, v[d]]));
      const m = { type, flip: false, turns: 1 };
      const tb = multiply(ta, mateRelative(m, ca, cb, want));
      const got = valuesForPose(m, ca, cb, ta, tb);
      for (const d of MATE_DOFS[type]) expect(got[d]).toBeCloseTo(want[d]!, 6);
    });
  }

  it("projects a drag onto the mate: a slider ignores sideways motion", () => {
    const m = { type: "slider" as const };
    const tb = multiply(ta, mateRelative(m, ca, cb, { tz: 4 }));
    // Push it 6 along the axis (world +Y here) and 9 sideways.
    const dragged = multiply(translation([9, 6, 0]), tb);
    expect(valuesForPose(m, ca, cb, ta, dragged).tz).toBeCloseTo(10, 6);
  });

  it("counts a hinge on past half a turn rather than jumping back", () => {
    const m = { type: "revolute" as const };
    const tb = multiply(ta, mateRelative(m, ca, cb, { rz: 200 }));
    expect(valuesForPose(m, ca, cb, ta, tb, { rz: 170 }).rz).toBeCloseTo(200, 6);
  });
});

describe("rotation helpers", () => {
  it("logRot inverts rotVec, including near a half turn", () => {
    for (const v of [
      [0.3, -0.2, 0.9],
      [0, 0, Math.PI - 1e-8],
      [Math.PI / Math.sqrt(2), Math.PI / Math.sqrt(2), 0],
    ] as Vec3[]) {
      const back = logRot(rotVec(v));
      closeM(rotVec(back), rotVec(v));
    }
  });

  it("invertRigid undoes a placement", () => {
    const m = multiply(translation([1, 2, 3]), rotZ(0.7));
    closeM(multiply(m, invertRigid(m)), IDENTITY);
  });
});
