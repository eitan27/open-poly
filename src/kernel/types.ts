// The Kernel facade. Application code (UI, document model) talks ONLY to these
// types — replicad / OpenCascade never leak past this boundary. This is the
// swap-point that lets us replace the implementation with direct opencascade.js
// calls later without touching the rest of the app.

// Mesh buffers are typed arrays (Float32Array positions/normals, Uint32Array
// indices) so the worker→main postMessage copies raw ArrayBuffers (a fast memcpy)
// instead of structured-cloning millions of JS numbers — the difference is ~100×
// on a large imported assembly. `number[]` is still permitted for main-thread-only
// producers (e.g. transform-ghost previews that never cross the worker boundary).
export type FloatBuffer = Float32Array | number[];
export type IndexBuffer = Uint32Array | number[];

/** Analytic facts about a face's underlying surface, resolved in the worker from
 *  the kernel. The tessellation alone can't supply these — a cylinder and a
 *  finely-faceted prism have identical triangles — so a radius has to come from
 *  OCCT. Only the faces we can describe unambiguously get one. */
export type FaceSurface =
  /** A cylindrical face: a hole's bore, a shaft's side. */
  | { kind: "cylinder"; radius: number }
  /** A flat face bounded by a single circle. */
  | { kind: "disc"; radius: number }
  /** A flat ring: a circular face with exactly one circular hole in it. */
  | { kind: "annulus"; radius: number; innerRadius: number };

export interface MeshedFaces {
  vertices: FloatBuffer;
  triangles: IndexBuffer;
  normals?: FloatBuffer;
  /** Maps ranges of the triangle buffer back to a topological face. `faceId` is
   *  the build-local pick id (OCCT hash); `name` is the persistent topological
   *  name (stable across rebuilds) used by feature references; `surface` is the
   *  analytic description, when the face has one we can name. `clusterId` groups
   *  the facets of ONE logical curved surface (a faceted cylinder's N side
   *  faces, a tangent fillet blend) — faces joined across sub-crease "smooth"
   *  edges share a clusterId, so a click selects the whole surface, not a slice.
   *  Build-local (a representative face's hash); a flat box face is its own
   *  singleton cluster. */
  faceGroups?: {
    start: number;
    count: number;
    faceId: number;
    name?: string;
    surface?: FaceSurface;
    clusterId?: number;
  }[];
}

export interface MeshedEdges {
  lines: FloatBuffer;
  /** Maps ranges of the line buffer back to a topological edge. `edgeId` is the
   *  build-local pick id; `name` is the persistent name (derived from the two
   *  adjacent faces' names) used by feature references like chamfer/fillet.
   *  `chainId` groups the tangent-continuous straight segments that approximate
   *  ONE smooth curve (a faceted circle's N rim chords) so a click selects the
   *  whole circle, not a chord. Build-local (a representative edge's hash); a
   *  sharp-cornered edge is its own singleton chain. */
  edgeGroups?: { start: number; count: number; edgeId: number; name?: string; chainId?: number }[];
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

/** An ordered, oriented boundary segment of a sketch-region profile, used to
 *  rebuild the profile with TRUE curves so a circular/arc cross-section sweeps as
 *  a smooth tube instead of a faceted polygon. `to` is the segment's end point in
 *  loop order; an arc also carries a `mid` point lying on the curve (so it's
 *  built orientation-free via a three-point arc). The loop starts at the
 *  profile's `segmentStart`. */
export type ProfileSegment =
  { kind: "line"; to: [number, number] } | { kind: "arc"; mid: [number, number]; to: [number, number] };

/** A profile to extrude, resolved for the kernel: either a baked sketch outline
 *  (closed loop in u,v on a frame) or a reference to a face of a running body
 *  (resolved against the body set inside the worker, where the B-rep lives).
 *  `segments`/`segmentStart`, when present, give the same loop as exact curves
 *  (lines + arcs) — the kernel prefers them over the faceted `outline`. */
export type ResolvedProfile =
  | {
      kind: "sketchRegion";
      outline: [number, number][];
      frame: ResolvedFrame;
      segmentStart?: [number, number];
      segments?: ProfileSegment[];
      holes?: [number, number][][];
    }
  // `faceName` is the persistent topological name (preferred); `center` (+
  // optional `normal`, for planar faces) is the geometric fingerprint used to
  // re-match the face when the name no longer exists on the rebuilt body.
  | {
      kind: "bodyFace";
      sourceId: string;
      faceName?: string;
      center: [number, number, number];
      normal?: [number, number, number];
    }
  // A text run, baked to glyph faces in the worker (replicad `textBlueprints`,
  // which does even-odd counters/holes). `anchor` is the baseline-left in u,v,
  // `rotation` in radians (CCW about the anchor), `height` the em size.
  | {
      kind: "sketchText";
      value: string;
      height: number;
      rotation: number;
      anchor: [number, number];
      frame: ResolvedFrame;
    };

/** How an extrude combines with the running body set. */
export type ExtrudeMode = "new" | "add" | "remove";

/** How far an extrude reaches — see document/types.ts's ExtrudeExtent for the
 *  full description; mirrored here since the kernel doesn't import the
 *  document model. */
export type ExtrudeExtent = "blind" | "symmetric" | "throughAll" | "upToFace" | "upToNext";

/** Resolved "up to face" target: the body (by id) and the face on it, found by
 *  persistent name (preferred) or geometric fingerprint inside the worker. */
export interface ResolvedUpToFace {
  sourceId: string;
  faceName?: string;
  center: [number, number, number];
  normal?: [number, number, number];
}

/** An edge reference's geometric fingerprint, stored when the edge was picked
 *  (alongside its persistent name) so the worker can re-match the edge when an
 *  upstream edit renamed it. `mid` is the edge's bounding-box centre. */
export interface ResolvedEdgeRef {
  name: string;
  mid?: [number, number, number];
  length?: number;
}

/** A face reference's geometric fingerprint, same role as ResolvedEdgeRef.
 *  `center` is the face's centroid; `normal` is set for planar faces only. */
export interface ResolvedFaceRef {
  name: string;
  center?: [number, number, number];
  normal?: [number, number, number];
}

/** Features with all parameters already resolved to numbers/geometry
 *  (expressions are evaluated in the app layer before reaching the kernel). */
export type ResolvedFeature =
  | { id: string; type: "primitive"; kind: PrimitiveKind; params: Record<string, number> }
  // `previewTool`: emit only the swept tool (the changing portion) as the body,
  // skipping the fuse/cut — used by the live extrude ghost preview so existing
  // bodies keep their own colour. Targets are still resolved so "throughAll"
  // sizes correctly.
  | {
      id: string;
      type: "extrude";
      /** One tool per profile. In "new" they gather into a single body, which
       *  the fold then splits into one part per disjoint solid; in add/remove
       *  each goes into its own target (a body-face profile's own body, else
       *  `targetId`). */
      profiles: ResolvedProfile[];
      distance: number;
      flip: boolean;
      extent: ExtrudeExtent;
      mode: ExtrudeMode;
      targetId?: string;
      upTo?: ResolvedUpToFace;
      previewTool?: boolean;
    }
  // `edges` are persistent names; `edgeRefs` (parallel, when the doc has them)
  // carry the geometric fingerprints used to re-match renamed edges.
  // `angle` (chamfer only, degrees from the reference face) is absent for a
  // plain symmetric chamfer, so its content key matches a pre-angle document's.
  // `previewDelta`: additionally emit the material the dress-up takes away and
  // the material it adds, as the extra preview bodies `<id>::removed` /
  // `<id>::added` — see DRESSUP_DELTA_IDS. The target is still dressed normally,
  // so downstream features (and this feature's own error) are unaffected.
  // `faces` dress every boundary edge of the named faces (see DressUpFeature) —
  // they are expanded to edges by the worker, which has the topology to do it.
  | {
      id: string;
      type: "dressup";
      op: "chamfer" | "fillet";
      /** One entry per body dressed. Edge names only mean something on the body
       *  they came from, so each target carries its own reference list. */
      targets: {
        targetId: string;
        edges: string[];
        edgeRefs?: ResolvedEdgeRef[];
        faces?: string[];
        faceRefs?: ResolvedFaceRef[];
      }[];
      size: number;
      angle?: number;
      flip?: boolean;
      previewDelta?: boolean;
    }
  // Hollow out a body: remove `faces` (by persistent name, `faceRefs` the
  // parallel geometric fingerprint) and leave a wall of `thickness` around
  // what remains. Zero faces = a fully sealed hollow shell.
  | { id: string; type: "shell"; targetId: string; faces: string[]; faceRefs?: ResolvedFaceRef[]; thickness: number }
  // A boolean combines existing bodies (by id) from the running set.
  | { id: string; type: "boolean"; op: BooleanOp; operands: string[] }
  // A transform moves a body (by id) — uniform scale about `pivot`, then rotate
  // about the axis LINE, then translate. `scale` is always > 0 (validated when
  // resolving). `copy` keeps the original and emits the moved body as a NEW body
  // (keyed by this feature). The axis arrives baked as `axisOrigin`+`axisDir`
  // (a world axis bakes to the pivot + that direction, so it still spins the
  // body on the spot) — EXCEPT a body-edge axis, which lives in the B-rep and
  // comes through as `axisEdge` for the worker to resolve, exactly like
  // revolve's. Exactly one of the two is present.
  | {
      id: string;
      type: "transform";
      targetId: string;
      tx: number;
      ty: number;
      tz: number;
      angle: number;
      axisOrigin?: [number, number, number];
      axisDir?: [number, number, number];
      axisEdge?: { sourceId: string; edgeName?: string; mid?: [number, number, number]; length?: number };
      scale: number;
      pivot: [number, number, number];
      copy: boolean;
    }
  // Mirror a body (by id) across the plane through `origin` with `normal`,
  // producing a new reflected body (the original is kept).
  | { id: string; type: "mirror"; targetId: string; origin: [number, number, number]; normal: [number, number, number] }
  // Repeat a body (by id) as rigid copies compounded into ONE new body (the
  // seed is kept). Exactly one of `offsets`/`angles` is present, both baked in
  // the app layer and EXCLUDING the seed: linear copies translate by each of
  // `offsets` (world mm); circular copies rotate by each of `angles` (radians)
  // about the axis — a baked world line, or a body face resolved in the worker
  // (cylindrical/conical → that surface's own central axis).
  | {
      id: string;
      type: "pattern";
      targetId: string;
      offsets?: [number, number, number][];
      angles?: number[];
      axisOrigin?: [number, number, number];
      axisDir?: [number, number, number];
      axisFace?: {
        sourceId: string;
        faceName?: string;
        center: [number, number, number];
        normal?: [number, number, number];
      };
    }
  // Revolve a sketch profile around an axis by an angle. The axis is either a
  // baked world line (`axisOrigin`+`axisDir`, for sketch-line axes and for plane
  // axes on a sketch-region profile, resolved in the document layer), a plane
  // deferred to the worker (`axisPlane`, when the profile is a body face), OR a
  // body face (`axisFace`, resolved in the kernel against the profile plane —
  // planar → plane∩profile, cylinder/cone → the surface axis), OR a straight body
  // edge (`axisEdge`, the line through its endpoints). Exactly one form is
  // present.
  | {
      id: string;
      type: "revolve";
      profile: ResolvedProfile;
      angle: number;
      symmetric: boolean;
      axisOrigin?: [number, number, number];
      axisDir?: [number, number, number];
      /** A PLANE axis that couldn't be baked in the document layer because the
       *  profile is a body face (its plane is only known once the B-rep is
       *  built): the worker intersects this frame with the profile's plane. */
      axisPlane?: ResolvedFrame;
      axisFace?: {
        sourceId: string;
        faceName?: string;
        center: [number, number, number];
        normal?: [number, number, number];
      };
      /** A straight body EDGE axis, resolved in the worker (name first, then the
       *  mid/length fingerprint) and read as the line through its endpoints. */
      axisEdge?: { sourceId: string; edgeName?: string; mid?: [number, number, number]; length?: number };
    }
  // Sweep a sketch profile along a path (baked to 2D points on a frame). For a
  // spline, `beziers` carries the exact cubic-Bézier spans of the drawn curve
  // (the spine is built from them, so it matches the sketch exactly); otherwise
  // `smooth` fits a B-spline through `points` (arcs) or it's a polyline (lines).
  | {
      id: string;
      type: "sweep";
      profile: ResolvedProfile;
      path: {
        points: [number, number][];
        smooth: boolean;
        frame: ResolvedFrame;
        beziers?: { c1: [number, number]; c2: [number, number]; end: [number, number] }[];
      };
    }
  // Loft through 2+ sketch profiles (in order).
  | { id: string; type: "loft"; profiles: ResolvedProfile[] }
  // A body imported from a CAD file (the raw STEP text).
  | { id: string; type: "import"; source: string };

/** The body ids a `previewDelta` dress-up emits alongside the dressed target:
 *  the solid it cuts away (before − after) and the solid it fills in
 *  (after − before). A chamfer/fillet on a convex edge produces only `removed`,
 *  on a concave edge only `added`; a feature spanning both produces both. */
/** The id a dress-up's preview deltas hang off for its n-th target. The first
 *  keeps the plain feature id, so a single-target dress-up's delta ids are
 *  exactly what they were before one feature could dress several bodies. */
export const dressUpDeltaBase = (featureId: string, targetIndex: number): string =>
  targetIndex === 0 ? featureId : `${featureId}#${targetIndex}`;

export const DRESSUP_DELTA_IDS = {
  removed: (featureId: string) => `${featureId}::removed`,
  added: (featureId: string) => `${featureId}::added`,
} as const;

export type RegenFeatureResult =
  { id: string; ok: true; mesh: ShapeMeshPayload } | { id: string; ok: false; error: string };

/** The complete outcome of a regenerate: one result per surviving body (plus
 *  one per failed feature), and non-fatal per-FEATURE warnings — e.g. "this
 *  reference was re-matched geometrically after an upstream edit renamed it"
 *  or "2 of 4 edges could not be re-found". Keyed by feature id (a dress-up's
 *  own id, not the body it modified). */
export interface RegenOutcome {
  results: RegenFeatureResult[];
  warnings: Record<string, string>;
}

export type ExportFormat = "step" | "stl";

/** The contract implemented by the worker-backed client. Grows per phase. */
export interface Kernel {
  /** Replay the feature list and tessellate the surviving bodies. `onProgress`,
   *  if given, fires once per body as it's meshed (for progressive painting);
   *  the resolved outcome is still the complete, authoritative result. */
  regenerate(
    features: ResolvedFeature[],
    onProgress?: (result: RegenFeatureResult) => void,
    onMeshProgress?: (featureId: string, done: number, total: number) => void,
  ): Promise<RegenOutcome>;
  /** Replays the feature list and exports the result body with `bodyId`.
   *  Geometry is authored in millimetres throughout, so STEP declares "mm". */
  exportBody(features: ResolvedFeature[], bodyId: string, format: ExportFormat): Promise<Blob>;
  dispose(): void;
}
