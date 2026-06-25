import { describe, expect, it } from "vitest";
import { sampleSpline, splineBeziers } from "./sketchTools";
import type { Vec2 } from "./types";

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
