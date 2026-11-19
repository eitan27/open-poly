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
  // A mirrored frame would turn the solid inside out, so handedness is part
  // of the shape.
  const hand = Math.sign(dot(cross(p.frame.uAxis, p.frame.vAxis), p.frame.normal));
  const sig = JSON.stringify({
    ...f,
    profiles: [{ ...p, frame: hand, outline: rel(p.outline), holes: (p.holes ?? []).map(rel) }],
  });
  return { sig, frame: p.frame, anchor: [ax, ay] };
}

/** The mesh built at `from`, carried rigidly to `to` (same signature). */
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
  return {
    ...mesh,
    faces: {
      ...mesh.faces,
      vertices: point(mesh.faces.vertices),
      ...(mesh.faces.normals ? { normals: dir(mesh.faces.normals) } : {}),
    },
    edges: { ...mesh.edges, lines: point(mesh.edges.lines) },
  };
}
