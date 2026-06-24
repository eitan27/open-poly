// Detects enclosed regions ("sketch faces") of a sketch. Each circle (and any
// self-closed arc/spline) is its own region; everything else is found by treating
// the sketch as a planar graph and enumerating its bounded faces. Line, **arc**,
// and **spline** entities all act as boundary edges — a curve is one graph edge
// between its two endpoints, tessellated into a polyline for the outline/area and
// using its *tangent* (not its chord) for the angular face traversal. Outlines are
// in 2D (uv); used both for the clickable fill and for area display. Curved
// boundaries are emitted as fine polylines (the kernel builds faceted faces, same
// as it already does for circles).
import type { SketchEntity, Vec2 } from "./types";
import { sampleArc, sampleSpline } from "./sketchTools";

export interface SketchRegion {
  id: string;
  outline: Vec2[]; // closed loop of uv points (curves tessellated)
  area: number;
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

export function detectSketchRegions(entities: SketchEntity[]): SketchRegion[] {
  const regions: SketchRegion[] = [];

  // Construction geometry is reference-only — never a profile boundary.
  entities = entities.filter((e) => !e.construction);

  // Circles are closed by themselves → one disk region each.
  for (const e of entities) {
    if (e.type !== "circle") continue;
    const outline: Vec2[] = [];
    const SEG = 48;
    for (let i = 0; i < SEG; i++) {
      const t = (2 * Math.PI * i) / SEG;
      outline.push([e.c[0] + e.r * Math.cos(t), e.c[1] + e.r * Math.sin(t)]);
    }
    regions.push({ id: `region-${e.id}`, outline, area: Math.PI * e.r * e.r, entityIds: [e.id] });
  }

  // Planar-graph face enumeration over line/arc/spline boundary entities: each
  // entity becomes two directed half-edges (twin(i) === i ^ 1), and each directed
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

  for (const e of entities) {
    const bd = entityBoundary(e);
    if (!bd) continue;
    const poly = bd.poly;
    const a = poly[0];
    const b = poly[poly.length - 1];

    // A self-closed curve (endpoints coincide) is its own region, like a circle.
    if (key(a) === key(b)) {
      const ar = signedArea(poly);
      if (poly.length >= 4 && Math.abs(ar) > 1e-7) {
        regions.push({
          id: `region-${e.id}`,
          outline: ar >= 0 ? poly.slice(0, -1) : poly.slice(0, -1).reverse(),
          area: Math.abs(ar),
          entityIds: [e.id],
        });
      }
      continue;
    }

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
    he.push({ from: an, to: bn, entityId: e.id, angle: leaveAngle(poly), poly });
    he.push({ from: bn, to: an, entityId: e.id, angle: leaveAngle(rev), poly: rev });
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

  return regions;
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
