import { describe, expect, it } from "vitest";
import {
  applyDerived,
  projectedEntityFromPolyline,
  projectedPointEntity,
  sameProjectedEntities,
} from "./derived";
import type { PlaneFrameData, Vec3 } from "./planes";
import type { DerivedOp, SketchEntity, SketchFeature } from "./types";

// plane-top: world (x, y, z) projects to uv (x, y).
const topFrame: PlaneFrameData = {
  origin: [0, 0, 0],
  uAxis: [1, 0, 0],
  vAxis: [0, 1, 0],
  normal: [0, 0, 1],
};

const sketch = (
  entities: SketchEntity[],
  derived: DerivedOp[],
): SketchFeature => ({
  id: "S",
  type: "sketch",
  name: "Sketch",
  suppressed: false,
  plane: { kind: "datum", id: "plane-top" } as SketchFeature["plane"],
  entities,
  constraints: [],
  derived,
});

const gen = (s: SketchFeature) => s.entities.filter((e) => e.derivedFrom);

describe("project — pure projection helpers", () => {
  it("projects a straight world edge to a line, tagged derivedFrom", () => {
    const poly: Vec3[] = [[0, 0, 5], [10, 0, 5]]; // off-plane (z=5) → drops to uv
    const e = projectedEntityFromPolyline(topFrame, poly, "op:0", "op");
    expect(e?.type).toBe("line");
    if (e?.type === "line") {
      expect(e.a).toEqual([0, 0]);
      expect(e.b).toEqual([10, 0]);
    }
    expect(e?.derivedFrom).toBe("op");
    expect(e?.id).toBe("op:0");
  });

  it("projects a world vertex to a point", () => {
    const e = projectedPointEntity(topFrame, [3, 4, 9], "op:1", "op");
    expect(e.type).toBe("point");
    if (e.type === "point") expect(e.p).toEqual([3, 4]);
    expect(e.derivedFrom).toBe("op");
  });
});

describe("project — change-detection guard (sameProjectedEntities)", () => {
  const mk = (a: [number, number], b: [number, number]): SketchEntity => ({
    type: "line", id: "x", a, b, derivedFrom: "op",
  });

  it("equal geometry → true (no rewrite ⇒ loop converges)", () => {
    expect(sameProjectedEntities([mk([0, 0], [10, 0])], [mk([0, 0], [10, 0])])).toBe(true);
  });

  it("moved beyond epsilon → false", () => {
    expect(sameProjectedEntities([mk([0, 0], [10, 0])], [mk([0, 0], [11, 0])])).toBe(false);
  });

  it("within epsilon → true (tessellation jitter tolerated)", () => {
    expect(sameProjectedEntities([mk([0, 0], [10, 0])], [mk([0, 0], [10 + 1e-9, 0])])).toBe(true);
  });

  it("different length / type → false", () => {
    expect(sameProjectedEntities([mk([0, 0], [10, 0])], [])).toBe(false);
    const pt: SketchEntity = { type: "point", id: "p", p: [0, 0], derivedFrom: "op" };
    expect(sameProjectedEntities([mk([0, 0], [10, 0])], [pt])).toBe(false);
  });
});

describe("applyDerived — preserves project outputs", () => {
  it("keeps project-derived entities and still regenerates offset", () => {
    const line: SketchEntity = { type: "line", id: "L", a: [0, 0], b: [10, 0] };
    // A project op's output lives in entities tagged derivedFrom; applyDerived
    // must NOT wipe it (project is re-projected in the app layer, not here).
    const projOut: SketchEntity = { type: "line", id: "P:0", a: [0, 5], b: [10, 5], derivedFrom: "P" };
    const offsetOp: DerivedOp = { id: "O", kind: "offset", sourceIds: ["L"], distance: "2" };
    const projectOp: DerivedOp = { id: "P", kind: "project", refs: [] };
    const out = applyDerived(sketch([line, projOut], [offsetOp, projectOp]), {});
    // project output survived…
    expect(out.entities.find((e) => e.id === "P:0")).toBeTruthy();
    // …and the offset was (re)generated.
    expect(out.entities.some((e) => e.derivedFrom === "O")).toBe(true);
  });
});

describe("applyDerived — offset", () => {
  const line: SketchEntity = { type: "line", id: "L", a: [0, 0], b: [10, 0] };
  const op: DerivedOp = { id: "op1", kind: "offset", sourceIds: ["L"], distance: "2" };

  it("offsets a source line to the right-of-travel side", () => {
    const out = applyDerived(sketch([line], [op]), {});
    const g = gen(out);
    expect(g).toHaveLength(1);
    const e = g[0];
    if (e.type !== "line") throw new Error("expected line");
    expect(e.derivedFrom).toBe("op1");
    // (0,0)->(10,0) heads +x; right-of-travel normal is -y, so +2 lands at y=-2.
    expect(e.a[1]).toBeCloseTo(-2, 6);
    expect(e.b[1]).toBeCloseTo(-2, 6);
  });

  it("re-computes when the source line moves", () => {
    const moved: SketchEntity = { type: "line", id: "L", a: [0, 5], b: [10, 5] };
    const out = applyDerived(sketch([moved], [op]), {});
    const e = gen(out)[0];
    if (e.type !== "line") throw new Error("expected line");
    expect(e.a[1]).toBeCloseTo(3, 6); // 5 + (-2)
  });

  it("re-evaluates when the distance expression changes", () => {
    const out = applyDerived(sketch([line], [{ ...op, distance: "4" }]), {});
    const e = gen(out)[0];
    if (e.type !== "line") throw new Error("expected line");
    expect(e.a[1]).toBeCloseTo(-4, 6);
  });

  it("evaluates the distance against the variable scope", () => {
    const out = applyDerived(sketch([line], [{ ...op, distance: "wall" }]), { wall: 3 });
    const e = gen(out)[0];
    if (e.type !== "line") throw new Error("expected line");
    expect(e.a[1]).toBeCloseTo(-3, 6);
  });

  it("offsets a lone circle concentrically", () => {
    const circle: SketchEntity = { type: "circle", id: "C", c: [0, 0], r: 10 };
    const out = applyDerived(sketch([circle], [{ id: "o2", kind: "offset", sourceIds: ["C"], distance: "3" }]), {});
    const e = gen(out)[0];
    if (e.type !== "circle") throw new Error("expected circle");
    expect(e.r).toBeCloseTo(13, 6);
  });

  it("drops stale outputs when the op is removed (no ops ⇒ only sources)", () => {
    const withOut = applyDerived(sketch([line], [op]), {});
    expect(gen(withOut)).toHaveLength(1);
    const cleared = applyDerived({ ...withOut, derived: [] }, {});
    expect(cleared.entities).toHaveLength(1);
    expect(gen(cleared)).toHaveLength(0);
  });
});

describe("applyDerived — mirror", () => {
  const axis: SketchEntity = { type: "line", id: "AX", a: [0, -10], b: [0, 10] }; // x = 0
  const src: SketchEntity = { type: "line", id: "L", a: [2, 0], b: [4, 0] };
  const op: DerivedOp = { id: "m1", kind: "mirror", axisId: "AX", sourceIds: ["L"] };

  it("reflects the source across the axis line", () => {
    const out = applyDerived(sketch([axis, src], [op]), {});
    const e = gen(out)[0];
    if (e.type !== "line") throw new Error("expected line");
    expect(e.a[0]).toBeCloseTo(-2, 6);
    expect(e.b[0]).toBeCloseTo(-4, 6);
  });

  it("re-computes when the source moves", () => {
    const moved: SketchEntity = { type: "line", id: "L", a: [6, 0], b: [8, 0] };
    const out = applyDerived(sketch([axis, moved], [op]), {});
    const e = gen(out)[0];
    if (e.type !== "line") throw new Error("expected line");
    expect(e.a[0]).toBeCloseTo(-6, 6);
    expect(e.b[0]).toBeCloseTo(-8, 6);
  });

  it("re-computes when the axis moves", () => {
    const axis2: SketchEntity = { type: "line", id: "AX", a: [5, -10], b: [5, 10] }; // x = 5
    const out = applyDerived(sketch([axis2, src], [op]), {});
    const e = gen(out)[0];
    if (e.type !== "line") throw new Error("expected line");
    // reflection of x=2 and x=4 across x=5 → x=8 and x=6.
    expect(e.a[0]).toBeCloseTo(8, 6);
    expect(e.b[0]).toBeCloseTo(6, 6);
  });
});

describe("applyDerived — robustness", () => {
  it("skips an op whose source id is missing without throwing", () => {
    const line: SketchEntity = { type: "line", id: "L", a: [0, 0], b: [10, 0] };
    const op: DerivedOp = { id: "op1", kind: "offset", sourceIds: ["GONE"], distance: "2" };
    const out = applyDerived(sketch([line], [op]), {});
    expect(gen(out)).toHaveLength(0);
    expect(out.entities).toHaveLength(1); // just the source survives
  });

  it("does not source derived geometry from other derived geometry", () => {
    // A pre-existing derivedFrom entity is treated as an output (dropped), never a source.
    const stale: SketchEntity = { type: "line", id: "X", a: [0, 0], b: [1, 1], derivedFrom: "old" };
    const out = applyDerived(sketch([stale], []), {});
    expect(out.entities).toHaveLength(0);
  });
});
