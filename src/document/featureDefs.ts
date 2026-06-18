// Static metadata for each feature kind: which parameters it exposes and their
// defaults. Drives both the parameter editor UI and new-feature creation.
import type { BooleanOp } from "../kernel/types";
import type { FeatureKind } from "./types";

export interface ParamDef {
  name: string;
  label: string;
  default: number;
}

export interface FeatureDef {
  kind: FeatureKind;
  label: string;
  params: ParamDef[];
}

const POSITION: ParamDef[] = [
  { name: "x", label: "Pos X", default: 0 },
  { name: "y", label: "Pos Y", default: 0 },
  { name: "z", label: "Pos Z", default: 0 },
];

export const FEATURE_DEFS: Record<FeatureKind, FeatureDef> = {
  box: {
    kind: "box",
    label: "Box",
    params: [
      { name: "width", label: "Width", default: 40 },
      { name: "depth", label: "Depth", default: 30 },
      { name: "height", label: "Height", default: 20 },
      ...POSITION,
    ],
  },
  cylinder: {
    kind: "cylinder",
    label: "Cylinder",
    params: [
      { name: "radius", label: "Radius", default: 18 },
      { name: "height", label: "Height", default: 40 },
      ...POSITION,
    ],
  },
  sphere: {
    kind: "sphere",
    label: "Sphere",
    params: [
      { name: "radius", label: "Radius", default: 22 },
      { name: "x", label: "Pos X", default: 0 },
      { name: "y", label: "Pos Y", default: 0 },
      { name: "z", label: "Pos Z", default: 22 },
    ],
  },
};

export const FEATURE_KINDS = Object.keys(FEATURE_DEFS) as FeatureKind[];

export const BOOLEAN_OPS: BooleanOp[] = ["union", "subtract", "intersect"];

export const BOOLEAN_OP_LABELS: Record<BooleanOp, string> = {
  union: "Union",
  subtract: "Subtract",
  intersect: "Intersect",
};
