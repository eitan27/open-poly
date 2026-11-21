// Moving a ghost instead of rebuilding it.
//
// A one-profile sketch extrude (a gear, as the dialog bakes it) is the same
// solid wherever it's put: a new location changes only the profile's frame and
// where the outline sits on it. The kernel can't tell — the placement is part
// of its cache key — so every pick would rebuild and re-tessellate the gear.
// Here the last built mesh is carried rigidly to the new placement instead, so
// the ghost moves at once; the kernel's own build of the new spot still runs,
// and replaces it (and is what Create then reuses).
import type { ResolvedFeature, ResolvedFrame, ShapeMeshPayload } from "../kernel/types";

type V3 = [number, number, number];

/** Where a placeable extrude sits, and a signature of everything else. */
export interface GhostPlacement {
  /** Equal signatures = the same solid, up to where it's placed. */
  sig: string;
  frame: ResolvedFrame;
  /** +1 for a right-handed frame (u × v = normal), −1 for a mirrored one (the
   *  Front datum's is). */
  hand: number;
  /** The outline's first point, in plane coordinates: the reference the shape
   *  is carried by. */
  anchor: [number, number];
}

const r6 = (n: number) => Math.round(n * 1e6) / 1e6;
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

/** A one-profile, sketch-region extrude's placement — or null when the solid
 *  depends on more than its own profile (a target, an up-to face). */
export function ghostPlacement(f: ResolvedFeature | undefined): GhostPlacement | null {
  if (!f || f.type !== "extrude" || f.profiles.length !== 1) return null;
  if (f.mode !== "new" || (f.extent !== "blind" && f.extent !== "symmetric")) return null;
  const p = f.profiles[0];
  if (p.kind !== "sketchRegion" || p.segments || !p.outline.length) return null;
  const [ax, ay] = p.outline[0];
  const rel = (pts: [number, number][]) => pts.map(([x, y]) => [r6(x - ax), r6(y - ay)]);
  const hand = Math.sign(dot(cross(p.frame.uAxis, p.frame.vAxis), p.frame.normal)) || 1;
  const sig = JSON.stringify({
    ...f,
    profiles: [{ ...p, frame: null, outline: rel(p.outline), holes: (p.holes ?? []).map(rel) }],
  });
  return { sig, frame: p.frame, hand, anchor: [ax, ay] };
}

/** The mesh built at `from`, carried to `to` (same signature). Plane
 *  coordinates map to plane coordinates, exactly as the kernel lays the
 *  profile out — a rotation, or, between a right- and a left-handed frame, a
 *  reflection, which also turns each triangle's corners around so its front
 *  stays outward. */
export function moveGhostMesh(mesh: ShapeMeshPayload, from: GhostPlacement, to: GhostPlacement): ShapeMeshPayload {
  const a = from.frame;
  const b = to.frame;
  const du = to.anchor[0] - from.anchor[0];
  const dv = to.anchor[1] - from.anchor[1];
  const point = (src: ArrayLike<number>) => {
    const out = new Float32Array(src.length);
    for (let i = 0; i < src.length; i += 3) {
      const x: V3 = [src[i] - a.origin[0], src[i + 1] - a.origin[1], src[i + 2] - a.origin[2]];
      const u = dot(x, a.uAxis) + du;
      const v = dot(x, a.vAxis) + dv;
      const w = dot(x, a.normal);
      for (let k = 0; k < 3; k++) out[i + k] = b.origin[k] + u * b.uAxis[k] + v * b.vAxis[k] + w * b.normal[k];
    }
    return out;
  };
  const dir = (src: ArrayLike<number>) => {
    const out = new Float32Array(src.length);
    for (let i = 0; i < src.length; i += 3) {
      const x: V3 = [src[i], src[i + 1], src[i + 2]];
      const u = dot(x, a.uAxis);
      const v = dot(x, a.vAxis);
      const w = dot(x, a.normal);
      for (let k = 0; k < 3; k++) out[i + k] = u * b.uAxis[k] + v * b.vAxis[k] + w * b.normal[k];
    }
    return out;
  };
  let triangles = mesh.faces.triangles;
  if (from.hand !== to.hand) {
    const t = new Uint32Array(triangles.length);
    for (let i = 0; i < t.length; i += 3) {
      t[i] = triangles[i];
      t[i + 1] = triangles[i + 2];
      t[i + 2] = triangles[i + 1];
    }
    triangles = t;
  }
  return {
    ...mesh,
    faces: {
      ...mesh.faces,
      vertices: point(mesh.faces.vertices),
      triangles,
      ...(mesh.faces.normals ? { normals: dir(mesh.faces.normals) } : {}),
    },
    edges: { ...mesh.edges, lines: point(mesh.edges.lines) },
  };
}

/** Where a screw ghost's one screw is built: at the world origin, upright
 *  (pointing down −Z, u along +X) — the same wherever its copies go, so the
 *  kernel builds (and caches) it by its shape alone. */
export const SCREW_TEMPLATE_FRAME: ResolvedFrame = {
  origin: [0, 0, 0],
  uAxis: [1, 0, 0],
  vAxis: [0, 1, 0],
  normal: [0, 0, 1],
};

/** One screw built at SCREW_TEMPLATE_FRAME, copied to each seat: the seat's
 *  origin, its shank going against its normal, u along its u — exactly how
 *  the kernel lays a screw out (a rotation, never a mirror: the thread keeps
 *  its hand). The copies are one mesh, as the built feature's would be. */
export function screwCopies(template: ShapeMeshPayload, seats: ResolvedFrame[]): ShapeMeshPayload {
  const tv = template.faces.vertices;
  const tn = template.faces.normals;
  const tt = template.faces.triangles;
  const tl = template.edges.lines;
  const nv = tv.length / 3;
  const vertices = new Float32Array(tv.length * seats.length);
  const normals = tn ? new Float32Array(tn.length * seats.length) : undefined;
  const triangles = new Uint32Array(tt.length * seats.length);
  const lines = new Float32Array(tl.length * seats.length);
  seats.forEach((s, k) => {
    const down: V3 = [-s.normal[0], -s.normal[1], -s.normal[2]];
    const u = s.uAxis;
    const e2 = cross(down, u);
    // Template world (x, −y, −z) is local (x, y, z): see the kernel's meshSolid.
    const map = (src: ArrayLike<number>, out: Float32Array, at: number, o: V3 | null) => {
      for (let i = 0; i < src.length; i += 3) {
        const x = src[i];
        const y = -src[i + 1];
        const z = -src[i + 2];
        for (let j = 0; j < 3; j++) out[at + i + j] = (o ? o[j] : 0) + x * u[j] + y * e2[j] + z * down[j];
      }
    };
    map(tv, vertices, k * tv.length, s.origin);
    if (tn && normals) map(tn, normals, k * tn.length, null);
    map(tl, lines, k * tl.length, s.origin);
    for (let i = 0; i < tt.length; i++) triangles[k * tt.length + i] = tt[i] + k * nv;
  });
  return {
    name: template.name,
    faces: { vertices, triangles, ...(normals ? { normals } : {}) },
    edges: { lines },
  };
}

/** A flat ring lying on `frame` around (u, v), from radius `r` out by
 *  `width`, with its two circles as edges: a hole's outline, lit while its
 *  row in the Hole dialog is hovered. Both sides face the camera (the ghost
 *  materials draw double-sided), so it reads from above or below. */
export function ringMesh(
  frame: ResolvedFrame,
  center: [number, number],
  r: number,
  width: number,
  n = 64,
): ShapeMeshPayload {
  const { origin: o, uAxis: u, vAxis: v, normal: nz } = frame;
  const c: V3 = [0, 1, 2].map((j) => o[j] + center[0] * u[j] + center[1] * v[j]) as V3;
  // Lifted a hair off the face, so it isn't lost in it.
  const lift = Math.max(0.01, r * 0.002);
  const at = (rad: number, a: number, out: Float32Array, i: number) => {
    const cu = Math.cos(a) * rad;
    const sv = Math.sin(a) * rad;
    for (let j = 0; j < 3; j++) out[i + j] = c[j] + cu * u[j] + sv * v[j] + lift * nz[j];
  };
  const vertices = new Float32Array(n * 2 * 3);
  const normals = new Float32Array(n * 2 * 3);
  const triangles = new Uint32Array(n * 6);
  const lines = new Float32Array(n * 2 * 2 * 3);
  for (let k = 0; k < n; k++) {
    const a = (k / n) * Math.PI * 2;
    const b = ((k + 1) / n) * Math.PI * 2;
    at(r, a, vertices, k * 6);
    at(r + width, a, vertices, k * 6 + 3);
    for (let j = 0; j < 6; j++) normals[k * 6 + j] = nz[j % 3];
    const i0 = 2 * k;
    const i1 = (2 * (k + 1)) % (2 * n);
    triangles.set([i0, i0 + 1, i1 + 1, i0, i1 + 1, i1], k * 6);
    at(r, a, lines, k * 12);
    at(r, b, lines, k * 12 + 3);
    at(r + width, a, lines, k * 12 + 6);
    at(r + width, b, lines, k * 12 + 9);
  }
  return { name: "ring", faces: { vertices, triangles, normals }, edges: { lines } };
}
