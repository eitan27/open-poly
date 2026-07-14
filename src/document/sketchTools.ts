// Pure geometry for the sketch construction tools. These return raw 2D points /
// circle / arc parameters; the caller turns them into SketchEntity objects (for
// committing) or polylines (for preview rendering). Shared by App and Viewport.
import type { SketchEntity, Vec2 } from "./types";

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

// ---------------------------------------------------------------------------
// Offset (a connected chain of edges copied a uniform signed distance away).
// ---------------------------------------------------------------------------

/** An offsettable sketch edge: a straight line, a circular arc, or a full
 *  circle (a closed one-edge chain). */
export type ChainEdge = Extract<SketchEntity, { type: "line" | "arc" | "circle" }>;

/** A raw offset result primitive — like a SketchEntity but without id /
 *  construction flag (the caller assigns those when it commits). */
export type OffsetPrimitive =
  | { type: "line"; a: Vec2; b: Vec2 }
  | { type: "arc"; c: Vec2; r: number; start: number; end: number }
  | { type: "circle"; c: Vec2; r: number };

const CHAIN_EPS = 1e-6;
const veq = (a: Vec2, b: Vec2, eps = CHAIN_EPS) => Math.hypot(a[0] - b[0], a[1] - b[1]) <= eps;
const ptOnCircle = (c: Vec2, r: number, ang: number): Vec2 => [c[0] + r * Math.cos(ang), c[1] + r * Math.sin(ang)];
const angleOf = (c: Vec2, p: Vec2) => Math.atan2(p[1] - c[1], p[0] - c[0]);

/** The two free endpoints of an edge (lines and arcs); circles have none. */
function edgeEnds(e: ChainEdge): [Vec2, Vec2] | null {
  if (e.type === "line") return [e.a, e.b];
  if (e.type === "arc") return [ptOnCircle(e.c, e.r, e.start), ptOnCircle(e.c, e.r, e.end)];
  return null; // circle is closed
}

/** Validate that `entities` (only lines/arcs/circles are considered) form
 *  exactly ONE simple chain — connected end-to-end, no branching, no gaps —
 *  and return it ordered head-to-tail. Returns null for anything else (empty,
 *  multiple disjoint pieces, a branch where 3+ edges meet at a vertex, or any
 *  non-offsettable entity such as a spline/point mixed in). A lone circle is a
 *  valid single closed chain. Open or closed chains are both accepted.
 *  Mirrors the Onshape rule behind "Can only offset a single chain at once." */
export function detectSingleChain(entities: SketchEntity[]): ChainEdge[] | null {
  // Any non-offsettable entity in the selection disqualifies it.
  if (entities.some((e) => e.type !== "line" && e.type !== "arc" && e.type !== "circle")) return null;
  const edges = entities.filter((e): e is ChainEdge => e.type === "line" || e.type === "arc" || e.type === "circle");
  if (edges.length === 0) return null;

  // A circle is a closed loop on its own — only valid as the SOLE selection.
  if (edges.some((e) => e.type === "circle")) return edges.length === 1 ? edges : null;

  if (edges.length === 1) return edges;

  // Reject branches: every endpoint may be shared by at most two edges.
  const ends = edges.map((e) => edgeEnds(e)!);
  const degree = (p: Vec2) => ends.reduce((n, [u, v]) => n + (veq(p, u) ? 1 : 0) + (veq(p, v) ? 1 : 0), 0);
  for (const [u, v] of ends) if (degree(u) > 2 || degree(v) > 2) return null;

  // Walk the chain. Start at a degree-1 endpoint (open chain) or anywhere (closed).
  const used = new Array(edges.length).fill(false);
  let startIdx = ends.findIndex(([u, v]) => degree(u) === 1 || degree(v) === 1);
  if (startIdx < 0) startIdx = 0; // closed loop
  const order: ChainEdge[] = [];
  // Pick the starting "tail" point so we walk away from it.
  const [s0, s1] = ends[startIdx];
  let frontier = degree(s0) === 1 ? s1 : degree(s1) === 1 ? s0 : s1;
  used[startIdx] = true;
  order.push(edges[startIdx]);
  for (let guard = 0; guard < edges.length; guard++) {
    let nextIdx = -1;
    let nextFrontier: Vec2 | null = null;
    for (let i = 0; i < edges.length; i++) {
      if (used[i]) continue;
      const [u, v] = ends[i];
      if (veq(u, frontier)) { nextIdx = i; nextFrontier = v; break; }
      if (veq(v, frontier)) { nextIdx = i; nextFrontier = u; break; }
    }
    if (nextIdx < 0) break; // chain ended
    used[nextIdx] = true;
    order.push(edges[nextIdx]);
    frontier = nextFrontier!;
  }
  // Every edge must be reachable in one walk, else the selection was disjoint.
  return order.length === edges.length ? order : null;
}

/** Ids of every entity in the connected component of `seedId` — the transitive
 *  closure of "shares an endpoint with". Used by double-click to grab a whole
 *  connected outline (e.g. an imported DXF of many small edges) in one gesture,
 *  ready to offset. Endpoints are matched at a tolerance that absorbs solver
 *  residue and arc-endpoint rounding; closed entities (circles) and pointlike
 *  ones (point/text) have no endpoints, so they're their own component. */
export function connectedEntityIds(seedId: string, entities: SketchEntity[]): string[] {
  // Endpoints within TOL are the same junction. Grid-bucketed with a neighbour
  // sweep + true distance test so points straddling a bucket edge still match
  // (a plain rounded key would split them) — robust to solver residue and
  // computed arc-endpoint noise, not just exactly-coincident coordinates.
  const TOL = 1e-4;
  const bucket = (v: number) => Math.round(v / TOL);
  const endsOf = (e: SketchEntity): Vec2[] => {
    if (e.type === "line") return [e.a, e.b];
    if (e.type === "arc") return [ptOnCircle(e.c, e.r, e.start), ptOnCircle(e.c, e.r, e.end)];
    if (e.type === "spline" && e.points.length >= 2) return [e.points[0], e.points[e.points.length - 1]];
    return [];
  };

  // Spatial index of every endpoint, and each entity's own endpoints.
  const grid = new Map<string, { id: string; p: Vec2 }[]>();
  const endpointsOfId = new Map<string, Vec2[]>();
  for (const e of entities) {
    const es = endsOf(e);
    if (es.length) endpointsOfId.set(e.id, es);
    for (const p of es) {
      const k = `${bucket(p[0])},${bucket(p[1])}`;
      const arr = grid.get(k);
      if (arr) arr.push({ id: e.id, p });
      else grid.set(k, [{ id: e.id, p }]);
    }
  }
  const touching = (p: Vec2): string[] => {
    const cx = bucket(p[0]), cy = bucket(p[1]);
    const ids: string[] = [];
    for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 1; dy++)
        for (const { id, p: q } of grid.get(`${cx + dx},${cy + dy}`) ?? [])
          if (Math.hypot(q[0] - p[0], q[1] - p[1]) <= TOL) ids.push(id);
    return ids;
  };

  // Breadth-first flood from the seed over shared endpoints.
  const seen = new Set<string>([seedId]);
  const stack = [seedId];
  while (stack.length) {
    const id = stack.pop()!;
    for (const p of endpointsOfId.get(id) ?? [])
      for (const nb of touching(p))
        if (!seen.has(nb)) { seen.add(nb); stack.push(nb); }
  }
  return [...seen];
}

// During offset, each chain edge is oriented in traversal order (p0 -> p1).
type Oriented =
  | { kind: "line"; p0: Vec2; p1: Vec2 }
  | { kind: "arc"; c: Vec2; r: number; ccw: boolean; p0: Vec2; p1: Vec2 };

/** Offset a single chain (the ordered output of `detectSingleChain`) by a
 *  signed distance. Sign convention: **positive offsets to the RIGHT of the
 *  traversal direction**, which for a counter-clockwise closed loop is OUTWARD
 *  (a larger loop); negative is inward / left. Straight edges translate by the
 *  perpendicular; arcs keep their centre and change radius; shared vertices are
 *  recomputed by intersecting the adjacent offset primitives (nearest the
 *  original corner) so the offset stays connected.
 *  TODO: this produces independent geometry; a follow-up could add an "offset"
 *  constraint linking each new edge to its source so it stays parametric. */
export function offsetChain(chain: ChainEdge[], d: number): OffsetPrimitive[] {
  if (chain.length === 0) return [];
  if (chain.length === 1 && chain[0].type === "circle") {
    const c = chain[0];
    return [{ type: "circle", c: c.c, r: Math.max(c.r + d, CHAIN_EPS) }];
  }

  // 1. Orient every edge so consecutive edges connect p1(i) ≈ p0(i+1).
  const oriented: Oriented[] = chain.length === 1 ? [toOrientedNatural(chain[0])] : orientChain(chain);

  // 2. Offset each oriented edge to the right of travel.
  const off = oriented.map((e) => offsetOriented(e, d));

  // 3. Recompute shared corners by intersecting neighbouring offset primitives.
  const closed = veq(oriented[0].p0, oriented[oriented.length - 1].p1, 1e-4);
  const n = off.length;
  const lastJoin = closed ? n : n - 1; // closed loops also join last->first
  for (let i = 0; i < lastJoin; i++) {
    const a = off[i];
    const b = off[(i + 1) % n];
    const ref: Vec2 = [(a.p1[0] + b.p0[0]) / 2, (a.p1[1] + b.p0[1]) / 2];
    const x = intersectOffset(a, b, ref);
    if (x) { a.p1 = x; b.p0 = x; }
  }

  // 4. Emit primitives.
  return off.map((e) => {
    if (e.kind === "line") return { type: "line", a: e.p0, b: e.p1 } as OffsetPrimitive;
    const start = e.ccw ? angleOf(e.c, e.p0) : angleOf(e.c, e.p1);
    let end = e.ccw ? angleOf(e.c, e.p1) : angleOf(e.c, e.p0);
    while (end <= start) end += Math.PI * 2;
    return { type: "arc", c: e.c, r: e.r, start, end } as OffsetPrimitive;
  });
}

type OffEdge =
  | { kind: "line"; p0: Vec2; p1: Vec2; t: Vec2 }
  | { kind: "arc"; kindArc: true; c: Vec2; r: number; ccw: boolean; p0: Vec2; p1: Vec2 };

function orientChain(chain: ChainEdge[]): Oriented[] {
  const ends = chain.map((e) => edgeEnds(e)!);
  // Decide edge 0's tail: the endpoint NOT shared with edge 1.
  const out: Oriented[] = [];
  let prevTip: Vec2;
  {
    const [a, b] = ends[0];
    const [u, v] = ends[1];
    const aShared = veq(a, u) || veq(a, v);
    const p0 = aShared ? b : a;
    const p1 = aShared ? a : b;
    out.push(toOriented(chain[0], p0, p1));
    prevTip = p1;
  }
  for (let i = 1; i < chain.length; i++) {
    const [a, b] = ends[i];
    const p0 = veq(a, prevTip) ? a : b;
    const p1 = veq(a, prevTip) ? b : a;
    out.push(toOriented(chain[i], p0, p1));
    prevTip = p1;
  }
  return out;
}

/** Orient a lone edge in its natural direction (line a->b, arc CCW start->end). */
function toOrientedNatural(e: ChainEdge): Oriented {
  const [p0, p1] = edgeEnds(e)!;
  return toOriented(e, p0, p1);
}

function toOriented(e: ChainEdge, p0: Vec2, p1: Vec2): Oriented {
  // Lines (and circles, which never reach here — they're handled as a lone
  // closed chain) orient trivially p0->p1.
  if (e.type !== "arc") return { kind: "line", p0, p1 };
  // Stored arcs sweep CCW from `start` to `end`; traversal is forward (ccw)
  // when we enter at the start-angle endpoint, reversed otherwise.
  const startPt = ptOnCircle(e.c, e.r, e.start);
  return { kind: "arc", c: e.c, r: e.r, ccw: veq(p0, startPt), p0, p1 };
}

function offsetOriented(e: Oriented, d: number): OffEdge {
  if (e.kind === "line") {
    const dx = e.p1[0] - e.p0[0], dy = e.p1[1] - e.p0[1];
    const len = Math.hypot(dx, dy) || 1;
    const t: Vec2 = [dx / len, dy / len];
    const nr: Vec2 = [t[1], -t[0]]; // right-of-travel normal
    return { kind: "line", t, p0: [e.p0[0] + d * nr[0], e.p0[1] + d * nr[1]], p1: [e.p1[0] + d * nr[0], e.p1[1] + d * nr[1]] };
  }
  // Arc: right-of-travel is outward for a CCW arc (radius grows), inward for CW.
  const r = Math.max(e.ccw ? e.r + d : e.r - d, CHAIN_EPS);
  return { kind: "arc", kindArc: true, c: e.c, r, ccw: e.ccw, p0: ptOnCircle(e.c, r, angleOf(e.c, e.p0)), p1: ptOnCircle(e.c, r, angleOf(e.c, e.p1)) };
}

/** Intersection of two adjacent offset primitives, nearest `ref` (the gap
 *  midpoint). Falls back to `ref` when there's no clean intersection. */
function intersectOffset(a: OffEdge, b: OffEdge, ref: Vec2): Vec2 | null {
  const nearest = (cands: Vec2[]) =>
    cands.length === 0 ? null : cands.reduce((best, p) => (Math.hypot(p[0] - ref[0], p[1] - ref[1]) < Math.hypot(best[0] - ref[0], best[1] - ref[1]) ? p : best));
  if (a.kind === "line" && b.kind === "line") {
    const p = lineLine(a.p0, a.t, b.p0, b.t);
    return p ?? ref;
  }
  if (a.kind === "line" && b.kind === "arc") return nearest(lineCircle(a.p0, a.t, b.c, b.r)) ?? ref;
  if (a.kind === "arc" && b.kind === "line") return nearest(lineCircle(b.p0, b.t, a.c, a.r)) ?? ref;
  if (a.kind === "arc" && b.kind === "arc") return nearest(circleCircle(a.c, a.r, b.c, b.r)) ?? ref;
  return ref;
}

function lineLine(p: Vec2, t: Vec2, q: Vec2, u: Vec2): Vec2 | null {
  const denom = t[0] * u[1] - t[1] * u[0];
  if (Math.abs(denom) < 1e-9) return null; // parallel
  const s = ((q[0] - p[0]) * u[1] - (q[1] - p[1]) * u[0]) / denom;
  return [p[0] + s * t[0], p[1] + s * t[1]];
}

function lineCircle(p: Vec2, t: Vec2, c: Vec2, r: number): Vec2[] {
  // Solve |p + s t - c|^2 = r^2.
  const fx = p[0] - c[0], fy = p[1] - c[1];
  const a = t[0] * t[0] + t[1] * t[1];
  const b = 2 * (fx * t[0] + fy * t[1]);
  const cc = fx * fx + fy * fy - r * r;
  const disc = b * b - 4 * a * cc;
  if (disc < 0) return [];
  const sq = Math.sqrt(disc);
  const s1 = (-b + sq) / (2 * a), s2 = (-b - sq) / (2 * a);
  return [[p[0] + s1 * t[0], p[1] + s1 * t[1]], [p[0] + s2 * t[0], p[1] + s2 * t[1]]];
}

function circleCircle(c0: Vec2, r0: number, c1: Vec2, r1: number): Vec2[] {
  const dx = c1[0] - c0[0], dy = c1[1] - c0[1];
  const dDist = Math.hypot(dx, dy);
  if (dDist < 1e-9 || dDist > r0 + r1 || dDist < Math.abs(r0 - r1)) return [];
  const aa = (r0 * r0 - r1 * r1 + dDist * dDist) / (2 * dDist);
  const h2 = r0 * r0 - aa * aa;
  const h = Math.sqrt(Math.max(h2, 0));
  const xm = c0[0] + (aa * dx) / dDist, ym = c0[1] + (aa * dy) / dDist;
  const rx = -(dy / dDist) * h, ry = (dx / dDist) * h;
  return [[xm + rx, ym + ry], [xm - rx, ym - ry]];
}

// ── Sketch Mirror tool ────────────────────────────────────────────────────────
// Pure reflection geometry for the 2D sketch Mirror tool (distinct from the
// modeling-mode body MirrorFeature). Reflects sketch entities across an infinite
// mirror axis defined by two points.

/** Reflect point `p` across the infinite line through `a` and `b`. */
export function reflectPointAcrossLine(p: Vec2, a: Vec2, b: Vec2): Vec2 {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  if (len2 < 1e-12) {
    // Degenerate axis (a == b): reflect through the point `a` instead.
    return [2 * a[0] - p[0], 2 * a[1] - p[1]];
  }
  // Project (p - a) onto the axis direction, then reflect across it.
  const t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2;
  const projX = a[0] + t * dx, projY = a[1] + t * dy;
  return [2 * projX - p[0], 2 * projY - p[1]];
}

/** Reflect a sketch entity across the mirror axis `a`→`b`, returning a new entity
 *  with id `newId`. Reflection reverses orientation, so an arc's start/end angles
 *  are rebuilt from its reflected start/mid/end sample points (via `arcFrom3`) so
 *  the mirrored arc still passes through the reflection of the original mid-arc
 *  point. The mirrored entity is construction iff the source was. */
export function mirrorEntity(e: SketchEntity, a: Vec2, b: Vec2, newId: string): SketchEntity {
  const r = (p: Vec2) => reflectPointAcrossLine(p, a, b);
  const c = e.construction ? { construction: true as const } : {};
  switch (e.type) {
    case "line":
      return { type: "line", id: newId, a: r(e.a), b: r(e.b), ...c };
    case "circle":
      return { type: "circle", id: newId, c: r(e.c), r: e.r, ...c };
    case "arc": {
      const sp = r([e.c[0] + e.r * Math.cos(e.start), e.c[1] + e.r * Math.sin(e.start)]);
      const mid = (e.start + e.end) / 2;
      const mp = r([e.c[0] + e.r * Math.cos(mid), e.c[1] + e.r * Math.sin(mid)]);
      const ep = r([e.c[0] + e.r * Math.cos(e.end), e.c[1] + e.r * Math.sin(e.end)]);
      const arc = arcFrom3(sp, mp, ep);
      if (arc) return { type: "arc", id: newId, c: arc.center, r: arc.r, start: arc.start, end: arc.end, ...c };
      // Degenerate (collinear samples): fall back to a reflected center + radius.
      return { type: "arc", id: newId, c: r(e.c), r: e.r, start: e.start, end: e.end, ...c };
    }
    case "spline":
      return { type: "spline", id: newId, points: e.points.map(r), ...c };
    case "point":
      return { type: "point", id: newId, p: r(e.p), ...c };
    case "text": {
      // Reflect the anchor and the baseline orientation. The glyphs themselves
      // stay readable (not horizontally flipped) — the renderer only draws
      // upright text, so a true mirror image isn't expressible.
      const axisAng = Math.atan2(b[1] - a[1], b[0] - a[0]);
      return {
        type: "text", id: newId, p: r(e.p), value: e.value, height: e.height,
        rotation: 2 * axisAng - (e.rotation ?? 0),
        ...(e.font ? { font: e.font } : {}), ...c,
      };
    }
  }
}

// ── Sketch Pattern tools ──────────────────────────────────────────────────────
// Pure rigid-motion geometry for the 2D sketch Linear/Circular Pattern tools
// (distinct from the modeling-mode body PatternFeature). Unlike mirror, these
// preserve orientation, so an arc's start/end angles map directly.

/** Translate a sketch entity by (dx, dy), returning a new entity with id
 *  `newId`. The copy is construction iff the source was. */
export function translateEntity(e: SketchEntity, dx: number, dy: number, newId: string): SketchEntity {
  const t = (p: Vec2): Vec2 => [p[0] + dx, p[1] + dy];
  const c = e.construction ? { construction: true as const } : {};
  switch (e.type) {
    case "line":
      return { type: "line", id: newId, a: t(e.a), b: t(e.b), ...c };
    case "circle":
      return { type: "circle", id: newId, c: t(e.c), r: e.r, ...c };
    case "arc":
      return { type: "arc", id: newId, c: t(e.c), r: e.r, start: e.start, end: e.end, ...c };
    case "spline":
      return { type: "spline", id: newId, points: e.points.map(t), ...c };
    case "point":
      return { type: "point", id: newId, p: t(e.p), ...c };
    case "text":
      return {
        type: "text", id: newId, p: t(e.p), value: e.value, height: e.height,
        ...(e.rotation !== undefined ? { rotation: e.rotation } : {}),
        ...(e.font ? { font: e.font } : {}), ...c,
      };
  }
}

/** Rotate a sketch entity by `angle` radians (CCW) about `center`, returning a
 *  new entity with id `newId`. A rotation preserves orientation, so an arc's
 *  start/end angles simply shift by the rotation angle (no re-fit needed).
 *  The copy is construction iff the source was. */
export function rotateEntity(e: SketchEntity, center: Vec2, angle: number, newId: string): SketchEntity {
  const cos = Math.cos(angle), sin = Math.sin(angle);
  const rot = (p: Vec2): Vec2 => {
    const x = p[0] - center[0], y = p[1] - center[1];
    return [center[0] + x * cos - y * sin, center[1] + x * sin + y * cos];
  };
  const c = e.construction ? { construction: true as const } : {};
  switch (e.type) {
    case "line":
      return { type: "line", id: newId, a: rot(e.a), b: rot(e.b), ...c };
    case "circle":
      return { type: "circle", id: newId, c: rot(e.c), r: e.r, ...c };
    case "arc":
      return { type: "arc", id: newId, c: rot(e.c), r: e.r, start: e.start + angle, end: e.end + angle, ...c };
    case "spline":
      return { type: "spline", id: newId, points: e.points.map(rot), ...c };
    case "point":
      return { type: "point", id: newId, p: rot(e.p), ...c };
    case "text":
      return {
        type: "text", id: newId, p: rot(e.p), value: e.value, height: e.height,
        rotation: (e.rotation ?? 0) + angle,
        ...(e.font ? { font: e.font } : {}), ...c,
      };
  }
}

// ---------------------------------------------------------------------------
// Project / Convert (existing 3D geometry pulled into the active sketch).
// ---------------------------------------------------------------------------

/** A fitted sketch primitive from a projected edge — raw params, no id /
 *  construction flag (the caller assigns those). A straight edge becomes a
 *  `line`; a planar circular edge a `circle` (closed) or `arc` (open); anything
 *  else falls back to a `spline` through the (decimated) projected points. */
export type FittedProjection =
  | { type: "line"; a: Vec2; b: Vec2 }
  | { type: "circle"; c: Vec2; r: number }
  | { type: "arc"; c: Vec2; r: number; start: number; end: number }
  | { type: "spline"; points: Vec2[] };

/** Largest perpendicular distance from any point to the chord a→b. */
function maxDeviationFromChord(pts: Vec2[], a: Vec2, b: Vec2): number {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const len = Math.hypot(dx, dy);
  if (len < CHAIN_EPS) return Math.max(...pts.map((p) => dist(p, a)));
  const nx = -dy / len, ny = dx / len; // unit normal to the chord
  let m = 0;
  for (const p of pts) m = Math.max(m, Math.abs((p[0] - a[0]) * nx + (p[1] - a[1]) * ny));
  return m;
}

/** Keep at most `max` points (always the endpoints), evenly sampled — so a
 *  densely tessellated curve becomes a manageable spline control polygon. */
function decimate(pts: Vec2[], max = 16): Vec2[] {
  if (pts.length <= max) return pts.slice();
  const out: Vec2[] = [];
  for (let i = 0; i < max; i++) out.push(pts[Math.round((i * (pts.length - 1)) / (max - 1))]);
  return out;
}

/** Fit a projected (already 2D) polyline to the simplest sketch primitive.
 *  Tessellation vertices lie ON the source curve, so a straight edge (2 points,
 *  or all within `tol` of its chord) → `line`; a constant-radius set of points →
 *  `circle` if the polyline closes, else `arc`; everything else → `spline`.
 *  A circle/arc that wasn't parallel to the sketch plane projects to an ellipse,
 *  fails the constant-radius test, and correctly falls back to a spline. */
export function fitProjectedPolyline(pts: Vec2[], tol = 1e-3): FittedProjection | null {
  if (pts.length < 2) return null;
  const a = pts[0];
  const b = pts[pts.length - 1];
  const closed = veq(a, b, tol);

  // Straight: a line iff every vertex hugs the chord (and the ends are distinct).
  if (!closed && maxDeviationFromChord(pts, a, b) <= tol) return { type: "line", a, b };

  // Curved: try a constant-radius (circle/arc) fit through three spread samples.
  if (pts.length >= 3) {
    const mid = pts[Math.floor(pts.length / 2)];
    const s3 = closed ? pts[Math.floor(pts.length / 3)] : a;
    const e3 = closed ? pts[Math.floor((2 * pts.length) / 3)] : b;
    const cc = circleFrom3(s3, mid, e3);
    // The on-circle tolerance scales with the polyline's own extent (its bbox
    // diagonal), NOT the fitted radius: a nearly-collinear sample triple yields
    // a huge radius, and a radius-scaled tolerance would wrongly accept any
    // gently-wavy curve. A real circular edge's vertices sit exactly on it.
    let lo = pts[0], hi = pts[0];
    for (const p of pts) { lo = [Math.min(lo[0], p[0]), Math.min(lo[1], p[1])]; hi = [Math.max(hi[0], p[0]), Math.max(hi[1], p[1])]; }
    const onTol = Math.max(tol, dist(lo, hi) * 1e-3);
    if (cc && cc.r > tol) {
      const onCircle = pts.every((p) => Math.abs(dist(p, cc.center) - cc.r) <= onTol);
      if (onCircle) {
        if (closed) return { type: "circle", c: cc.center, r: cc.r };
        const arc = arcFrom3(a, mid, b);
        if (arc) return { type: "arc", c: arc.center, r: arc.r, start: arc.start, end: arc.end };
      }
    }
  }

  // Fallback: a smooth spline through the decimated projected points.
  return { type: "spline", points: decimate(pts) };
}
