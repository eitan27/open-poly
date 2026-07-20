// Sketch inference lines (alignment guides) — the pure geometry core.
//
// While drawing, hovered points and "armed" line directions become ANCHORS that
// emit GUIDE lines (horizontal / vertical / parallel / perpendicular). The cursor
// snaps onto a guide when near it, or onto the INTERSECTION of two guides. A snap
// carries the MEANING(s) of the guide(s) it hit, so the click can capture the
// matching constraint (horizontal, vertical, parallel, perpendicular).
//
// This module is coordinate-only (sketch-plane uv) and has no three.js / React
// dependency, so the precedence + geometry can be unit-tested directly. Pixel
// tolerance is injected via a `uv -> screen px` projector, so callers keep the
// tolerance in screen space while the math stays in uv.
import type { Vec2 } from "../document/types";

/** What relationship a guide expresses — drives which constraint a snap captures. */
export type Meaning = "horizontal" | "vertical" | "parallel" | "perpendicular";

/** A reference an anchor/guide can constrain against: a sketch line's direction
 *  and the entity id to attach a parallel/perpendicular constraint to. */
export interface DirRef {
  dir: Vec2; // need not be unit; normalized internally
  refId?: string; // the sketch line entity this direction came from (for constraints)
}

/** The inputs a guide set is built from. */
export interface AnchorSet {
  /** Hovered key points. A bare point emits H/V; one with `lineDir` also emits
   *  parallel + perpendicular through itself (relative to that line). */
  points: { p: Vec2; lineDir?: Vec2; refId?: string }[];
  /** The draft's fixed start (the current segment pivots here). Emits H/V, and —
   *  for each armed direction — parallel/perpendicular of that direction (the
   *  "draw this segment parallel to an existing line" case). */
  draftStart?: Vec2;
  /** Armed reference directions (a hovered line's direction), used only with
   *  `draftStart` to angle-snap the segment being drawn. */
  armedDirs?: DirRef[];
}

/** A guide line: the infinite line through `origin` along unit `dir`, tagged with
 *  its meaning and the entity a parallel/perpendicular snap should constrain to. */
export interface Guide {
  origin: Vec2;
  dir: Vec2; // unit
  meaning: Meaning;
  refId?: string;
}

/** The chosen snap: a point, the meaning(s) of the guide(s) it lies on (one for a
 *  single guide, two for a guide intersection), and those guide lines themselves
 *  (so the caller can render them as dotted alignment lines). */
export interface GuideSnap {
  uv: Vec2;
  meanings: { meaning: Meaning; refId?: string }[];
  guides: Guide[];
}

const EPS = 1e-9;
const norm = (v: Vec2): number => Math.hypot(v[0], v[1]);
const unit = (v: Vec2): Vec2 => {
  const n = norm(v) || 1;
  return [v[0] / n, v[1] / n];
};
/** Left-hand perpendicular of a 2D vector. */
const perp = (v: Vec2): Vec2 => [-v[1], v[0]];
const cross = (a: Vec2, b: Vec2): number => a[0] * b[1] - a[1] * b[0];
const dot = (a: Vec2, b: Vec2): number => a[0] * b[0] + a[1] * b[1];

/** The guides one anchor point emits: horizontal + vertical, plus (if it lies on
 *  a line) parallel + perpendicular of that line, all through the point. */
export function guidesForPoint(p: Vec2, lineDir?: Vec2, refId?: string): Guide[] {
  const guides: Guide[] = [
    { origin: p, dir: [1, 0], meaning: "horizontal" },
    { origin: p, dir: [0, 1], meaning: "vertical" },
  ];
  if (lineDir && norm(lineDir) > EPS) {
    const d = unit(lineDir);
    guides.push({ origin: p, dir: d, meaning: "parallel", refId });
    guides.push({ origin: p, dir: unit(perp(d)), meaning: "perpendicular", refId });
  }
  return guides;
}

/** Every active guide, from hovered points, the draft start, and armed line
 *  directions. Deduping/capping of near-identical guides is left to the caller. */
export function buildGuides(set: AnchorSet): Guide[] {
  const guides: Guide[] = [];
  for (const a of set.points) guides.push(...guidesForPoint(a.p, a.lineDir, a.refId));
  if (set.draftStart) {
    const s = set.draftStart;
    guides.push({ origin: s, dir: [1, 0], meaning: "horizontal" });
    guides.push({ origin: s, dir: [0, 1], meaning: "vertical" });
    // Angle-snap the drawn segment to each armed line: a parallel guide through
    // the draft start along that direction (+ its perpendicular). Snapping the
    // cursor onto it makes the segment start->cursor parallel/perpendicular.
    for (const a of set.armedDirs ?? []) {
      if (norm(a.dir) <= EPS) continue;
      const d = unit(a.dir);
      guides.push({ origin: s, dir: d, meaning: "parallel", refId: a.refId });
      guides.push({ origin: s, dir: unit(perp(d)), meaning: "perpendicular", refId: a.refId });
    }
  }
  return guides;
}

/** The nearest point on a guide's infinite line to `p`. */
export function projectOntoGuide(p: Vec2, g: Guide): Vec2 {
  const w: Vec2 = [p[0] - g.origin[0], p[1] - g.origin[1]];
  const t = dot(w, g.dir);
  return [g.origin[0] + t * g.dir[0], g.origin[1] + t * g.dir[1]];
}

/** Intersection of two guide lines, or null when they're parallel (no unique
 *  point) — which also skips a guide against itself. */
export function guideIntersection(a: Guide, b: Guide): Vec2 | null {
  const denom = cross(a.dir, b.dir);
  if (Math.abs(denom) < EPS) return null; // parallel / collinear
  const diff: Vec2 = [b.origin[0] - a.origin[0], b.origin[1] - a.origin[1]];
  const t = cross(diff, b.dir) / denom;
  return [a.origin[0] + t * a.dir[0], a.origin[1] + t * a.dir[1]];
}

/** Pick the best snap for `cursor` among `guides`: a guide INTERSECTION wins over
 *  a single guide; within a tier the nearest (in screen px) wins. `pxOf` maps uv
 *  to screen pixels so `tolPx` is a pixel radius. Returns null if nothing is in
 *  range. Extra guides on the same line as a chosen snap fold their meanings in
 *  (so an intersection that also lies on a third parallel guide still reports it
 *  once). */
export function snapToGuides(
  cursor: Vec2,
  guides: Guide[],
  pxOf: (uv: Vec2) => Vec2,
  tolPx: number,
): GuideSnap | null {
  const pxBetween = (a: Vec2, b: Vec2): number => {
    const pa = pxOf(a);
    const pb = pxOf(b);
    return Math.hypot(pa[0] - pb[0], pa[1] - pb[1]);
  };
  const pxDist = (uv: Vec2): number => pxBetween(uv, cursor);
  // Whether a point lies ON a guide (its own projection onto the guide is itself).
  const onGuide = (uv: Vec2, g: Guide): boolean => pxBetween(uv, projectOntoGuide(uv, g)) < 0.5;

  // Tier 1: intersections of two non-parallel guides within tolerance.
  let best: { uv: Vec2; d: number; guides: Guide[] } | null = null;
  for (let i = 0; i < guides.length; i++) {
    for (let j = i + 1; j < guides.length; j++) {
      const x = guideIntersection(guides[i], guides[j]);
      if (!x) continue;
      const d = pxDist(x);
      if (d < tolPx && (!best || d < best.d)) best = { uv: x, d, guides: [guides[i], guides[j]] };
    }
  }
  // Tier 2: nearest single guide (only if no intersection qualified).
  if (!best) {
    for (const g of guides) {
      const uv = projectOntoGuide(cursor, g);
      const d = pxDist(uv);
      if (d < tolPx && (!best || d < best.d)) best = { uv, d, guides: [g] };
    }
  }
  if (!best) return null;

  // Fold in any other guide the chosen point also lies on, then dedupe meanings.
  const hit = guides.filter((g) => best!.guides.includes(g) || onGuide(best!.uv, g));
  const meanings: GuideSnap["meanings"] = [];
  for (const g of hit) {
    if (!meanings.some((m) => m.meaning === g.meaning && m.refId === g.refId)) {
      meanings.push({ meaning: g.meaning, refId: g.refId });
    }
  }
  return { uv: best.uv, meanings, guides: hit };
}
