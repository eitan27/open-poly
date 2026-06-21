// The Kernel facade. Application code (UI, document model) talks ONLY to these
// types — replicad / OpenCascade never leak past this boundary. This is the
// swap-point that lets us replace the implementation with direct opencascade.js
// calls later without touching the rest of the app.

export interface MeshedFaces {
  vertices: number[];
  triangles: number[];
  normals?: number[];
  /** Maps ranges of the triangle buffer back to a topological face. `faceId` is
   *  the build-local pick id (OCCT hash); `name` is the persistent topological
   *  name (stable across rebuilds) used by feature references. */
  faceGroups?: { start: number; count: number; faceId: number; name?: string }[];
}

export interface MeshedEdges {
  lines: number[];
  /** Maps ranges of the line buffer back to a topological edge. `edgeId` is the
   *  build-local pick id; `name` is the persistent name (derived from the two
   *  adjacent faces' names) used by feature references like chamfer/fillet. */
  edgeGroups?: { start: number; count: number; edgeId: number; name?: string }[];
}

/** A tessellated shape ready to be uploaded to three.js. */
export interface ShapeMeshPayload {
  name: string;
  faces: MeshedFaces;
  edges: MeshedEdges;
}

/** Primitive solids the kernel knows how to build (Phase 1). */
export type PrimitiveKind = "box" | "cylinder" | "sphere";

/** Boolean combination operators. */
export type BooleanOp = "union" | "subtract" | "intersect";

/** An orthonormal coordinate frame (world space). */
export interface ResolvedFrame {
  origin: [number, number, number];
  uAxis: [number, number, number];
  vAxis: [number, number, number];
  normal: [number, number, number];
}

/** A profile to extrude, resolved for the kernel: either a baked sketch outline
 *  (closed loop in u,v on a frame) or a reference to a face of a running body
 *  (resolved against the body set inside the worker, where the B-rep lives). */
export type ResolvedProfile =
  | { kind: "sketchRegion"; outline: [number, number][]; frame: ResolvedFrame }
  // `faceName` is the persistent topological name (preferred); `center` is the
  // centroid fallback for faces that don't have a name yet.
  | { kind: "bodyFace"; sourceId: string; faceName?: string; center: [number, number, number] };

/** How an extrude combines with the running body set. */
export type ExtrudeMode = "new" | "add" | "remove";

/** How far an extrude reaches — see document/types.ts's ExtrudeExtent for the
 *  full description; mirrored here since the kernel doesn't import the
 *  document model. */
export type ExtrudeExtent = "blind" | "symmetric" | "throughAll";

/** Features with all parameters already resolved to numbers/geometry
 *  (expressions are evaluated in the app layer before reaching the kernel). */
export type ResolvedFeature =
  | { id: string; type: "primitive"; kind: PrimitiveKind; params: Record<string, number> }
  // `previewTool`: emit only the swept tool (the changing portion) as the body,
  // skipping the fuse/cut — used by the live extrude ghost preview so existing
  // bodies keep their own colour. Targets are still resolved so "throughAll"
  // sizes correctly.
  | { id: string; type: "extrude"; profile: ResolvedProfile; distance: number; flip: boolean; extent: ExtrudeExtent; mode: ExtrudeMode; targetId?: string; previewTool?: boolean }
  | { id: string; type: "dressup"; op: "chamfer" | "fillet"; targetId: string; edges: string[]; size: number }
  // A boolean combines existing bodies (by id) from the running set.
  | { id: string; type: "boolean"; op: BooleanOp; operands: string[] }
  // A rigid transform moves a body (by id) — translate + rotate. `copy` keeps
  // the original and emits the moved body as a NEW body (keyed by this feature).
  | { id: string; type: "transform"; targetId: string; tx: number; ty: number; tz: number; angle: number; axis: "x" | "y" | "z"; pivot: [number, number, number]; copy: boolean }
  // Mirror a body (by id) across the plane through `origin` with `normal`,
  // producing a new reflected body (the original is kept).
  | { id: string; type: "mirror"; targetId: string; origin: [number, number, number]; normal: [number, number, number] }
  // Revolve a sketch profile around an axis (origin + direction) by an angle.
  | { id: string; type: "revolve"; profile: ResolvedProfile; angle: number; axisOrigin: [number, number, number]; axisDir: [number, number, number] }
  // Sweep a sketch profile along a path (baked to 2D points on a frame; `smooth`
  // builds a B-spline spine, else a polyline).
  | { id: string; type: "sweep"; profile: ResolvedProfile; path: { points: [number, number][]; smooth: boolean; frame: ResolvedFrame } }
  // Loft through 2+ sketch profiles (in order).
  | { id: string; type: "loft"; profiles: ResolvedProfile[] }
  // A body imported from a CAD file (the raw STEP text).
  | { id: string; type: "import"; source: string };

export type RegenFeatureResult =
  | { id: string; ok: true; mesh: ShapeMeshPayload }
  | { id: string; ok: false; error: string };

export type ExportFormat = "step" | "stl";

/** The contract implemented by the worker-backed client. Grows per phase. */
export interface Kernel {
  regenerate(features: ResolvedFeature[]): Promise<RegenFeatureResult[]>;
  /** Replays the feature list and exports the result body with `bodyId`.
   *  Geometry is authored in millimetres throughout, so STEP declares "mm". */
  exportBody(features: ResolvedFeature[], bodyId: string, format: ExportFormat): Promise<Blob>;
  dispose(): void;
}
