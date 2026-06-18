// The document model: a parametric document is an ordered timeline of features
// plus a set of variables. Regeneration replays the features up to the rollback
// point. This is the backbone every later feature (sketches, extrude, …) plugs
// into.
import type { PrimitiveKind } from "../kernel/types";
import type { SketchPlaneRef } from "./planes";

export type FeatureKind = PrimitiveKind;

export type Vec2 = [number, number];

export type SketchEntity =
  | { type: "line"; id: string; a: Vec2; b: Vec2 }
  | { type: "circle"; id: string; c: Vec2; r: number }
  | { type: "arc"; id: string; c: Vec2; r: number; start: number; end: number }
  | { type: "point"; id: string; p: Vec2 };

/** Dimensional/geometric constraints over sketch entities (solved by planegcs).
 *  `entity`/`a`/`b` reference SketchEntity ids. */
export type SketchConstraint =
  | { id: string; type: "horizontal"; entity: string }
  | { id: string; type: "vertical"; entity: string }
  | { id: string; type: "parallel"; a: string; b: string }
  | { id: string; type: "perpendicular"; a: string; b: string }
  | { id: string; type: "distance"; entity: string; value: number };

interface FeatureBase {
  id: string;
  name: string;
  suppressed: boolean;
}

/** A primitive solid (box/cylinder/sphere) — maps 1:1 to a kernel primitive. */
export interface PrimitiveFeature extends FeatureBase {
  type: "primitive";
  kind: FeatureKind;
  /** param name -> expression string (e.g. "40", or "width * 2"). */
  params: Record<string, string>;
  /** Display color (0xRRGGBB), assigned once at creation from the pastel bank. */
  color: number;
  /** Display opacity, 0 (invisible) – 1 (opaque). User-adjustable in the solids list. */
  opacity: number;
}

/** A 2D sketch on a datum plane. Produces no solid on its own; it's a profile
 *  source consumed by extrude (and later revolve/sweep). */
export interface SketchFeature extends FeatureBase {
  type: "sketch";
  plane: SketchPlaneRef;
  entities: SketchEntity[];
  constraints: SketchConstraint[];
}

/** How an extrude combines with the running body set. */
export type ExtrudeMode = "new" | "add" | "remove";

/** What an extrude pulls: a closed region of a sketch, or a planar face of an
 *  existing body (referenced by the feature that produced it + the face id). */
export type ExtrudeProfile =
  | { kind: "sketchRegion"; sketchId: string; regionId: string }
  // A body face. `faceName` is the persistent topological name (preferred,
  // stable across rebuilds); `faceId` is the build-local hash from selection and
  // `center` the centroid — both kept as fallback when there's no name yet.
  | { kind: "bodyFace"; featureId: string; faceId: number; faceName?: string; center: [number, number, number] };

/** Extrude a sketch region or a body face into a solid. (Phase 3.) */
export interface ExtrudeFeature extends FeatureBase {
  type: "extrude";
  profile: ExtrudeProfile;
  /** Blind distance, as an expression string (e.g. "10" or "height/2"). */
  distance: string;
  /** Reverse the extrusion direction (against the profile normal). */
  flip: boolean;
  mode: ExtrudeMode;
}

/** Chamfer/fillet a set of edges of a body (referenced by persistent name). */
export interface DressUpFeature extends FeatureBase {
  type: "dressup";
  op: "chamfer" | "fillet";
  /** The body whose edges are dressed (the feature id that produced it). */
  targetId: string;
  /** Persistent names of the edges to chamfer/fillet. */
  edges: string[];
  /** Chamfer distance / fillet radius, as an expression string. */
  size: string;
}

export type Feature = PrimitiveFeature | SketchFeature | ExtrudeFeature | DressUpFeature;

export interface Variable {
  id: string;
  name: string;
  expression: string;
}

export interface Document {
  features: Feature[];
  variables: Variable[];
  /** Number of features evaluated, 0..features.length. Features at index >=
   *  rollbackIndex are "rolled back" (not regenerated). */
  rollbackIndex: number;
}
