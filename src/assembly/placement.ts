// Where an instance sits: 4×4 rigid placements (column-major, three.js order)
// and baking one into a copy of its part's mesh. Plain arithmetic, no three.js,
// so it runs (and is tested) in Node.
//
// Instances are drawn by BAKING their placement into a copy of the part's mesh
// rather than handing the viewport a matrix: a baked mesh is an ordinary
// world-space body, so picking, highlights, section view and the transform
// gizmo's drag preview all work on it unchanged. The copy keeps the face/edge
// groups (names, surface tags), which a placement can't invalidate — it moves
// vertices, never the triangle or line index ranges the groups point into.
import type { ShapeMeshPayload } from "../kernel/types";
import type { Mat4 } from "./types";

export type Vec3 = [number, number, number];

export const IDENTITY: Mat4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

export function isIdentity(m: Mat4): boolean {
  return m.every((v, i) => v === IDENTITY[i]);
}

export function translation(t: Vec3): Mat4 {
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, t[0], t[1], t[2], 1];
}

/** a · b (b applies first). */
export function multiply(a: Mat4, b: Mat4): Mat4 {
  const out = new Array<number>(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
      out[c * 4 + r] = s;
    }
  }
  return out;
}

export function applyPoint(m: Mat4, p: Vec3): Vec3 {
  return [
    m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12],
    m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
    m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14],
  ];
}

/** Bake `m` into a copy of `mesh`. Groups are carried over as they are; the
 *  index buffers are shared with the source (they don't change). */
export function placeMesh(mesh: ShapeMeshPayload, m: Mat4): ShapeMeshPayload {
  if (isIdentity(m)) return mesh;
  const points = (src: ArrayLike<number>) => {
    const out = new Float32Array(src.length);
    for (let i = 0; i < src.length; i += 3) {
      const x = src[i],
        y = src[i + 1],
        z = src[i + 2];
      out[i] = m[0] * x + m[4] * y + m[8] * z + m[12];
      out[i + 1] = m[1] * x + m[5] * y + m[9] * z + m[13];
      out[i + 2] = m[2] * x + m[6] * y + m[10] * z + m[14];
    }
    return out;
  };
  // Normals turn with the rotation and ignore the translation. A placement is
  // rigid, so they stay unit length.
  const dirs = (src: ArrayLike<number>) => {
    const out = new Float32Array(src.length);
    for (let i = 0; i < src.length; i += 3) {
      const x = src[i],
        y = src[i + 1],
        z = src[i + 2];
      out[i] = m[0] * x + m[4] * y + m[8] * z;
      out[i + 1] = m[1] * x + m[5] * y + m[9] * z;
      out[i + 2] = m[2] * x + m[6] * y + m[10] * z;
    }
    return out;
  };
  return {
    name: mesh.name,
    faces: {
      ...mesh.faces,
      vertices: points(mesh.faces.vertices),
      ...(mesh.faces.normals ? { normals: dirs(mesh.faces.normals) } : {}),
    },
    edges: {
      ...mesh.edges,
      lines: points(mesh.edges.lines),
    },
  };
}

/** Axis-aligned bounds of a mesh's vertices, or null for an empty one. */
export function meshBounds(mesh: ShapeMeshPayload): { min: Vec3; max: Vec3 } | null {
  const v = mesh.faces.vertices;
  if (v.length < 3) return null;
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < v.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      if (v[i + k] < min[k]) min[k] = v[i + k];
      if (v[i + k] > max[k]) max[k] = v[i + k];
    }
  }
  return { min, max };
}

export function boundsCenter(b: { min: Vec3; max: Vec3 }): Vec3 {
  return [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2];
}

/** The clearance an inserted part keeps from what's already placed. */
export const INSERT_GAP_MM = 10;

/** How far along +X an insert moves so it lands just past everything already
 *  placed (`placed`, in world space), never inside another part: the gap past
 *  the furthest +X of what's there. 0 when either side is empty. The parts of
 *  one insert move together, keeping the arrangement they were modelled in. */
export function insertShift(
  placed: ({ min: Vec3; max: Vec3 } | null)[],
  parts: ({ min: Vec3; max: Vec3 } | null)[],
  gap: number,
): number {
  const p = placed.filter((b) => b !== null);
  const q = parts.filter((b) => b !== null);
  if (!p.length || !q.length) return 0;
  return Math.max(...p.map((b) => b.max[0])) - Math.min(...q.map((b) => b.min[0])) + gap;
}
