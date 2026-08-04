// Pure geometry for linear distance dimensions between two sketch elements.
//
// A `distanceBetween` constraint measures the distance between two "sides", each
// of which is a point (a vertex / a circle-arc centre / the origin), an
// (infinite) line, or the nearest boundary ("rim") of a circle/arc. The measure
// and the two witness endpoints (where the on-canvas dimension line starts/ends)
// follow from the pair; this module owns that geometry so it can be unit-tested
// without the React/solver layers. See DistanceRef in document/types.ts.
import type { DistanceRef, PointRef, SketchEntity, Vec2 } from "../document/types";
import { mag2 as len } from "../lib/vec2";

/** A DistanceRef resolved to live sketch geometry (uv). */
export type ResolvedSide =
  | { kind: "point"; p: Vec2 }
  | { kind: "line"; a: Vec2; b: Vec2 }
  | { kind: "rim"; c: Vec2; r: number };

const sub = (a: Vec2, b: Vec2): Vec2 => [a[0] - b[0], a[1] - b[1]];
const unit = (a: Vec2): Vec2 => {
  const l = len(a) || 1;
  return [a[0] / l, a[1] / l];
};
const addScaled = (p: Vec2, d: Vec2, s: number): Vec2 => [p[0] + d[0] * s, p[1] + d[1] * s];

/** Foot of the perpendicular from `p` onto the infinite line through `a`,`b`. */
export function footOnLine(p: Vec2, a: Vec2, b: Vec2): Vec2 {
  const ab = sub(b, a);
  const denom = ab[0] * ab[0] + ab[1] * ab[1] || 1;
  const t = ((p[0] - a[0]) * ab[0] + (p[1] - a[1]) * ab[1]) / denom;
  return [a[0] + t * ab[0], a[1] + t * ab[1]];
}

/** Live coordinates of a PointRef (origin, or an entity's named vertex/centre). */
export function pointRefCoord(ref: PointRef, entities: SketchEntity[]): Vec2 | null {
  if ("origin" in ref) return [0, 0];
  if ("fixed" in ref) return ref.fixed;
  const e = entities.find((x) => x.id === ref.entity);
  if (!e) return null;
  if (e.type === "line") return ref.at === "a" ? e.a : e.b;
  if (e.type === "circle") return e.c;
  if (e.type === "arc") {
    if (ref.at === "c") return e.c;
    const ang = ref.at === "a" ? e.start : e.end;
    return [e.c[0] + e.r * Math.cos(ang), e.c[1] + e.r * Math.sin(ang)];
  }
  return null;
}

/** Resolve a DistanceRef to live geometry, or null if it can't be resolved
 *  (missing entity, or the referenced entity is the wrong kind for `on`). */
export function resolveSide(ref: DistanceRef, entities: SketchEntity[]): ResolvedSide | null {
  if (ref.on === "point") {
    const p = pointRefCoord(ref.ref, entities);
    return p ? { kind: "point", p } : null;
  }
  const e = entities.find((x) => x.id === ref.entity);
  if (!e) return null;
  if (ref.on === "line") return e.type === "line" ? { kind: "line", a: e.a, b: e.b } : null;
  // rim
  if (e.type === "circle" || e.type === "arc") return { kind: "rim", c: e.c, r: e.r };
  return null;
}

/** The signed distance and the two uv endpoints the dimension line spans, for a
 *  pair of resolved sides. Distance is the natural measure for the pair: straight
 *  for point–point, perpendicular for anything involving a line, and the nearest
 *  gap (centre distance ∓ radius) for a rim. Returns null for a degenerate pair
 *  (e.g. a point that coincides with a circle's own centre). */
export function measureBetween(a: ResolvedSide, b: ResolvedSide): { value: number; wa: Vec2; wb: Vec2 } | null {
  // Normalize ordering so each case is written once; witnesses are symmetric.
  const rank = (s: ResolvedSide) => (s.kind === "point" ? 0 : s.kind === "line" ? 1 : 2);
  const flip = rank(a) > rank(b);
  const [x, y] = flip ? [b, a] : [a, b];
  const out = measureOrdered(x, y);
  if (!out) return null;
  return flip ? { value: out.value, wa: out.wb, wb: out.wa } : out;
}

// `x` has rank <= `y` (point < line < rim), so only six combinations remain.
function measureOrdered(x: ResolvedSide, y: ResolvedSide): { value: number; wa: Vec2; wb: Vec2 } | null {
  if (x.kind === "point" && y.kind === "point") {
    return { value: len(sub(y.p, x.p)), wa: x.p, wb: y.p };
  }
  if (x.kind === "point" && y.kind === "line") {
    const foot = footOnLine(x.p, y.a, y.b);
    return { value: len(sub(foot, x.p)), wa: x.p, wb: foot };
  }
  if (x.kind === "point" && y.kind === "rim") {
    const d = len(sub(x.p, y.c));
    if (d < 1e-9) return null; // point on the centre — no well-defined rim direction
    const rimPt = addScaled(y.c, unit(sub(x.p, y.c)), y.r);
    return { value: d - y.r, wa: x.p, wb: rimPt };
  }
  if (x.kind === "line" && y.kind === "line") {
    // Parallel-line separation: perpendicular distance from one line's midpoint.
    const mid: Vec2 = [(x.a[0] + x.b[0]) / 2, (x.a[1] + x.b[1]) / 2];
    const foot = footOnLine(mid, y.a, y.b);
    return { value: len(sub(foot, mid)), wa: mid, wb: foot };
  }
  if (x.kind === "line" && y.kind === "rim") {
    const foot = footOnLine(y.c, x.a, x.b);
    const d = len(sub(y.c, foot));
    if (d < 1e-9) return null; // centre on the line
    const rimPt = addScaled(y.c, unit(sub(foot, y.c)), y.r);
    return { value: d - y.r, wa: foot, wb: rimPt };
  }
  if (x.kind === "rim" && y.kind === "rim") {
    const between = sub(y.c, x.c);
    const d = len(between);
    if (d < 1e-9) return null; // concentric — no well-defined rim gap
    const dir = unit(between);
    const rimA = addScaled(x.c, dir, x.r);
    const rimB = addScaled(y.c, dir, -y.r);
    return { value: d - x.r - y.r, wa: rimA, wb: rimB };
  }
  return null;
}
