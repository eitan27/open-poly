// Detects enclosed regions ("sketch faces") of a sketch. Each circle (and any
// self-closed arc/spline) that nothing crosses is its own region; everything
// else is found by treating the sketch as a planar graph and enumerating its
// bounded faces. Line, **arc**, and **spline** entities all act as boundary
// edges, tessellated into polylines for the outline/area and using the curve
// *tangent* (not the chord) for the angular face traversal. Before the graph is
// built, every boundary polyline is **split where it meets another** — at
// T-junctions (an endpoint landing mid-edge) and X-crossings — so the faces
// enumerated are the most granular subregions: a box with interior edge-to-edge
// lines yields each cell as its own selectable region. Outlines are in 2D (uv);
// used both for the clickable fill and for area display. Curved boundaries are
// emitted as fine polylines (the kernel builds faceted faces, same as it
// already does for circles).
import type { SketchEntity, Vec2 } from "./types";
import type { ProfileSegment } from "../kernel/types";
import { sampleArc, sampleCircle, sampleSpline } from "./sketchTools";
import { clamp } from "../lib/clamp";
import { dist2 } from "../lib/vec2";

export interface SketchRegion {
  id: string;
  outline: Vec2[]; // closed loop of uv points (curves tessellated)
  area: number;
  /** Closed inner loops (uv, curves tessellated) carved out of this region — a
   *  free-floating loop entirely inside another face reads as a hole, so the
   *  outer face is the frame/annulus and the inner loop is its own region. Empty
   *  or absent when the region is simply connected (the common case). */
  holes?: Vec2[][];
  /** Ids of the sketch entities (lines/arcs/splines/circle) that bound this
   *  region, so a selection of those entities can stand in for a direct pick of
   *  the region (see `regionsEnclosedBy`). */
  entityIds: string[];
}

// Round to 4dp for vertex identity, normalizing "-0.0000" → "0.0000" so a tiny
// negative coordinate (e.g. an arc endpoint that the solver places at ~0 with a
// sub-epsilon negative sign) still matches a point at exactly 0. Without this, a
// loop closing at the origin can fail to enclose. */
const coord = (v: number) => {
  const s = v.toFixed(4);
  return s === "-0.0000" ? "0.0000" : s;
};
const key = (p: Vec2) => `${coord(p[0])},${coord(p[1])}`;

/** Even-odd point-in-polygon test (ray cast). Boundary cases are irrelevant
 *  here — we only ever test a point taken from strictly inside another face. */
function pointInPoly(p: Vec2, poly: Vec2[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const yi = poly[i][1], yj = poly[j][1];
    if ((yi > p[1]) !== (yj > p[1])) {
      const x = poly[i][0] + ((p[1] - yi) / (yj - yi)) * (poly[j][0] - poly[i][0]);
      if (p[0] < x) inside = !inside;
    }
  }
  return inside;
}

/** A point guaranteed strictly inside a simple polygon: scan a horizontal line
 *  through the vertical mid-height and take the midpoint of the widest interior
 *  span. Robust for non-convex faces (an L-shaped cell) where the centroid can
 *  fall outside; falls back to the centroid only if the scan finds no span. */
function interiorPoint(poly: Vec2[]): Vec2 {
  let minY = Infinity, maxY = -Infinity;
  for (const p of poly) { if (p[1] < minY) minY = p[1]; if (p[1] > maxY) maxY = p[1]; }
  const y = (minY + maxY) / 2;
  const xs: number[] = [];
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const yi = poly[i][1], yj = poly[j][1];
    if ((yi > y) !== (yj > y)) xs.push(poly[i][0] + ((y - yi) / (yj - yi)) * (poly[j][0] - poly[i][0]));
  }
  xs.sort((a, b) => a - b);
  let bestMid = 0, bestW = -1;
  for (let i = 0; i + 1 < xs.length; i += 2) {
    const w = xs[i + 1] - xs[i];
    if (w > bestW) { bestW = w; bestMid = (xs[i] + xs[i + 1]) / 2; }
  }
  if (bestW >= 0) return [bestMid, y];
  let cx = 0, cy = 0;
  for (const p of poly) { cx += p[0]; cy += p[1]; }
  return [cx / poly.length, cy / poly.length];
}

/** Signed area (CCW positive) via the shoelace formula. */
function signedArea(pts: Vec2[]): number {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const j = (i + 1) % pts.length;
    a += pts[i][0] * pts[j][1] - pts[j][0] * pts[i][1];
  }
  return a / 2;
}

/** The two endpoints + a tessellated polyline (endpoint→endpoint) of a boundary
 *  entity. Lines are their own two points; arcs/splines are sampled. Returns null
 *  for non-boundary entities (circles are handled separately; points ignored). */
function entityBoundary(e: SketchEntity): { poly: Vec2[] } | null {
  if (e.type === "line") return { poly: [e.a, e.b] };
  if (e.type === "arc") return { poly: sampleArc(e.c, e.r, e.start, e.end) };
  if (e.type === "spline") {
    const poly = sampleSpline(e.points);
    return poly.length >= 2 ? { poly } : null;
  }
  return null;
}

/** Direction (radians) the polyline leaves its first point — the curve tangent
 *  at the `from` endpoint, used to order edges around a vertex. */
const leaveAngle = (poly: Vec2[]) => Math.atan2(poly[1][1] - poly[0][1], poly[1][0] - poly[0][0]);

// Coordinates within EPS are the same point (matches the 4dp `coord` rounding).
const EPS = 1e-4;

/** Intersection of segments p1→p2 and q1→q2, endpoints inclusive (within EPS),
 *  parallel/collinear pairs excluded. Returns the point + both segment params. */
function segIntersect(p1: Vec2, p2: Vec2, q1: Vec2, q2: Vec2): { point: Vec2; t: number; u: number } | null {
  const rx = p2[0] - p1[0], ry = p2[1] - p1[1];
  const sx = q2[0] - q1[0], sy = q2[1] - q1[1];
  const lenR = Math.hypot(rx, ry), lenS = Math.hypot(sx, sy);
  if (lenR < 1e-12 || lenS < 1e-12) return null;
  const denom = rx * sy - ry * sx;
  if (Math.abs(denom) < 1e-12 * lenR * lenS) return null;
  const qpx = q1[0] - p1[0], qpy = q1[1] - p1[1];
  let t = (qpx * sy - qpy * sx) / denom;
  let u = (qpx * ry - qpy * rx) / denom;
  if (t < -EPS / lenR || t > 1 + EPS / lenR || u < -EPS / lenS || u > 1 + EPS / lenS) return null;
  t = clamp(t, 0, 1);
  u = clamp(u, 0, 1);
  return { point: [p1[0] + t * rx, p1[1] + t * ry], t, u };
}

/** A boundary entity flattened to a polyline. `closed` marks circles and
 *  self-closed curves (poly[0] === poly[last]). `cuts` collects the parameter
 *  positions (segment index + fraction, i.e. param `i` is vertex `i`) where
 *  another entity touches or crosses this one. */
interface BoundaryPoly { entityId: string; poly: Vec2[]; closed: boolean; cuts: { t: number; p: Vec2 }[] }

/** The sub-polyline from param `ta` to `tb` (ta < tb), using the exact cut
 *  points at the ends so both sides of a split share identical coordinates. */
function polySlice(poly: Vec2[], ta: number, pa: Vec2, tb: number, pb: Vec2): Vec2[] {
  const pts: Vec2[] = [pa];
  for (let i = Math.floor(ta) + 1; i <= Math.min(Math.floor(tb), poly.length - 1); i++) {
    if (i > ta + 1e-9 && i < tb - 1e-9) pts.push(poly[i]);
  }
  pts.push(pb);
  return pts;
}

export function detectSketchRegions(entities: SketchEntity[]): SketchRegion[] {
  const regions: SketchRegion[] = [];

  // Construction geometry is reference-only — never a profile boundary.
  entities = entities.filter((e) => !e.construction);

  // Flatten every boundary entity to a polyline. Circles join the pool too so a
  // curve crossing a circle splits it into selectable sub-regions; an uncrossed
  // circle falls out below as one disk region. Sampled canonically, like every
  // other circle — a region's outline becomes an extruded wall, and that wall has
  // to coincide with any other wall built from the same circle.
  const polys: BoundaryPoly[] = [];
  for (const e of entities) {
    if (e.type === "circle") {
      polys.push({ entityId: e.id, poly: sampleCircle(e.c, e.r), closed: true, cuts: [] });
      continue;
    }
    const bd = entityBoundary(e);
    if (!bd || bd.poly.length < 2) continue;
    const closed = key(bd.poly[0]) === key(bd.poly[bd.poly.length - 1]);
    polys.push({ entityId: e.id, poly: bd.poly, closed, cuts: [] });
  }

  // Find every place two boundary polylines touch or cross (T-junctions and
  // X-crossings) and record a cut on each side. Cuts at an open polyline's own
  // endpoints are dropped — those are already graph vertices. Bounding-box
  // rejection (per polyline pair, then per segment pair) keeps the quadratic
  // sweep cheap on curve-heavy sketches.
  const bbox = polys.map((bp) => {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const p of bp.poly) {
      if (p[0] < x0) x0 = p[0];
      if (p[0] > x1) x1 = p[0];
      if (p[1] < y0) y0 = p[1];
      if (p[1] > y1) y1 = p[1];
    }
    return { x0, y0, x1, y1 };
  });
  for (let i = 0; i < polys.length; i++) {
    for (let j = i + 1; j < polys.length; j++) {
      const P = polys[i], Q = polys[j];
      const bi = bbox[i], bj = bbox[j];
      if (bi.x1 + EPS < bj.x0 || bj.x1 + EPS < bi.x0 || bi.y1 + EPS < bj.y0 || bj.y1 + EPS < bi.y0) continue;
      for (let a = 0; a < P.poly.length - 1; a++) {
        const p1 = P.poly[a], p2 = P.poly[a + 1];
        const ax0 = Math.min(p1[0], p2[0]) - EPS, ax1 = Math.max(p1[0], p2[0]) + EPS;
        const ay0 = Math.min(p1[1], p2[1]) - EPS, ay1 = Math.max(p1[1], p2[1]) + EPS;
        for (let b = 0; b < Q.poly.length - 1; b++) {
          const q1 = Q.poly[b], q2 = Q.poly[b + 1];
          if (Math.max(q1[0], q2[0]) < ax0 || Math.min(q1[0], q2[0]) > ax1) continue;
          if (Math.max(q1[1], q2[1]) < ay0 || Math.min(q1[1], q2[1]) > ay1) continue;
          const hit = segIntersect(p1, p2, q1, q2);
          if (!hit) continue;
          P.cuts.push({ t: a + hit.t, p: hit.point });
          Q.cuts.push({ t: b + hit.u, p: hit.point });
        }
      }
    }
  }

  // Planar-graph face enumeration over the (split) boundary pieces: each piece
  // becomes two directed half-edges (twin(i) === i ^ 1), and each directed
  // half-edge belongs to exactly one face. This (unlike a greedy loop tracer)
  // lets a single edge bound two adjacent regions.
  const nodeIndex = new Map<string, number>();
  const nodePos: Vec2[] = [];
  const node = (p: Vec2): number => {
    const k = key(p);
    let i = nodeIndex.get(k);
    if (i === undefined) {
      i = nodePos.length;
      nodeIndex.set(k, i);
      nodePos.push(p);
    }
    return i;
  };

  interface HalfEdge { from: number; to: number; entityId: string; angle: number; poly: Vec2[] }
  const he: HalfEdge[] = [];
  // Collapse exact-duplicate edges (same endpoints AND same mid-point) so a
  // shared edge drawn twice doesn't corrupt the angular traversal — while still
  // keeping two *distinct* curves between the same endpoints (a lens) apart.
  const seenEdge = new Set<string>();

  // Split each polyline at its cuts into graph-edge pieces.
  const pieces: { entityId: string; poly: Vec2[] }[] = [];
  for (const bp of polys) {
    const startKey = key(bp.poly[0]);
    const endKey = key(bp.poly[bp.poly.length - 1]);
    // Sort, then dedupe by rounded point (a crossing at a closed poly's seam
    // registers at both t≈0 and t≈N — one cut, not two) and — for open
    // polylines — drop cuts that coincide with the polyline's own endpoints.
    const seenCut = new Set<string>();
    const cuts = bp.cuts
      .filter((c) => bp.closed || (key(c.p) !== startKey && key(c.p) !== endKey))
      .sort((x, y) => x.t - y.t)
      .filter((c) => {
        const k = key(c.p);
        if (seenCut.has(k)) return false;
        seenCut.add(k);
        return true;
      });

    if (bp.closed && cuts.length < 2) {
      // Nothing splits this closed curve (a lone touch point can't) → it is its
      // own region: a disk for circles, the enclosed loop for self-closed curves.
      const ring = bp.poly.slice(0, -1);
      const e = entities.find((x) => x.id === bp.entityId);
      if (e?.type === "circle") {
        regions.push({ id: `region-${e.id}`, outline: ring, area: Math.PI * e.r * e.r, entityIds: [e.id] });
      } else {
        const ar = signedArea(ring);
        if (ring.length >= 3 && Math.abs(ar) > 1e-7) {
          regions.push({
            id: `region-${bp.entityId}`,
            outline: ar >= 0 ? ring : [...ring].reverse(),
            area: Math.abs(ar),
            entityIds: [bp.entityId],
          });
        }
      }
      continue;
    }

    const N = bp.poly.length - 1;
    if (bp.closed) {
      // Pieces between consecutive cuts, plus the wrap-around piece (the poly's
      // coincident first/last point makes plain concatenation correct).
      for (let c = 0; c < cuts.length; c++) {
        const cur = cuts[c];
        const nxt = cuts[(c + 1) % cuts.length];
        const poly =
          c < cuts.length - 1
            ? polySlice(bp.poly, cur.t, cur.p, nxt.t, nxt.p)
            : [...polySlice(bp.poly, cur.t, cur.p, N, bp.poly[N]), ...polySlice(bp.poly, 0, bp.poly[0], nxt.t, nxt.p).slice(1)];
        pieces.push({ entityId: bp.entityId, poly });
      }
    } else {
      const bounds = [{ t: 0, p: bp.poly[0] }, ...cuts, { t: N, p: bp.poly[N] }];
      for (let c = 0; c < bounds.length - 1; c++) {
        pieces.push({ entityId: bp.entityId, poly: polySlice(bp.poly, bounds[c].t, bounds[c].p, bounds[c + 1].t, bounds[c + 1].p) });
      }
    }
  }

  for (const piece of pieces) {
    const poly = piece.poly;
    if (poly.length < 2) continue;
    const a = poly[0];
    const b = poly[poly.length - 1];
    const an = node(a);
    const bn = node(b);
    if (an === bn) continue; // endpoints rounded to the same vertex — degenerate
    // Direction-independent edge signature: endpoints (unordered) + polyline
    // centroid. The centroid is the same whichever way the edge was drawn (so a
    // duplicate collapses) yet differs for two distinct curves between the same
    // endpoints (so a lens is kept).
    let cx = 0, cy = 0;
    for (const p of poly) { cx += p[0]; cy += p[1]; }
    const mid = key([cx / poly.length, cy / poly.length]);
    const ka = key(a), kb = key(b);
    const ek = (ka < kb ? `${ka}:${kb}` : `${kb}:${ka}`) + `:${mid}`;
    if (seenEdge.has(ek)) continue;
    seenEdge.add(ek);

    const rev = [...poly].reverse();
    he.push({ from: an, to: bn, entityId: piece.entityId, angle: leaveAngle(poly), poly });
    he.push({ from: bn, to: an, entityId: piece.entityId, angle: leaveAngle(rev), poly: rev });
  }

  // Outgoing half-edges per vertex, sorted CCW by leave-angle.
  const outgoing: number[][] = nodePos.map(() => []);
  he.forEach((e, i) => outgoing[e.from].push(i));
  for (const list of outgoing) list.sort((p, q) => he[p].angle - he[q].angle);

  // next(e): arriving at e.to, turn to the most-clockwise next edge — i.e. the
  // half-edge just before the reverse edge (twin) in CCW order around e.to.
  const next = (i: number): number => {
    const twin = i ^ 1;
    const list = outgoing[he[i].to];
    const pos = list.indexOf(twin);
    return list[(pos - 1 + list.length) % list.length];
  };

  const visited = new Array<boolean>(he.length).fill(false);
  for (let s = 0; s < he.length; s++) {
    if (visited[s]) continue;
    const loop: Vec2[] = [];
    const entityIds = new Set<string>();
    let cur = s;
    for (let guard = 0; guard <= he.length; guard++) {
      if (visited[cur]) break;
      visited[cur] = true;
      // Append this edge's geometry (its `from` point + any curve interior),
      // dropping the last point so the next edge's `from` isn't duplicated.
      loop.push(...he[cur].poly.slice(0, -1));
      entityIds.add(he[cur].entityId);
      cur = next(cur);
      if (cur === s) break;
    }
    // Bounded faces come out CCW (positive signed area); the single outer face
    // comes out CW (negative) and is discarded. Slivers/danglers are ~0.
    const a = signedArea(loop);
    if (loop.length >= 3 && a > 1e-7) {
      const id = `region-loop-${[...entityIds].sort().join("_")}`;
      regions.push({ id, outline: loop, area: a, entityIds: [...entityIds] });
    }
  }

  // Distinct subregions can share a bounding-entity set (e.g. the 4 quadrants
  // of a circle crossed by two lines). Ids must be unique — and stable across
  // rebuilds, since features persist them — so colliding ids get an ordinal by
  // centroid order (x, then y). Non-colliding ids (the common case, and every
  // pre-existing document) are untouched.
  const byId = new Map<string, SketchRegion[]>();
  for (const r of regions) {
    const list = byId.get(r.id);
    if (list) list.push(r);
    else byId.set(r.id, [r]);
  }
  for (const group of byId.values()) {
    if (group.length < 2) continue;
    const centroid = (r: SketchRegion): Vec2 => {
      let x = 0, y = 0;
      for (const p of r.outline) { x += p[0]; y += p[1]; }
      return [x / r.outline.length, y / r.outline.length];
    };
    group
      .map((r) => ({ r, c: centroid(r) }))
      .sort((p, q) => p.c[0] - q.c[0] || p.c[1] - q.c[1])
      .forEach(({ r }, k) => { r.id = `${r.id}~${k}`; });
  }

  // Island nesting → holes. Adjacent cells of a connected sketch come out as
  // siblings (no containment), but a free-floating loop wholly inside another
  // face is a separate connected component the planar graph can't tie together.
  // Detect it geometrically: each region whose interior point lies inside a
  // larger region's outline becomes a hole of the SMALLEST such region, so a
  // box with an inner loop reads as an annulus + the inner face. Faces don't
  // overlap, so a single interior-point test is decisive.
  if (regions.length > 1) {
    const rep = regions.map((r) => interiorPoint(r.outline));
    const origArea = regions.map((r) => r.area);
    const parent = regions.map((_r, i) => {
      let best = -1, bestArea = Infinity;
      for (let j = 0; j < regions.length; j++) {
        if (j === i || origArea[j] <= origArea[i]) continue;
        if (pointInPoly(rep[i], regions[j].outline) && origArea[j] < bestArea) {
          bestArea = origArea[j];
          best = j;
        }
      }
      return best;
    });
    for (let i = 0; i < regions.length; i++) {
      const p = parent[i];
      if (p < 0) continue;
      (regions[p].holes ??= []).push(regions[i].outline);
      regions[p].area -= origArea[i]; // subtract from the ORIGINAL area (holes nest)
    }
  }

  return regions;
}

/** Rebuild a region's boundary as an ordered, oriented list of exact curve
 *  segments (lines + arcs), so a sweep/loft profile is a TRUE circle/arc rather
 *  than the faceted `outline` polyline. Returns `undefined` when the boundary
 *  can't be expressed exactly (e.g. it contains a spline, an entity is missing,
 *  or the edges don't chain into a single closed loop) — callers fall back to
 *  the polyline. A lone circle becomes two half-arcs (a full circle can't be one
 *  three-point arc). */
export function regionProfileSegments(
  region: SketchRegion,
  entities: SketchEntity[],
): { start: Vec2; segments: ProfileSegment[] } | undefined {
  const byId = new Map(entities.map((e) => [e.id, e]));
  const ents = region.entityIds.map((id) => byId.get(id));
  if (ents.some((e) => !e)) return undefined;
  const found = ents as SketchEntity[];

  // A lone circle: two half-arcs through the top and bottom of the circle.
  if (found.length === 1 && found[0].type === "circle") {
    const { c, r } = found[0];
    return {
      start: [c[0] + r, c[1]],
      segments: [
        { kind: "arc", mid: [c[0], c[1] + r], to: [c[0] - r, c[1]] },
        { kind: "arc", mid: [c[0], c[1] - r], to: [c[0] + r, c[1]] },
      ],
    };
  }

  // Line/arc loops: collect each edge's endpoints (and an on-curve mid for arcs),
  // then chain them end-to-end into one closed loop.
  type Edge = { from: Vec2; to: Vec2; mid?: Vec2 };
  const edges: Edge[] = [];
  for (const e of found) {
    if (e.type === "line") edges.push({ from: e.a, to: e.b });
    else if (e.type === "arc") {
      let sweep = e.end - e.start;
      while (sweep <= 0) sweep += 2 * Math.PI; // arcs run CCW from start to end
      const at = (t: number): Vec2 => [e.c[0] + e.r * Math.cos(t), e.c[1] + e.r * Math.sin(t)];
      edges.push({ from: at(e.start), to: at(e.end), mid: at(e.start + sweep / 2) });
    } else return undefined; // spline/point → not exactly expressible here
  }

  const eps = 1e-4;
  const eq = (p: Vec2, q: Vec2) => dist2(p, q) < eps;
  const used = new Array(edges.length).fill(false);
  used[0] = true;
  const start = edges[0].from;
  const chain: Edge[] = [edges[0]];
  let cur = edges[0].to;
  for (let n = 1; n < edges.length; n++) {
    let next: Edge | undefined;
    for (let i = 0; i < edges.length; i++) {
      if (used[i]) continue;
      if (eq(edges[i].from, cur)) { used[i] = true; next = edges[i]; break; }
      if (eq(edges[i].to, cur)) { used[i] = true; next = { from: edges[i].to, to: edges[i].from, mid: edges[i].mid }; break; }
    }
    if (!next) return undefined; // a gap → not a single chain
    chain.push(next);
    cur = next.to;
  }
  if (!eq(cur, start)) return undefined; // not closed

  return {
    start,
    segments: chain.map((e) => (e.mid ? { kind: "arc", mid: e.mid, to: e.to } : { kind: "line", to: e.to })),
  };
}

/** The regions (from `detectSketchRegions`) entirely bounded by `entityIds` —
 *  i.e. enclosed by a selected set of sketch edges. Lets selecting the edges
 *  around a loop stand in for clicking the (possibly tiny) face itself, which
 *  is fiddly in a small sketch. Extra selected entities beyond a region's
 *  boundary don't disqualify it; missing ones do. */
export function regionsEnclosedBy(entities: SketchEntity[], entityIds: ReadonlySet<string>): SketchRegion[] {
  if (entityIds.size === 0) return [];
  return detectSketchRegions(entities).filter((r) => r.entityIds.every((id) => entityIds.has(id)));
}
