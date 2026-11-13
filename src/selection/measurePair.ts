// Measuring between two picks — any two of a vertex, an edge and a face, on
// one part or on two (in an assembly, on its placed meshes, so in assembly
// space). Two kinds of number:
//
// - Distance: the true minimum gap between the two picks as tessellated,
//   exact over their triangles and segments (0 where they touch or overlap).
// - What the pair's shapes mean (from frames.ts, the same fits a mate's
//   connectors use): two points' ΔX/ΔY/ΔZ; parallel lines or faces'
//   Parallel distance, else their Angle (0–90°); round features' centre or
//   axis distance; a point's perpendicular distance to a line or a face.
import { edgeShape, faceShape, type ConnectorShape } from "../assembly/frames";
import type { MeshedEdges, MeshedFaces } from "../kernel/types";
import type { FeatureMesh } from "../viewport/types";
import { formatNumber as fmt } from "../lib/format";
import type { Selection } from "./types";

type Vec3 = [number, number, number];
type Tri = [Vec3, Vec3, Vec3];
type Seg = [Vec3, Vec3];

/** One pick, as geometry: what it is, and the primitives it's made of. */
interface Picked {
  noun: "Vertex" | "Edge" | "Face";
  shape: ConnectorShape | null;
  points: Vec3[];
  segments: Seg[];
  triangles: Tri[];
}

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const len = (a: Vec3) => Math.hypot(a[0], a[1], a[2]);
const DEG = 180 / Math.PI;
/** Directions this close (sine of the angle) count as parallel. */
const PARALLEL = 1e-3;
/** Beyond this many primitive pairs the minimum distance is skipped: it runs
 *  on every selection change. */
const MAX_PAIRS = 2_000_000;

/** The pick as geometry, or null when its mesh isn't there. */
function picked(s: Selection, meshes: FeatureMesh[]): Picked | null {
  if (s.kind === "vertex")
    return {
      noun: "Vertex",
      shape: { kind: "point", origin: s.point },
      points: [s.point],
      segments: [],
      triangles: [],
    };
  if (s.kind !== "face" && s.kind !== "edge") return null;
  const m = meshes.find((x) => x.id === s.featureId);
  if (!m) return null;
  if (s.kind === "edge") {
    const segments = chainSegments(m.mesh.edges, s.edgeId);
    return {
      noun: "Edge",
      shape: edgeShape(m.mesh.edges, s.edgeId, m.mesh.faces),
      points: [],
      segments,
      triangles: [],
    };
  }
  return {
    noun: "Face",
    shape: faceShape(m.mesh.faces, s.faceId),
    points: [],
    segments: [],
    triangles: clusterTriangles(m.mesh.faces, s.faceId),
  };
}

/** The segments of an edge's whole chain (a faceted circle's chords). */
function chainSegments(edges: MeshedEdges, edgeId: number): Seg[] {
  const g = edges.edgeGroups?.find((x) => x.edgeId === edgeId);
  if (!g) return [];
  const ids =
    g.chainId === undefined || !edges.edgeGroups
      ? [edgeId]
      : edges.edgeGroups.filter((x) => x.chainId === g.chainId).map((x) => x.edgeId);
  const { lines } = edges;
  const at = (v: number): Vec3 => [lines[v * 3], lines[v * 3 + 1], lines[v * 3 + 2]];
  const out: Seg[] = [];
  for (const id of ids) {
    const eg = edges.edgeGroups!.find((x) => x.edgeId === id);
    if (!eg) continue;
    for (let v = eg.start; v + 1 < eg.start + eg.count; v += 2) out.push([at(v), at(v + 1)]);
  }
  return out;
}

/** The triangles of a face's whole cluster (a faceted wall's facets). */
function clusterTriangles(faces: MeshedFaces, faceId: number): Tri[] {
  const g = faces.faceGroups?.find((x) => x.faceId === faceId);
  if (!g) return [];
  const ids = new Set(
    g.clusterId === undefined || !faces.faceGroups
      ? [faceId]
      : faces.faceGroups.filter((x) => x.clusterId === g.clusterId).map((x) => x.faceId),
  );
  const { vertices: v, triangles: t } = faces;
  const at = (i: number): Vec3 => [v[i * 3], v[i * 3 + 1], v[i * 3 + 2]];
  const out: Tri[] = [];
  for (const fg of faces.faceGroups ?? [])
    if (ids.has(fg.faceId))
      for (let k = fg.start; k + 2 < fg.start + fg.count; k += 3) out.push([at(t[k]), at(t[k + 1]), at(t[k + 2])]);
  return out;
}

// --- Exact distances between primitives ---------------------------------------

/** The point of triangle `t` closest to `p` (Ericson, Real-Time Collision Detection 5.1.5). */
function closestOnTriangle(p: Vec3, [a, b, c]: Tri): Vec3 {
  const ab = sub(b, a),
    ac = sub(c, a),
    ap = sub(p, a);
  const d1 = dot(ab, ap),
    d2 = dot(ac, ap);
  if (d1 <= 0 && d2 <= 0) return a;
  const bp = sub(p, b);
  const d3 = dot(ab, bp),
    d4 = dot(ac, bp);
  if (d3 >= 0 && d4 <= d3) return b;
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) return add(a, scale(ab, d1 / (d1 - d3)));
  const cp = sub(p, c);
  const d5 = dot(ab, cp),
    d6 = dot(ac, cp);
  if (d6 >= 0 && d5 <= d6) return c;
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) return add(a, scale(ac, d2 / (d2 - d6)));
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) return add(b, scale(sub(c, b), (d4 - d3) / (d4 - d3 + (d5 - d6))));
  const denom = 1 / (va + vb + vc);
  return add(a, add(scale(ab, vb * denom), scale(ac, vc * denom)));
}

const pointTriangle = (p: Vec3, t: Tri) => len(sub(p, closestOnTriangle(p, t)));

function pointSegment(p: Vec3, [a, b]: Seg): number {
  const ab = sub(b, a);
  const l2 = dot(ab, ab);
  const t = l2 ? Math.max(0, Math.min(1, dot(sub(p, a), ab) / l2)) : 0;
  return len(sub(p, add(a, scale(ab, t))));
}

/** Distance between two segments (Ericson 5.1.9). */
function segmentSegment([p1, q1]: Seg, [p2, q2]: Seg): number {
  const d1 = sub(q1, p1),
    d2 = sub(q2, p2),
    r = sub(p1, p2);
  const a = dot(d1, d1),
    e = dot(d2, d2),
    f = dot(d2, r);
  let s: number, t: number;
  if (a <= 1e-18 && e <= 1e-18) return len(r);
  if (a <= 1e-18) {
    s = 0;
    t = Math.max(0, Math.min(1, f / e));
  } else {
    const c = dot(d1, r);
    if (e <= 1e-18) {
      t = 0;
      s = Math.max(0, Math.min(1, -c / a));
    } else {
      const b = dot(d1, d2);
      const denom = a * e - b * b;
      s = denom > 1e-18 ? Math.max(0, Math.min(1, (b * f - c * e) / denom)) : 0;
      t = (b * s + f) / e;
      if (t < 0) {
        t = 0;
        s = Math.max(0, Math.min(1, -c / a));
      } else if (t > 1) {
        t = 1;
        s = Math.max(0, Math.min(1, (b - c) / a));
      }
    }
  }
  return len(sub(add(p1, scale(d1, s)), add(p2, scale(d2, t))));
}

/** Whether segment `s` passes through triangle `t` (Möller–Trumbore). */
function segmentCrosses([p, q]: Seg, [a, b, c]: Tri): boolean {
  const d = sub(q, p);
  const e1 = sub(b, a),
    e2 = sub(c, a);
  const h = cross(d, e2);
  const det = dot(e1, h);
  if (Math.abs(det) < 1e-14) return false;
  const f = 1 / det;
  const s = sub(p, a);
  const u = f * dot(s, h);
  if (u < 0 || u > 1) return false;
  const qv = cross(s, e1);
  const v = f * dot(d, qv);
  if (v < 0 || u + v > 1) return false;
  const t = f * dot(e2, qv);
  return t >= 0 && t <= 1;
}

const edgesOf = ([a, b, c]: Tri): Seg[] => [
  [a, b],
  [b, c],
  [c, a],
];

function segmentTriangle(s: Seg, t: Tri): number {
  if (segmentCrosses(s, t)) return 0;
  let best = Math.min(pointTriangle(s[0], t), pointTriangle(s[1], t));
  for (const e of edgesOf(t)) best = Math.min(best, segmentSegment(s, e));
  return best;
}

function triangleTriangle(t: Tri, u: Tri): number {
  let best = Infinity;
  for (const e of edgesOf(t)) best = Math.min(best, segmentTriangle(e, u));
  for (const e of edgesOf(u)) best = Math.min(best, segmentTriangle(e, t));
  return best;
}

/** The minimum distance between two picks, or null when it'd cost too much. */
export function minimumDistance(a: Picked, b: Picked): number | null {
  const size = (p: Picked) => p.points.length + p.segments.length + p.triangles.length;
  if (size(a) * size(b) > MAX_PAIRS) return null;
  let best = Infinity;
  const each = (p: Picked) => [
    ...p.points.map((x) => ({ kind: "p" as const, x })),
    ...p.segments.map((x) => ({ kind: "s" as const, x })),
    ...p.triangles.map((x) => ({ kind: "t" as const, x })),
  ];
  const A = each(a),
    B = each(b);
  for (const x of A)
    for (const y of B) {
      let d: number;
      if (x.kind === "p" && y.kind === "p") d = len(sub(x.x, y.x));
      else if (x.kind === "p" && y.kind === "s") d = pointSegment(x.x, y.x);
      else if (x.kind === "s" && y.kind === "p") d = pointSegment(y.x, x.x);
      else if (x.kind === "p" && y.kind === "t") d = pointTriangle(x.x, y.x);
      else if (x.kind === "t" && y.kind === "p") d = pointTriangle(y.x, x.x);
      else if (x.kind === "s" && y.kind === "s") d = segmentSegment(x.x, y.x);
      else if (x.kind === "s" && y.kind === "t") d = segmentTriangle(x.x, y.x);
      else if (x.kind === "t" && y.kind === "s") d = segmentTriangle(y.x, x.x);
      else d = triangleTriangle(x.x as Tri, y.x as Tri);
      if (d < best) best = d;
      if (best === 0) return 0;
    }
  return Number.isFinite(best) ? best : null;
}

// --- What the shapes mean -------------------------------------------------------

/** A shape's direction, if it has one: a line's, a plane's normal, an axis. */
const direction = (s: ConnectorShape): Vec3 | null =>
  s.kind === "line"
    ? s.dir
    : s.kind === "plane" || s.kind === "circle"
      ? s.normal
      : s.kind === "cylinder"
        ? s.dir
        : null;
/** The angle between two undirected directions, 0–90°. */
const angleBetween = (a: Vec3, b: Vec3) => Math.acos(Math.min(1, Math.abs(dot(a, b)) / (len(a) * len(b)))) * DEG;
const isParallel = (a: Vec3, b: Vec3) => len(cross(a, b)) / (len(a) * len(b)) < PARALLEL;
/** Distance from `p` to the infinite line through `o` along `d`. */
const toLine = (p: Vec3, o: Vec3, d: Vec3) => {
  const w = sub(p, o);
  const u = scale(d, 1 / len(d));
  return len(sub(w, scale(u, dot(w, u))));
};
const toPlane = (p: Vec3, o: Vec3, n: Vec3) => Math.abs(dot(sub(p, o), n)) / len(n);
/** A point on the shape's line or axis, for lines, cylinders and circles. */
const axisPoint = (s: ConnectorShape): Vec3 | null =>
  s.kind === "line" ? s.mid : s.kind === "cylinder" ? s.axisPoint : s.kind === "circle" ? s.center : null;

/** The rows the pair's shapes give, beyond the minimum distance. */
function shapeRows(a: ConnectorShape, b: ConnectorShape): { label: string; value: string }[] {
  const rows: { label: string; value: string }[] = [];
  // Order the pair so each case below reads one way round.
  const rank = { point: 0, circle: 1, line: 2, cylinder: 3, plane: 4 } as const;
  if (rank[a.kind] > rank[b.kind]) [a, b] = [b, a];

  if (a.kind === "point" && b.kind === "point") {
    const d = sub(b.origin, a.origin);
    rows.push({ label: "ΔX", value: fmt(d[0]) }, { label: "ΔY", value: fmt(d[1]) }, { label: "ΔZ", value: fmt(d[2]) });
    return rows;
  }
  if (a.kind === "point") {
    if (b.kind === "circle") rows.push({ label: "To centre", value: fmt(len(sub(a.origin, b.center))) });
    else if (b.kind === "line") rows.push({ label: "To line", value: fmt(toLine(a.origin, b.mid, b.dir)) });
    else if (b.kind === "cylinder") rows.push({ label: "To axis", value: fmt(toLine(a.origin, b.axisPoint, b.dir)) });
    else if (b.kind === "plane") rows.push({ label: "To plane", value: fmt(toPlane(a.origin, b.origin, b.normal)) });
    return rows;
  }
  // Round features: their centres or axes.
  if (a.kind === "circle" && b.kind === "circle")
    rows.push({ label: "Centre distance", value: fmt(len(sub(a.center, b.center))) });
  const da = direction(a),
    db = direction(b);
  if (!da || !db) return rows;
  const axial = (s: ConnectorShape) => s.kind === "cylinder" || s.kind === "circle";
  if (b.kind === "plane") {
    // A line, an axis or a plane against a plane: a line or axis is parallel
    // to the plane when it's square to the normal.
    const lineLike = a.kind !== "plane";
    const parallel = lineLike ? Math.abs(dot(da, db)) / (len(da) * len(db)) < PARALLEL : isParallel(da, db);
    const p = a.kind === "plane" ? a.origin : axisPoint(a);
    if (parallel && p) rows.push({ label: "Parallel distance", value: fmt(toPlane(p, b.origin, b.normal)) });
    else rows.push({ label: "Angle", value: `${fmt(lineLike ? 90 - angleBetween(da, db) : angleBetween(da, db))}°` });
    return rows;
  }
  // Lines and axes against each other.
  const pa = axisPoint(a),
    pb = axisPoint(b);
  if (isParallel(da, db) && pa && pb) {
    const label = axial(a) && axial(b) ? "Axis distance" : "Parallel distance";
    // Two circles in one plane already have their centre distance.
    if (!(a.kind === "circle" && b.kind === "circle")) rows.push({ label, value: fmt(toLine(pb, pa, da)) });
  } else rows.push({ label: "Angle", value: `${fmt(angleBetween(da, db))}°` });
  return rows;
}

/** Measurements between two picks, or null when either isn't a vertex, an
 *  edge or a face whose mesh is there. */
export function measurePair(
  s0: Selection,
  s1: Selection,
  meshes: FeatureMesh[],
): { title: string; rows: { label: string; value: string }[] } | null {
  const a = picked(s0, meshes);
  const b = picked(s1, meshes);
  if (!a || !b) return null;
  const rows: { label: string; value: string }[] = [];
  const d = minimumDistance(a, b);
  if (d !== null) rows.push({ label: "Distance", value: fmt(d) });
  if (a.shape && b.shape) rows.push(...shapeRows(a.shape, b.shape));
  return { title: `${a.noun} ↔ ${b.noun}`, rows };
}
