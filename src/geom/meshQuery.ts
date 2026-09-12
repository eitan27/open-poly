// Pure queries over a tessellated body's meshed faces/edges — centroid, normal,
// persistent name, midpoint, fingerprint. Split out of App.tsx so the pick →
// feature-reference logic that needs them (dressUpTarget.ts, extrudeProfiles.ts)
// can live in the document layer and be unit-tested without React.

import type { MeshedEdges, MeshedFaces } from "../kernel/types";

/** Average position of a tessellated body face — the centroid fallback used to
 *  re-find a face that has no persistent name yet. */
export function faceCentroid(faces: MeshedFaces, faceId: number): [number, number, number] | null {
  const g = faces.faceGroups?.find((fg) => fg.faceId === faceId);
  if (!g) return null;
  const { triangles, vertices } = faces;
  let sx = 0,
    sy = 0,
    sz = 0,
    n = 0;
  for (let k = g.start; k < g.start + g.count; k++) {
    const vi = triangles[k] * 3;
    sx += vertices[vi];
    sy += vertices[vi + 1];
    sz += vertices[vi + 2];
    n++;
  }
  return n ? [sx / n, sy / n, sz / n] : null;
}

/** Unit normal of a tessellated body face, or null if the face is non-planar
 *  (vertices not coplanar within tolerance — e.g. a cylinder side). Prefers the
 *  meshed per-vertex normals, falling back to the first non-degenerate triangle's
 *  geometric normal. Used to derive a mirror plane from a picked planar face. */
export function faceNormal(faces: MeshedFaces, faceId: number): [number, number, number] | null {
  const g = faces.faceGroups?.find((fg) => fg.faceId === faceId);
  if (!g) return null;
  const { triangles, vertices, normals } = faces;
  let n: [number, number, number] | null = null;
  if (normals && normals.length) {
    let nx = 0,
      ny = 0,
      nz = 0;
    for (let k = g.start; k < g.start + g.count; k++) {
      const vi = triangles[k] * 3;
      nx += normals[vi];
      ny += normals[vi + 1];
      nz += normals[vi + 2];
    }
    const l = Math.hypot(nx, ny, nz);
    if (l > 1e-9) n = [nx / l, ny / l, nz / l];
  }
  if (!n) {
    for (let k = g.start; k + 2 < g.start + g.count; k += 3) {
      const a = triangles[k] * 3,
        b = triangles[k + 1] * 3,
        c = triangles[k + 2] * 3;
      const ux = vertices[b] - vertices[a],
        uy = vertices[b + 1] - vertices[a + 1],
        uz = vertices[b + 2] - vertices[a + 2];
      const vx = vertices[c] - vertices[a],
        vy = vertices[c + 1] - vertices[a + 1],
        vz = vertices[c + 2] - vertices[a + 2];
      const nx = uy * vz - uz * vy,
        ny = uz * vx - ux * vz,
        nz = ux * vy - uy * vx;
      const l = Math.hypot(nx, ny, nz);
      if (l > 1e-9) {
        n = [nx / l, ny / l, nz / l];
        break;
      }
    }
  }
  if (!n) return null;
  // Reject a non-planar face: every vertex must lie on the plane (point + n).
  const a0 = triangles[g.start] * 3;
  const px = vertices[a0],
    py = vertices[a0 + 1],
    pz = vertices[a0 + 2];
  for (let k = g.start; k < g.start + g.count; k++) {
    const vi = triangles[k] * 3;
    const d = (vertices[vi] - px) * n[0] + (vertices[vi + 1] - py) * n[1] + (vertices[vi + 2] - pz) * n[2];
    if (Math.abs(d) > 0.05) return null; // mm tolerance
  }
  return n;
}

/** The persistent topological name of a tessellated face (if it has one). */
export function faceNameOf(faces: MeshedFaces, faceId: number): string | undefined {
  return faces.faceGroups?.find((fg) => fg.faceId === faceId)?.name;
}

/** The persistent topological name of a tessellated edge (if it has one). */
export function edgeNameOf(edges: MeshedEdges, edgeId: number): string | undefined {
  return edges.edgeGroups?.find((eg) => eg.edgeId === edgeId)?.name;
}

/** Midpoint of a tessellated edge (world space) — anchors the dress-up dialog. */
export function edgeMidpoint(edges: MeshedEdges, edgeId: number): [number, number, number] | null {
  const g = edges.edgeGroups?.find((eg) => eg.edgeId === edgeId);
  if (!g) return null;
  const { lines } = edges;
  let sx = 0,
    sy = 0,
    sz = 0,
    n = 0;
  for (let v = g.start; v < g.start + g.count; v++) {
    sx += lines[v * 3];
    sy += lines[v * 3 + 1];
    sz += lines[v * 3 + 2];
    n++;
  }
  return n ? [sx / n, sy / n, sz / n] : null;
}

/** Geometric fingerprint of a tessellated edge, stored with a dress-up so the
 *  kernel can re-match the edge if an upstream edit renames it. `mid` is the
 *  polyline's bounding-box centre (matches the kernel's edge-bbox centre — and
 *  is robust for closed edges, where an endpoint average lands on the seam);
 *  `length` is the polyline arc length. */
export function edgeFingerprint(
  edges: MeshedEdges,
  edgeId: number,
): { mid: [number, number, number]; length: number } | null {
  const g = edges.edgeGroups?.find((eg) => eg.edgeId === edgeId);
  if (!g || g.count === 0) return null;
  const { lines } = edges;
  let minX = Infinity,
    minY = Infinity,
    minZ = Infinity;
  let maxX = -Infinity,
    maxY = -Infinity,
    maxZ = -Infinity;
  let length = 0;
  for (let v = g.start; v < g.start + g.count; v++) {
    const x = lines[v * 3],
      y = lines[v * 3 + 1],
      z = lines[v * 3 + 2];
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    minZ = Math.min(minZ, z);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
    maxZ = Math.max(maxZ, z);
    if (v > g.start) {
      length += Math.hypot(x - lines[(v - 1) * 3], y - lines[(v - 1) * 3 + 1], z - lines[(v - 1) * 3 + 2]);
    }
  }
  return { mid: [(minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2], length };
}

/** The edgeId carrying a persistent edge name, or undefined if no edge does.
 *  Names outlive ids across a rebuild, so a stored reference resolves by name
 *  first and only falls back to the id it was picked with. */
export function edgeIdByName(edges: MeshedEdges, name: string): number | undefined {
  return edges.edgeGroups?.find((eg) => eg.name === name)?.edgeId;
}

/** The world line a STRAIGHT tessellated edge lies on: a point on it and a unit
 *  direction. Null for a missing, degenerate or curved edge — a circle or spline
 *  has no single direction, so it can't be an axis. Straightness is measured
 *  against the chord rather than assumed from the vertex count: a line meshes to
 *  two points today, but an edge that merely LOOKS straight at this tessellation
 *  must not pass as one. */
export function edgeLine(
  edges: MeshedEdges,
  edgeId: number,
): { origin: [number, number, number]; dir: [number, number, number] } | null {
  const g = edges.edgeGroups?.find((eg) => eg.edgeId === edgeId);
  if (!g || g.count < 2) return null;
  const { lines } = edges;
  const at = (v: number): [number, number, number] => [lines[v * 3], lines[v * 3 + 1], lines[v * 3 + 2]];
  const a = at(g.start);
  const b = at(g.start + g.count - 1);
  const d: [number, number, number] = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const len = Math.hypot(d[0], d[1], d[2]);
  if (len < 1e-9) return null; // closed (a full circle) or degenerate
  const dir: [number, number, number] = [d[0] / len, d[1] / len, d[2] / len];
  for (let v = g.start + 1; v < g.start + g.count - 1; v++) {
    const p = at(v);
    const w: [number, number, number] = [p[0] - a[0], p[1] - a[1], p[2] - a[2]];
    const along = w[0] * dir[0] + w[1] * dir[1] + w[2] * dir[2];
    const off = Math.hypot(w[0] - along * dir[0], w[1] - along * dir[1], w[2] - along * dir[2]);
    if (off > 1e-6 * len + 1e-9) return null; // bows away from the chord: curved
  }
  return { origin: a, dir };
}
