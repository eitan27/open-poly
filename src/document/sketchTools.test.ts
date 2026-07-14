import { describe, expect, it } from "vitest";
import {
  connectedEntityIds,
  detectSingleChain,
  fitProjectedPolyline,
  mirrorEntity,
  offsetChain,
  reflectPointAcrossLine,
  sampleArc,
  sampleCircle,
  sampleSpline,
  splineBeziers,
  type ChainEdge,
} from "./sketchTools";
import { uvToWorld, worldToUv, type PlaneFrameData } from "./planes";
import type { SketchEntity, Vec2 } from "./types";

// Reference: the original Catmull-Rom (tension 0.5) evaluation that the display
// used before splineBeziers became the single source of truth. The Bézier spans
// must reproduce this exact curve, so the swept spine == the drawn curve.
function catmullRom(points: Vec2[], segsPerSpan = 16): Vec2[] {
  if (points.length < 3) return points.slice();
  const out: Vec2[] = [points[0]];
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[i - 1] ?? points[i];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[i + 2] ?? points[i + 1];
    for (let s = 1; s <= segsPerSpan; s++) {
      const t = s / segsPerSpan, t2 = t * t, t3 = t2 * t;
      out.push([
        0.5 * (2 * p1[0] + (-p0[0] + p2[0]) * t + (2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * t2 + (-p0[0] + 3 * p1[0] - 3 * p2[0] + p3[0]) * t3),
        0.5 * (2 * p1[1] + (-p0[1] + p2[1]) * t + (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * t2 + (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * t3),
      ]);
    }
  }
  return out;
}

describe("splineBeziers / sampleSpline", () => {
  const pts: Vec2[] = [[38, 72], [66, 66], [76, 47], [66, 28], [38, 22]];

  it("Bézier spans reproduce the original Catmull-Rom curve exactly", () => {
    const sampled = sampleSpline(pts);
    const ref = catmullRom(pts);
    expect(sampled.length).toBe(ref.length);
    for (let i = 0; i < ref.length; i++) {
      expect(sampled[i][0]).toBeCloseTo(ref[i][0], 9);
      expect(sampled[i][1]).toBeCloseTo(ref[i][1], 9);
    }
  });

  it("interpolates the control points (spans pass through them)", () => {
    const { start, spans } = splineBeziers(pts);
    expect(start).toEqual(pts[0]);
    expect(spans).toHaveLength(pts.length - 1);
    spans.forEach((s, i) => expect(s.end).toEqual(pts[i + 1]));
  });

  it("clamps end tangents (first span leaves toward the 2nd point)", () => {
    // With the first control point doubled, the start tangent is 0.5*(P1−P0),
    // so the first Bézier control sits 1/6 of the way toward P1.
    const { spans } = splineBeziers(pts);
    expect(spans[0].c1[0]).toBeCloseTo(38 + (66 - 38) / 6, 9);
    expect(spans[0].c1[1]).toBeCloseTo(72 + (66 - 72) / 6, 9);
  });
});

const line = (id: string, a: Vec2, b: Vec2): ChainEdge => ({ type: "line", id, a, b });
// A CCW-ordered unit-ish square (0,0)->(10,0)->(10,10)->(0,10), closed.
const ccwSquare = (): ChainEdge[] => [
  line("s0", [0, 0], [10, 0]),
  line("s1", [10, 0], [10, 10]),
  line("s2", [10, 10], [0, 10]),
  line("s3", [0, 10], [0, 0]),
];

describe("detectSingleChain", () => {
  it("accepts a single line", () => {
    expect(detectSingleChain([line("a", [0, 0], [10, 0])])).toHaveLength(1);
  });

  it("orders a two-line L head-to-tail (either direction is valid)", () => {
    const chain = detectSingleChain([line("b", [10, 0], [10, 10]), line("a", [0, 0], [10, 0])]);
    expect(chain).not.toBeNull();
    expect(chain!.map((e) => e.id).sort()).toEqual(["a", "b"]);
    // Consecutive edges share an endpoint (it's a real chain, not just a set).
    const ends = chain!.map((e) => (e.type === "line" ? [e.a, e.b] : []));
    const shared = ends[0].some((p) => ends[1].some((q) => p[0] === q[0] && p[1] === q[1]));
    expect(shared).toBe(true);
  });

  it("accepts a closed loop", () => {
    expect(detectSingleChain(ccwSquare())).toHaveLength(4);
  });

  it("accepts a lone circle but rejects a circle mixed with edges", () => {
    const circle: SketchEntity = { type: "circle", id: "c", c: [0, 0], r: 5 };
    expect(detectSingleChain([circle])).toHaveLength(1);
    expect(detectSingleChain([circle, line("a", [0, 0], [10, 0])])).toBeNull();
  });

  it("rejects empty, disjoint, and branched selections", () => {
    expect(detectSingleChain([])).toBeNull();
    // Disjoint: two unconnected lines.
    expect(detectSingleChain([line("a", [0, 0], [1, 0]), line("b", [5, 5], [6, 5])])).toBeNull();
    // Branch: three lines meeting at the origin.
    expect(
      detectSingleChain([line("a", [0, 0], [1, 0]), line("b", [0, 0], [0, 1]), line("c", [0, 0], [-1, 0])]),
    ).toBeNull();
  });

  it("rejects a non-offsettable entity (spline) in the selection", () => {
    const spline: SketchEntity = { type: "spline", id: "sp", points: [[0, 0], [1, 1], [2, 0]] };
    expect(detectSingleChain([spline])).toBeNull();
  });
});

describe("connectedEntityIds", () => {
  it("floods the whole connected chain from any seed, ignoring a disjoint piece", () => {
    // A closed square (4 lines) + one disjoint line elsewhere.
    const square = [
      line("a", [0, 0], [10, 0]),
      line("b", [10, 0], [10, 10]),
      line("c", [10, 10], [0, 10]),
      line("d", [0, 10], [0, 0]),
    ];
    const stray = line("e", [50, 50], [60, 50]);
    const all: SketchEntity[] = [...square, stray];
    expect(new Set(connectedEntityIds("b", all))).toEqual(new Set(["a", "b", "c", "d"]));
    expect(connectedEntityIds("e", all)).toEqual(["e"]);
  });

  it("bridges a line into an arc at a shared endpoint and welds sub-tolerance gaps", () => {
    const l = line("l", [0, 0], [10, 0]);
    // Arc starting where the line ends (10,0), 90° up.
    const arc: SketchEntity = { type: "arc", id: "arc", c: [10, 5], r: 5, start: -Math.PI / 2, end: 0 };
    // A second line meeting the first's start with a ~5e-5 gap (within 1e-4).
    const l2 = line("l2", [0, 0.00005], [0, -10]);
    expect(new Set(connectedEntityIds("l", [l, arc, l2]))).toEqual(new Set(["l", "arc", "l2"]));
  });

  it("treats a lone circle / point as its own component", () => {
    const circle: SketchEntity = { type: "circle", id: "c", c: [0, 0], r: 5 };
    const pt: SketchEntity = { type: "point", id: "p", p: [0, 0] };
    expect(connectedEntityIds("c", [circle, pt])).toEqual(["c"]);
  });
});

describe("offsetChain", () => {
  it("offsets a single line to a parallel line at the right distance (right = +)", () => {
    const out = offsetChain([line("a", [0, 0], [10, 0])], 2);
    expect(out[0].type).toBe("line");
    if (out[0].type === "line") {
      // Right of +x travel is -y; the line shifts to y = -2.
      expect(out[0].a[1]).toBeCloseTo(-2, 9);
      expect(out[0].b[1]).toBeCloseTo(-2, 9);
    }
    const neg = offsetChain([line("a", [0, 0], [10, 0])], -2)[0];
    if (neg.type === "line") expect(neg.a[1]).toBeCloseTo(2, 9);
  });

  it("recomputes the corner of an L", () => {
    const out = offsetChain([line("a", [0, 0], [10, 0]), line("b", [10, 0], [10, 10])], 2);
    // The shared corner offsets outward (right of travel) to (12, -2).
    expect(out[0].type).toBe("line");
    if (out[0].type === "line") {
      expect(out[0].b[0]).toBeCloseTo(12, 6);
      expect(out[0].b[1]).toBeCloseTo(-2, 6);
    }
  });

  it("offsets a CCW square outward (+) larger and inward (−) smaller", () => {
    const larger = offsetChain(ccwSquare(), 2);
    const xs = larger.flatMap((e) => (e.type === "line" ? [e.a[0], e.b[0]] : []));
    const ys = larger.flatMap((e) => (e.type === "line" ? [e.a[1], e.b[1]] : []));
    expect(Math.min(...xs)).toBeCloseTo(-2, 6);
    expect(Math.max(...xs)).toBeCloseTo(12, 6);
    expect(Math.min(...ys)).toBeCloseTo(-2, 6);
    expect(Math.max(...ys)).toBeCloseTo(12, 6);

    const smaller = offsetChain(ccwSquare(), -3);
    const sxs = smaller.flatMap((e) => (e.type === "line" ? [e.a[0], e.b[0]] : []));
    expect(Math.min(...sxs)).toBeCloseTo(3, 6);
    expect(Math.max(...sxs)).toBeCloseTo(7, 6);
  });

  it("offsets a full circle by changing its radius", () => {
    const out = offsetChain([{ type: "circle", id: "c", c: [0, 0], r: 5 }], 2);
    expect(out[0]).toMatchObject({ type: "circle", r: 7 });
  });

  it("offsets a lone arc to a concentric arc (same centre, radius ± d)", () => {
    const arc: ChainEdge = { type: "arc", id: "a", c: [0, 0], r: 10, start: 0, end: Math.PI };
    const out = offsetChain([arc], 3)[0];
    expect(out.type).toBe("arc");
    if (out.type === "arc") {
      expect(out.c).toEqual([0, 0]);
      // CCW arc → +d grows the radius (outward, right of travel).
      expect(out.r).toBeCloseTo(13, 6);
    }
    const inward = offsetChain([arc], -4)[0];
    if (inward.type === "arc") expect(inward.r).toBeCloseTo(6, 6);
  });

  it("clamps a circle/arc offset that would invert the radius to a tiny positive", () => {
    const circle = offsetChain([{ type: "circle", id: "c", c: [0, 0], r: 5 }], -20)[0];
    if (circle.type === "circle") expect(circle.r).toBeGreaterThan(0);
  });
});

describe("reflectPointAcrossLine / mirrorEntity", () => {
  it("reflects a point across a vertical line (x = 2)", () => {
    const out = reflectPointAcrossLine([5, 3], [2, 0], [2, 10]);
    expect(out[0]).toBeCloseTo(-1, 9);
    expect(out[1]).toBeCloseTo(3, 9);
  });

  it("reflects a point across the 45° line y = x (swaps coords)", () => {
    const out = reflectPointAcrossLine([1, 4], [0, 0], [1, 1]);
    expect(out[0]).toBeCloseTo(4, 9);
    expect(out[1]).toBeCloseTo(1, 9);
  });

  it("leaves a point on the axis unmoved", () => {
    const out = reflectPointAcrossLine([3, 3], [0, 0], [1, 1]);
    expect(out[0]).toBeCloseTo(3, 9);
    expect(out[1]).toBeCloseTo(3, 9);
  });

  it("mirrors a line to the expected coordinates across x = 0", () => {
    const e: SketchEntity = { type: "line", id: "l", a: [1, 1], b: [3, 5] };
    const m = mirrorEntity(e, [0, 0], [0, 1], "l2");
    expect(m).toMatchObject({ type: "line", id: "l2" });
    if (m.type === "line") {
      expect(m.a[0]).toBeCloseTo(-1, 9);
      expect(m.a[1]).toBeCloseTo(1, 9);
      expect(m.b[0]).toBeCloseTo(-3, 9);
      expect(m.b[1]).toBeCloseTo(5, 9);
    }
  });

  it("preserves construction flag and assigns the new id", () => {
    const e: SketchEntity = { type: "circle", id: "c", c: [2, 0], r: 4, construction: true };
    const m = mirrorEntity(e, [0, 0], [0, 1], "c2");
    expect(m).toMatchObject({ type: "circle", id: "c2", r: 4, construction: true });
    if (m.type === "circle") expect(m.c[0]).toBeCloseTo(-2, 9);
  });

  it("mirrors an arc so it still passes through the reflection of its midpoint", () => {
    const axisA: Vec2 = [0, 0], axisB: Vec2 = [0, 1]; // mirror across x = 0
    const e: SketchEntity = { type: "arc", id: "a", c: [3, 0], r: 2, start: 0.3, end: 2.1 };
    const m = mirrorEntity(e, axisA, axisB, "a2");
    expect(m.type).toBe("arc");
    if (m.type !== "arc") return;
    // The original mid-arc point, reflected, must lie on the mirrored arc.
    const origMidAng = (e.start + e.end) / 2;
    const origMid: Vec2 = [e.c[0] + e.r * Math.cos(origMidAng), e.c[1] + e.r * Math.sin(origMidAng)];
    const expectedMid = reflectPointAcrossLine(origMid, axisA, axisB);
    // Sample the mirrored arc and confirm the reflected midpoint is on it.
    const pts = sampleArc(m.c, m.r, m.start, m.end, 200);
    const minDist = Math.min(...pts.map((p) => Math.hypot(p[0] - expectedMid[0], p[1] - expectedMid[1])));
    expect(minDist).toBeLessThan(1e-2);
    // And the reflected endpoints are the arc's endpoints.
    const origStart: Vec2 = [e.c[0] + e.r * Math.cos(e.start), e.c[1] + e.r * Math.sin(e.start)];
    const expStart = reflectPointAcrossLine(origStart, axisA, axisB);
    const dStart = Math.min(...pts.map((p) => Math.hypot(p[0] - expStart[0], p[1] - expStart[1])));
    expect(dStart).toBeLessThan(1e-2);
  });
});

describe("worldToUv (Project/Convert projection)", () => {
  const front: PlaneFrameData = {
    origin: [0, 0, 0],
    uAxis: [1, 0, 0],
    vAxis: [0, 0, 1],
    normal: [0, 1, 0],
  };

  it("is the inverse of uvToWorld on the plane", () => {
    const [u, v] = [3.5, -2.25];
    const w = uvToWorld(front, u, v);
    const back = worldToUv(front, w);
    expect(back[0]).toBeCloseTo(u, 9);
    expect(back[1]).toBeCloseTo(v, 9);
  });

  it("drops the normal (off-plane) component — orthographic projection", () => {
    // Same in-plane (u,v) but pushed 10 along the plane normal (+Y) → same uv.
    const onPlane = uvToWorld(front, 4, 7);
    const offPlane: [number, number, number] = [onPlane[0], onPlane[1] + 10, onPlane[2]];
    const [u, v] = worldToUv(front, offPlane);
    expect(u).toBeCloseTo(4, 9);
    expect(v).toBeCloseTo(7, 9);
  });
});

describe("fitProjectedPolyline", () => {
  it("fits a straight (2-point) edge to a line", () => {
    const fit = fitProjectedPolyline([[1, 2], [5, 9]]);
    expect(fit?.type).toBe("line");
    if (fit?.type === "line") {
      expect(fit.a).toEqual([1, 2]);
      expect(fit.b).toEqual([5, 9]);
    }
  });

  it("fits a densely-sampled straight edge to a line (hugs its chord)", () => {
    const pts: Vec2[] = [];
    for (let i = 0; i <= 20; i++) pts.push([i * 0.5, 3 - i * 0.1]);
    expect(fitProjectedPolyline(pts)?.type).toBe("line");
  });

  it("fits a closed circular polyline to a circle", () => {
    const pts = sampleCircle([2, -3], 5, 64);
    const fit = fitProjectedPolyline(pts);
    expect(fit?.type).toBe("circle");
    if (fit?.type === "circle") {
      expect(fit.c[0]).toBeCloseTo(2, 6);
      expect(fit.c[1]).toBeCloseTo(-3, 6);
      expect(fit.r).toBeCloseTo(5, 6);
    }
  });

  it("fits an open arc to an arc passing through its samples", () => {
    const c: Vec2 = [0, 0];
    const r = 4;
    const pts = sampleArc(c, r, 0.2, 2.1, 48);
    const fit = fitProjectedPolyline(pts);
    expect(fit?.type).toBe("arc");
    if (fit?.type === "arc") {
      expect(fit.c[0]).toBeCloseTo(0, 5);
      expect(fit.c[1]).toBeCloseTo(0, 5);
      expect(fit.r).toBeCloseTo(4, 5);
    }
  });

  it("falls back to a spline for a non-circular curved polyline", () => {
    // A sine wiggle: curved but not constant-radius, and not straight.
    const pts: Vec2[] = [];
    for (let i = 0; i <= 30; i++) pts.push([i, Math.sin(i * 0.4) * 2]);
    expect(fitProjectedPolyline(pts)?.type).toBe("spline");
  });
});
