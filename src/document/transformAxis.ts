// A transform's rotation axis, resolved to a world line for the viewport.
//
// The kernel resolves the same three references its own way (document.ts bakes
// the world ones, worker.ts reads a body edge out of the B-rep). This module is
// the VIEWPORT's answer to the same question: the gizmo has to draw the ring on
// the axis before anything is regenerated, and it only has the tessellated
// meshes to do it from. Split out of App.tsx so the resolution is unit-testable
// and so `document/` stays framework-free (structural mesh types, like
// dressUpTarget.ts).

import { edgeIdByName, edgeLine } from "../geom/meshQuery";
import type { MeshedEdges } from "../kernel/types";
import { frameOf, uvToWorld, type PlaneFrameData } from "./planes";
import type { Document, TransformAxis } from "./types";

type Vec3 = [number, number, number];

/** The parts of a `FeatureMesh` this module needs. */
export interface AxisMesh {
  id: string;
  mesh: { edges: MeshedEdges };
}

/** A world line: a point on it and a UNIT direction. */
export interface AxisLine {
  origin: Vec3;
  dir: Vec3;
}

const unit = (v: Vec3): AxisLine["dir"] | null => {
  const len = Math.hypot(v[0], v[1], v[2]);
  return len < 1e-9 ? null : [v[0] / len, v[1] / len, v[2] / len];
};

/** Resolve a transform's rotation axis to a world line, or null when the
 *  reference no longer resolves (its sketch or entity deleted, its edge gone or
 *  renamed past re-matching, the body not yet meshed). A world axis always
 *  resolves — it is `pivot` plus that direction, which is what keeps "rotate
 *  about Z" a spin on the spot rather than a swing around the world origin. */
export function transformAxisLine(
  axis: TransformAxis,
  pivot: Vec3,
  doc: Document,
  planeFrames: Map<string, PlaneFrameData>,
  meshes: AxisMesh[],
): AxisLine | null {
  if (typeof axis === "string") {
    return { origin: pivot, dir: axis === "x" ? [1, 0, 0] : axis === "y" ? [0, 1, 0] : [0, 0, 1] };
  }
  if ("edge" in axis) {
    const m = meshes.find((x) => x.id === axis.edge.featureId);
    if (!m) return null;
    // By persistent name first (it outlives a rebuild), then the id it was
    // picked with — the same precedence the kernel resolver uses.
    const id = (axis.edge.edgeName ? edgeIdByName(m.mesh.edges, axis.edge.edgeName) : undefined) ?? axis.edge.edgeId;
    return edgeLine(m.mesh.edges, id);
  }
  const sketch = doc.features.find((f) => f.id === axis.sketchId);
  if (sketch?.type !== "sketch") return null;
  const ent = sketch.entities.find((e) => e.id === axis.entityId);
  if (ent?.type !== "line") return null;
  const frame = frameOf(sketch.plane, planeFrames);
  const a = uvToWorld(frame, ent.a[0], ent.a[1]);
  const b = uvToWorld(frame, ent.b[0], ent.b[1]);
  const dir = unit([b[0] - a[0], b[1] - a[1], b[2] - a[2]]);
  return dir ? { origin: a, dir } : null;
}

/** How a transform's axis reads in the dialog's pick slot. */
export function transformAxisLabel(axis: TransformAxis, doc: Document): string | null {
  if (typeof axis === "string") return null; // the X/Y/Z buttons say it already
  const owner = doc.features.find((f) => f.id === ("edge" in axis ? axis.edge.featureId : axis.sketchId));
  return "edge" in axis ? `${owner?.name ?? "Body"} · edge` : `${owner?.name ?? "Sketch"} · line`;
}
