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
}

/** A 2D sketch on a datum plane. Produces no solid yet (extrude is Phase 3). */
export interface SketchFeature extends FeatureBase {
  type: "sketch";
  plane: SketchPlaneRef;
  entities: SketchEntity[];
}

export type Feature = PrimitiveFeature | SketchFeature;

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
