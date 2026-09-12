import { describe, expect, it } from "vitest";
import {
  cutParams,
  extendPlan,
  intersectEntities,
  nearestEnd,
  paramAt,
  pointAt,
  trimPlan,
  type TrimTarget,
} from "./trim";
import type { SketchEntity, Vec2 } from "../document/types";

const line = (id: string, a: Vec2, b: Vec2): TrimTarget => ({ type: "line", id, a, b });
const circle = (id: string, c: Vec2, r: number): TrimTarget => ({ type: "circle", id, c, r });
const arc = (id: string, c: Vec2, r: number, start: number, end: number): TrimTarget => ({
  type: "arc",
  id,
  c,
  r,
  start,
  end,
});
const near = (p: Vec2, q: Vec2, tol = 1e-6) => expect(Math.hypot(p[0] - q[0], p[1] - q[1])).toBeLessThan(tol);
const sorted = (ps: Vec2[]) => [...ps].sort((a, b) => a[0] - b[0] || a[1] - b[1]);

describe("intersectEntities", () => {
  it("crosses two segments that actually cross", () => {
    const ps = intersectEntities(line("A", [-5, 0], [5, 0]), line("B", [0, -5], [0, 5]));
    expect(ps).toHaveLength(1);
    near(ps[0], [0, 0]);
  });

  it("finds nothing where the segments would only cross if extended", () => {
    expect(intersectEntities(line("A", [-5, 0], [-1, 0]), line("B", [0, -5], [0, 5]))).toEqual([]);
  });

  it("finds nothing between parallel lines", () => {
    expect(intersectEntities(line("A", [0, 0], [10, 0]), line("B", [0, 3], [10, 3]))).toEqual([]);
  });

  it("cuts a circle with a line twice, and tangentially once", () => {
    const through = intersectEntities(line("L", [-10, 0], [10, 0]), circle("C", [0, 0], 4));
    expect(through).toHaveLength(2);
    expect(sorted(through).map((p) => +p[0].toFixed(6))).toEqual([-4, 4]);
    const tangent = intersectEntities(line("L", [-10, 4], [10, 4]), circle("C", [0, 0], 4));
    expect(tangent).toHaveLength(1);
    near(tangent[0], [0, 4]);
  });

  it("crosses two circles in two places, and misses ones that are too far apart", () => {
    expect(intersectEntities(circle("A", [0, 0], 5), circle("B", [6, 0], 5))).toHaveLength(2);
    expect(intersectEntities(circle("A", [0, 0], 2), circle("B", [20, 0], 2))).toEqual([]);
    // Concentric circles never cross, however close their radii.
    expect(intersectEntities(circle("A", [0, 0], 5), circle("B", [0, 0], 5.001))).toEqual([]);
  });

  it("respects an arc's sweep — a crossing off the arc doesn't count", () => {
    const upperHalf = arc("A", [0, 0], 4, 0, Math.PI);
    // A vertical line crosses the circle at (0,4) and (0,-4); only the first is
    // on the upper half.
    const ps = intersectEntities(line("L", [0, -10], [0, 10]), upperHalf);
    expect(ps).toHaveLength(1);
    near(ps[0], [0, 4]);
  });

  it("never intersects an entity with itself", () => {
    const l = line("A", [0, 0], [5, 5]);
    expect(intersectEntities(l, l)).toEqual([]);
  });
});

describe("paramAt / pointAt round-trip", () => {
  it("walks a line from a to b", () => {
    const l = line("L", [2, 2], [12, 2]);
    expect(paramAt(l, [7, 2])).toBeCloseTo(0.5, 9);
    near(pointAt(l, 0), [2, 2]);
    near(pointAt(l, 1), [12, 2]);
  });

  it("walks an arc along its own sweep, including a clockwise one", () => {
    const ccw = arc("A", [0, 0], 5, 0, Math.PI / 2);
    near(pointAt(ccw, 0), [5, 0]);
    near(pointAt(ccw, 1), [0, 5]);
    expect(paramAt(ccw, [Math.SQRT1_2 * 5, Math.SQRT1_2 * 5])).toBeCloseTo(0.5, 6);
    const cw = arc("B", [0, 0], 5, Math.PI / 2, 0);
    near(pointAt(cw, 0), [0, 5]);
    near(pointAt(cw, 1), [5, 0]);
  });
});

describe("cutParams", () => {
  it("ignores a crossing that sits on the line's own endpoint", () => {
    // Two lines meeting at a corner bound nothing — there's no piece to remove.
    const l = line("L", [0, 0], [10, 0]);
    expect(cutParams(l, [line("M", [10, 0], [10, 10])])).toEqual([]);
  });

  it("collapses two crossings at the same spot into one cut", () => {
    const l = line("L", [-10, 0], [10, 0]);
    const cuts = cutParams(l, [line("A", [0, -5], [0, 5]), line("B", [0, -3], [0, 8])]);
    expect(cuts).toHaveLength(1);
  });

  it("sorts the cuts along the line", () => {
    const l = line("L", [0, 0], [10, 0]);
    const cuts = cutParams(l, [line("A", [7, -1], [7, 1]), line("B", [3, -1], [3, 1])]);
    expect(cuts.map((c) => +c.toFixed(3))).toEqual([0.3, 0.7]);
  });

  it("skips derived geometry — it isn't real sketch geometry to cut against", () => {
    const l = line("L", [-5, 0], [5, 0]);
    const derived: SketchEntity = { ...line("D", [0, -5], [0, 5]), derivedFrom: "op1" };
    expect(cutParams(l, [derived])).toEqual([]);
  });
});

describe("trimPlan — lines", () => {
  const crossing = line("X", [5, -5], [5, 5]);

  it("removes the stub past a crossing, shortening the line", () => {
    const l = line("L", [0, 0], [10, 0]);
    const plan = trimPlan(l, [crossing], [8, 0], "NEW");
    expect(plan.kind).toBe("shorten");
    if (plan.kind !== "shorten") return;
    expect(plan.movedEnd).toBe("b");
    near((plan.entity as Extract<TrimTarget, { type: "line" }>).b, [5, 0]);
    near((plan.entity as Extract<TrimTarget, { type: "line" }>).a, [0, 0]);
  });

  it("removes the other stub when you click the other side", () => {
    const l = line("L", [0, 0], [10, 0]);
    const plan = trimPlan(l, [crossing], [2, 0], "NEW");
    expect(plan.kind).toBe("shorten");
    if (plan.kind !== "shorten") return;
    expect(plan.movedEnd).toBe("a");
    near((plan.entity as Extract<TrimTarget, { type: "line" }>).a, [5, 0]);
  });

  it("splits the line in two when the piece is in the middle", () => {
    const l = line("L", [0, 0], [10, 0]);
    const others = [line("A", [3, -5], [3, 5]), line("B", [7, -5], [7, 5])];
    const plan = trimPlan(l, others, [5, 0], "NEW");
    expect(plan.kind).toBe("split");
    if (plan.kind !== "split") return;
    // The first fragment keeps the id AND the original `a` end.
    expect(plan.keep.id).toBe("L");
    near((plan.keep as Extract<TrimTarget, { type: "line" }>).a, [0, 0]);
    near((plan.keep as Extract<TrimTarget, { type: "line" }>).b, [3, 0]);
    expect(plan.rest.id).toBe("NEW");
    near((plan.rest as Extract<TrimTarget, { type: "line" }>).a, [7, 0]);
    near((plan.rest as Extract<TrimTarget, { type: "line" }>).b, [10, 0]);
  });

  it("deletes a line nothing crosses", () => {
    expect(trimPlan(line("L", [0, 0], [10, 0]), [], [5, 0], "NEW").kind).toBe("delete");
  });

  it("reports the piece being removed, so the preview shows what goes", () => {
    const plan = trimPlan(line("L", [0, 0], [10, 0]), [crossing], [8, 0], "NEW");
    near(plan.span[0], [5, 0]);
    near(plan.span[plan.span.length - 1], [10, 0]);
  });
});

describe("trimPlan — arcs and circles", () => {
  it("shortens an arc by its end piece, keeping centre and radius exact", () => {
    const a = arc("A", [0, 0], 10, 0, Math.PI); // upper half, ccw
    const cut = line("L", [0, -20], [0, 20]); // crosses at (0,10) = mid-arc
    const plan = trimPlan(a, [cut], [-7, 7], "NEW"); // click the far quarter
    expect(plan.kind).toBe("shorten");
    if (plan.kind !== "shorten" || plan.entity.type !== "arc") return;
    expect(plan.movedEnd).toBe("b");
    expect(plan.entity.c).toEqual([0, 0]);
    expect(plan.entity.r).toBe(10);
    expect(plan.entity.end).toBeCloseTo(Math.PI / 2, 9);
  });

  it("turns a circle into the arc that's left", () => {
    const c = circle("C", [0, 0], 10);
    const l1 = line("A", [-20, 0], [20, 0]); // cuts at 0 and 180
    const plan = trimPlan(c, [l1], [0, -10], "NEW"); // click the bottom half
    expect(plan.kind).toBe("open");
    if (plan.kind !== "open" || plan.entity.type !== "arc") return;
    expect(plan.entity.id).toBe("C"); // same entity, opened up
    expect(plan.entity.r).toBe(10);
    // What survives is the upper half: from 0 round to π.
    const mid = pointAt(plan.entity, 0.5);
    expect(mid[1]).toBeGreaterThan(9.9);
  });

  it("deletes a circle that only one thing touches (nothing bounds a piece)", () => {
    const tangent = line("T", [-20, 10], [20, 10]);
    expect(trimPlan(circle("C", [0, 0], 10), [tangent], [0, -10], "NEW").kind).toBe("delete");
  });

  it("keeps construction-ness through a trim", () => {
    const l: TrimTarget = { ...line("L", [0, 0], [10, 0]), construction: true };
    const plan = trimPlan(l, [line("X", [5, -5], [5, 5])], [8, 0], "NEW");
    if (plan.kind !== "shorten") throw new Error("expected shorten");
    expect(plan.entity.construction).toBe(true);
  });
});

describe("extendPlan", () => {
  it("grows a line's end out to the first thing ahead of it", () => {
    const l = line("L", [0, 0], [5, 0]);
    const far = line("F", [12, -5], [12, 5]);
    const near_ = line("N", [8, -5], [8, 5]);
    const plan = extendPlan(l, [far, near_], "b");
    expect(plan).not.toBeNull();
    near((plan!.entity as Extract<TrimTarget, { type: "line" }>).b, [8, 0]);
    expect(plan!.hitId).toBe("N"); // the NEAREST thing ahead, not the first listed
    expect(plan!.hitVertex).toBeNull(); // landed mid-entity, not on its vertex
  });

  it("grows the other end backwards", () => {
    const plan = extendPlan(line("L", [0, 0], [5, 0]), [line("B", [-4, -5], [-4, 5])], "a");
    near((plan!.entity as Extract<TrimTarget, { type: "line" }>).a, [-4, 0]);
  });

  it("says so when the target's end lands on another entity's VERTEX", () => {
    const plan = extendPlan(line("L", [0, 0], [5, 0]), [line("V", [8, 0], [8, 6])], "b");
    expect(plan!.hitVertex).toBe("a");
    expect(plan!.hitId).toBe("V");
  });

  it("returns null when nothing lies ahead", () => {
    expect(extendPlan(line("L", [0, 0], [5, 0]), [line("B", [-4, -5], [-4, 5])], "b")).toBeNull();
    expect(extendPlan(line("L", [0, 0], [5, 0]), [], "b")).toBeNull();
  });

  it("ignores something that lies ahead but isn't actually there", () => {
    // The other segment's own extent stops short of where the paths would meet.
    expect(extendPlan(line("L", [0, 0], [5, 0]), [line("S", [8, 2], [8, 6])], "b")).toBeNull();
  });

  it("grows an arc around its own circle", () => {
    const a = arc("A", [0, 0], 10, 0, Math.PI / 2); // 0° → 90°
    const cut = line("L", [-20, 10], [20, 10]); // tangent at the top… use a crossing instead
    const plan = extendPlan(a, [line("V", [-10, -20], [-10, 20])], "b");
    expect(plan).not.toBeNull();
    if (!plan || plan.entity.type !== "arc") return;
    expect(plan.entity.end).toBeCloseTo(Math.PI, 6); // grew to 180°, where x = -10
    expect(plan.entity.r).toBe(10); // radius untouched
    expect(cut.id).toBe("L");
  });

  it("refuses to extend a circle — it has no end", () => {
    expect(extendPlan(circle("C", [0, 0], 5), [line("L", [0, 0], [20, 0])], "b")).toBeNull();
  });
});

describe("nearestEnd", () => {
  it("picks the end you clicked nearest", () => {
    const l = line("L", [0, 0], [10, 0]);
    expect(nearestEnd(l, [1, 0])).toBe("a");
    expect(nearestEnd(l, [9, 0])).toBe("b");
  });
});
