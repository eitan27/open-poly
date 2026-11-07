// Mate connector frames, read off a part's saved mesh — no kernel.
//
// Every mate joins two frames (Onshape's model): a point plus a Z direction,
// with X fixed deterministically so the result doesn't flip between rebuilds.
// They come from the tessellation, not OCCT, for two reasons. Nearly every round
// wall here is a faceted prism (a 96-gon cylinder, an extruded circle), so the
// kernel has no analytic cylinder to report for the surfaces people actually
// mate — the axis has to be fitted to the facets anyway. And a part's cached
// build is all an assembly ever loads, so frames work on meshes saved before
// assemblies existed, with no rebuild.
//
// A connector is stored by the face/edge's persistent name plus a geometric
// fingerprint (its centre, and normal for a plane) to re-find it when an edit
// renames it — the same contract as a dress-up's edge refs.
import type { MeshedEdges, MeshedFaces, ShapeMeshPayload } from "../kernel/types";
import type { Mat4 } from "./types";
import { meshBounds, type Vec3 } from "./placement";

/** A frame in PART coordinates: origin plus orthonormal X and Z (Y = Z × X). */
export interface Frame {
  origin: Vec3;
  x: Vec3;
  z: Vec3;
}

/** Which inferred frame on an entity: a cylinder's axis has three (middle and
 *  either end); everything else only "center". */
export type Anchor = "center" | "start" | "end";

export interface ConnectorRef {
  kind: "face" | "edge";
  name: string;
  /** Fingerprint at pick time, in part coordinates. */
  center?: Vec3;
  normal?: Vec3;
}

/** What an entity is, as far as mating goes. */
export type ConnectorShape =
  | { kind: "plane"; origin: Vec3; normal: Vec3 }
  | { kind: "cylinder"; axisPoint: Vec3; dir: Vec3; radius: number; tMin: number; tMax: number }
  | { kind: "circle"; center: Vec3; normal: Vec3; radius: number }
  | { kind: "line"; mid: Vec3; dir: Vec3 };

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
const unit = (a: Vec3): Vec3 => {
  const n = len(a);
  return n > 1e-12 ? [a[0] / n, a[1] / n, a[2] / n] : [0, 0, 0];
};

/** A direction's sign made canonical (largest component positive), so an axis
 *  fitted from facets reads the same however the facets were ordered. */
function canonical(d: Vec3): Vec3 {
  let k = 0;
  for (let i = 1; i < 3; i++) if (Math.abs(d[i]) > Math.abs(d[k])) k = i;
  return d[k] < 0 ? scale(d, -1) : d;
}

/** A unit X perpendicular to `z`: world X projected onto the plane, or world Y
 *  when Z is (nearly) along X. Part coordinates are the part's own, so this is
 *  stable across rebuilds and placements. */
export function defaultX(z: Vec3): Vec3 {
  const ref: Vec3 = Math.abs(z[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  return unit(sub(ref, scale(z, dot(ref, z))));
}

/** The 4×4 (column-major) taking frame coordinates to part coordinates. */
export function frameMatrix(f: Frame): Mat4 {
  const y = cross(f.z, f.x);
  return [f.x[0], f.x[1], f.x[2], 0, y[0], y[1], y[2], 0, f.z[0], f.z[1], f.z[2], 0, ...f.origin, 1];
}

/** Least-squares circle through 2D points (Kåsa): centre and radius, or null
 *  when the points don't lie on one (`tol` is relative to the radius). */
function fitCircle2(pts: [number, number][], tol: number): { c: [number, number]; r: number } | null {
  if (pts.length < 3) return null;
  // Centre the data first: the normal equations are badly conditioned far from
  // the origin (a part modelled at x = 500 mm).
  let mx = 0,
    my = 0;
  for (const [x, y] of pts) {
    mx += x;
    my += y;
  }
  mx /= pts.length;
  my /= pts.length;
  // Solve [Σxx Σxy Σx; Σxy Σyy Σy; Σx Σy n] [a b c]ᵀ = [-Σx(x²+y²) …] for
  // x² + y² + ax + by + c = 0.
  let sxx = 0,
    sxy = 0,
    syy = 0,
    sx = 0,
    sy = 0,
    sxz = 0,
    syz = 0,
    sz = 0;
  for (const [px, py] of pts) {
    const x = px - mx,
      y = py - my,
      z = x * x + y * y;
    sxx += x * x;
    sxy += x * y;
    syy += y * y;
    sx += x;
    sy += y;
    sxz += x * z;
    syz += y * z;
    sz += z;
  }
  const n = pts.length;
  const m = [
    [sxx, sxy, sx],
    [sxy, syy, sy],
    [sx, sy, n],
  ];
  const rhs = [-sxz, -syz, -sz];
  const sol = solve3(m, rhs);
  if (!sol) return null;
  const [a, b, c] = sol;
  const cx = -a / 2,
    cy = -b / 2;
  const r2 = cx * cx + cy * cy - c;
  if (!(r2 > 0)) return null;
  const r = Math.sqrt(r2);
  for (const [px, py] of pts) {
    if (Math.abs(Math.hypot(px - mx - cx, py - my - cy) - r) > tol * r + 1e-6) return null;
  }
  return { c: [cx + mx, cy + my], r };
}

function solve3(m: number[][], b: number[]): number[] | null {
  const det = (q: number[][]) =>
    q[0][0] * (q[1][1] * q[2][2] - q[1][2] * q[2][1]) -
    q[0][1] * (q[1][0] * q[2][2] - q[1][2] * q[2][0]) +
    q[0][2] * (q[1][0] * q[2][1] - q[1][1] * q[2][0]);
  const d = det(m);
  if (Math.abs(d) < 1e-18) return null;
  return [0, 1, 2].map((k) => det(m.map((row, i) => row.map((v, j) => (j === k ? b[i] : v)))) / d);
}

/** Distinct points (µm grid) — a tessellation repeats every shared vertex. */
function distinct(points: Vec3[]): Vec3[] {
  const seen = new Map<string, Vec3>();
  for (const p of points) seen.set(`${Math.round(p[0] * 1e3)},${Math.round(p[1] * 1e3)},${Math.round(p[2] * 1e3)}`, p);
  return [...seen.values()];
}

/** A circle through 3D points (a rim's chord vertices — closed ring or arc). */
function fitCircle3(points: Vec3[]): { center: Vec3; normal: Vec3; radius: number } | null {
  const pts = distinct(points);
  if (pts.length < 4) return null;
  const o = pts[0];
  // The plane: the most independent pair of spokes from the first point.
  let normal: Vec3 = [0, 0, 0];
  let best = 0;
  for (let i = 1; i < pts.length; i++)
    for (let j = i + 1; j < pts.length; j += Math.max(1, Math.floor(pts.length / 16))) {
      const c = cross(sub(pts[i], o), sub(pts[j], o));
      if (len(c) > best) {
        best = len(c);
        normal = c;
      }
    }
  normal = unit(normal);
  if (len(normal) < 0.5) return null; // collinear: a straight edge
  const u = defaultX(normal);
  const v = cross(normal, u);
  let size = 0;
  for (const p of pts) size = Math.max(size, len(sub(p, o)));
  for (const p of pts) if (Math.abs(dot(sub(p, o), normal)) > 1e-4 * size + 1e-6) return null; // not planar
  const fit = fitCircle2(
    pts.map((p) => [dot(p, u), dot(p, v)]),
    2e-3,
  );
  if (!fit) return null;
  const h = dot(o, normal);
  return { center: add(add(scale(u, fit.c[0]), scale(v, fit.c[1])), scale(normal, h)), normal, radius: fit.r };
}

function faceGroup(faces: MeshedFaces, faceId: number) {
  return faces.faceGroups?.find((g) => g.faceId === faceId);
}

/** The faces of the logical surface a face belongs to (a faceted cylinder's
 *  facets share a cluster). */
function clusterOf(faces: MeshedFaces, faceId: number): number[] {
  const g = faceGroup(faces, faceId);
  if (g?.clusterId === undefined || !faces.faceGroups) return [faceId];
  return faces.faceGroups.filter((x) => x.clusterId === g.clusterId).map((x) => x.faceId);
}

interface Tri {
  p: [Vec3, Vec3, Vec3];
  n: Vec3;
  area: number;
}

function trianglesOf(faces: MeshedFaces, faceIds: number[]): Tri[] {
  const { vertices: v, triangles: t } = faces;
  const at = (i: number): Vec3 => [v[i * 3], v[i * 3 + 1], v[i * 3 + 2]];
  const out: Tri[] = [];
  for (const id of faceIds) {
    const g = faceGroup(faces, id);
    if (!g) continue;
    for (let k = g.start; k + 2 < g.start + g.count; k += 3) {
      const p: [Vec3, Vec3, Vec3] = [at(t[k]), at(t[k + 1]), at(t[k + 2])];
      const c = cross(sub(p[1], p[0]), sub(p[2], p[0]));
      const a = len(c) / 2;
      if (a > 1e-12) out.push({ p, n: unit(c), area: a });
    }
  }
  return out;
}

/** What a face is for mating: a plane (centroid + outward normal) or a
 *  cylinder (axis fitted to its facets), else null — a sphere, a fillet blend
 *  round a corner, a freeform loft can't anchor a mate yet. */
export function faceShape(faces: MeshedFaces, faceId: number): ConnectorShape | null {
  const own = trianglesOf(faces, [faceId]);
  if (own.length === 0) return null;
  let area = 0;
  let nSum: Vec3 = [0, 0, 0];
  let cSum: Vec3 = [0, 0, 0];
  for (const t of own) {
    area += t.area;
    nSum = add(nSum, scale(t.n, t.area));
    cSum = add(cSum, scale(add(add(t.p[0], t.p[1]), t.p[2]), t.area / 3));
  }
  const normal = unit(nSum);
  const planar = own.every((t) => dot(t.n, normal) > 0.99996); // within ~0.5°
  const plane: ConnectorShape = { kind: "plane", origin: scale(cSum, 1 / area), normal };
  const cluster = clusterOf(faces, faceId);
  if (cluster.length === 1) return planar ? plane : cylinderOf(own);
  // A facet of a round wall is flat but means the wall's axis, so a cluster is
  // tried as a cylinder first. A cluster can also take in flat faces a fillet
  // or a slot's round end runs tangent into; then the whole won't fit one
  // circle, and the round part is grown out from the picked facet instead.
  const whole = cylinderOf(trianglesOf(faces, cluster));
  if (whole) return whole;
  // Only a narrow facet can stand for a wall: a flat face the blend runs off
  // (a filleted box's top) can fit a circle with a few facets beside it, but it
  // spans a wide arc of it, and means its own plane.
  const grown = growCylinder(faces, faceId, cluster);
  if (grown && arcSpan(own, grown) < (20 * Math.PI) / 180) return grown;
  return planar ? plane : null;
}

/** The angle a face's points span around a cylinder's axis. */
function arcSpan(tris: Tri[], cyl: ConnectorShape): number {
  if (cyl.kind !== "cylinder") return Infinity;
  const u = defaultX(cyl.dir);
  const v = cross(cyl.dir, u);
  const angles = tris
    .flatMap((t) => t.p)
    .map((p) => {
      const w = sub(p, cyl.axisPoint);
      return Math.atan2(dot(w, v), dot(w, u));
    });
  // Smallest arc holding every angle: 2π minus the widest gap between them.
  angles.sort((a, b) => a - b);
  let gap = angles[0] + 2 * Math.PI - angles[angles.length - 1];
  for (let i = 1; i < angles.length; i++) gap = Math.max(gap, angles[i] - angles[i - 1]);
  return 2 * Math.PI - gap;
}

/** The cylinder made by the picked facet and the cluster faces reachable from
 *  it (sharing a vertex) that keep fitting one circle, or null. */
function growCylinder(faces: MeshedFaces, faceId: number, cluster: number[]): ConnectorShape | null {
  if (cluster.length > 400) return null;
  const keysOf = new Map<number, Set<string>>();
  for (const id of cluster) {
    const ks = new Set<string>();
    for (const t of trianglesOf(faces, [id]))
      for (const p of t.p) ks.add(`${Math.round(p[0] * 1e3)},${Math.round(p[1] * 1e3)},${Math.round(p[2] * 1e3)}`);
    keysOf.set(id, ks);
  }
  const touches = (a: number, b: number) => {
    const kb = keysOf.get(b)!;
    for (const k of keysOf.get(a)!) if (kb.has(k)) return true;
    return false;
  };
  const set = [faceId];
  let fit: ConnectorShape | null = null;
  for (let grew = true; grew;) {
    grew = false;
    for (const id of cluster) {
      if (set.includes(id) || !set.some((s) => touches(s, id))) continue;
      const next = [...set, id];
      // Three facets are the fewest a circle can be checked against.
      const f = next.length < 3 ? null : cylinderOf(trianglesOf(faces, next));
      if (next.length >= 3 && !f) continue;
      set.push(id);
      fit = f;
      grew = true;
    }
  }
  return fit;
}

function cylinderOf(tris: Tri[]): ConnectorShape | null {
  if (tris.length < 3) return null;
  // The axis is perpendicular to every facet normal: take the most independent
  // pair, then check the rest agree.
  let dir: Vec3 = [0, 0, 0];
  let best = 0;
  const step = Math.max(1, Math.floor(tris.length / 32));
  for (let i = 0; i < tris.length; i += step)
    for (let j = i + 1; j < tris.length; j += step) {
      const c = cross(tris[i].n, tris[j].n);
      if (len(c) > best) {
        best = len(c);
        dir = c;
      }
    }
  if (best < 0.05) return null; // all facing one way: not round
  dir = canonical(unit(dir));
  if (tris.some((t) => Math.abs(dot(t.n, dir)) > 0.02)) return null;
  const pts = distinct(tris.flatMap((t) => t.p));
  if (pts.length < 4) return null;
  const u = defaultX(dir);
  const v = cross(dir, u);
  const fit = fitCircle2(
    pts.map((p) => [dot(p, u), dot(p, v)]),
    2e-3,
  );
  if (!fit) return null;
  let tMin = Infinity,
    tMax = -Infinity;
  for (const p of pts) {
    const t = dot(p, dir);
    tMin = Math.min(tMin, t);
    tMax = Math.max(tMax, t);
  }
  const axisPoint = add(scale(u, fit.c[0]), scale(v, fit.c[1])); // at t = 0
  return { kind: "cylinder", axisPoint, dir, radius: fit.r, tMin, tMax };
}

function edgeGroup(edges: MeshedEdges, edgeId: number) {
  return edges.edgeGroups?.find((g) => g.edgeId === edgeId);
}

/** What an edge is for mating: a circle (its rim's chords, closed or an arc)
 *  or a straight line, else null. */
export function edgeShape(edges: MeshedEdges, edgeId: number, faces?: MeshedFaces): ConnectorShape | null {
  const g = edgeGroup(edges, edgeId);
  if (!g) return null;
  const ids =
    g.chainId === undefined || !edges.edgeGroups
      ? [edgeId]
      : edges.edgeGroups.filter((x) => x.chainId === g.chainId).map((x) => x.edgeId);
  const { lines } = edges;
  const pts: Vec3[] = [];
  for (const id of ids) {
    const eg = edgeGroup(edges, id);
    if (!eg) continue;
    for (let i = eg.start; i < eg.start + eg.count; i++) pts.push([lines[i * 3], lines[i * 3 + 1], lines[i * 3 + 2]]);
  }
  const circle = ids.length >= 3 ? fitCircle3(pts) : null;
  if (circle) {
    // Orient the circle's Z like the flat face it bounds (a rim's top face),
    // so a bolt head's underside and a plate's top face come out facing each
    // other; otherwise canonical.
    let normal = canonical(circle.normal);
    const face = faces && g.name ? adjacentPlane(faces, g.name, normal) : null;
    if (face) normal = face;
    return { kind: "circle", center: circle.center, normal, radius: circle.radius };
  }
  // Straight: every point on the chord between the two farthest-apart ends.
  const ends = distinct(pts);
  if (ends.length < 2) return null;
  let a = ends[0],
    b = ends[1],
    far = 0;
  for (const p of ends)
    for (const q of ends)
      if (len(sub(p, q)) > far) {
        far = len(sub(p, q));
        a = p;
        b = q;
      }
  if (far < 1e-9) return null;
  const dir = unit(sub(b, a));
  for (const p of ends) {
    const w = sub(p, a);
    if (len(sub(w, scale(dir, dot(w, dir)))) > 1e-3 * far + 1e-6) return null;
  }
  return { kind: "line", mid: scale(add(a, b), 0.5), dir: canonical(dir) };
}

/** The normal of a planar face adjacent to an edge (edge names are
 *  "faceA∩faceB") that is parallel to `axis`, or null. */
function adjacentPlane(faces: MeshedFaces, edgeName: string, axis: Vec3): Vec3 | null {
  for (const fname of edgeName.split("∩")) {
    const fg = faces.faceGroups?.find((x) => x.name === fname);
    if (!fg) continue;
    const s = faceShape(faces, fg.faceId);
    if (s?.kind === "plane" && Math.abs(dot(s.normal, axis)) > 0.999) return s.normal;
  }
  return null;
}

/** The plane midway between two parallel flat faces: a width mate's
 *  connector. Its normal is made canonical, so the slot's and the tab's
 *  mid-planes point the same way whichever wall was picked first. Null unless
 *  both are planes, parallel and apart. */
export function midplaneShape(p: ConnectorShape, q: ConnectorShape): ConnectorShape | null {
  if (p.kind !== "plane" || q.kind !== "plane") return null;
  if (Math.abs(dot(p.normal, q.normal)) < 0.999) return null;
  const normal = canonical(p.normal);
  if (Math.abs(dot(sub(q.origin, p.origin), normal)) < 1e-6) return null;
  return { kind: "plane", origin: scale(add(p.origin, q.origin), 0.5), normal };
}

/** The anchors an entity offers, in the order a picker should present them. */
export function anchorsOf(shape: ConnectorShape): Anchor[] {
  return shape.kind === "cylinder" ? ["center", "start", "end"] : ["center"];
}

/** The frame at one anchor of an entity. */
export function shapeFrame(shape: ConnectorShape, anchor: Anchor): Frame {
  switch (shape.kind) {
    case "plane":
      return { origin: shape.origin, z: shape.normal, x: defaultX(shape.normal) };
    case "circle":
      return { origin: shape.center, z: shape.normal, x: defaultX(shape.normal) };
    case "line":
      return { origin: shape.mid, z: shape.dir, x: defaultX(shape.dir) };
    case "cylinder": {
      const t = anchor === "start" ? shape.tMin : anchor === "end" ? shape.tMax : (shape.tMin + shape.tMax) / 2;
      return { origin: add(shape.axisPoint, scale(shape.dir, t)), z: shape.dir, x: defaultX(shape.dir) };
    }
  }
}

/** A picked face/edge as a stored reference (name + fingerprint). Null for an
 *  unnamed entity or one that can't anchor a mate. */
export function connectorRefOf(
  mesh: ShapeMeshPayload,
  pick: { kind: "face"; faceId: number } | { kind: "edge"; edgeId: number },
): { ref: ConnectorRef; shape: ConnectorShape } | null {
  if (pick.kind === "face") {
    const name = faceGroup(mesh.faces, pick.faceId)?.name;
    const shape = faceShape(mesh.faces, pick.faceId);
    if (!name || !shape) return null;
    return { ref: { kind: "face", name, ...fingerprint(shape) }, shape };
  }
  const name = edgeGroup(mesh.edges, pick.edgeId)?.name;
  const shape = edgeShape(mesh.edges, pick.edgeId, mesh.faces);
  if (!name || !shape) return null;
  return { ref: { kind: "edge", name, ...fingerprint(shape) }, shape };
}

function fingerprint(s: ConnectorShape): { center: Vec3; normal?: Vec3 } {
  switch (s.kind) {
    case "plane":
      return { center: s.origin, normal: s.normal };
    case "circle":
      return { center: s.center, normal: s.normal };
    case "line":
      return { center: s.mid };
    case "cylinder":
      return { center: add(s.axisPoint, scale(s.dir, (s.tMin + s.tMax) / 2)) };
  }
}

/** Re-find a stored connector on a (possibly rebuilt) part mesh: by name
 *  first, then by fingerprint — the nearest entity of the same kind whose
 *  shape sits where the reference was, within a tolerance scaled to the part.
 *  `rematched` says the name was gone and the fingerprint found it. */
export function resolveConnector(
  mesh: ShapeMeshPayload,
  ref: ConnectorRef,
): { shape: ConnectorShape; rematched: boolean } | null {
  const byName =
    ref.kind === "face"
      ? mesh.faces.faceGroups?.find((g) => g.name === ref.name)
      : mesh.edges.edgeGroups?.find((g) => g.name === ref.name);
  if (byName) {
    const shape =
      ref.kind === "face"
        ? faceShape(mesh.faces, (byName as { faceId: number }).faceId)
        : edgeShape(mesh.edges, (byName as { edgeId: number }).edgeId, mesh.faces);
    return shape ? { shape, rematched: false } : null;
  }
  if (!ref.center) return null;
  const tol = Math.max(0.05, 1e-3 * partSize(mesh));
  let best: ConnectorShape | null = null;
  let bestD = tol;
  const consider = (shape: ConnectorShape | null) => {
    if (!shape) return;
    const fp = fingerprint(shape);
    if (ref.normal && (!fp.normal || dot(fp.normal, ref.normal) < 0.999)) return;
    const d = len(sub(fp.center, ref.center!));
    if (d < bestD) {
      bestD = d;
      best = shape;
    }
  };
  if (ref.kind === "face") for (const g of mesh.faces.faceGroups ?? []) consider(faceShape(mesh.faces, g.faceId));
  else for (const g of mesh.edges.edgeGroups ?? []) consider(edgeShape(mesh.edges, g.edgeId, mesh.faces));
  return best ? { shape: best, rematched: true } : null;
}

function partSize(mesh: ShapeMeshPayload): number {
  const b = meshBounds(mesh);
  return b ? Math.hypot(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]) : 0;
}
