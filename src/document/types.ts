// The document model: a parametric document is an ordered timeline of features
// plus a set of variables. Regeneration replays the features up to the rollback
// point. This is the backbone every later feature (sketches, extrude, …) plugs
// into.
import type { BooleanOp, PrimitiveKind } from "../kernel/types";
import type { SketchPlaneRef } from "./planes";

export type FeatureKind = PrimitiveKind;

export type Vec2 = [number, number];

/** `construction: true` marks an entity as reference geometry — used for
 *  dimensions/constraints/snapping but ignored when detecting profile regions
 *  and never extruded. */
export type SketchEntity =
  | { type: "line"; id: string; a: Vec2; b: Vec2; construction?: boolean }
  | { type: "circle"; id: string; c: Vec2; r: number; construction?: boolean }
  | { type: "arc"; id: string; c: Vec2; r: number; start: number; end: number; construction?: boolean }
  // A smooth (interpolated) open spline through its control points. An open curve
  // — used for snapping and as a sweep path, not a region boundary.
  | { type: "spline"; id: string; points: Vec2[]; construction?: boolean }
  | { type: "point"; id: string; p: Vec2; construction?: boolean };

/** Dimensional/geometric constraints over sketch entities (solved by planegcs).
 *  `entity`/`a`/`b` reference SketchEntity ids. */
export type SketchConstraint =
  | { id: string; type: "horizontal"; entity: string }
  | { id: string; type: "vertical"; entity: string }
  | { id: string; type: "parallel"; a: string; b: string }
  | { id: string; type: "perpendicular"; a: string; b: string }
  | { id: string; type: "equal"; a: string; b: string }
  | { id: string; type: "distance"; entity: string; value: number }
  | { id: string; type: "radius"; entity: string; value: number }
  | { id: string; type: "angle"; a: string; b: string; value: number };

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
  /** Hidden (not rendered/pickable) — a view toggle, distinct from suppress. */
  hidden?: boolean;
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

/** How far an extrude reaches: a fixed `distance` one way ("blind"), `distance`
 *  split evenly both ways of the profile ("symmetric"), or far enough to fully
 *  clear the target body regardless of its shape ("throughAll" — add/remove
 *  only; a target-less extrude falls back to blind using `distance`). */
export type ExtrudeExtent = "blind" | "symmetric" | "throughAll";

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
  /** Blind/symmetric distance, as an expression string (e.g. "10" or "height/2").
   *  Ignored by "throughAll" once it resolves a target. */
  distance: string;
  /** Reverse the extrusion direction (against the profile normal). No effect
   *  when extent is "symmetric" (both directions are always extruded). */
  flip: boolean;
  extent: ExtrudeExtent;
  mode: ExtrudeMode;
  /** For add/remove: the body (by feature id) to fuse into / cut from. */
  targetId?: string;
  /** Display color/opacity for a "new" extrusion's body (like primitives).
   *  Ignored when the extrude is add/remove (it modifies an existing body). */
  color: number;
  opacity: number;
  hidden?: boolean;
}

/** A union/subtract/intersect of two or more earlier solid bodies, referenced
 *  by id. Operand order matters for subtract (first = base, rest = tools). */
export interface BooleanFeature extends FeatureBase {
  type: "boolean";
  op: BooleanOp;
  operands: string[];
  /** Inherited from the first operand at creation time — see document/colors.ts. */
  color: number;
  opacity: number;
  hidden?: boolean;
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

/** A user-created reference / construction plane. v1: offset (parallel) from a
 *  base datum / face / earlier plane by a (signed) distance. More placement
 *  methods (midplane, angle, through-geometry) come later. */
export interface PlaneFeature extends FeatureBase {
  type: "plane";
  base: SketchPlaneRef;
  /** Offset distance along the base's normal, as an expression string. */
  offset: string;
  /** Display color (0xRRGGBB), assigned once at creation from the pastel bank. */
  color: number;
}

/** A rigid transform (translate + rotate) applied to a body in place. A rigid
 *  motion doesn't alter topology, so the body keeps its identity AND its
 *  persistent topological names — downstream features still reference it. The
 *  body keeps the id of the feature that produced it (like chamfer/fillet).
 *  Phase 5.5. */
export interface TransformFeature extends FeatureBase {
  type: "transform";
  /** The body being moved (the feature id that produced it). */
  targetId: string;
  /** Translation along world X/Y/Z, as expression strings (mm). */
  tx: string;
  ty: string;
  tz: string;
  /** Rotation angle in degrees (expression), about `axis` through `pivot`. */
  angle: string;
  /** World axis the rotation turns about. */
  axis: "x" | "y" | "z";
  /** Pivot the rotation turns around (world space), baked at creation from the
   *  target body's centroid so the gizmo and kernel agree. */
  pivot: [number, number, number];
  /** Keep the original: when true the transform produces a NEW body (a moved
   *  copy, keyed by this feature) and leaves the target untouched; when false it
   *  moves the target in place (keeping its id). */
  copy: boolean;
  /** Appearance of the copied body (used only when `copy`). */
  color: number;
  opacity: number;
  hidden?: boolean;
}

/** Revolve a sketch region around an axis line (in a sketch) to make a solid.
 *  Like extrude, a body *producer*. (Phase 6.) */
export interface RevolveFeature extends FeatureBase {
  type: "revolve";
  /** The closed sketch region to revolve. */
  profile: { sketchId: string; regionId: string };
  /** The rotation axis: a line entity (its two endpoints define the axis). */
  axis: { sketchId: string; entityId: string };
  /** Revolve angle in degrees, as an expression (e.g. "360" or "angle/2"). */
  angle: string;
  color: number;
  opacity: number;
  hidden?: boolean;
}

/** Mirror a body across a plane, producing a new (reflected) body. The original
 *  is kept. The mirror plane is a datum / reference plane / planar face. */
export interface MirrorFeature extends FeatureBase {
  type: "mirror";
  /** The body being mirrored (the feature id that produced it). */
  targetId: string;
  /** The mirror plane. */
  plane: SketchPlaneRef;
  color: number;
  opacity: number;
  hidden?: boolean;
}

/** Sweep a sketch region (profile) along a path entity (line/arc/spline) in a
 *  sketch. A body *producer* like extrude/revolve. (Phase 6.) */
export interface SweepFeature extends FeatureBase {
  type: "sweep";
  /** The closed sketch region to sweep. */
  profile: { sketchId: string; regionId: string };
  /** The path/spine: a single open entity (line, arc, or spline) in a sketch. */
  path: { sketchId: string; entityId: string };
  color: number;
  opacity: number;
  hidden?: boolean;
}

/** Loft through two or more sketch regions (in timeline order) to make a solid.
 *  A body *producer*. (Phase 6.) */
export interface LoftFeature extends FeatureBase {
  type: "loft";
  /** Ordered closed sections to loft through (≥2). */
  profiles: { sketchId: string; regionId: string }[];
  color: number;
  opacity: number;
  hidden?: boolean;
}

/** A body imported from a CAD file (STEP for now). A body *producer*, like a
 *  primitive. The raw file text is stored on the feature (JSON-serializable, so
 *  it round-trips through IndexedDB / `.json`). */
export interface ImportFeature extends FeatureBase {
  type: "import";
  format: "step";
  /** Raw STEP file contents. */
  source: string;
  color: number;
  opacity: number;
  hidden?: boolean;
}

export type Feature =
  | PrimitiveFeature
  | SketchFeature
  | ExtrudeFeature
  | DressUpFeature
  | BooleanFeature
  | PlaneFeature
  | TransformFeature
  | MirrorFeature
  | RevolveFeature
  | SweepFeature
  | LoftFeature
  | ImportFeature;

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
