// Trim and extend: the two edits that let you draw roughly and clean up after.
//
// Trim removes the PIECE of a curve you click on, where a "piece" is the span
// between the points at which that curve crosses other curves in the sketch.
// Extend is the inverse — it grows an open curve along its own path until it
// runs into something.
//
// Everything here is pure geometry over sketch entities: it decides WHAT the
// result should be and hands back a plan. Applying that plan to a document —
// and deciding what becomes of the constraints attached to the parts that move
// or disappear — is document/trimOps.ts.
//
// Curves are compared exactly (line/circle intersections solved in closed form),
// not through the polyline approximations region detection uses: a trimmed arc
// has to keep an exact centre, radius and angles or every downstream constraint
// is quietly wrong.

import type { SketchEntity, Vec2 } from "../document/types";

/** The entity kinds trim and extend understand. Splines aren't mapped by the
 *  solver and text/points aren't curves, so neither tool touches them. */
export type TrimTarget = Extract<SketchEntity, { type: "line" | "circle" | "arc" }>;

export const TRIM_EPS = 1e-7;
/** How close (in sketch mm) a cut has to be to an end before it's treated as
 *  being AT that end — below this a trim would leave a slver nobody wanted. */
const END_EPS = 1e-4;

const TAU = Math.PI * 2;
const norm2pi = (a: number): number => ((a % TAU) + TAU) % TAU;
const sub = (p: Vec2, q: Vec2): Vec2 => [p[0] - q[0], p[1] - q[1]];
const dot = (p: Vec2, q: Vec2): number => p[0] * q[0] + p[1] * q[1];
const len = (p: Vec2): number => Math.hypot(p[0], p[1]);
export const dist = (p: Vec2, q: Vec2): number => len(sub(p, q));

export function isTrimTarget(e: SketchEntity): e is TrimTarget {
  return (e.type === "line" || e.type === "circle" || e.type === "arc") && !e.derivedFrom;
}

/** An arc's signed sweep — negative when it runs clockwise. */
const sweepOf = (a: Extract<SketchEntity, { type: "arc" }>): number => a.end - a.start;

/** Whether an angle falls within an arc's own sweep. */
function angleOnArc(a: Extract<SketchEntity, { type: "arc" }>, theta: number): boolean {
  const sweep = sweepOf(a);
  const d = sweep >= 0 ? norm2pi(theta - a.start) : norm2pi(a.start - theta);
  return d <= Math.abs(sweep) + 1e-9;
}

// --- parameterization -----------------------------------------------------
// One scheme for all three kinds so the interval logic below is shared: 0..1
// along a line, 0..1 along an arc's own sweep, and 0..1 around a circle (which
// wraps, and is the only closed one).

export function pointAt(e: TrimTarget, t: number): Vec2 {
  if (e.type === "line") return [e.a[0] + (e.b[0] - e.a[0]) * t, e.a[1] + (e.b[1] - e.a[1]) * t];
  const theta = e.type === "circle" ? t * TAU : e.start + sweepOf(e) * t;
  return [e.c[0] + e.r * Math.cos(theta), e.c[1] + e.r * Math.sin(theta)];
}

/** Where a point sits along the entity, in the scheme above. Points off the
 *  curve project onto it (which is what a click does). */
export function paramAt(e: TrimTarget, p: Vec2): number {
  if (e.type === "line") {
    const ab = sub(e.b, e.a);
    const l2 = dot(ab, ab);
    if (l2 < TRIM_EPS) return 0;
    return Math.min(1, Math.max(0, dot(sub(p, e.a), ab) / l2));
  }
  const theta = Math.atan2(p[1] - e.c[1], p[0] - e.c[0]);
  if (e.type === "circle") return norm2pi(theta) / TAU;
  const sweep = sweepOf(e);
  if (Math.abs(sweep) < TRIM_EPS) return 0;
  const d = sweep >= 0 ? norm2pi(theta - e.start) : -norm2pi(e.start - theta);
  return Math.min(1, Math.max(0, d / sweep));
}

const isClosed = (e: TrimTarget): boolean => e.type === "circle";

// --- intersections --------------------------------------------------------

function lineLine(p1: Vec2, p2: Vec2, q1: Vec2, q2: Vec2): Vec2[] {
  const r = sub(p2, p1);
  const s = sub(q2, q1);
  const denom = r[0] * s[1] - r[1] * s[0];
  if (Math.abs(denom) < TRIM_EPS) return []; // parallel or degenerate
  const qp = sub(q1, p1);
  const t = (qp[0] * s[1] - qp[1] * s[0]) / denom;
  const u = (qp[0] * r[1] - qp[1] * r[0]) / denom;
  if (t < -1e-9 || t > 1 + 1e-9 || u < -1e-9 || u > 1 + 1e-9) return [];
  return [[p1[0] + r[0] * t, p1[1] + r[1] * t]];
}

/** Where an infinite line meets a circle, as parameters along p1→p2. */
function lineCircleParams(p1: Vec2, p2: Vec2, c: Vec2, r: number): number[] {
  const d = sub(p2, p1);
  const f = sub(p1, c);
  const a = dot(d, d);
  if (a < TRIM_EPS) return [];
  const b = 2 * dot(f, d);
  const cc = dot(f, f) - r * r;
  const disc = b * b - 4 * a * cc;
  if (disc < 0) return [];
  if (disc < TRIM_EPS) return [-b / (2 * a)]; // tangent
  const sq = Math.sqrt(disc);
  return [(-b - sq) / (2 * a), (-b + sq) / (2 * a)];
}

function circleCircle(c1: Vec2, r1: number, c2: Vec2, r2: number): Vec2[] {
  const d = dist(c1, c2);
  if (d < TRIM_EPS) return []; // concentric — no crossings (identical circles included)
  if (d > r1 + r2 + 1e-9 || d < Math.abs(r1 - r2) - 1e-9) return [];
  const a = (r1 * r1 - r2 * r2 + d * d) / (2 * d);
  const h2 = r1 * r1 - a * a;
  const h = h2 > 0 ? Math.sqrt(h2) : 0;
  const mid: Vec2 = [c1[0] + (a * (c2[0] - c1[0])) / d, c1[1] + (a * (c2[1] - c1[1])) / d];
  if (h < TRIM_EPS) return [mid];
  const rx = (-(c2[1] - c1[1]) * h) / d;
  const ry = ((c2[0] - c1[0]) * h) / d;
  return [
    [mid[0] + rx, mid[1] + ry],
    [mid[0] - rx, mid[1] - ry],
  ];
}

/** Whether a point lies within an entity's own extent (a segment's span, an
 *  arc's sweep; a circle is all of itself). */
function onExtent(e: TrimTarget, p: Vec2): boolean {
  if (e.type === "line") {
    const ab = sub(e.b, e.a);
    const l2 = dot(ab, ab);
    if (l2 < TRIM_EPS) return false;
    const t = dot(sub(p, e.a), ab) / l2;
    return t >= -1e-9 && t <= 1 + 1e-9;
  }
  if (e.type === "circle") return true;
  return angleOnArc(e, Math.atan2(p[1] - e.c[1], p[0] - e.c[0]));
}

/** Points where an infinite line meets a circle, clipped to the segment. */
function lineCirclePoints(line: Extract<TrimTarget, { type: "line" }>, c: Vec2, r: number, clip = true): Vec2[] {
  return lineCircleParams(line.a, line.b, c, r)
    .filter((t) => !clip || (t >= -1e-9 && t <= 1 + 1e-9))
    .map((t): Vec2 => [line.a[0] + (line.b[0] - line.a[0]) * t, line.a[1] + (line.b[1] - line.a[1]) * t]);
}

/** Every point at which two entities actually cross, within both extents. */
export function intersectEntities(a: TrimTarget, b: TrimTarget): Vec2[] {
  if (a.id === b.id) return [];
  let raw: Vec2[];
  if (a.type === "line" && b.type === "line") raw = lineLine(a.a, a.b, b.a, b.b);
  else if (a.type !== "line" && b.type !== "line") raw = circleCircle(a.c, a.r, b.c, b.r);
  else if (a.type === "line" && b.type !== "line") raw = lineCirclePoints(a, b.c, b.r);
  else if (b.type === "line" && a.type !== "line") raw = lineCirclePoints(b, a.c, a.r);
  else raw = [];
  return raw.filter((p) => onExtent(a, p) && onExtent(b, p));
}

// --- trim -----------------------------------------------------------------

/** What a trim would do. `span` is the piece being removed, as a polyline — the
 *  hover preview draws exactly this, so what you see removed is what goes. */
export type TrimPlan =
  /** Nothing crosses it: clicking trims the whole entity away. */
  | { kind: "delete"; span: Vec2[] }
  /** The piece is at one end — the entity survives, shorter, with `movedEnd`
   *  pulled back to the cut. */
  | { kind: "shorten"; entity: TrimTarget; movedEnd: "a" | "b"; span: Vec2[] }
  /** The piece is in the middle — one entity becomes two. `keep` holds the
   *  original id (and its `a` end); `rest` is new and holds the original `b`. */
  | { kind: "split"; keep: TrimTarget; rest: TrimTarget; span: Vec2[] }
  /** A circle loses an arc's worth of itself and becomes an arc. */
  | { kind: "open"; entity: TrimTarget; span: Vec2[] };

/** Sample a span of the entity as a polyline (straight for a line, walked in
 *  small angular steps for a curve), for preview and for hit feedback. */
export function spanPolyline(e: TrimTarget, from: number, to: number): Vec2[] {
  if (e.type === "line") return [pointAt(e, from), pointAt(e, to)];
  const steps = Math.max(2, Math.ceil(Math.abs(to - from) * (e.type === "circle" ? 64 : 48)));
  const out: Vec2[] = [];
  for (let i = 0; i <= steps; i++) out.push(pointAt(e, from + ((to - from) * i) / steps));
  return out;
}

/** The cut parameters along `target`, sorted, with duplicates and cuts sitting
 *  on an open entity's own ends removed (those bound nothing). */
export function cutParams(target: TrimTarget, others: SketchEntity[]): number[] {
  const params: number[] = [];
  for (const o of others) {
    if (!isTrimTarget(o) || o.id === target.id) continue;
    for (const p of intersectEntities(target, o)) params.push(paramAt(target, p));
  }
  // Tolerance in PARAMETER terms: END_EPS is a distance, so scale it by how
  // long the entity actually is.
  const closed = isClosed(target);
  const span =
    target.type === "line"
      ? dist(target.a, target.b)
      : target.type === "circle"
        ? target.r * TAU
        : Math.abs(target.r * sweepOf(target));
  const tol = span > TRIM_EPS ? END_EPS / span : 1e-6;
  const kept = params.filter((t) => closed || (t > tol && t < 1 - tol)).sort((x, y) => x - y);
  return kept.filter((t, i) => i === 0 || t - kept[i - 1] > tol);
}

/** Plan the trim of `target` at the point clicked. `others` is the rest of the
 *  sketch; `newId` names the second entity a middle cut creates. */
export function trimPlan(target: TrimTarget, others: SketchEntity[], click: Vec2, newId: string): TrimPlan {
  const cuts = cutParams(target, others);
  const whole = spanPolyline(target, 0, 1);
  // A curve nothing crosses has no piece to take: the click removes all of it,
  // which is what every CAD trim does with an unbounded entity.
  if (cuts.length === 0 || (isClosed(target) && cuts.length < 2)) return { kind: "delete", span: whole };

  const t = paramAt(target, click);
  if (target.type === "circle") {
    // Wrapping: the piece runs from the last cut at or before t to the next one
    // after it, around the end if need be.
    let i = cuts.findIndex((c) => c > t);
    if (i === -1) i = 0;
    const hi = cuts[i];
    const lo = cuts[(i - 1 + cuts.length) % cuts.length];
    // What's LEFT is the complement: an arc from hi round to lo.
    const start = hi * TAU;
    const end = lo * TAU + (lo <= hi ? TAU : 0);
    const arc: TrimTarget = {
      type: "arc",
      id: target.id,
      c: target.c,
      r: target.r,
      start,
      end,
      ...(target.construction ? { construction: true } : {}),
    };
    const spanTo = lo < hi ? hi : hi + 1;
    return { kind: "open", entity: arc, span: spanPolyline(target, lo < hi ? lo : lo - 1, spanTo) };
  }

  const bounds = [0, ...cuts, 1];
  let i = bounds.findIndex((b) => b > t);
  if (i <= 0) i = bounds.length - 1;
  const lo = bounds[i - 1];
  const hi = bounds[i];
  const span = spanPolyline(target, lo, hi);
  const atStart = lo <= 0;
  const atEnd = hi >= 1;
  if (atStart && atEnd) return { kind: "delete", span: whole };
  if (atStart) return { kind: "shorten", entity: reshape(target, hi, 1), movedEnd: "a", span };
  if (atEnd) return { kind: "shorten", entity: reshape(target, 0, lo), movedEnd: "b", span };
  return { kind: "split", keep: reshape(target, 0, lo), rest: { ...reshape(target, hi, 1), id: newId }, span };
}

/** The same entity restricted to a sub-span of itself, keeping its id and kind. */
function reshape(e: TrimTarget, from: number, to: number): TrimTarget {
  if (e.type === "line") return { ...e, a: pointAt(e, from), b: pointAt(e, to) };
  if (e.type === "arc") {
    const sweep = sweepOf(e);
    return { ...e, start: e.start + sweep * from, end: e.start + sweep * to };
  }
  return e;
}

// --- extend ---------------------------------------------------------------

export interface ExtendPlan {
  /** The entity with the chosen end grown out to meet something. */
  entity: TrimTarget;
  end: "a" | "b";
  /** What it landed on, and whether it landed on that entity's own vertex —
   *  which decides whether the joint recorded is a coincidence or a point-on. */
  hitId: string;
  hitPoint: Vec2;
  hitVertex: "a" | "b" | "c" | null;
  /** The stretch being ADDED, as a polyline — the preview draws this, so what
   *  you see gained is what you get. */
  span: Vec2[];
}

/** Where an entity's named vertex sits — used to tell "landed on its end" from
 *  "landed somewhere along it". */
function vertexPoints(e: TrimTarget): { at: "a" | "b" | "c"; p: Vec2 }[] {
  if (e.type === "line") {
    return [
      { at: "a", p: e.a },
      { at: "b", p: e.b },
    ];
  }
  if (e.type === "circle") return [{ at: "c", p: e.c }];
  return [
    { at: "a", p: pointAt(e, 0) },
    { at: "b", p: pointAt(e, 1) },
  ];
}

/** Plan the extension of `target`'s `end` out to the first thing it meets.
 *  Returns null when nothing lies ahead — the tool then says so rather than
 *  moving the end to nowhere. A circle has no end to extend. */
export function extendPlan(target: TrimTarget, others: SketchEntity[], end: "a" | "b"): ExtendPlan | null {
  if (target.type === "circle") return null;

  // Candidate landing points: where the entity's own unbounded path (the full
  // line, or the arc's whole circle) crosses another entity's actual extent.
  type Hit = { p: Vec2; t: number; id: string; vertex: "a" | "b" | "c" | null };
  const hits: Hit[] = [];
  for (const o of others) {
    if (!isTrimTarget(o) || o.id === target.id) continue;
    // The target's UNBOUNDED path — a line's whole line, an arc's whole circle —
    // against the other entity's actual extent.
    let pts: Vec2[] = [];
    if (target.type === "line") {
      if (o.type === "line") {
        const p = lineLineUnbounded(target.a, target.b, o.a, o.b);
        pts = p ? [p] : [];
      } else {
        pts = lineCirclePoints(target, o.c, o.r, false);
      }
    } else {
      pts = o.type === "line" ? lineCirclePoints(o, target.c, target.r) : circleCircle(target.c, target.r, o.c, o.r);
    }
    for (const p of pts) {
      if (!onExtent(o, p)) continue; // the other entity has to actually be there
      const t = extensionAmount(target, end, p);
      if (t === null) continue;
      const v = vertexPoints(o).find((x) => dist(x.p, p) < END_EPS);
      hits.push({ p, t, id: o.id, vertex: v ? v.at : null });
    }
  }
  if (hits.length === 0) return null;
  hits.sort((x, y) => x.t - y.t);
  const best = hits[0];
  const grown = grownTo(target, end, best.p);
  // The added stretch, in the GROWN entity's own parameterization: from where
  // the old end now sits, out to the end that moved.
  const wasAt = paramAt(grown, pointAt(target, end === "b" ? 1 : 0));
  const span = end === "b" ? spanPolyline(grown, wasAt, 1) : spanPolyline(grown, 0, wasAt);
  return { entity: grown, end, hitId: best.id, hitPoint: best.p, hitVertex: best.vertex, span };
}

function lineLineUnbounded(p1: Vec2, p2: Vec2, q1: Vec2, q2: Vec2): Vec2 | null {
  const r = sub(p2, p1);
  const s = sub(q2, q1);
  const denom = r[0] * s[1] - r[1] * s[0];
  if (Math.abs(denom) < TRIM_EPS) return null;
  const qp = sub(q1, p1);
  const t = (qp[0] * s[1] - qp[1] * s[0]) / denom;
  return [p1[0] + r[0] * t, p1[1] + r[1] * t];
}

/** How far BEYOND the chosen end a candidate point lies, or null if it isn't
 *  beyond it at all (an extension only ever grows the entity). */
function extensionAmount(target: TrimTarget, end: "a" | "b", p: Vec2): number | null {
  if (target.type === "line") {
    const ab = sub(target.b, target.a);
    const l2 = dot(ab, ab);
    if (l2 < TRIM_EPS) return null;
    const t = dot(sub(p, target.a), ab) / l2;
    const past = end === "b" ? t - 1 : -t;
    return past > 1e-6 ? past * Math.sqrt(l2) : null;
  }
  if (target.type !== "arc") return null;
  const sweep = sweepOf(target);
  const theta = Math.atan2(p[1] - target.c[1], p[0] - target.c[0]);
  // Angular distance travelled from the chosen end, in the direction that grows
  // the arc, capped short of a full turn so it can't wrap onto itself.
  const from = end === "b" ? target.end : target.start;
  const dir = end === "b" ? Math.sign(sweep) || 1 : -(Math.sign(sweep) || 1);
  const d = dir > 0 ? norm2pi(theta - from) : norm2pi(from - theta);
  if (d < 1e-6 || d > TAU - Math.abs(sweep) - 1e-6) return null;
  return d * target.r;
}

function grownTo(target: TrimTarget, end: "a" | "b", p: Vec2): TrimTarget {
  if (target.type === "line") return end === "b" ? { ...target, b: p } : { ...target, a: p };
  if (target.type !== "arc") return target;
  const theta = Math.atan2(p[1] - target.c[1], p[0] - target.c[0]);
  const sweep = sweepOf(target);
  if (end === "b") {
    const d = sweep >= 0 ? norm2pi(theta - target.end) : -norm2pi(target.end - theta);
    return { ...target, end: target.end + d };
  }
  const d = sweep >= 0 ? norm2pi(target.start - theta) : -norm2pi(theta - target.start);
  return { ...target, start: target.start - d };
}

/** Which end of an open entity a click is nearest — what the extend tool grows. */
export function nearestEnd(target: TrimTarget, click: Vec2): "a" | "b" {
  return paramAt(target, click) < 0.5 ? "a" : "b";
}
