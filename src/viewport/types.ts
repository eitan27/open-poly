/** The shared vocabulary the viewport speaks to the rest of the app: the render
 *  payloads it is handed, the gizmo states it drives, and the imperative handle
 *  (`ViewportApi`) it exposes. Split out of `Viewport.tsx` so a module that only
 *  needs a type doesn't pull a 4,700-line three.js component — and the tests
 *  that exercise pure logic don't pull three.js at all. */
import type { SketchRegion } from "../document/regions";
import type { PlaneFrameData, SketchPlaneRef } from "../document/planes";
import type { SketchEntity } from "../document/types";
import type { ShapeMeshPayload } from "../kernel/types";

export interface FeatureMesh {
  id: string;
  mesh: ShapeMeshPayload;
  /** Base display color (0xRRGGBB) for this body's faces. */
  color: number;
  /** Base display opacity, 0–1 (before the sketch-mode dim override). */
  opacity: number;
}

/** A would-be result rendered as a translucent "ghost" before the user commits
 *  (e.g. the Extrude dialog's live preview). It lives in its own group with
 *  fixed materials, so it's never raycast-pickable and never participates in
 *  selection highlighting — callers omit the body it stands in for from
 *  `meshes` themselves. */
export interface GhostMesh {
  mesh: ShapeMeshPayload;
  /** How the ghost reads:
   *   • "add" (default) — the cyan "this will appear" solid of the extrude /
   *     revolve / pattern previews. Depth-tested: it stands where a real body
   *     would, so it must be occluded like one.
   *   • "fill" / "cut" — the two halves of a dress-up delta: the material a
   *     chamfer/fillet ADDS (a fillet bridging a concave corner) and the
   *     material it CARVES OFF (a bevel, a rounded-off corner). Warm vs. cool
   *     so "this goes away" never reads as "this arrives".
   *
   *  The delta pair is drawn WITHOUT depth testing, because a delta is flush
   *  with the body it changes and would otherwise be invisible: before you
   *  commit, a chamfer's wedge lies entirely inside the un-chamfered solid
   *  (two of its faces exactly coplanar with the body's), and while editing —
   *  where the change is already applied to the model — the added material
   *  likewise lies inside the finished body. Drawn on top, the delta reads as a
   *  translucent band hugging the edge in both cases. */
  variant?: "add" | "fill" | "cut";
}

export interface RenderSketch {
  id: string;
  frame: PlaneFrameData;
  entities: SketchEntity[];
  regions: SketchRegion[];
}

/** A user reference plane to render + pick. */
export interface RenderPlane {
  id: string;
  name: string;
  frame: PlaneFrameData;
  color: number;
}

export type TransformMode = "translate" | "rotate" | "scale";

/** The live state of the Transform gizmo: which body it sits on, its rotation /
 *  scaling pivot, and the current (resolved, numeric) translate/rotate/scale
 *  values. Numbers, not expressions — the gizmo is a numeric input device; the
 *  dialog owns text. */
export interface TransformEdit {
  featureId: string;
  /** Which rendered body the gizmo moves: the source body (move-in-place) or the
   *  copy keyed by the feature (copy=true). Used for the live drag preview. */
  bodyId: string;
  pivot: [number, number, number];
  tx: number;
  ty: number;
  tz: number;
  /** Rotation angle in degrees about `axis`. */
  angle: number;
  /** The rotation axis as a world LINE — `dir` is what the body turns about and
   *  `origin` a point it passes through. A world-axis transform resolves to the
   *  pivot plus a unit direction (so it still spins the body on the spot); a
   *  picked sketch line or body edge to its own line, which is what makes the
   *  body hinge around it instead. Always unit-length `dir`. */
  axis: { origin: [number, number, number]; dir: [number, number, number] };
  /** Uniform scale factor about `pivot` (> 0; 1 = unscaled). */
  scale: number;
}

/** Numeric values the gizmo emits on each drag (written back as the feature's
 *  translate/rotate/scale expressions). */
export interface TransformDelta {
  tx: number;
  ty: number;
  tz: number;
  angle: number;
  scale: number;
}

/** The live state of the extrude-distance gizmo: a single arrow at the
 *  extrusion's tip, dragged along the extrude axis. Numbers, not expressions —
 *  like TransformEdit, the gizmo is a numeric input device; the dialog owns
 *  text. Null when no extrude is being created/edited (or its extent ignores
 *  the distance — through-all / up-to-face / up-to-next). */
export interface ExtrudeGizmo {
  /** World anchor on the profile (region centroid / picked face's centroid). */
  origin: [number, number, number];
  /** Unit world direction the extrusion currently travels (the profile plane's
   *  normal with the mode/flip sign already folded in). */
  dir: [number, number, number];
  /** Resolved numeric distance (mm). The TOTAL span for symmetric. */
  distance: number;
  /** Symmetric extent: the arrow sits at distance/2 and a drag sets the total. */
  symmetric: boolean;
}

/** A revolve-axis pick from the unified "Select axis" arming: a sketch line, a
 *  straight body edge (the axis line itself), a body face (resolved to a line in
 *  the kernel), or a datum/reference plane. */
export type RevolveAxisPick =
  | { kind: "line"; sketchId: string; entityId: string }
  | { kind: "bodyEdge"; featureId: string; edgeId: number }
  | { kind: "bodyFace"; featureId: string; faceId: number }
  | { kind: "plane"; ref: SketchPlaneRef };

export type SketchTool =
  | "select"
  | "line"
  | "rect-corner"
  | "rect-center"
  | "circle-center"
  | "circle-3p"
  | "polygon"
  | "arc-3p"
  | "spline"
  | "offset"
  | "mirror"
  | "project"
  | "trim"
  | "extend"
  | "pattern-linear"
  | "pattern-circular"
  | "text";

export type ViewName = "front" | "back" | "left" | "right" | "top" | "bottom" | "iso";

export interface ViewportApi {
  setView(name: ViewName): void;
  /** Snap to the default iso 3/4 view, zoomed to fit every body and every
   *  visible sketch in the scene (bounding-sphere fit + margin). Falls back to
   *  the plain iso view about the world origin when nothing is modelled yet. */
  homeView(): void;
  /** Switch the camera between perspective and orthographic projection,
   *  preserving the current view (position/target and apparent scale). */
  setProjection(mode: "perspective" | "orthographic"): void;
  /** Orient the camera face-on to `frame` (looking down its normal, up = vAxis).
   *  Aims at `aim` when given — the point the user actually clicked to start the
   *  sketch — else the frame origin, and keeps the current viewing distance so
   *  entering a sketch doesn't yank the camera to a fixed far standoff. */
  lookAtFrame(frame: PlaneFrameData, aim?: [number, number, number]): void;
  /** Orient to `frame` like `lookAtFrame`, but centre the view on the given
   *  in-plane (u,v) bounds and zoom so they fit — used after a DXF import, whose
   *  geometry can sit far from the plane origin (and so be off-screen with the
   *  default framing). `min`/`max` are the entities' 2D bounding box. */
  frameSketchBounds(frame: PlaneFrameData, min: [number, number], max: [number, number]): void;
  /** Project a world point to pixel coords relative to the canvas top-left. */
  worldToScreen(p: [number, number, number]): { x: number; y: number };
  /** The ordered world-space polyline of a body edge (by feature + edge id), as
   *  drawn — the source geometry the Project/Convert sketch tool projects onto
   *  the active plane. Null if that edge isn't currently rendered. */
  getEdgeWorldPolyline(featureId: string, edgeId: number): [number, number, number][] | null;
  /** The persistent topological name of a body edge (stable across rebuilds),
   *  captured when an edge is picked for an associative projection. Undefined if
   *  the edge has no name or isn't rendered. */
  getEdgeName(featureId: string, edgeId: number): string | undefined;
  /** Like `getEdgeWorldPolyline` but resolves the edge by its persistent name —
   *  used to re-project associative geometry after a rebuild (the build-local
   *  `edgeId` can renumber, the name doesn't). Null if no edge with that name is
   *  currently rendered (a dangling projection). */
  getEdgeWorldPolylineByName(featureId: string, name: string): [number, number, number][] | null;
  /** Render the current scene and return it as a PNG data URL — the agent's
   *  visual feedback. Finalizes any in-flight camera tween first so a
   *  preceding setView is reflected immediately. `plain` renders the capture
   *  frame with ALL highlights suppressed (selection/hover/whole-body/boolean
   *  operands) — for document thumbnails, where an orange selected part would
   *  mislead — then restores them; all synchronous, so nothing flickers
   *  on screen. Agent screenshots stay un-plain: highlighting the selection is
   *  how `select` + `screenshot` communicate. */
  capturePNG(opts?: { plain?: boolean }): string;
}
