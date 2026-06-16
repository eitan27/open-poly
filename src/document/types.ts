// The document model: a parametric document is an ordered timeline of features
// plus a set of variables. Regeneration replays the features up to the rollback
// point. This is the backbone every later feature (sketches, extrude, …) plugs
// into.
import type { PrimitiveKind } from "../kernel/types";

// In Phase 1 a feature maps 1:1 to a kernel primitive; later kinds (sketch,
// extrude, …) will map to richer kernel ops.
export type FeatureKind = PrimitiveKind;

export interface Feature {
  id: string;
  kind: FeatureKind;
  name: string;
  suppressed: boolean;
  /** param name -> expression string (e.g. "40", or later "width * 2"). */
  params: Record<string, string>;
}

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
