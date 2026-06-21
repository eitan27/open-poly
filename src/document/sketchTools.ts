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
export function sampleSpline(points: Vec2[], segsPerSpan = 16): Vec2[] {
  if (points.length < 3) return points.slice();
  const out: Vec2[] = [points[0]];
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[i - 1] ?? points[i];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[i + 2] ?? points[i + 1];
    for (let s = 1; s <= segsPerSpan; s++) {
      const t = s / segsPerSpan;
      const t2 = t * t;
      const t3 = t2 * t;
      // Catmull-Rom basis (tension 0.5).
      const x = 0.5 * ((2 * p1[0]) + (-p0[0] + p2[0]) * t + (2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * t2 + (-p0[0] + 3 * p1[0] - 3 * p2[0] + p3[0]) * t3);
      const y = 0.5 * ((2 * p1[1]) + (-p0[1] + p2[1]) * t + (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * t2 + (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * t3);
      out.push([x, y]);
    }
  }
  return out;
}
