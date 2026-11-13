import type { ShapeMeshPayload } from "../kernel/types";

type V3 = [number, number, number];

/** The axis-aligned box round a mesh's vertices (world space, as meshes are
 *  baked), or null for an empty mesh. */
export function meshBounds(mesh: ShapeMeshPayload): { min: V3; max: V3 } | null {
  const v = mesh.faces.vertices;
  if (v.length < 3) return null;
  const min: V3 = [Infinity, Infinity, Infinity];
  const max: V3 = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i + 2 < v.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      if (v[i + k] < min[k]) min[k] = v[i + k];
      if (v[i + k] > max[k]) max[k] = v[i + k];
    }
  }
  return { min, max };
}
