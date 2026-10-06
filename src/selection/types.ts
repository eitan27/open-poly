/** What a selection IS, independent of the viewport that produces it. Lives here
 *  rather than in `viewport/` because the pure-logic consumers — measurement, the
 *  agent command layer, the feature tree — reason about selections without ever
 *  touching three.js. */
import type { SketchPlaneId } from "../document/planes";

/** What is currently selected in the viewport: a whole feature (sketch or body),
 *  or a sub-element of a body — a face / edge (by stable OCCT id) or a vertex
 *  (by position, until a stable vertex id exists). */
export type Selection =
  | { kind: "feature"; id: string }
  | { kind: "face"; featureId: string; faceId: number }
  | { kind: "edge"; featureId: string; edgeId: number }
  | { kind: "vertex"; featureId: string; point: [number, number, number] }
  | { kind: "sketchEntity"; sketchId: string; entityId: string }
  | { kind: "sketchPoint"; sketchId: string; point: [number, number] }
  | { kind: "sketchFace"; sketchId: string; regionId: string };

export function sameSelection(a: Selection | null, b: Selection | null): boolean {
  if (a === b) return true;
  if (!a || !b || a.kind !== b.kind) return false;
  if (a.kind === "feature" && b.kind === "feature") return a.id === b.id;
  if (a.kind === "face" && b.kind === "face") return a.featureId === b.featureId && a.faceId === b.faceId;
  if (a.kind === "edge" && b.kind === "edge") return a.featureId === b.featureId && a.edgeId === b.edgeId;
  if (a.kind === "vertex" && b.kind === "vertex")
    return a.featureId === b.featureId && a.point.every((v, i) => v === b.point[i]);
  if (a.kind === "sketchEntity" && b.kind === "sketchEntity")
    return a.sketchId === b.sketchId && a.entityId === b.entityId;
  if (a.kind === "sketchPoint" && b.kind === "sketchPoint")
    return a.sketchId === b.sketchId && a.point.every((v, i) => v === b.point[i]);
  if (a.kind === "sketchFace" && b.kind === "sketchFace") return a.sketchId === b.sketchId && a.regionId === b.regionId;
  return false;
}

export type DatumId = "origin" | SketchPlaneId;

/** Which body-geometry kinds the picker is allowed to return (selection filters).
 *  Sketch picking while editing a sketch is unaffected. */
export interface SelectionFilter {
  body: boolean;
  face: boolean;
  edge: boolean;
  vertex: boolean;
}
