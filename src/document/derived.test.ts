import { describe, expect, it } from "vitest";
import {
  applyDerived,
  applyEntityExprs,
  circularPatternAngles,
  MAX_PATTERN_INSTANCES,
  projectedEntityFromPolyline,
  projectedPointEntity,
  resolvePatternCount,
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

const sketch = (entities: SketchEntity[], derived: DerivedOp[]): SketchFeature => ({
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

describe("applyEntityExprs — expression-driven coordinates", () => {
  it("reflows a coordinate/radius from its exprs overlay against the scope", () => {
    const s = sketch([{ type: "circle", id: "c", c: [0, 0], r: 1, exprs: { r: "innerRad + clearance" } }], []);
    const out = applyEntityExprs(s, { innerRad: 6, clearance: 0.3 });
    expect(out.entities[0]).toMatchObject({ type: "circle", r: 6.3 });
    // Re-drives when the variable changes — the overlay is the source of truth.
    expect(applyEntityExprs(s, { innerRad: 10, clearance: 0 }).entities[0]).toMatchObject({ r: 10 });
  });

  it("writes nested array paths (line ends, spline points)", () => {
    const s = sketch([{ type: "line", id: "l", a: [0, 0], b: [1, 0], exprs: { "a.0": "-w/2", "b.0": "w/2" } }], []);
    const out = applyEntityExprs(s, { w: 10 });
    expect(out.entities[0]).toMatchObject({ a: [-5, 0], b: [5, 0] });
  });

  it("keeps the stored literal when an expression is invalid or unknown", () => {
    const s = sketch([{ type: "circle", id: "c", c: [0, 0], r: 4, exprs: { r: "missingVar" } }], []);
    expect(applyEntityExprs(s, {}).entities[0]).toMatchObject({ r: 4 });
  });

  it("is a no-op (same reference) when no entity carries an overlay", () => {
    const s = sketch([{ type: "circle", id: "c", c: [0, 0], r: 4 }], []);
    expect(applyEntityExprs(s, { w: 1 })).toBe(s);
  });

  it("runs before derived geometry, so a mirror reflects reflowed coordinates", () => {
    // A vertical mirror axis at u = 0, and a point driven to u = w by its overlay.
    const s = sketch(
      [
        { type: "line", id: "axis", a: [0, -10], b: [0, 10] },
        { type: "point", id: "p", p: [1, 2], exprs: { "p.0": "w" } },
      ],
      [{ id: "m", kind: "mirror", axisId: "axis", sourceIds: ["p"] }],
    );
    const out = applyDerived(s, { w: 5 });
    const src = out.entities.find((e) => e.id === "p");
    const mirrored = gen(out).find((e) => e.type === "point");
    expect(src).toMatchObject({ p: [5, 2] }); // reflowed from w
    expect(mirrored).toMatchObject({ type: "point", p: [-5, 2] }); // reflected across u=0
  });
});

describe("project — pure projection helpers", () => {
  it("projects a straight world edge to a line, tagged derivedFrom", () => {
    const poly: Vec3[] = [
      [0, 0, 5],
      [10, 0, 5],
    ]; // off-plane (z=5) → drops to uv
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
    type: "line",
    id: "x",
    a,
    b,
    derivedFrom: "op",
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

describe("applyDerived — linear pattern", () => {
  const hole: SketchEntity = { type: "circle", id: "H", c: [0, 0], r: 3 };
  const op: DerivedOp = { id: "lp", kind: "linearPattern", sourceIds: ["H"], count: "4", dx: "10", dy: "0" };

  it("generates count−1 copies at i·(dx,dy), seed untouched", () => {
    const out = applyDerived(sketch([hole], [op]), {});
    const g = gen(out);
    expect(g).toHaveLength(3);
    const centers = g.map((e) => (e.type === "circle" ? e.c[0] : NaN)).sort((a, b) => a - b);
    expect(centers[0]).toBeCloseTo(10, 9);
    expect(centers[1]).toBeCloseTo(20, 9);
    expect(centers[2]).toBeCloseTo(30, 9);
    expect(out.entities.find((e) => e.id === "H")).toBeTruthy();
  });

  it("follows the source when it moves (associativity)", () => {
    const moved: SketchEntity = { type: "circle", id: "H", c: [5, 5], r: 3 };
    const out = applyDerived(sketch([moved], [op]), {});
    const e = gen(out)[0];
    if (e.type !== "circle") throw new Error("expected circle");
    expect(e.c).toEqual([15, 5]);
  });

  it("evaluates count/step against the variable scope", () => {
    const out = applyDerived(sketch([hole], [{ ...op, count: "holes", dx: "pitch" }]), { holes: 3, pitch: 7 });
    const g = gen(out);
    expect(g).toHaveLength(2);
    if (g[0].type !== "circle") throw new Error("expected circle");
    expect(g[0].c[0]).toBeCloseTo(7, 9);
  });

  it("contributes nothing for count < 2, a zero step, or a missing source", () => {
    expect(gen(applyDerived(sketch([hole], [{ ...op, count: "1" }]), {}))).toHaveLength(0);
    expect(gen(applyDerived(sketch([hole], [{ ...op, dx: "0", dy: "0" }]), {}))).toHaveLength(0);
    expect(gen(applyDerived(sketch([hole], [{ ...op, sourceIds: ["GONE"] }]), {}))).toHaveLength(0);
  });

  it("keeps per-output ids stable across recomputes", () => {
    const a = gen(applyDerived(sketch([hole], [op]), {})).map((e) => e.id);
    const b = gen(applyDerived(sketch([{ ...hole, c: [1, 1] } as SketchEntity], [op]), {})).map((e) => e.id);
    expect(a).toEqual(b);
  });

  it("preserves the source's construction flag on every copy", () => {
    const c: SketchEntity = { type: "circle", id: "H", c: [0, 0], r: 3, construction: true };
    const g = gen(applyDerived(sketch([c], [op]), {}));
    expect(g.every((e) => e.construction)).toBe(true);
  });
});

describe("applyDerived — circular pattern", () => {
  const hole: SketchEntity = { type: "circle", id: "H", c: [20, 0], r: 2 };
  const full: DerivedOp = {
    id: "cp",
    kind: "circularPattern",
    sourceIds: ["H"],
    center: { at: [0, 0] },
    count: "4",
    angle: "360",
  };

  it("full circle: count−1 copies at 360/count steps, no duplicate at the wrap", () => {
    const out = applyDerived(sketch([hole], [full]), {});
    const g = gen(out);
    expect(g).toHaveLength(3);
    const pts = g.map((e) => (e.type === "circle" ? e.c : [NaN, NaN]));
    // 90°, 180°, 270° around the origin from (20,0).
    expect(pts[0][0]).toBeCloseTo(0, 6);
    expect(pts[0][1]).toBeCloseTo(20, 6);
    expect(pts[1][0]).toBeCloseTo(-20, 6);
    expect(pts[1][1]).toBeCloseTo(0, 6);
    expect(pts[2][0]).toBeCloseTo(0, 6);
    expect(pts[2][1]).toBeCloseTo(-20, 6);
  });

  it("angle mode: spreads endpoints-inclusive across the sweep", () => {
    const op: DerivedOp = { ...full, count: "3", angle: "90" };
    const g = gen(applyDerived(sketch([hole], [op]), {}));
    expect(g).toHaveLength(2); // 45° and 90° (0° is the seed)
    const pts = g.map((e) => (e.type === "circle" ? e.c : [NaN, NaN]));
    expect(pts[0][0]).toBeCloseTo(20 * Math.SQRT1_2, 6);
    expect(pts[0][1]).toBeCloseTo(20 * Math.SQRT1_2, 6);
    expect(pts[1][0]).toBeCloseTo(0, 6);
    expect(pts[1][1]).toBeCloseTo(20, 6);
  });

  it("symmetric angle mode: spreads ±angle/2 about the seed", () => {
    const op: DerivedOp = { ...full, count: "3", angle: "90", symmetric: true };
    const g = gen(applyDerived(sketch([hole], [op]), {}));
    expect(g).toHaveLength(2); // −45° and +45°; the 0° slot is the seed, skipped
    const ys = g.map((e) => (e.type === "circle" ? e.c[1] : NaN)).sort((a, b) => a - b);
    expect(ys[0]).toBeCloseTo(-20 * Math.SQRT1_2, 6);
    expect(ys[1]).toBeCloseTo(20 * Math.SQRT1_2, 6);
  });

  it("rotation preserves an arc's sweep (start/end shift by the step)", () => {
    const arc: SketchEntity = { type: "arc", id: "A", c: [20, 0], r: 5, start: 0, end: Math.PI / 2 };
    const op: DerivedOp = { ...full, sourceIds: ["A"], count: "2", angle: "180" };
    const g = gen(applyDerived(sketch([arc], [op]), {}));
    expect(g).toHaveLength(1);
    const e = g[0];
    if (e.type !== "arc") throw new Error("expected arc");
    expect(e.c[0]).toBeCloseTo(-20, 6);
    expect(e.end - e.start).toBeCloseTo(Math.PI / 2, 9); // sweep preserved
    expect(e.start).toBeCloseTo(Math.PI, 9);
  });

  it("follows an associative center reference (entity vertex) when it moves", () => {
    const pivot: SketchEntity = { type: "point", id: "P", p: [10, 0], construction: true };
    const op: DerivedOp = { ...full, center: { entity: "P", at: "c" }, count: "2", angle: "180" };
    const out = applyDerived(sketch([hole, pivot], [op]), {});
    const e = gen(out)[0];
    if (e.type !== "circle") throw new Error("expected circle");
    expect(e.c[0]).toBeCloseTo(0, 6); // (20,0) rotated 180° about (10,0)
    // Move the pivot: the copy follows.
    const out2 = applyDerived(sketch([hole, { ...pivot, p: [15, 0] } as SketchEntity], [op]), {});
    const e2 = gen(out2)[0];
    if (e2.type !== "circle") throw new Error("expected circle");
    expect(e2.c[0]).toBeCloseTo(10, 6);
  });

  it("contributes nothing when the center reference is gone", () => {
    const op: DerivedOp = { ...full, center: { entity: "GONE", at: "c" } };
    expect(gen(applyDerived(sketch([hole], [op]), {}))).toHaveLength(0);
  });
});

describe("pattern count/angle helpers", () => {
  it("clamps runaway counts to MAX_PATTERN_INSTANCES", () => {
    expect(resolvePatternCount("1000000", {})).toBe(MAX_PATTERN_INSTANCES);
  });

  it("rejects non-numeric / sub-2 counts", () => {
    expect(resolvePatternCount("oops", {})).toBeNull();
    expect(resolvePatternCount("1", {})).toBeNull();
    expect(resolvePatternCount("-3", {})).toBeNull();
  });

  it("full-circle angles exclude the seed and the wrap duplicate", () => {
    const a = circularPatternAngles(6, 360);
    expect(a).toHaveLength(5);
    expect(a[0]).toBeCloseTo(Math.PI / 3, 9);
    expect(a[4]).toBeCloseTo((5 * Math.PI) / 3, 9);
  });

  it("multiples of 360 count as full circles", () => {
    expect(circularPatternAngles(4, 720)).toHaveLength(3);
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
