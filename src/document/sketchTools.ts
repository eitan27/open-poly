// Pure geometry for the sketch construction tools. These return raw 2D points /
// circle / arc parameters; the caller turns them into SketchEntity objects (for
// committing) or polylines (for preview rendering). Shared by App and Viewport.
import type { Vec2 } from "./types";

const dist = (a: Vec2, b: Vec2) => Math.hypot(b[0] - a[0], b[1] - a[1]);

/** Axis-aligned rectangle from two opposite corners. */
export function rectangleCorners(a: Vec2, b: Vec2): Vec2[] {
  return [
    [a[0], a[1]],
    [b[0], a[1]],
    [b[0], b[1]],
    [a[0], b[1]],
  ];
}

/** Axis-aligned rectangle from a centre point and a corner. */
export function rectangleFromCenter(center: Vec2, corner: Vec2): Vec2[] {
  const hx = corner[0] - center[0];
  const hy = corner[1] - center[1];
  return [
    [center[0] - hx, center[1] - hy],
    [center[0] + hx, center[1] - hy],
    [center[0] + hx, center[1] + hy],
    [center[0] - hx, center[1] + hy],
  ];
}

/** Regular n-gon inscribed in the circle through `vertex`, centred at `center`. */
export function regularPolygon(center: Vec2, vertex: Vec2, n: number): Vec2[] {
  const r = dist(center, vertex);
  const a0 = Math.atan2(vertex[1] - center[1], vertex[0] - center[0]);
  const pts: Vec2[] = [];
  for (let i = 0; i < n; i++) {
    const a = a0 + (2 * Math.PI * i) / n;
    pts.push([center[0] + r * Math.cos(a), center[1] + r * Math.sin(a)]);
  }
  return pts;
}

/** Circle through three points (circumcircle); null if collinear. */
export function circleFrom3(a: Vec2, b: Vec2, c: Vec2): { center: Vec2; r: number } | null {
  const [ax, ay] = a;
  const [bx, by] = b;
  const [cx, cy] = c;
  const d = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by));
  if (Math.abs(d) < 1e-9) return null;
  const a2 = ax * ax + ay * ay;
  const b2 = bx * bx + by * by;
  const c2 = cx * cx + cy * cy;
  const ux = (a2 * (by - cy) + b2 * (cy - ay) + c2 * (ay - by)) / d;
  const uy = (a2 * (cx - bx) + b2 * (ax - cx) + c2 * (bx - ax)) / d;
  return { center: [ux, uy], r: Math.hypot(ax - ux, ay - uy) };
}

const TWO_PI = Math.PI * 2;
const norm = (x: number) => ((x % TWO_PI) + TWO_PI) % TWO_PI;

/** Arc through start, mid, end; start/end angles oriented CCW through `mid`. */
export function arcFrom3(
  start: Vec2,
  mid: Vec2,
  end: Vec2,
): { center: Vec2; r: number; start: number; end: number } | null {
  const cc = circleFrom3(start, mid, end);
  if (!cc) return null;
  const ang = (p: Vec2) => Math.atan2(p[1] - cc.center[1], p[0] - cc.center[0]);
  const s = norm(ang(start));
  const e = norm(ang(end));
  const m = norm(ang(mid));
  const sweepE = norm(e - s);
  const sweepM = norm(m - s);
  // If mid lies within the CCW sweep s->e, keep it; otherwise reverse so the
  // drawn arc passes through mid.
  if (sweepM <= sweepE) return { center: cc.center, r: cc.r, start: s, end: s + sweepE };
  return { center: cc.center, r: cc.r, start: e, end: e + norm(s - e) };
}

export function sampleCircle(center: Vec2, r: number, segs = 64): Vec2[] {
  const pts: Vec2[] = [];
  for (let i = 0; i <= segs; i++) {
    const a = (TWO_PI * i) / segs;
    pts.push([center[0] + r * Math.cos(a), center[1] + r * Math.sin(a)]);
  }
  return pts;
}

export function sampleArc(center: Vec2, r: number, start: number, end: number, segs = 48): Vec2[] {
  const pts: Vec2[] = [];
  for (let i = 0; i <= segs; i++) {
    const a = start + ((end - start) * i) / segs;
    pts.push([center[0] + r * Math.cos(a), center[1] + r * Math.sin(a)]);
  }
  return pts;
}

/** Consecutive segments around a closed loop of points. */
export function loopSegments(points: Vec2[]): [Vec2, Vec2][] {
  return points.map((p, i) => [p, points[(i + 1) % points.length]]);
}

/** Tessellate a smooth (Catmull-Rom) spline through `points` into a polyline,
 *  for sketch rendering/preview. The kernel builds the actual B-spline, so this
 *  is just a visual approximation of the same control points. */
/** One cubic-Bézier span of a spline: control points `c1`/`c2` and the span end
 *  (its start is the previous span's end, or the curve start for the first). */
export interface SplineBezier { c1: Vec2; c2: Vec2; end: Vec2; }

/** The canonical through-point spline as cubic-Bézier spans — the SINGLE source
 *  of truth shared by the on-screen curve (`sampleSpline`) and the swept spine
 *  the kernel builds, so the swept solid follows exactly the path that's drawn.
 *  A uniform Catmull-Rom (tension 0.5) with clamped ends (first/last control
 *  point doubled): a Catmull-Rom segment P1→P2 is exactly the cubic Bézier with
 *  controls P1, P1+(P2−P0)/6, P2−(P3−P1)/6, P2 (same endpoints and tangents). */
export function splineBeziers(points: Vec2[]): { start: Vec2; spans: SplineBezier[] } {
  const spans: SplineBezier[] = [];
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[i - 1] ?? points[i];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[i + 2] ?? points[i + 1];
    spans.push({
      c1: [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6],
      c2: [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6],
      end: p2,
    });
  }
  return { start: points[0], spans };
}

export function sampleSpline(points: Vec2[], segsPerSpan = 16): Vec2[] {
  if (points.length < 3) return points.slice();
  const { start, spans } = splineBeziers(points);
  const out: Vec2[] = [start];
  let p0 = start;
  for (const { c1, c2, end } of spans) {
    for (let s = 1; s <= segsPerSpan; s++) {
      const t = s / segsPerSpan;
      const mt = 1 - t;
      const a = mt * mt * mt, b = 3 * mt * mt * t, c = 3 * mt * t * t, d = t * t * t;
      out.push([
        a * p0[0] + b * c1[0] + c * c2[0] + d * end[0],
        a * p0[1] + b * c1[1] + c * c2[1] + d * end[1],
      ]);
    }
    p0 = end;
  }
  return out;
}
