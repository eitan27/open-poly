import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import {
  addRotationArrowheads,
  closeRotationRings,
  dropBackwardArrow,
  joinShaftsToBothArrows,
  softenGizmo,
} from "./gizmoShape";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { TransformControls } from "three/examples/jsm/controls/TransformControls.js";
import { LineSegments2 } from "three/examples/jsm/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/examples/jsm/lines/LineSegmentsGeometry.js";
import { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";
import { Line2 } from "three/examples/jsm/lines/Line2.js";
import { LineGeometry } from "three/examples/jsm/lines/LineGeometry.js";
import { getEdgeId, getFaceId } from "replicad-threejs-helper";
import type { MouseDragAction, ResolvedTheme } from "../settings/settings";
import { VIEWPORT_THEMES } from "../settings/viewportTheme";

import { faceBoundaryEdges, nearestHitInPixels, realVertexNear, syncBodyGeometry } from "./geometryQuery";
import { fitCircle, nearestOnSegment, transformMatrix } from "./sceneMath";
import { buttCaps, createSectionCapTriple, makeBodyMaterial } from "./materials";
import { createViewCube, type CubeHit, type ViewCube } from "./viewCube";
import type { SketchEntity, Vec2 } from "../document/types";
import { buildGuides, snapToGuides, type Guide } from "../sketch/inference";
import {
  deriveFaceFrame,
  uvToWorld,
  type PlaneFrameData,
  type SketchPlaneId,
  type SketchPlaneRef,
  type Vec3,
} from "../document/planes";
import { resolveSectionPlane, sectionKeeps } from "../document/sectionView";
import {
  arcFrom3,
  circleFrom3,
  rectangleCorners,
  rectangleFromCenter,
  regularPolygon,
  sampleArc,
  sampleCircle,
  sampleSpline,
} from "../document/sketchTools";
import { getSketchFont, loadSketchFont, textToContours } from "../document/text";
import { sameSelection, type DatumId, type Selection, type SelectionFilter } from "../selection/types";
import type {
  ExtrudeGizmo,
  FeatureMesh,
  GhostMesh,
  RenderPlane,
  RenderSketch,
  RevolveAxisPick,
  SketchTool,
  TransformDelta,
  TransformEdit,
  TransformMode,
  ViewName,
  ViewportApi,
} from "./types";

/** The yellow a gizmo handle lights up in when it's hovered or being dragged.
 *  TransformControls paints its own active handle with `materialLib.active`
 *  (`matYellow`), and softenGizmo never reaches that material — no handle mesh
 *  uses it — so the move and rotate gizmos highlight in exactly this. The scale
 *  gizmo is ours to paint, and matches it on purpose: one highlight colour means
 *  "this is the thing you're about to drag" everywhere in the viewport. */
const GIZMO_ACTIVE = 0xffff00;
/** Step the scale factor snaps to while dragging the gizmo (5%). */
const SCALE_SNAP = 0.05;
/** On-screen half-width of a scale gizmo corner grip, in CSS pixels. Held
 *  constant on screen so the grips stay grabbable whatever the body's size. */
const SCALE_GRIP_PX = 5.5;
/** How close to the pivot a grab may be (screen px) before its distance ratio
 *  stops being a usable scale factor. */
const SCALE_MIN_GRAB_PX = 10;
/** Scratch vector for the scale gizmo's per-frame bounds loop (one allocation,
 *  not one per mesh vertex). */
const _scaleTmp = new THREE.Vector3();
/** Scratch vector for moving highlight vertices with a dragged body (same
 *  reason: this runs once per highlighted vertex, every drag frame). */
const _highlightTmp = new THREE.Vector3();
/** The proxy's local rotate axis, and a scratch for aligning it to a world one. */
const _unitZ = new THREE.Vector3(0, 0, 1);
const _axisTmp = new THREE.Vector3();

/** The quaternion that carries the rotate proxy's local +Z onto a rotation axis.
 *  The rotate gizmo runs in LOCAL space with only the Z ring shown, so the ring
 *  lies across the axis whatever direction it points — which is the whole reason
 *  an arbitrary (edge / sketch-line) axis can be dragged at all, and the frame
 *  the dragged angle is read back against (see proxyDelta). */
function axisFrameQuaternionOf(dir: [number, number, number]): THREE.Quaternion {
  return new THREE.Quaternion().setFromUnitVectors(_unitZ, _axisTmp.set(dir[0], dir[1], dir[2]).normalize());
}
/** The eight corners of a unit box, as sign triples. */
const BOX_CORNERS: [number, number, number][] = [
  [-1, -1, -1],
  [-1, -1, 1],
  [-1, 1, -1],
  [-1, 1, 1],
  [1, -1, -1],
  [1, -1, 1],
  [1, 1, -1],
  [1, 1, 1],
];

/** Tools that pick/click existing entities (entity selection) rather than draw
 *  new geometry on the plane: Select, the Mirror tool (which clicks an axis line
 *  and then entities to reflect), the Pattern tools (which click entities to
 *  repeat — and, for circular, a center point via the snapped uv passed along
 *  with each pick), and Project/Convert (which clicks body edges / vertices to
 *  pull into the sketch). Routes clicks to onSelect, not onSketchClick, and
 *  keeps selection-hover highlighting live. */
function isPickTool(t: SketchTool): boolean {
  return (
    t === "select" ||
    t === "mirror" ||
    t === "project" ||
    t === "pattern-linear" ||
    t === "pattern-circular" ||
    t === "trim" ||
    t === "extend"
  );
}
/** Tools that act on the entity under the cursor and want to show what they'd
 *  do to it before the click lands. */
const isTrimTool = (t: SketchTool): boolean => t === "trim" || t === "extend";

interface DatumEntry {
  id: DatumId;
  object: THREE.Object3D;
  kind: "point" | "plane";
  material: THREE.Material & { opacity: number };
  outline?: THREE.LineSegments;
  baseOpacity: number;
}

interface SceneState {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera | THREE.OrthographicCamera;
  controls: OrbitControls;
  group: THREE.Group;
  // Whether sketch-edit mode is dimming solids (applied per-body since each
  // body now owns its own base-color material instead of sharing one).
  sketchDimActive: boolean;
  selectedMaterial: THREE.MeshStandardMaterial;
  hoverMaterial: THREE.MeshStandardMaterial;
  lineMaterial: THREE.LineBasicMaterial;
  // Fat-line overlay that draws highlighted body edges + sketch entities on top.
  highlightMaterial: LineMaterial;
  highlightOverlay: LineSegments2;
  // Dashed twin of the overlay, used for construction (reference) sketch geometry.
  highlightMaterialDash: LineMaterial;
  highlightOverlayDash: LineSegments2;
  // Highlighted vertices / sketch points (selected + hovered) as coloured points.
  pointMarkers: THREE.Points;
  datums: DatumEntry[];
  sketchGroup: THREE.Group;
  /** User-created reference planes (translucent quads), rebuilt from the prop. */
  planeGroup: THREE.Group;
  /** The reference-plane dialog's live ghost quad (rebuilt from `ghostPlane`).
   *  Its own group, kept OUT of `planeGroup`, so the plane-pick raycasts never
   *  see it: the ghost is a preview of a plane that doesn't exist yet, and it
   *  sits exactly where the user is still clicking to pick its own inputs. */
  ghostPlaneGroup: THREE.Group;
  /** The live ghost-preview bodies (rebuilt from the `ghostMeshes` prop). */
  ghostGroup: THREE.Group;
  ghostMaterial: THREE.MeshStandardMaterial;
  ghostLineMaterial: THREE.LineBasicMaterial;
  /** Dress-up delta ghosts: material the operation adds / carves off. */
  ghostFillMaterial: THREE.MeshStandardMaterial;
  ghostFillLineMaterial: THREE.LineBasicMaterial;
  ghostCutMaterial: THREE.MeshStandardMaterial;
  ghostCutLineMaterial: THREE.LineBasicMaterial;
  /** A whole body a Boolean subtract will consume — the removal red as an
   *  ordinary, occluded ghost (see the material's own comment). */
  ghostCutBodyMaterial: THREE.MeshStandardMaterial;
  // The translate/rotate gizmo and the invisible proxy object it drives. The
  // proxy's position/rotation are read back as the Transform feature's values.
  transformControls: TransformControls;
  gizmoProxy: THREE.Object3D;
  /** Active gizmo drag: the moved body's render objects plus the inverse of the
   *  transform matrix it had when the drag began. Each frame we re-pose those
   *  objects with (current matrix · m0⁻¹) — a rigid motion is topology-preserving,
   *  so the body's geometry is just its committed mesh moved by a matrix, and we
   *  skip the kernel entirely until the drag is released (one regenerate, not one
   *  per frame — the difference between instant and stuck in a many-body doc). */
  liveDrag: {
    /** The body being dragged — `delta` applies to ITS geometry and nothing else. */
    bodyId: string;
    objects: THREE.Object3D[];
    m0Inverse: THREE.Matrix4;
    /** The motion the drag has applied so far (current matrix · m0⁻¹). Highlight
     *  overlays copy vertices straight out of the body's baked-world geometry,
     *  which the drag never touches, so they have to be moved by this to travel
     *  with the body instead of hanging in the air where it started. */
    delta: THREE.Matrix4;
  } | null;
  /** A just-released drag whose kernel regenerate is still in flight. The commit
   *  changes the document immediately, which rebuilds the body's objects from the
   *  STILL-STALE meshes (original position) before the new geometry lands — so we
   *  re-pin the dragged matrix onto each rebuild until the body's mesh reference
   *  actually changes (the real geometry), avoiding a flash back to the origin. */
  pendingCommit: { bodyId: string; delta: THREE.Matrix4; meshRef: unknown } | null;
  // The rubber-band preview while drawing (line/rect/arc/polygon), as a fat line
  // so it reads as clearly as a committed sketch line.
  previewLine: Line2;
  trimLine: Line2;
  snapMarker: THREE.Mesh;
  // Lights up the WHOLE edge being snapped to (not just the marker dot), so you
  // can see it's a real in-plane edge and its extent. Fat line (screen-px width).
  snapEdgeLine: LineSegments2;
  // Dotted inference/alignment guides shown while an inference snap is active
  // (fat dashed line), plus small square markers on each anchor point (fat solid).
  guideOverlay: LineSegments2;
  anchorOverlay: LineSegments2;
  // A small DOM chip near the cursor showing the active inference glyph(s)
  // (—/|/∥/⊥), so it's clear which constraint a click will capture.
  guideBadge: HTMLDivElement;
  tween: { from: THREE.Vector3; to: THREE.Vector3; up: THREE.Vector3; start: number } | null;
  // Section view: a single GPU clip plane shared (by reference) across every
  // clippable material. "Disabled" is represented by parking the plane far from
  // the model (see FAR_PLANE) rather than emptying the clippingPlanes array —
  // that keeps every material's compiled shader variant stable (no needsUpdate
  // churn on toggle), since only the plane's uniform values change per frame.
  sectionPlane: THREE.Plane;
  sectionClipPlanes: THREE.Plane[];
  // Translucent quad + border hinting the plane's extent, shown whenever section
  // view is enabled (independent of whether it currently cuts through a body).
  sectionWidget: THREE.Mesh;
  // Per-body stencil-cap triples (back-face writer, front-face writer, neutral
  // cap quad) that fill in the cross-section — see createSectionCapTriple below.
  // Rebuilt alongside the body meshes; visibility toggles with section view.
  sectionCapGroup: THREE.Group;
  sectionCapGeometry: THREE.PlaneGeometry;
  sectionCapMaterial: THREE.MeshStandardMaterial;
  // Ground grid, navigation cube and the scale gizmo's box. Held so a theme
  // change can recolour them in place rather than rebuilding the scene.
  grid: THREE.LineSegments;
  scaleWire: THREE.LineSegments;
  scaleGripMaterial: THREE.MeshBasicMaterial;
  viewCube: ViewCube;
}

// A clip plane this far from the origin never intersects a real model — used to
// represent "section view off" without emptying any material's clippingPlanes
// array (see SceneState.sectionPlane).
const FAR_PLANE_CONSTANT = 1e6;
// Cap/plane-widget full span = 2·(in-plane reach to the bodies)·MARGIN, floored
// at MIN_SIZE. MARGIN is a small pad past the cross-section so the plane hugs the
// actual part rather than filling the viewport (clipSphere would size it to the
// ±130 reference box); MIN_SIZE keeps a modest plane visible for tiny/empty scenes.
const SECTION_CAP_MIN_SIZE = 20;
const SECTION_CAP_MARGIN = 1.1;
// renderOrder base for the stencil-cap passes — comfortably above every other
// renderOrder used in this file (highest existing is pointMarkers at 13), and
// each body claims a strictly increasing 3-slot range (back, front, cap) so the
// per-body stencil clear (cap.onAfterRender) never bleeds into the next body.
const SECTION_CAP_RENDER_ORDER_BASE = 1000;

const VIEW_DISTANCE = 220;
const TWEEN_MS = 300;
const SNAP_PX = 12;
const DRAG_START_PX = 3; // pointer travel before a sketch press becomes a drag
/** Standard whole-body / face selection highlight color. Referenced wherever a
 *  body is highlighted (selection, union/subtract-base boolean operands) so it
 *  can change globally in one place. */
export const SELECT_COLOR = 0xff9d3c;
/** Translucent "not committed yet" accent — ghost previews and boolean
 *  tool/intersect operands. */
export const GHOST_COLOR = 0x4fd1ff;
/** The counterpart accent for material an operation will REMOVE (a chamfer's
 *  bevel, a fillet's rounded-off corner). Warm/red against GHOST_COLOR's cool
 *  cyan, so "this goes away" never reads as "this gets added". */
export const GHOST_CUT_COLOR = 0xff6b5a;
/** Material a dress-up ADDS. A green distinct from GHOST_COLOR's cyan: the
 *  delta pair is read as a pair, and green/red carries "gained/lost" with no
 *  legend, where cyan/red would just look like two unrelated previews. */
export const GHOST_FILL_COLOR = 0x51e08a;
const EDGE_SEL_COLOR = new THREE.Color(SELECT_COLOR);
const EDGE_HOV_COLOR = new THREE.Color(0x36d6c3);
// Small persistent dots drawn at every selectable/draggable vertex of the ACTIVE
// sketch, so the grabbable key points are discoverable. Colour matches the sketch
// line (recoloured live with its constrained state — see applyHighlights); the
// hover/selection marker is larger and translucent so this dot shows through it.
const sketchDotMaterial = new THREE.PointsMaterial({
  color: 0x4d8dff,
  size: 5,
  sizeAttenuation: false,
  depthTest: false,
  transparent: true,
  opacity: 0.95,
});
// Edge/vertex picking is done entirely in SCREEN space (pixels), at every stage,
// so it behaves identically at any zoom. A world-space ray threshold for edge
// *detection* — a fixed 1.6 mm, say — is the obvious alternative and has two flaws:
//   • zoomed out, 1.6 mm is only a pixel or two, so edges were hard to click and
//     you had to nudge the cursor to hit them;
//   • zoomed in, 1.6 mm is tens of pixels, so an edge's grab band ballooned and
//     swallowed the whole interior of any narrow face (a 2–3 mm rib / L-flange),
//     which then stayed unpickable no matter how far you zoomed.
// Instead we set the raycaster threshold to PICK_DETECT_PX *pixels* worth of
// world units at the cursor's depth, then gate the result by exact pixel
// distance. PICK_DETECT_PX is a hair wider than the gates so detection never
// clips the true (pixel-gated) boundary.
const PICK_DETECT_PX = 12;
// A click within VERTEX_PICK_PX px of an edge endpoint selects the vertex; within
// EDGE_PICK_PX px of the edge polyline selects the edge. Vertex ≥ edge so an
// endpoint reliably wins over the edge body. Both are small so a face only needs
// ~2×EDGE_PICK_PX px of on-screen width to expose a pickable interior — i.e. a
// 2–3 mm face becomes selectable with only modest zoom.
const VERTEX_PICK_PX = 8;
const EDGE_PICK_PX = 6;

// Depth slack (world mm): an edge/line counts as "in front of" the face under the
// cursor if it's within this of the face hit — covers tessellation seams where a
// face's own boundary edge sits a hair behind the triangles.
const PICK_DEPTH_TOL = 1;

// Sketch-line colours. The active sketch reads its constrained state: a vivid
// blue while it still has free degrees of freedom (under-constrained) and a
// vivid green once it is fully constrained — the pronounced blue→green shift
// mirrors Onshape/Fusion and makes "this is solved" obvious at a glance.
// Inactive sketches stay a muted grey so they recede behind the active one.
const SKETCH_COLOR_UNDER = 0x4d8dff; // active, under-constrained (free DOF)
const SKETCH_COLOR_FULL = 0x33d27a; // active, fully constrained
const SKETCH_COLOR_IDLE = 0x9aa6cc; // not the active sketch
// Inference guides read as helpers, NOT real geometry: a yellow-orange amber,
// distinct from the sketch/construction blue, and drawn slightly thinner.
const GUIDE_COLOR = 0xe0a64f;
const GUIDE_LINE_WIDTH = 1.25;
/** On-screen width (px) of solid sketch lines — a touch heavier than the 1px
 *  default so entities read clearly and the constrained-state colour is easy to
 *  see. Drawn as fat lines (LineMaterial), since LineBasicMaterial ignores it. */
const SKETCH_LINE_WIDTH = 2.0;
const sketchBaseColor = (active: boolean, fullyConstrained: boolean): number =>
  active ? (fullyConstrained ? SKETCH_COLOR_FULL : SKETCH_COLOR_UNDER) : SKETCH_COLOR_IDLE;

const ANGLE_SNAP = 0.06; // ~3.4° — horizontal/vertical inference window

const VIEWS: Record<ViewName, { dir: [number, number, number]; up: [number, number, number] }> = {
  front: { dir: [0, -1, 0], up: [0, 0, 1] },
  back: { dir: [0, 1, 0], up: [0, 0, 1] },
  right: { dir: [1, 0, 0], up: [0, 0, 1] },
  left: { dir: [-1, 0, 0], up: [0, 0, 1] },
  top: { dir: [0, 0, 1], up: [0, 1, 0] },
  bottom: { dir: [0, 0, -1], up: [0, 1, 0] },
  iso: { dir: [1, -1, 0.8], up: [0, 0, 1] },
};

// --- On-canvas ViewCube -----------------------------------------------------
// A small labelled cube in the top-right corner (BELOW the modeling toolbar).
// Each face is a named view (Z-up: +Z Top, -Z Bottom, +X Right, -X Left, +Y
// Back, -Y Front) and each of the 8 corners is a 3/4 iso view looking down that
// corner's diagonal; clicking either tweens to it. Faces/corners highlight on
// hover. It's drawn as an overlay into the SAME WebGL canvas, with `autoClear`
// managed so its render pass never wipes the main scene.

/** A navigation target under a cube click: a named face view, or a free camera
 *  direction (the corners → iso 3/4 views). */

const MOUSE_ACTION_TO_THREE: Record<MouseDragAction, THREE.MOUSE> = {
  pan: THREE.MOUSE.PAN,
  orbit: THREE.MOUSE.ROTATE,
  zoom: THREE.MOUSE.DOLLY,
};

/** Bind the middle/right drag actions from settings. LEFT is hard-wired to
 *  ROTATE and deliberately not configurable — the left button also carries
 *  selection, sketch drawing and entity dragging (which this file handles
 *  itself, ahead of OrbitControls), so repurposing it would break all three.
 *  Scroll-wheel zoom is likewise always on. */
function applyMouseBindings(controls: OrbitControls, middle: MouseDragAction, right: MouseDragAction): void {
  controls.mouseButtons = {
    LEFT: THREE.MOUSE.ROTATE,
    MIDDLE: MOUSE_ACTION_TO_THREE[middle],
    RIGHT: MOUSE_ACTION_TO_THREE[right],
  };
}

export function Viewport({
  meshes,
  ghostMeshes,
  selection,
  emphasize,
  highlightBodyIds,
  booleanHighlight,
  onSelect,
  onSketchEntityDouble,
  datumVisibility,
  userPlanes,
  ghostPlane,
  transformEdit,
  transformMode,
  onTransformInput,
  onTransformPreview,
  extrudeGizmo,
  onExtrudeDistanceChange,
  picking,
  onPick,
  axisPick,
  onAxisPick,
  activeSketch,
  activeSketchFace,
  sketchTool,
  sketches,
  activeSketchId,
  sketchFullyConstrained,
  draft,
  polygonSides,
  onSketchClick,
  onSketchToolHover,
  trimPreview,
  onSketchDragMove,
  onSketchDragEnd,
  selectionFilter,
  regionPickPriority,
  sectionView,
  onSectionOffsetChange,
  theme,
  mouseMiddle,
  mouseRight,
  cameraInertia,
  apiRef,
}: {
  meshes: FeatureMesh[];
  /** Live preview bodies to render translucently (empty = none). */
  ghostMeshes: GhostMesh[];
  selection: Selection[];
  /** Externally-driven emphasis, rendered in the hover colour on top of the
   *  pointer's own hover (e.g. hovering a row in the constraints list lights up
   *  the entities/points that constraint references). Independent of the mouse. */
  emphasize?: Selection[];
  /** Body ids whose whole body should highlight (modifier features resolve to
   *  the body they affect — see App). */
  highlightBodyIds: Set<string>;
  /** Boolean-dialog operand highlight (null when the dialog is closed), by what
   *  the operation will DO to each body rather than by colour:
   *    • `keep`  — survives as itself (union's operands, subtract's base):
   *      the standard selection accent, SELECT_COLOR.
   *    • `ghost` — folded into a result that is none of them (intersect's
   *      operands): the translucent "not committed yet" GHOST_COLOR.
   *    • `cut`   — the material about to be TAKEN AWAY (subtract's tools):
   *      GHOST_CUT_COLOR, the same removal red a Remove extrude's tool and a
   *      chamfer's bevel wear. One vocabulary for "this goes away". */
  booleanHighlight: { keep: Set<string>; ghost: Set<string>; cut: Set<string> } | null;
  /** `sketchUv` rides along when a sketch is being edited: the click's SNAPPED
   *  uv on the active plane (endpoints/origin/grid, same stack as drawing
   *  tools), so pick-tool flows that need a coordinate — the circular pattern's
   *  center — get one without a second click path. */
  onSelect: (picked: Selection | null, sketchUv?: Vec2) => void;
  /** Double-clicking a sketch entity while the Select tool is active (used to
   *  grab a whole connected chain — e.g. a DXF outline of many small edges — in
   *  one gesture for offsetting). Only fires for a `sketchEntity` hit. */
  onSketchEntityDouble?: (sketchId: string, entityId: string) => void;
  datumVisibility: Record<DatumId, boolean>;
  /** User reference planes to render + make pickable (for sketch / plane base). */
  userPlanes: RenderPlane[];
  /** Where the reference-plane dialog's current inputs would put the new plane —
   *  drawn as a translucent ghost quad. Null when nothing is previewable yet
   *  (no base picked, or an in-place edit, which moves the real plane instead). */
  ghostPlane: PlaneFrameData | null;
  /** The active Transform gizmo (null = no gizmo shown). */
  transformEdit: TransformEdit | null;
  /** Which gizmo to show while editing a transform. */
  transformMode: TransformMode;
  /** Committed once when a gizmo drag is released — the single point the kernel
   *  regenerates (the drag itself is previewed locally, no kernel round-trips). */
  onTransformInput: (delta: TransformDelta) => void;
  /** Per-frame numeric values during a drag, for display only (the floating
   *  panel's live readout). Must not trigger a regenerate. */
  onTransformPreview: (delta: TransformDelta) => void;
  /** The active extrude-distance gizmo (null = hidden). */
  extrudeGizmo: ExtrudeGizmo | null;
  /** Fired while the gizmo arrow is dragged (throttled — each change costs a
   *  kernel regen) and once more on release: the new distance, 1 mm-snapped,
   *  SIGNED along the gizmo's current `dir`. Negative means the drag crossed
   *  the profile plane — the caller flips the feature's direction and keeps
   *  the magnitude. Never 0. */
  onExtrudeDistanceChange: (distance: number) => void;
  picking: boolean;
  /** `aim` is the clicked world point (face picks only) so the sketch view can
   *  orient onto the face the user actually clicked, not the plane origin. */
  onPick: (ref: SketchPlaneRef, aim?: [number, number, number], faceId?: number) => void;
  /** When true (during a revolve "Select axis" arming), a pick in `picking` mode
   *  is routed to `onAxisPick` instead of `onPick`, accepting a sketch line, a
   *  body face, or a datum/reference plane from one click stream. */
  axisPick: boolean;
  onAxisPick: (pick: RevolveAxisPick) => void;
  activeSketch: { datumId: SketchPlaneId | null } | null;
  /** When the active sketch is on a body face, the body id + the face's frozen
   *  frame — used to TINT that face so it's unmistakable which surface (vs a
   *  see-through parallel face) you're sketching/snapping on. */
  activeSketchFace: { bodyId: string; frame: PlaneFrameData } | null;
  sketchTool: SketchTool;
  sketches: RenderSketch[];
  activeSketchId: string | null;
  sketchFullyConstrained: boolean;
  draft: Vec2[];
  polygonSides: number;
  onSketchClick: (
    uv: Vec2,
    hv?: "horizontal" | "vertical",
    on?: { id: string; mid: boolean },
    atVertex?: boolean,
    meanings?: { meaning: "horizontal" | "vertical" | "parallel" | "perpendicular"; refId?: string }[],
    onFixed?: Vec2,
  ) => void;
  /** Live drag of unconstrained sketch geometry: each frame reports the points
   *  being moved (by original uv → target uv); App re-solves so constraints stay
   *  satisfied while free DOF follow the cursor. */
  onSketchDragMove: (points: { from: Vec2; to: Vec2 }[]) => void;
  /** Drag released — App finalizes the move (drops the pre-drag snapshot). */
  onSketchDragEnd: () => void;
  /** While the Trim/Extend tool is active: which sketch entity is under the
   *  cursor and where, so App can work out the piece that would go. Fires with
   *  null when the cursor is over nothing. */
  onSketchToolHover?: (hit: { entityId: string; uv: Vec2 } | null) => void;
  /** The span Trim would remove (or the stretch Extend would add), in sketch uv
   *  — drawn on the active sketch plane in the "this is going" colour. */
  trimPreview?: Vec2[] | null;
  selectionFilter: SelectionFilter;
  /** True while a dialog is waiting for a sketch REGION to be clicked (Revolve's
   *  profile). A region is normally the loser of every depth tie — it's a
   *  paper-thin fill, so any body face in front of it wins — which made the
   *  arming a dead end whenever a solid sat between the camera and the profile.
   *  With this set, a region under the cursor is returned before anything else. */
  regionPickPriority: boolean;
  /** Section view: a resolved cut plane (App owns the SketchPlaneRef → frame
   *  resolution, same as activeSketchFace) plus a signed offset along the
   *  frame's own normal and a flip (which half is kept). `enabled` false still
   *  carries a valid frame — it's just not applied. Pure view state: no undo,
   *  no timeline. */
  sectionView: { enabled: boolean; frame: PlaneFrameData; offset: number; flip: boolean };
  /** Fired on every drag frame of the plane handle with the new offset (along
   *  the frame's unflipped normal) — cheap, since this is plain view state. */
  onSectionOffsetChange: (offset: number) => void;
  /** Resolved color theme (user settings, "system" already folded in). Drives
   *  the scene background + grid; see settings/viewportTheme.ts for why the rest
   *  of the scene deliberately doesn't move. */
  theme: ResolvedTheme;
  /** What a middle / right drag does — see applyMouseBindings. */
  mouseMiddle: MouseDragAction;
  mouseRight: MouseDragAction;
  /** Whether orbit/pan glide on after release (OrbitControls damping). */
  cameraInertia: boolean;
  apiRef: { current: ViewportApi | null };
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const stateRef = useRef<SceneState | null>(null);

  const selectionRef = useRef(selection);
  selectionRef.current = selection;
  const highlightBodyIdsRef = useRef(highlightBodyIds);
  highlightBodyIdsRef.current = highlightBodyIds;
  const emphasizeRef = useRef(emphasize);
  emphasizeRef.current = emphasize;
  const booleanHighlightRef = useRef(booleanHighlight);
  booleanHighlightRef.current = booleanHighlight;
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;
  const onSketchEntityDoubleRef = useRef(onSketchEntityDouble);
  onSketchEntityDoubleRef.current = onSketchEntityDouble;
  const userPlanesRef = useRef(userPlanes);
  userPlanesRef.current = userPlanes;
  const transformEditRef = useRef(transformEdit);
  transformEditRef.current = transformEdit;
  const transformModeRef = useRef(transformMode);
  transformModeRef.current = transformMode;
  const onTransformInputRef = useRef(onTransformInput);
  onTransformInputRef.current = onTransformInput;
  const onTransformPreviewRef = useRef(onTransformPreview);
  onTransformPreviewRef.current = onTransformPreview;
  const extrudeGizmoRef = useRef(extrudeGizmo);
  extrudeGizmoRef.current = extrudeGizmo;
  const onExtrudeDistanceChangeRef = useRef(onExtrudeDistanceChange);
  onExtrudeDistanceChangeRef.current = onExtrudeDistanceChange;
  const meshesRef = useRef(meshes);
  meshesRef.current = meshes;
  // Resolved (per current build) faceIds of the body face the active sketch sits
  // on — every face coplanar with the sketch frame. The per-frame face-material
  // loop reads this to tint them (index 4).
  const activeSketchFaceRef = useRef<{ bodyId: string; faceIds: Set<number> } | null>(null);
  const hoverSelRef = useRef<Selection | null>(null);
  const applyHighlightsRef = useRef<() => void>(() => {});

  const pickingRef = useRef(picking);
  pickingRef.current = picking;
  const onPickRef = useRef(onPick);
  onPickRef.current = onPick;
  const axisPickRef = useRef(axisPick);
  axisPickRef.current = axisPick;
  const onAxisPickRef = useRef(onAxisPick);
  onAxisPickRef.current = onAxisPick;
  const sketchToolRef = useRef(sketchTool);
  sketchToolRef.current = sketchTool;
  const selectionFilterRef = useRef(selectionFilter);
  selectionFilterRef.current = selectionFilter;
  const regionPickPriorityRef = useRef(regionPickPriority);
  regionPickPriorityRef.current = regionPickPriority;
  const draftRef = useRef(draft);
  draftRef.current = draft;
  // Inference "armed" refs: key points and edge directions the cursor has recently
  // brushed, which emit alignment guides while drawing. Capped + time-limited so
  // they fade rather than pile up (Onshape-style priming).
  const armedRef = useRef<{ points: { uv: Vec2; at: number }[]; lines: { dir: Vec2; refId?: string; at: number }[] }>({
    points: [],
    lines: [],
  });
  const polygonSidesRef = useRef(polygonSides);
  polygonSidesRef.current = polygonSides;
  const sketchFullyConstrainedRef = useRef(sketchFullyConstrained);
  sketchFullyConstrainedRef.current = sketchFullyConstrained;
  const activeSketchIdRef = useRef(activeSketchId);
  activeSketchIdRef.current = activeSketchId;
  const sketchesRef = useRef(sketches);
  sketchesRef.current = sketches;
  const onSketchClickRef = useRef(onSketchClick);
  onSketchClickRef.current = onSketchClick;
  const onSketchDragMoveRef = useRef(onSketchDragMove);
  onSketchDragMoveRef.current = onSketchDragMove;
  const onSketchToolHoverRef = useRef(onSketchToolHover);
  onSketchToolHoverRef.current = onSketchToolHover;
  const onSketchDragEndRef = useRef(onSketchDragEnd);
  onSketchDragEndRef.current = onSketchDragEnd;
  // derived from sketches + activeSketchId in the render effect
  const activeFrameRef = useRef<PlaneFrameData | null>(null);
  const activeEntitiesRef = useRef<SketchEntity[]>([]);
  // snap candidates on the active plane (in uv): points (origin, endpoints,
  // midpoints from any sketch or body edge) and lines (coplanar edges).
  //  • a point with `midpointOf` = an *active-sketch* line/arc whose midpoint it
  //    is → snapping there gives a midpoint constraint.
  //  • a line with `id` = an *active-sketch* line entity → snapping onto its body
  //    gives a point-on-line constraint.
  //  • a point with `vertex` = an existing corner (line/arc endpoint, or the
  //    origin) — snapping the line tool there ends the polyline chain.
  // Undefined for body edges / other-sketch geometry (not constrainable here).
  const snapPointsRef = useRef<
    { uv: Vec2; midpointOf?: string; vertex?: boolean; circle?: { c: Vec2; r: number }; external?: boolean }[]
  >([]);
  const snapLinesRef = useRef<{ a: Vec2; b: Vec2; id?: string; construction?: boolean; external?: boolean }[]>([]);
  // Circles (centre + radius, in the active sketch's uv) coplanar with the sketch
  // — a hole rim, a cylinder cap. Their centre + quadrant points are added to
  // snapPointsRef; this list drives the on-circle (nearest-point-on-the-ring)
  // snap so drawing hugs the true circle, not its faceted chords.
  /** Coplanar rings to snap onto. `external` = body geometry (a hole rim / cap),
   *  which PINS the drawn point in place; `id` = an active-sketch circle, whose
   *  rim attaches the drawn point parametrically (point-on-circle). */
  const snapCirclesRef = useRef<{ c: Vec2; r: number; external?: boolean; id?: string }[]>([]);

  const hoverPlaneRef = useRef<DatumId | null>(null);
  const hoverUserPlaneRef = useRef<string | null>(null);
  const hoverBodyRef = useRef<{ mesh: THREE.Mesh; prev: THREE.Material | THREE.Material[] } | null>(null);
  const sectionViewRef = useRef(sectionView);
  sectionViewRef.current = sectionView;
  const onSectionOffsetChangeRef = useRef(onSectionOffsetChange);
  onSectionOffsetChangeRef.current = onSectionOffsetChange;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    // `stencil: true` — off by default in three.js — is required for the
    // section-view cross-section cap (see createSectionCapTriple).
    const renderer = new THREE.WebGLRenderer({ antialias: true, stencil: true });
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.domElement.style.display = "block";
    container.appendChild(renderer.domElement);
    // Per-material (not global) clipping: only materials we explicitly hand
    // `sectionClipPlanes` are affected, so the grid/datums/sketch/ViewCube are
    // exempt without any extra bookkeeping.
    renderer.localClippingEnabled = true;

    const scene = new THREE.Scene();
    // Mount-time theme. This effect deliberately runs once (deps: [apiRef]) —
    // rebuilding the whole scene on a theme flip would drop the camera, the
    // selection and every cached mesh — so later changes are applied in place
    // by the appearance effect below.
    const theme0 = VIEWPORT_THEMES[theme];
    scene.background = new THREE.Color(theme0.background);

    // `let` (not const): the perspective/orthographic toggle swaps this binding.
    // Every closure below reads `camera`, so reassigning it repoints them all;
    // controls / transformControls / renderer are re-pointed explicitly.
    const CAMERA_FOV = 45;
    // Default to ORTHOGRAPHIC (the checkbox turns perspective ON). The frustum is
    // sized from the initial framing — dist·tan(fov/2) — so it matches what a 45°
    // perspective would show; the aspect is fixed on the first resize.
    const initPos = new THREE.Vector3(110, -120, 90);
    const initHalfH = initPos.length() * Math.tan(THREE.MathUtils.degToRad(CAMERA_FOV) / 2);
    let camera: THREE.PerspectiveCamera | THREE.OrthographicCamera = new THREE.OrthographicCamera(
      -initHalfH,
      initHalfH,
      initHalfH,
      -initHalfH,
      0.1,
      10_000,
    );
    camera.up.set(0, 0, 1);
    camera.position.copy(initPos);

    // World units spanned by one device pixel at view `depth` (distance from the
    // camera). Perspective grows with depth; orthographic is depth-independent
    // (a constant frustum). Used for screen-space picking tolerance + marker sizing.
    const worldPerPixel = (depth: number, hpx: number): number => {
      if ((camera as THREE.OrthographicCamera).isOrthographicCamera) {
        const oc = camera as THREE.OrthographicCamera;
        return (oc.top - oc.bottom) / oc.zoom / hpx;
      }
      return (2 * depth * Math.tan(THREE.MathUtils.degToRad((camera as THREE.PerspectiveCamera).fov) / 2)) / hpx;
    };

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = cameraInertia;
    applyMouseBindings(controls, mouseMiddle, mouseRight);
    controls.target.set(0, 0, 0);
    controls.update();

    // On-canvas navigation ViewCube: a small labelled cube drawn into the
    // top-right corner of this same WebGL canvas.
    // It tracks whichever camera is current (perspective/orthographic) since
    // `render` is passed `state.camera` each frame; clicks route through
    // `goToView` below so its up-vectors match the named views exactly.
    const viewCube = createViewCube(theme);

    scene.add(new THREE.AmbientLight(0xffffff, 0.65));
    const keyLight = new THREE.DirectionalLight(0xffffff, 1.6);
    keyLight.position.set(60, 100, 80);
    scene.add(keyLight);
    const fill = new THREE.DirectionalLight(0xffffff, 0.5);
    fill.position.set(-80, -40, -60);
    scene.add(fill);

    const grid = createGroundGrid(theme0.gridMajor, theme0.gridMinor);
    scene.add(grid);
    const axes = new THREE.AxesHelper(AXES_LENGTH);
    scene.add(axes);

    const datums = createDatums(scene);

    // Section view's single clip plane. Parked far away (see FAR_PLANE_CONSTANT)
    // until enabled; every clippable material below shares this SAME array by
    // reference so toggling/dragging only ever mutates the plane's values, never
    // the array's length (see the SceneState field comment for why that matters).
    const sectionPlane = new THREE.Plane(new THREE.Vector3(0, 0, 1), FAR_PLANE_CONSTANT);
    const sectionClipPlanes = [sectionPlane];

    const selectedMaterial = makeBodyMaterial(SELECT_COLOR, sectionClipPlanes);
    const hoverMaterial = makeBodyMaterial(0x36d6c3, sectionClipPlanes);
    const lineMaterial = new THREE.LineBasicMaterial({ color: 0x0d0f14, clippingPlanes: sectionClipPlanes });
    // Shared sketch entity highlight materials (per-entity geometry groups flip
    // to these; index 0 is the per-sketch base material set in the render effect).

    // Fat-line overlay (real line width) for the highlighted body edge.
    const highlightMaterial = buttCaps(
      new LineMaterial({
        vertexColors: true,
        linewidth: 3,
        worldUnits: false,
        depthTest: false,
        transparent: true,
        clippingPlanes: sectionClipPlanes,
      }),
    );
    const highlightOverlay = new LineSegments2(new LineSegmentsGeometry(), highlightMaterial);
    highlightOverlay.renderOrder = 11;
    highlightOverlay.frustumCulled = false;
    highlightOverlay.visible = false;
    scene.add(highlightOverlay);

    // Construction-geometry highlight: same fat line, but dashed so a selected /
    // hovered reference entity reads as dashed (matching its base appearance).
    const highlightMaterialDash = new LineMaterial({
      vertexColors: true,
      linewidth: 3,
      worldUnits: false,
      dashed: true,
      // Match the base construction material's dash period so the highlight
      // dashes sit over the line's own dashes instead of beating against them.
      dashSize: 1.4,
      gapSize: 0.9,
      depthTest: false,
      transparent: true,
      clippingPlanes: sectionClipPlanes,
    });
    const highlightOverlayDash = new LineSegments2(new LineSegmentsGeometry(), highlightMaterialDash);
    highlightOverlayDash.renderOrder = 11;
    highlightOverlayDash.frustumCulled = false;
    highlightOverlayDash.visible = false;
    scene.add(highlightOverlayDash);

    const pointMarkers = new THREE.Points(
      new THREE.BufferGeometry(),
      // Translucent so the small persistent vertex dot (sketchDotMaterial) stays
      // visible underneath when a sketch vertex is hovered/selected.
      new THREE.PointsMaterial({
        size: 11,
        sizeAttenuation: false,
        vertexColors: true,
        depthTest: false,
        transparent: true,
        opacity: 0.65,
      }),
    );
    pointMarkers.renderOrder = 13;
    pointMarkers.visible = false;
    pointMarkers.frustumCulled = false;
    scene.add(pointMarkers);

    const group = new THREE.Group();
    const sketchGroup = new THREE.Group();
    const planeGroup = new THREE.Group();
    const ghostPlaneGroup = new THREE.Group();
    const ghostGroup = new THREE.Group();
    scene.add(group, sketchGroup, planeGroup, ghostPlaneGroup, ghostGroup);

    // Ghost-preview materials. ONE definition, three accents: a preview always
    // reads as "not committed yet" in a fixed accent rather than the body's own
    // colour, whatever it stands in for, so a chamfer's bevel and a Remove
    // extrude's tool are the same red by construction and not by coincidence.
    //
    // `inside` is the treatment for a ghost that lies WITHIN the body it
    // changes — the dress-up delta, and a cut's tool. Depth testing would hide
    // exactly those (a chamfer's wedge is buried in the un-chamfered solid, two
    // of its faces coplanar with it; a cut's prism is inside the material it
    // removes), so they draw on top instead, and a little more opaquely: these
    // volumes are thin and read weakly at the additive ghost's 0.35.
    const ghostFaceMat = (color: number, inside = false) =>
      new THREE.MeshStandardMaterial({
        color,
        metalness: 0.1,
        roughness: 0.55,
        side: THREE.DoubleSide,
        transparent: true,
        opacity: inside ? 0.5 : 0.35,
        depthWrite: false,
        depthTest: !inside,
        clippingPlanes: sectionClipPlanes,
      });
    const ghostLineMat = (color: number, inside = false) =>
      new THREE.LineBasicMaterial({
        color,
        transparent: true,
        opacity: inside ? 0.9 : 0.7,
        depthTest: !inside,
        clippingPlanes: sectionClipPlanes,
      });
    const ghostMaterial = ghostFaceMat(GHOST_COLOR);
    const ghostLineMaterial = ghostLineMat(GHOST_COLOR);
    const ghostFillMaterial = ghostFaceMat(GHOST_FILL_COLOR, true);
    const ghostFillLineMaterial = ghostLineMat(GHOST_FILL_COLOR, true);
    const ghostCutMaterial = ghostFaceMat(GHOST_CUT_COLOR, true);
    const ghostCutLineMaterial = ghostLineMat(GHOST_CUT_COLOR, true);
    // A whole BODY about to be subtracted away wears the removal red too — but
    // as an ordinary depth-tested ghost, not the drawn-on-top `inside` one: a
    // subtract tool is a solid standing in the scene, not a sliver buried in
    // one, so it has to be occluded like the body it is.
    const ghostCutBodyMaterial = ghostFaceMat(GHOST_CUT_COLOR);

    // Section view: a translucent quad hinting the plane's extent (always shown
    // while enabled, everywhere — independent of the stencil cap below, which
    // only paints where the plane actually cuts a body), plus a constant-pixel-
    // size drag handle (a cone, pointing along the plane's normal). Both are
    // repositioned/rescaled every frame in animate() from the resolved section
    // frame, so no transform is set here.
    const sectionWidgetGeom = new THREE.PlaneGeometry(1, 1);
    const sectionWidgetMat = new THREE.MeshBasicMaterial({
      color: 0x5da9ff,
      transparent: true,
      opacity: 0.08,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    const sectionWidget = new THREE.Mesh(sectionWidgetGeom, sectionWidgetMat);
    sectionWidget.visible = false;
    sectionWidget.renderOrder = 1;
    const sectionWidgetBorder = new THREE.LineSegments(
      new THREE.EdgesGeometry(sectionWidgetGeom),
      new THREE.LineBasicMaterial({ color: 0x5da9ff, transparent: true, opacity: 0.5, depthWrite: false }),
    );
    sectionWidgetBorder.renderOrder = 1;
    sectionWidget.add(sectionWidgetBorder);
    scene.add(sectionWidget);

    // Drag handles for the section plane's offset and the extrude dialog's
    // distance: single-axis translate gizmos built on TransformControls, so
    // every draggable arrow in the app looks and behaves like the Transform
    // gizmo (same arrows, same softened palette, same 1 mm snap). Each drives
    // an invisible proxy whose local +Z is the handle's axis — space "local"
    // with only the Z arrow shown — and the proxy's position is read back as
    // the value, exactly like the Transform gizmo's proxy.
    const makeAxisGizmo = ({ oneWay = false, joinShaft = false } = {}) => {
      const proxy = new THREE.Object3D();
      scene.add(proxy);
      const tc = new TransformControls(camera, renderer.domElement);
      tc.setMode("translate");
      tc.setSpace("local");
      tc.setTranslationSnap(1); // 1 mm grid, like the Transform gizmo
      tc.setSize(0.85);
      tc.showX = false;
      tc.showY = false;
      tc.enabled = false;
      const helper = tc.getHelper();
      helper.visible = false;
      if (oneWay) dropBackwardArrow(helper);
      if (joinShaft) joinShaftsToBothArrows(helper);
      softenGizmo(helper); // mute the default pure-RGB arrow to fit the UI
      scene.add(helper);
      return { proxy, tc, helper };
    };
    // The section handle keeps both arrows — it straddles the body, so either
    // direction reads as meaningful — but the shaft has to span them both.
    const { proxy: sectionProxy, tc: sectionControls, helper: sectionHelper } = makeAxisGizmo({ joinShaft: true });
    // Extrude shows one arrow: see dropBackwardArrow.
    const { proxy: extrudeProxy, tc: extrudeControls, helper: extrudeHelper } = makeAxisGizmo({ oneWay: true });

    // Section-offset gizmo: each drag frame projects the proxy back onto the
    // frame's (unflipped) normal. Plain view state — safe to fire every frame;
    // syncSectionPlane also reads the proxy directly mid-drag, so the plane
    // tracks with zero latency ahead of the prop round trip.
    const sectionDragN = new THREE.Vector3();
    sectionControls.addEventListener("dragging-changed", (e) => {
      controls.enabled = !(e as unknown as { value: boolean }).value;
    });
    sectionControls.addEventListener("objectChange", () => {
      if (!sectionControls.dragging) return;
      const f = sectionViewRef.current.frame;
      sectionDragN.set(f.normal[0], f.normal[1], f.normal[2]).normalize();
      const offset =
        sectionProxy.position.dot(sectionDragN) -
        (f.origin[0] * sectionDragN.x + f.origin[1] * sectionDragN.y + f.origin[2] * sectionDragN.z);
      onSectionOffsetChangeRef.current(offset);
    });

    // Extrude-distance gizmo. The drag axis is captured at drag start (the
    // prop's `dir` can flip mid-drag once a plane crossing is committed — see
    // emitExtrudeDistance), and emissions are throttled: unlike the section
    // offset, every emitted distance triggers a kernel regen (the dialog's
    // ghost preview, or a live in-place edit), so they're deduped and
    // rate-limited, with the final value always emitted on release.
    const EXTRUDE_EMIT_MS = 50;
    let extrudeDrag: { origin: THREE.Vector3; axis: THREE.Vector3; emitted: number | null; emittedAt: number } | null =
      null;
    const extrudeDragVec = new THREE.Vector3();
    // Project the proxy back onto the drag axis, sign the result against the
    // gizmo's CURRENT direction (so "negative = the other side of the profile"
    // stays true across a mid-drag flip), snap to whole mm and emit.
    const emitExtrudeDistance = (final: boolean) => {
      const ed = extrudeDrag;
      const eg = extrudeGizmoRef.current;
      if (!ed || !eg) return;
      const s = extrudeDragVec.copy(extrudeProxy.position).sub(ed.origin).dot(ed.axis);
      const dirSign = ed.axis.x * eg.dir[0] + ed.axis.y * eg.dir[1] + ed.axis.z * eg.dir[2] < 0 ? -1 : 1;
      const along = s * dirSign;
      const total = Math.round(eg.symmetric ? along * 2 : along);
      if (total === 0 || total === ed.emitted) return;
      const now = performance.now();
      if (!final && now - ed.emittedAt < EXTRUDE_EMIT_MS) return;
      ed.emitted = total;
      ed.emittedAt = now;
      onExtrudeDistanceChangeRef.current(total);
    };
    extrudeControls.addEventListener("dragging-changed", (e) => {
      const dragging = (e as unknown as { value: boolean }).value;
      controls.enabled = !dragging;
      if (dragging) {
        const eg = extrudeGizmoRef.current;
        if (!eg) return;
        extrudeDrag = {
          origin: new THREE.Vector3(eg.origin[0], eg.origin[1], eg.origin[2]),
          axis: new THREE.Vector3(eg.dir[0], eg.dir[1], eg.dir[2]).normalize(),
          emitted: null,
          emittedAt: 0,
        };
      } else {
        emitExtrudeDistance(true); // a change the throttle may still be holding
        extrudeDrag = null;
      }
    });
    extrudeControls.addEventListener("objectChange", () => {
      if (extrudeControls.dragging) emitExtrudeDistance(false);
    });

    // Per-body stencil-cap triples (see createSectionCapTriple), rebuilt in the
    // mesh-rebuild effect below. The cap quad geometry/material are shared across
    // every body — v1 caps are one flat neutral colour, not per-body tinted.
    const sectionCapGroup = new THREE.Group();
    scene.add(sectionCapGroup);
    const sectionCapGeometry = new THREE.PlaneGeometry(1, 1);
    const sectionCapMaterial = new THREE.MeshStandardMaterial({
      color: 0x9aa0ab,
      metalness: 0.05,
      roughness: 0.9,
      side: THREE.DoubleSide,
      stencilWrite: true,
      stencilRef: 0,
      stencilFunc: THREE.NotEqualStencilFunc,
      stencilFail: THREE.ReplaceStencilOp,
      stencilZFail: THREE.ReplaceStencilOp,
      stencilZPass: THREE.ReplaceStencilOp,
    });
    // Mechanical section hatch: 45° stripes over the (stencil-masked) cap fill so
    // the cross-section reads as cut solid material, not just another face. Drawn
    // in WORLD space projected onto the cut plane's own u/v axes, so the hatch
    // lives ON the cut face — it rotates and scales with the part when you orbit,
    // like a real drawing's section lines (not a screen-locked overlay). The
    // uniforms (plane origin/axes + spacing) are refreshed each frame in
    // syncSectionPlane; 45° comes from banding on (u+v). fwidth() antialiases the
    // stripe edges so they stay crisp at any zoom.
    const sectionHatchUniforms = {
      uHatchOrigin: { value: new THREE.Vector3() },
      uHatchU: { value: new THREE.Vector3(1, 0, 0) },
      uHatchV: { value: new THREE.Vector3(0, 1, 0) },
      uHatchSpacing: { value: 4 },
      uHatchHalfWidth: { value: 0.35 },
      uHatchColor: { value: new THREE.Color(0x2b2f36) },
    };
    sectionCapMaterial.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, sectionHatchUniforms);
      shader.vertexShader = shader.vertexShader
        .replace("#include <common>", "#include <common>\nvarying vec3 vHatchWorld;")
        .replace(
          "#include <project_vertex>",
          "#include <project_vertex>\n\tvHatchWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;",
        );
      shader.fragmentShader = shader.fragmentShader
        .replace(
          "#include <common>",
          "#include <common>\nvarying vec3 vHatchWorld;\nuniform vec3 uHatchOrigin;\nuniform vec3 uHatchU;\nuniform vec3 uHatchV;\nuniform float uHatchSpacing;\nuniform float uHatchHalfWidth;\nuniform vec3 uHatchColor;",
        )
        .replace(
          "#include <dithering_fragment>",
          `#include <dithering_fragment>
          {
            vec3 rel = vHatchWorld - uHatchOrigin;
            float across = dot(rel, uHatchU) + dot(rel, uHatchV); // ⟂ to the 45° lines
            float along  = dot(rel, uHatchU) - dot(rel, uHatchV); // along the 45° lines
            // Squiggle: sinusoidally offset each line across its width as it runs,
            // so the hatch reads hand-drawn rather than ruled. Amplitude/wavelength
            // scale with spacing to hold their look at every zoom/part size.
            float wobble = uHatchSpacing * 0.3 * sin(along / (uHatchSpacing * 0.8));
            float coord = (across + wobble) / uHatchSpacing;
            float f = fract(coord);
            float dist = min(f, 1.0 - f) * uHatchSpacing;   // world dist to nearest line
            float aa = fwidth(coord) * uHatchSpacing + 1e-4; // antialias band
            float line = 1.0 - smoothstep(uHatchHalfWidth - aa, uHatchHalfWidth + aa, dist);
            gl_FragColor.rgb = mix(gl_FragColor.rgb, uHatchColor, line * 0.9);
          }`,
        );
    };
    // Distinct cache key so this custom program isn't shared with any other
    // MeshStandardMaterial's compiled shader.
    sectionCapMaterial.customProgramCacheKey = () => "section-cap-hatch";

    // Transform gizmo: an invisible proxy object that the TransformControls move,
    // whose position/rotation are read back as the active Transform feature's
    // translate/rotate values. Hidden until a transform is being edited.
    const gizmoProxy = new THREE.Object3D();
    scene.add(gizmoProxy);
    const transformControls = new TransformControls(camera, renderer.domElement);
    transformControls.setTranslationSnap(1); // 1 mm grid
    transformControls.setRotationSnap(THREE.MathUtils.degToRad(5)); // 5° snap
    transformControls.setSize(0.85);
    const gizmoHelper = transformControls.getHelper();
    gizmoHelper.visible = false;
    // Both arrows of every axis get a shaft, the rotate ring is a whole circle,
    // and it carries arrowheads saying it turns — see gizmoShape.ts for what
    // stock TransformControls draws instead.
    joinShaftsToBothArrows(gizmoHelper);
    closeRotationRings(gizmoHelper);
    addRotationArrowheads(gizmoHelper);
    softenGizmo(gizmoHelper); // mute the default pure-RGB arrows to fit the UI
    scene.add(gizmoHelper);
    // Scale gizmo: a wireframe box wrapping the target body, with a grab cube at
    // each of its eight corners. Dragging a corner away from the body grows it,
    // toward the body shrinks it, and the box follows so it always reads as the
    // body's own bounds.
    //
    // Not TransformControls' scale mode, which cannot express this: it sizes its
    // WHOLE gizmo to a constant on-screen size, so its handles sit at a fixed
    // distance from the pivot rather than on the body, and it derives a uniform
    // factor as |pointEnd| / |pointStart| measured from that pivot — a ratio that
    // divides by ~0 at the centre and, dragged through it, flips sign
    // (`if (pointEnd.dot(pointStart) < 0) d *= -1`), mirroring the handle to the
    // far side. A corner of the body's own box is far from the pivot, so the same
    // ratio is well conditioned everywhere it can be grabbed.
    const scaleGizmo = new THREE.Group();
    scaleGizmo.visible = false;
    const scaleWire = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1)),
      // Colour and opacity are set from the theme on mount and on every change.
      new THREE.LineBasicMaterial({ transparent: true, depthTest: false }),
    );
    scaleWire.renderOrder = 12;
    const scaleGripGeometry = new THREE.BoxGeometry(2, 2, 2); // unit half-extent, scaled per frame
    const scaleGripMaterial = new THREE.MeshBasicMaterial({
      transparent: true,
      opacity: 0.85,
      depthTest: false, // colour from the theme, like the box it sits on
    });
    const scaleGripHoverMaterial = new THREE.MeshBasicMaterial({ color: GIZMO_ACTIVE, depthTest: false });
    const scaleGrips = BOX_CORNERS.map((corner) => {
      const m = new THREE.Mesh(scaleGripGeometry, scaleGripMaterial);
      m.renderOrder = 13;
      m.userData.corner = corner;
      return m;
    });
    scaleGizmo.add(scaleWire, ...scaleGrips);
    scene.add(scaleGizmo);

    // The body's world bounds, measured from the mesh the kernel last returned,
    // remembered with the factor they were measured AT — the box on screen is
    // those bounds scaled about the pivot by (current factor / measured factor),
    // so a drag grows the box and the body together without a kernel round trip.
    let scaleBounds: { min: THREE.Vector3; max: THREE.Vector3; atFactor: number; source: unknown } | null = null;
    // A corner drag in progress. `grabPx` is the press's distance from the pivot
    // ON SCREEN, which is what the new factor is measured against.
    let scaleDrag: {
      grabPx: number;
      dir: { x: number; y: number };
      startFactor: number;
      live: number;
      moved: boolean;
    } | null = null;

    // Suspend orbiting while a gizmo handle is being dragged.
    // The gizmo's current translate/rotate, read off the proxy. Each MODE reads
    // the one thing its gizmo writes and passes the other through untouched:
    // TransformControls' translate only moves the proxy and its rotate only
    // turns it, and in rotate mode the proxy sits on the AXIS line rather than
    // at pivot+translation, so reading a translation off it there would invent
    // a move the user never made. Scale is passed through in both cases: the
    // controls never drive it (the box gizmo below is its own thing).
    const proxyDelta = (te: TransformEdit, mode: TransformMode): TransformDelta => {
      if (mode === "rotate") {
        // How far the proxy has turned about the axis, as a signed angle: undo
        // the axis frame and what is left is a pure rotation about local Z.
        const rel = axisFrameQuaternionOf(te.axis.dir).invert().multiply(gizmoProxy.quaternion);
        return {
          tx: te.tx,
          ty: te.ty,
          tz: te.tz,
          angle: THREE.MathUtils.radToDeg(2 * Math.atan2(rel.z, rel.w)),
          scale: te.scale,
        };
      }
      const p = gizmoProxy.position;
      return {
        tx: p.x - te.pivot[0],
        ty: p.y - te.pivot[1],
        tz: p.z - te.pivot[2],
        angle: te.angle,
        scale: te.scale,
      };
    };
    transformControls.addEventListener("dragging-changed", (e) => {
      const dragging = (e as unknown as { value: boolean }).value;
      controls.enabled = !dragging;
      const te = transformEditRef.current;
      if (dragging) {
        // Drag start: snapshot the body's render objects and the inverse of the
        // matrix they currently carry, so each frame can re-pose them with a
        // pure matrix instead of asking the kernel to rebuild the document.
        if (!te) return;
        const m0 = transformMatrix(te.pivot, te.tx, te.ty, te.tz, te.angle, te.axis, te.scale);
        const objects = state.group.children.filter((c) => c.userData.featureId === te.bodyId);
        for (const o of objects) o.matrixAutoUpdate = false;
        state.liveDrag = { bodyId: te.bodyId, objects, m0Inverse: m0.clone().invert(), delta: new THREE.Matrix4() };
      } else {
        // Drag end: commit the final values once — that is the only regenerate.
        const ld = state.liveDrag;
        state.liveDrag = null;
        if (!te) return;
        const d = proxyDelta(te, transformModeRef.current);
        if (ld) {
          // Pin the dragged matrix across the stale rebuild that the commit
          // triggers, until the body's real (re-baked) geometry arrives. Keyed
          // by the body's current mesh ref, which changes only when regenerate
          // returns — so the pin releases exactly when the new geometry lands.
          const m1 = transformMatrix(te.pivot, d.tx, d.ty, d.tz, d.angle, te.axis, d.scale);
          const delta = m1.multiply(ld.m0Inverse);
          const entry = meshesRef.current.find((m) => m.id === te.bodyId);
          state.pendingCommit = { bodyId: te.bodyId, delta, meshRef: entry?.mesh ?? null };
        }
        onTransformInputRef.current(d);
      }
    });
    // Each drag frame: re-pose the moved body locally (current matrix · m0⁻¹) and
    // push numbers to the panel readout — but never to the document/kernel.
    transformControls.addEventListener("objectChange", () => {
      if (!transformControls.dragging) return;
      const te = transformEditRef.current;
      if (!te) return;
      const d = proxyDelta(te, transformModeRef.current);
      const ld = state.liveDrag;
      if (ld) poseDraggedBody(ld, transformMatrix(te.pivot, d.tx, d.ty, d.tz, d.angle, te.axis, d.scale));
      onTransformPreviewRef.current(d);
    });

    const previewMaterial = new LineMaterial({
      color: 0x7da8ff,
      linewidth: 3,
      worldUnits: false,
      depthTest: false,
      transparent: true,
    });
    // Trim/Extend: what the click would take away (or add), drawn thicker and in
    // a colour used nowhere else, so it never reads as sketch geometry, as
    // construction, or as a snap guide.
    const trimMaterial = new LineMaterial({
      color: 0xff5c5c,
      linewidth: 5,
      worldUnits: false,
      depthTest: false,
      transparent: true,
    });
    const trimLine = new Line2(new LineGeometry(), trimMaterial);
    trimLine.frustumCulled = false;
    trimLine.visible = false;
    trimLine.renderOrder = 10.6; // just above the drawing preview
    const previewLine = new Line2(new LineGeometry(), previewMaterial);
    previewLine.frustumCulled = false;
    previewLine.visible = false;
    // Above the guide/anchor overlays (renderOrder 10) so the opaque preview line
    // occludes a coincident guide, but below the snap marker/edge (11–12). All use
    // depthTest:false, so draw order alone decides who's on top.
    previewLine.renderOrder = 10.5;
    const snapMarker = new THREE.Mesh(
      new THREE.SphereGeometry(1.4, 16, 16),
      new THREE.MeshBasicMaterial({ color: 0xffe14a, depthTest: false }),
    );
    snapMarker.renderOrder = 12;
    snapMarker.visible = false;
    keepConstantPixelRadius(snapMarker, 1.4, SNAP_PIXEL_RADIUS);
    // Whole-edge snap highlight: a bright FAT line over the edge under the cursor,
    // drawn on top (depthTest off) so it reads even against the dimmed body.
    const snapEdgeMaterial = buttCaps(
      new LineMaterial({
        color: 0xffe14a,
        linewidth: 4,
        worldUnits: false,
        depthTest: false,
        transparent: true,
        dashSize: 1.4,
        gapSize: 0.9, // used only when `dashed` is toggled on (construction edges)
      }),
    );
    const snapEdgeLine = new LineSegments2(new LineSegmentsGeometry(), snapEdgeMaterial);
    snapEdgeLine.renderOrder = 11;
    snapEdgeLine.frustumCulled = false;
    snapEdgeLine.visible = false;
    // Dotted inference/alignment guides — a fat dashed line so its width reads,
    // and small square markers on each anchor point in the same colour + width.
    const guideMaterial = new LineMaterial({
      color: GUIDE_COLOR,
      linewidth: GUIDE_LINE_WIDTH,
      worldUnits: false,
      dashed: true,
      dashSize: 1.4,
      gapSize: 0.9,
      depthTest: false,
      transparent: true,
      opacity: 0.9,
    });
    const guideOverlay = new LineSegments2(new LineSegmentsGeometry(), guideMaterial);
    guideOverlay.renderOrder = 10;
    guideOverlay.frustumCulled = false;
    guideOverlay.visible = false;
    const anchorMaterial = new LineMaterial({
      color: GUIDE_COLOR,
      linewidth: GUIDE_LINE_WIDTH,
      worldUnits: false,
      depthTest: false,
      transparent: true,
      opacity: 0.9,
    });
    const anchorOverlay = new LineSegments2(new LineSegmentsGeometry(), anchorMaterial);
    anchorOverlay.renderOrder = 10;
    anchorOverlay.frustumCulled = false;
    anchorOverlay.visible = false;
    scene.add(trimLine, previewLine, snapMarker, snapEdgeLine, guideOverlay, anchorOverlay);
    // Appended to <body> (not the canvas container) so it can't be clipped, and
    // styled from App.css rather than inline so it picks up the colour theme
    // like every other chip — only `display` and the cursor-following position
    // are set from here.
    const guideBadge = document.createElement("div");
    guideBadge.className = "guide-badge";
    document.body.appendChild(guideBadge);

    const state: SceneState = {
      renderer,
      scene,
      camera,
      controls,
      group,
      sketchDimActive: false,
      selectedMaterial,
      hoverMaterial,
      lineMaterial,
      highlightMaterial,
      highlightOverlay,
      highlightMaterialDash,
      highlightOverlayDash,
      pointMarkers,
      datums,
      sketchGroup,
      planeGroup,
      ghostPlaneGroup,
      transformControls,
      gizmoProxy,
      liveDrag: null,
      pendingCommit: null,
      ghostGroup,
      ghostMaterial,
      ghostLineMaterial,
      ghostFillMaterial,
      ghostFillLineMaterial,
      ghostCutMaterial,
      ghostCutLineMaterial,
      ghostCutBodyMaterial,
      previewLine,
      trimLine,
      snapMarker,
      snapEdgeLine,
      guideOverlay,
      anchorOverlay,
      guideBadge,
      tween: null,
      sectionPlane,
      sectionClipPlanes,
      sectionWidget,
      sectionCapGroup,
      sectionCapGeometry,
      sectionCapMaterial,
      grid,
      scaleWire,
      scaleGripMaterial,
      viewCube,
    };
    stateRef.current = state;
    applyDatumAppearance(state, null);

    /** Pose the dragged body at `m1` and redraw what hangs off it. The body's
     *  own faces follow for free (its meshes carry the matrix), but the
     *  selection/hover overlays are rebuilt world-space buffers, so they have to
     *  be regenerated against the new motion — otherwise a face lit up under the
     *  cursor when the drag started floats in place while the body slides out
     *  from under it. Cheap: the rebuild only walks the ranges actually
     *  highlighted, which is one face or edge. */
    const poseDraggedBody = (ld: NonNullable<SceneState["liveDrag"]>, m1: THREE.Matrix4) => {
      ld.delta.copy(m1).multiply(ld.m0Inverse); // current · committed⁻¹
      for (const o of ld.objects) {
        o.matrix.copy(ld.delta);
        o.matrixWorldNeedsUpdate = true; // matrixAutoUpdate is off; force the world recompute
      }
      applyHighlights();
    };

    // Apply selection (a SET) + hover highlighting. Faces use per-face material
    // index; edges/sketch entities use the fat-line overlay; vertices/points use
    // the point markers; sketches keep their per-sketch base colour.
    const applyHighlights = () => {
      const sels = selectionRef.current;
      const hov = hoverSelRef.current;
      const hovered = hov && !sels.some((s) => sameSelection(s, hov)) ? hov : null;
      const isSketchId = (id: string) => sketchGroup.children.some((c) => c.userData.sketchId === id);

      // Faces
      for (const child of group.children) {
        if (!(child instanceof THREE.Mesh)) continue;
        const fid = child.userData.featureId as string;
        const geom = child.geometry;
        const fg = geom.userData.faceGroups as { faceId: number; clusterId?: number }[] | undefined;
        if (!fg) continue;
        const wholeSel = highlightBodyIdsRef.current.has(fid);
        const wholeHov = hovered?.kind === "feature" && hovered.id === fid;
        // Boolean-dialog operand highlight overrides normal selection: a body
        // being consumed (cut, index 5; ghost, index 3) wins over "selected"
        // (index 2), since what the operation does to it is the more useful
        // fact while the dialog is open.
        const bh = booleanHighlightRef.current;
        const wholeCut = bh?.cut.has(fid) ?? false;
        const wholeGhost = bh?.ghost.has(fid) ?? false;
        const wholeKeep = bh?.keep.has(fid) ?? false;
        const asf = activeSketchFaceRef.current;
        const asfFaces = asf?.bodyId === fid ? asf.faceIds : null;
        // Logical-face selection: a click on any facet of a faceted cylinder
        // highlights the WHOLE surface. `cl` maps a picked faceId to its cluster
        // representative (falls back to the id itself for flat/singleton faces or
        // reference bodies that carry no clusterId), then we match by cluster.
        const clMap = new Map<number, number>();
        for (const g of fg) if (g.clusterId !== undefined) clMap.set(g.faceId, g.clusterId);
        const cl = (id: number) => clMap.get(id) ?? id;
        const selClusters = new Set(
          sels.filter((s) => s.kind === "face" && s.featureId === fid).map((s) => cl((s as { faceId: number }).faceId)),
        );
        const hovCluster = hovered?.kind === "face" && hovered.featureId === fid ? cl(hovered.faceId) : undefined;
        let dirty = false;
        geom.groups.forEach((g: { materialIndex?: number }, i: number) => {
          const faceId = fg[i]?.faceId;
          const fc = cl(faceId as number);
          const selF = wholeSel || selClusters.has(fc);
          const hovF = wholeHov || (hovCluster !== undefined && fc === hovCluster);
          const sketchF = asfFaces?.has(faceId as number) ?? false;
          const idx = wholeCut ? 5 : wholeGhost ? 3 : selF || wholeKeep ? 2 : hovF ? 1 : sketchF ? 4 : 0;
          if (g.materialIndex !== idx) {
            g.materialIndex = idx;
            dirty = true;
          }
        });
        if (dirty) (geom as THREE.BufferGeometry & { groupsNeedUpdate: boolean }).groupsNeedUpdate = true;
      }

      // Fat-line overlay: body edges + sketch entities + whole sketches.
      // Construction (reference) geometry routes to a dashed twin overlay.
      const overlayPos: number[] = [];
      const overlayCol: number[] = [];
      const overlayPosDash: number[] = [];
      const overlayColDash: number[] = [];
      // A body under an active gizmo drag is posed by a matrix its geometry does
      // not carry (see SceneState.liveDrag), so anything copied out of that
      // geometry has to be moved by the same matrix — otherwise the outline of a
      // hovered or selected face hangs in the air where the body used to be. The
      // same holds for the released-but-not-yet-rebuilt window that pendingCommit
      // pins, which is why it answers here too.
      const ld = state.liveDrag;
      const pc = state.pendingCommit;
      const dragMotion = (featureId: string): THREE.Matrix4 | null =>
        ld?.bodyId === featureId ? ld.delta : pc?.bodyId === featureId ? pc.delta : null;
      const pushRange = (
        geom: THREE.BufferGeometry,
        start: number,
        count: number,
        c: THREE.Color,
        dashed = false,
        motion: THREE.Matrix4 | null = null,
      ) => {
        const pos = geom.getAttribute("position");
        const tp = dashed ? overlayPosDash : overlayPos;
        const tc = dashed ? overlayColDash : overlayCol;
        for (let v = start; v < start + count; v++) {
          _highlightTmp.set(pos.getX(v), pos.getY(v), pos.getZ(v));
          if (motion) _highlightTmp.applyMatrix4(motion);
          tp.push(_highlightTmp.x, _highlightTmp.y, _highlightTmp.z);
          tc.push(c.r, c.g, c.b);
        }
      };
      const sketchChild = (sid: string) =>
        sketchGroup.children.find(
          (c): c is THREE.LineSegments => c instanceof THREE.LineSegments && c.userData.sketchId === sid,
        );
      const addOverlay = (s: Selection, c: THREE.Color) => {
        if (s.kind === "edge") {
          const child = group.children.find(
            (x): x is THREE.LineSegments =>
              x instanceof THREE.LineSegments && x.userData.isBodyEdges && x.userData.featureId === s.featureId,
          );
          const eg = child?.geometry.userData.edgeGroups as
            { start: number; count: number; edgeId: number; chainId?: number }[] | undefined;
          if (child && eg) {
            // Logical-edge selection: highlight every chord of the picked edge's
            // chain (the whole faceted circle), not just the one segment.
            const chain = eg.find((x) => x.edgeId === s.edgeId)?.chainId;
            const motion = dragMotion(s.featureId);
            for (const g of eg)
              if (g.edgeId === s.edgeId || (chain !== undefined && g.chainId === chain))
                pushRange(child.geometry, g.start, g.count, c, false, motion);
          }
        } else if (s.kind === "sketchEntity") {
          const child = sketchChild(s.sketchId);
          const eg = child?.geometry.userData.entityGroups as
            { start: number; count: number; entityId: string; construction?: boolean }[] | undefined;
          const g = eg?.find((x) => x.entityId === s.entityId);
          if (child && g) pushRange(child.geometry, g.start, g.count, c, !!g.construction);
        } else if (s.kind === "feature" && isSketchId(s.id)) {
          // While a sketch is being edited it's the selected feature (so the
          // params panel shows), but don't paint all its entities as selected —
          // inside the sketch, individual entity selection is what matters.
          if (s.id === activeSketchIdRef.current) return;
          const child = sketchChild(s.id);
          const eg = child?.geometry.userData.entityGroups as
            { start: number; count: number; entityId: string; construction?: boolean }[] | undefined;
          if (child && eg) {
            for (const g of eg) pushRange(child.geometry, g.start, g.count, c, !!g.construction);
          } else if (child) {
            pushRange(child.geometry, 0, child.geometry.getAttribute("position").count, c);
          }
        } else if (s.kind === "face") {
          // Also highlight the face's boundary edges.
          const faceMesh = group.children.find(
            (x): x is THREE.Mesh => x instanceof THREE.Mesh && x.userData.featureId === s.featureId,
          );
          const edgeMesh = group.children.find(
            (x): x is THREE.LineSegments =>
              x instanceof THREE.LineSegments && x.userData.isBodyEdges && x.userData.featureId === s.featureId,
          );
          if (faceMesh && edgeMesh) {
            // Boundary of the whole logical face (the picked facet's cluster), so a
            // selected cylinder outlines its rim rings, not one facet's strip.
            const fgm = faceMesh.geometry.userData.faceGroups as { faceId: number; clusterId?: number }[] | undefined;
            const selCluster = fgm?.find((g) => g.faceId === s.faceId)?.clusterId;
            const clusterIds = new Set<number>(
              selCluster !== undefined && fgm
                ? fgm.filter((g) => g.clusterId === selCluster).map((g) => g.faceId)
                : [s.faceId],
            );
            const motion = dragMotion(s.featureId);
            for (const [start, count] of faceBoundaryEdges(faceMesh.geometry, edgeMesh.geometry, clusterIds)) {
              pushRange(edgeMesh.geometry, start, count, c, false, motion);
            }
          }
        } else if (s.kind === "sketchFace") {
          const fill = sketchGroup.children.find(
            (x) =>
              x instanceof THREE.Mesh &&
              x.userData.isRegion &&
              x.userData.sketchId === s.sketchId &&
              x.userData.regionId === s.regionId,
          );
          const outline = fill?.userData.outlineWorld as number[] | undefined;
          if (outline) {
            for (let i = 0; i < outline.length; i += 3) {
              overlayPos.push(outline[i], outline[i + 1], outline[i + 2]);
              overlayCol.push(c.r, c.g, c.b);
            }
          }
        }
      };
      for (const s of sels) addOverlay(s, EDGE_SEL_COLOR);
      if (hovered) addOverlay(hovered, EDGE_HOV_COLOR);
      // Externally-driven emphasis (constraints-list hover) rides the hover colour.
      for (const s of emphasizeRef.current ?? []) addOverlay(s, EDGE_HOV_COLOR);
      if (overlayPos.length >= 6) {
        // Build a fresh geometry each time — re-using one via setPositions does
        // not grow the rendered instance count when more segments are added.
        const og = new LineSegmentsGeometry();
        og.setPositions(overlayPos);
        og.setColors(overlayCol);
        highlightOverlay.geometry.dispose();
        highlightOverlay.geometry = og;
        highlightOverlay.visible = true;
      } else {
        highlightOverlay.visible = false;
      }
      if (overlayPosDash.length >= 6) {
        const og = new LineSegmentsGeometry();
        og.setPositions(overlayPosDash);
        og.setColors(overlayColDash);
        highlightOverlayDash.geometry.dispose();
        highlightOverlayDash.geometry = og;
        highlightOverlayDash.computeLineDistances(); // needed by the dashed material
        highlightOverlayDash.visible = true;
      } else {
        highlightOverlayDash.visible = false;
      }

      // Point markers: vertices + sketch points.
      const ptPos: number[] = [];
      const ptCol: number[] = [];
      const ptWorld = (s: Selection): [number, number, number] | null => {
        if (s.kind === "vertex") {
          const motion = dragMotion(s.featureId);
          if (!motion) return s.point;
          _highlightTmp.set(s.point[0], s.point[1], s.point[2]).applyMatrix4(motion);
          return [_highlightTmp.x, _highlightTmp.y, _highlightTmp.z];
        }
        if (s.kind === "sketchPoint") {
          const child = sketchChild(s.sketchId);
          const frame = child?.userData.frame as PlaneFrameData | undefined;
          if (frame) return uvToWorld(frame, s.point[0], s.point[1]);
        }
        return null;
      };
      for (const s of sels) {
        const w = ptWorld(s);
        if (w) {
          ptPos.push(w[0], w[1], w[2]);
          ptCol.push(EDGE_SEL_COLOR.r, EDGE_SEL_COLOR.g, EDGE_SEL_COLOR.b);
        }
      }
      if (hovered) {
        const w = ptWorld(hovered);
        if (w) {
          ptPos.push(w[0], w[1], w[2]);
          ptCol.push(EDGE_HOV_COLOR.r, EDGE_HOV_COLOR.g, EDGE_HOV_COLOR.b);
        }
      }
      for (const s of emphasizeRef.current ?? []) {
        const w = ptWorld(s);
        if (w) {
          ptPos.push(w[0], w[1], w[2]);
          ptCol.push(EDGE_HOV_COLOR.r, EDGE_HOV_COLOR.g, EDGE_HOV_COLOR.b);
        }
      }
      if (ptPos.length > 0) {
        pointMarkers.geometry.setAttribute("position", new THREE.Float32BufferAttribute(ptPos, 3));
        pointMarkers.geometry.setAttribute("color", new THREE.Float32BufferAttribute(ptCol, 3));
        pointMarkers.visible = true;
      } else {
        pointMarkers.visible = false;
      }

      // Sketch base colours (lines) + region fill highlight (faces).
      for (const child of sketchGroup.children) {
        if (child.userData.isSketchDisplay) {
          // Fat solid display line — recoloured live as the active sketch's
          // constrained state changes (under-constrained blue ⇄ solved green).
          const sid = child.userData.sketchId as string;
          const isActive = sid === activeSketchIdRef.current;
          ((child as LineSegments2).material as LineMaterial).color.set(
            sketchBaseColor(isActive, sketchFullyConstrainedRef.current),
          );
        } else if (child.userData.isSketchDots) {
          // Vertex dots match the active sketch line (blue ⇄ green). Shared
          // material, and dots only exist for the active sketch.
          sketchDotMaterial.color.set(sketchBaseColor(true, sketchFullyConstrainedRef.current));
        } else if (child instanceof THREE.LineSegments) {
          const sid = child.userData.sketchId as string;
          const isActive = sid === activeSketchIdRef.current;
          // material[0] = solid base line (invisible; the fat display line draws
          // it), material[1] = the dashed construction line (fixed amber).
          const base = (Array.isArray(child.material) ? child.material[0] : child.material) as THREE.LineBasicMaterial;
          base.color.set(sketchBaseColor(isActive, sketchFullyConstrainedRef.current));
        } else if (child instanceof THREE.Mesh && child.userData.isRegion) {
          const sid = child.userData.sketchId as string;
          const rid = child.userData.regionId as string;
          const isSel = sels.some((s) => s.kind === "sketchFace" && s.sketchId === sid && s.regionId === rid);
          const isHov = hovered?.kind === "sketchFace" && hovered.sketchId === sid && hovered.regionId === rid;
          const mat = child.material as THREE.MeshBasicMaterial;
          mat.opacity = isSel ? 0.32 : isHov ? 0.16 : 0;
          mat.color.set(isSel ? SELECT_COLOR : EDGE_HOV_COLOR);
        }
      }

      // Reference planes (user-created): brighten when selected as a feature or
      // hovered. Datums use their own hover path; user planes are pickable
      // features, so selection (from the viewport OR the timeline) lights them up.
      for (const c of planeGroup.children) {
        const pid = c.userData.planeId as string | undefined;
        if (!pid) continue;
        const selP = sels.some((s) => s.kind === "feature" && s.id === pid);
        const hovP = hoverUserPlaneRef.current === pid || (hovered?.kind === "feature" && hovered.id === pid);
        if (c instanceof THREE.Mesh) {
          (c.material as THREE.MeshBasicMaterial).opacity = selP ? 0.34 : hovP ? 0.3 : 0.1;
        } else if (c instanceof THREE.LineSegments) {
          (c.material as THREE.LineBasicMaterial).opacity = selP || hovP ? 0.9 : 0.5;
        }
      }
    };
    applyHighlightsRef.current = applyHighlights;

    const startTween = (to: THREE.Vector3, up: THREE.Vector3, target: THREE.Vector3) => {
      state.tween = { from: camera.position.clone(), to, up, start: performance.now() };
      controls.target.copy(target);
    };
    const goToDir = (dir: [number, number, number], up: [number, number, number]) => {
      const to = new THREE.Vector3(...dir).normalize().multiplyScalar(VIEW_DISTANCE);
      startTween(to, new THREE.Vector3(...up), new THREE.Vector3(0, 0, 0));
    };
    const goToView = (name: ViewName) => goToDir(VIEWS[name].dir, VIEWS[name].up);
    // Navigate to a ViewCube face (named view) or corner (an iso 3/4 direction).
    const goToCube = (hit: CubeHit) => ("view" in hit ? goToView(hit.view) : goToDir(hit.dir, hit.up));
    // --- Body-edge lookup (shared by the Project/Convert tool's id- and
    // name-based edge queries). Edge groups carry a build-local `edgeId` and a
    // persistent `name`; the LineSegments buffer is consecutive world-space pairs
    // [p0,p1, p1,p2, …] (no mesh transform). ---
    type EdgeGroup = { start: number; count: number; edgeId: number; name?: string; chainId?: number };
    const bodyEdgeGroups = (featureId: string): EdgeGroup[] | undefined => {
      const child = group.children.find(
        (x): x is THREE.LineSegments =>
          x instanceof THREE.LineSegments && x.userData.isBodyEdges && x.userData.featureId === featureId,
      );
      return child?.geometry.userData.edgeGroups as EdgeGroup[] | undefined;
    };
    const edgePolyline = (featureId: string, match: (g: EdgeGroup) => boolean): [number, number, number][] | null => {
      const child = group.children.find(
        (x): x is THREE.LineSegments =>
          x instanceof THREE.LineSegments && x.userData.isBodyEdges && x.userData.featureId === featureId,
      );
      const g = (child?.geometry.userData.edgeGroups as EdgeGroup[] | undefined)?.find(match);
      if (!child || !g) return null;
      const pos = child.geometry.getAttribute("position");
      // First segment's start, then the end of every segment → ordered polyline.
      const pts: [number, number, number][] = [[pos.getX(g.start), pos.getY(g.start), pos.getZ(g.start)]];
      for (let i = g.start + 1; i < g.start + g.count; i += 2) {
        pts.push([pos.getX(i), pos.getY(i), pos.getZ(i)]);
      }
      return pts;
    };
    apiRef.current = {
      setView(name) {
        goToView(name);
      },
      homeView() {
        const dir = new THREE.Vector3(...VIEWS.iso.dir).normalize();
        const up = new THREE.Vector3(...VIEWS.iso.up);
        // Bounds of every solid (body face meshes) plus every rendered sketch
        // outline. Suppressed/hidden sketches aren't in the group, so keying on
        // the rendered geometry naturally respects sketch visibility. Datum
        // planes and sketch region fills are skipped — they'd over-inflate the fit.
        const box = new THREE.Box3();
        let any = false;
        // Body face meshes live in `group`; rendered sketch outlines live in
        // `sketchGroup` (the thin LineSegments with a plain position attribute —
        // not the fat LineSegments2 display line, whose instanced geometry
        // doesn't give usable bounds). Suppressed/hidden sketches aren't in the
        // group, so keying on rendered geometry respects sketch visibility.
        for (const child of group.children) {
          if (child instanceof THREE.Mesh && child.userData.featureId && !child.userData.isRegion) {
            box.expandByObject(child);
            any = true;
          }
        }
        for (const child of sketchGroup.children) {
          if (child instanceof THREE.LineSegments && child.userData.sketchId) {
            box.expandByObject(child);
            any = true;
          }
        }
        if (!any || box.isEmpty()) {
          // Nothing modelled yet: the plain default iso about the world origin.
          startTween(dir.clone().multiplyScalar(VIEW_DISTANCE), up, new THREE.Vector3(0, 0, 0));
          return;
        }
        const center = box.getCenter(new THREE.Vector3());
        const radius = Math.max(box.getBoundingSphere(new THREE.Sphere()).radius, 1e-3);
        const MARGIN = 1.15;
        if ((camera as THREE.OrthographicCamera).isOrthographicCamera) {
          // Orthographic: distance doesn't scale, so fit via zoom against the
          // frustum's tighter half-extent (resize keeps it at the canvas aspect).
          const oc = camera as THREE.OrthographicCamera;
          const frustHalf = Math.min((oc.right - oc.left) / 2, (oc.top - oc.bottom) / 2);
          oc.zoom = frustHalf / (radius * MARGIN);
          oc.updateProjectionMatrix();
          startTween(center.clone().add(dir.clone().multiplyScalar(VIEW_DISTANCE)), up, center);
        } else {
          // Perspective: pull back so the bounding sphere fits the tighter of the
          // vertical/horizontal FOVs.
          const rect = renderer.domElement.getBoundingClientRect();
          const aspect = rect.width / rect.height || 1;
          const vFov = THREE.MathUtils.degToRad(CAMERA_FOV);
          const hFov = 2 * Math.atan(Math.tan(vFov / 2) * aspect);
          const dist = (radius * MARGIN) / Math.sin(Math.min(vFov, hFov) / 2);
          startTween(center.clone().add(dir.clone().multiplyScalar(dist)), up, center);
        }
      },
      setProjection(mode) {
        const isOrtho = (camera as THREE.OrthographicCamera).isOrthographicCamera === true;
        if ((mode === "orthographic") === isOrtho) return; // already in that mode
        const rect = renderer.domElement.getBoundingClientRect();
        const aspect = rect.width / rect.height || 1;
        const fovRad = THREE.MathUtils.degToRad(CAMERA_FOV);
        const dir = camera.position.clone().sub(controls.target); // camera - target
        const dist = dir.length() || VIEW_DISTANCE;
        let next: THREE.PerspectiveCamera | THREE.OrthographicCamera;
        if (mode === "orthographic") {
          // Match the perspective's visible height at the target so the swap is
          // seamless: frustum half-height = dist·tan(fov/2).
          const halfH = dist * Math.tan(fovRad / 2);
          next = new THREE.OrthographicCamera(-halfH * aspect, halfH * aspect, halfH, -halfH, 0.1, 10_000);
          next.position.copy(camera.position);
        } else {
          // Going back to perspective: place the camera at the distance whose
          // frustum height equals the ortho's current visible height (top/zoom).
          const oc = camera as THREE.OrthographicCamera;
          const visH = (oc.top - oc.bottom) / oc.zoom;
          const newDist = visH / (2 * Math.tan(fovRad / 2)) || dist;
          next = new THREE.PerspectiveCamera(CAMERA_FOV, aspect, 0.1, 10_000);
          next.position.copy(controls.target).add(dir.setLength(newDist));
        }
        next.up.copy(camera.up);
        next.lookAt(controls.target);
        next.updateProjectionMatrix();
        camera = next;
        controls.object = next;
        transformControls.camera = next;
        sectionControls.camera = next;
        extrudeControls.camera = next;
        state.camera = next;
        controls.update();
        // The ViewCube reads `state.camera` each frame (see the animate loop),
        // so a projection swap needs no work here.
      },
      lookAtFrame(frame, aim) {
        const normal = new THREE.Vector3(...frame.normal).normalize();
        // Aim at the clicked point (the user's actual action) when we have it,
        // else the frame origin. Keep the current camera→target distance so the
        // view re-orients face-on without jumping to a fixed far standoff.
        const target = aim ? new THREE.Vector3(...aim) : new THREE.Vector3(...frame.origin);
        const dist = camera.position.distanceTo(controls.target) || VIEW_DISTANCE;
        startTween(target.clone().add(normal.multiplyScalar(dist)), new THREE.Vector3(...frame.vAxis), target);
      },
      frameSketchBounds(frame, min, max) {
        const O = new THREE.Vector3(...frame.origin);
        const U = new THREE.Vector3(...frame.uAxis);
        const V = new THREE.Vector3(...frame.vAxis);
        const N = new THREE.Vector3(...frame.normal).normalize();
        // Bounds centre mapped from (u,v) into world space — the point we aim at.
        const cu = (min[0] + max[0]) / 2,
          cv = (min[1] + max[1]) / 2;
        const center = O.clone().add(U.clone().multiplyScalar(cu)).add(V.clone().multiplyScalar(cv));
        // In-plane half-extents with a margin so the geometry isn't edge-to-edge.
        // Guard against a zero-size box (single point / all-coincident import).
        const MARGIN = 1.15;
        const halfW = Math.max((max[0] - min[0]) / 2, 1e-3) * MARGIN;
        const halfH = Math.max((max[1] - min[1]) / 2, 1e-3) * MARGIN;
        if ((camera as THREE.OrthographicCamera).isOrthographicCamera) {
          // Orthographic: fit by setting zoom so both axes are inside the frustum
          // (which resize keeps at the canvas aspect). Distance is irrelevant to
          // scale, so keep the standard VIEW_DISTANCE for a stable near/far.
          const oc = camera as THREE.OrthographicCamera;
          const frustHalfW = (oc.right - oc.left) / 2;
          const frustHalfH = (oc.top - oc.bottom) / 2;
          oc.zoom = Math.min(frustHalfW / halfW, frustHalfH / halfH);
          oc.updateProjectionMatrix();
          startTween(
            center.clone().add(N.clone().multiplyScalar(VIEW_DISTANCE)),
            new THREE.Vector3(...frame.vAxis),
            center,
          );
        } else {
          // Perspective: fit by pulling the camera back to the distance whose
          // frustum spans the bounds on the tighter axis.
          const rect = renderer.domElement.getBoundingClientRect();
          const aspect = rect.width / rect.height || 1;
          const t = Math.tan(THREE.MathUtils.degToRad(CAMERA_FOV) / 2);
          const dist = Math.max(halfH, halfW / aspect) / t;
          startTween(center.clone().add(N.clone().multiplyScalar(dist)), new THREE.Vector3(...frame.vAxis), center);
        }
      },
      worldToScreen(p) {
        const v = new THREE.Vector3(p[0], p[1], p[2]).project(camera);
        const rect = renderer.domElement.getBoundingClientRect();
        return { x: (v.x * 0.5 + 0.5) * rect.width, y: (-v.y * 0.5 + 0.5) * rect.height };
      },
      getEdgeWorldPolyline(featureId, edgeId) {
        return edgePolyline(featureId, (g) => g.edgeId === edgeId);
      },
      getEdgeName(featureId, edgeId) {
        const eg = bodyEdgeGroups(featureId);
        return eg?.find((x) => x.edgeId === edgeId)?.name;
      },
      getEdgeWorldPolylineByName(featureId, name) {
        return edgePolyline(featureId, (g) => g.name === name);
      },
      capturePNG(opts) {
        // Snap to the end of any in-flight view tween so the requested camera is
        // captured now, not mid-animation.
        if (state.tween) {
          camera.position.copy(state.tween.to);
          camera.up.copy(state.tween.up);
          state.tween = null;
        }
        controls.update();
        // Plain mode: blank every highlight source, re-apply materials, render
        // the capture frame, then restore — all in this tick, so the on-screen
        // frame the user sees next is the normal highlighted one.
        const saved = opts?.plain
          ? {
              sel: selectionRef.current,
              hover: hoverSelRef.current,
              bodies: highlightBodyIdsRef.current,
              bool: booleanHighlightRef.current,
            }
          : null;
        if (saved) {
          selectionRef.current = [];
          hoverSelRef.current = null;
          highlightBodyIdsRef.current = new Set();
          booleanHighlightRef.current = null;
          applyHighlights();
        }
        // Read back in the same tick as render — the WebGL drawing buffer isn't
        // preserved across the browser's compositing step.
        renderer.render(scene, camera);
        const url = renderer.domElement.toDataURL("image/png");
        if (saved) {
          selectionRef.current = saved.sel;
          hoverSelRef.current = saved.hover;
          highlightBodyIdsRef.current = saved.bodies;
          booleanHighlightRef.current = saved.bool;
          applyHighlights();
          renderer.render(scene, camera);
        }
        return url;
      },
    };

    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    let down: { x: number; y: number } | null = null;
    // The ViewCube target under the press, if the press landed on the cube. A
    // release that barely moved navigates to it (a click); a release that dragged
    // is left to OrbitControls (grab-and-orbit). Either way the cube press is
    // suppressed from the normal selection click. Set in onGizmoDown.
    let cubeHit: CubeHit | null = null;
    // An in-progress drag of unconstrained sketch geometry (Select tool, inside a
    // sketch). `origins` are the pre-drag uv of the points being moved; `single`
    // distinguishes a one-vertex drag (snap to cursor) from a body/region
    // translate (every point shifts by the same delta). `moved` gates the click
    // vs. drag decision so a tap still selects.
    let sketchDrag: {
      startClient: { x: number; y: number };
      grab: Vec2;
      origins: Vec2[];
      single: boolean;
      moved: boolean;
    } | null = null;
    const projectToPx = (world: THREE.Vector3) => {
      const v = world.clone().project(camera);
      const rect = renderer.domElement.getBoundingClientRect();
      return { x: (v.x * 0.5 + 0.5) * rect.width + rect.left, y: (-v.y * 0.5 + 0.5) * rect.height + rect.top };
    };
    /** The scale gizmo grip under the cursor, if any. Depth-independent: the grips
     *  draw over everything (depthTest off), so they must pick that way too. */
    const pickScaleGrip = (clientX: number, clientY: number): THREE.Mesh | null => {
      if (!scaleGizmo.visible) return null;
      const rect = renderer.domElement.getBoundingClientRect();
      pointer.x = ((clientX - rect.left) / rect.width) * 2 - 1;
      pointer.y = -((clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(pointer, camera);
      return (raycaster.intersectObjects(scaleGrips, false)[0]?.object as THREE.Mesh) ?? null;
    };

    const planeHitUv = (clientX: number, clientY: number): Vec2 | null => {
      const frame = activeFrameRef.current;
      if (!frame) return null;
      const rect = renderer.domElement.getBoundingClientRect();
      pointer.x = ((clientX - rect.left) / rect.width) * 2 - 1;
      pointer.y = -((clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(pointer, camera);
      const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(
        new THREE.Vector3(...frame.normal).normalize(),
        new THREE.Vector3(...frame.origin),
      );
      const hit = new THREE.Vector3();
      if (!raycaster.ray.intersectPlane(plane, hit)) return null;
      const d = hit.sub(new THREE.Vector3(...frame.origin));
      return [d.dot(new THREE.Vector3(...frame.uAxis)), d.dot(new THREE.Vector3(...frame.vAxis))];
    };
    // Snap to inferences: points (origin, endpoints/midpoints of any coplanar
    // sketch or body edge), then nearest point on a coplanar edge, then
    // horizontal/vertical relative to the chain start. No grid snapping.
    const snap = (
      raw: Vec2,
      clientX: number,
      clientY: number,
    ): {
      uv: Vec2;
      kind: "point" | "edge" | "h" | "v" | "guide" | "free";
      hv?: "horizontal" | "vertical";
      /** What an active-sketch entity the snapped point should attach to: its
       *  midpoint (`mid: true`) or a point on its body (`mid: false`). */
      on?: { id: string; mid: boolean };
      /** The snap landed on an existing corner (endpoint/origin) — the line tool
       *  ends its chain here rather than continuing to the next segment. */
      atVertex?: boolean;
      /** For an edge snap: the full segment snapped to (uv), so the whole edge
       *  can be highlighted, not just the marker dot. */
      seg?: [Vec2, Vec2];
      /** The snapped edge belongs to a construction line — highlight it dashed. */
      construction?: boolean;
      /** For a guide (inference) snap: the guide lines the point lies on, to draw
       *  as dotted alignment lines. */
      guideLines?: Guide[];
      /** For a guide snap: the meanings hit, so the click can capture a
       *  parallel/perpendicular constraint (H/V go through `hv`). */
      meanings?: { meaning: "horizontal" | "vertical" | "parallel" | "perpendicular"; refId?: string }[];
      /** The body circle this snap references (centre/quadrant/on-ring) — drawn
       *  as a highlight so it's clear which hole/rim you're snapping to. */
      circle?: { c: Vec2; r: number };
      /** A uv to PIN this snap to (a coincident-to-{fixed}) when it landed on body
       *  geometry (a rim/centre/quadrant or a body edge) — so the snap lasts. */
      onFixed?: Vec2;
    } => {
      const frame = activeFrameRef.current!;
      const distPx = (c: Vec2) => {
        const w = uvToWorld(frame, c[0], c[1]);
        const px = projectToPx(new THREE.Vector3(w[0], w[1], w[2]));
        return Math.hypot(px.x - clientX, px.y - clientY);
      };
      const ref = draftRef.current[draftRef.current.length - 1];
      // Horizontal/vertical of the segment ref -> p (if it's near-axis-aligned).
      // Derived from the *resolved* endpoint, so it still fires when the endpoint
      // also snaps to a point/edge — otherwise closing a rectangle onto an
      // existing corner would silently drop that edge's H/V constraint.
      const hvOf = (p: Vec2): "horizontal" | "vertical" | undefined => {
        if (!ref || (p[0] === ref[0] && p[1] === ref[1])) return undefined;
        const ang = Math.atan2(p[1] - ref[1], p[0] - ref[0]);
        const dH = Math.min(Math.abs(ang), Math.abs(Math.abs(ang) - Math.PI));
        const dV = Math.abs(Math.abs(ang) - Math.PI / 2);
        if (dH < ANGLE_SNAP) return "horizontal";
        if (dV < ANGLE_SNAP) return "vertical";
        return undefined;
      };
      // 1. nearest snap point (static candidates + the current draft points).
      // Draft points carry no `vertex` flag, so snapping back onto the chain's
      // own in-progress point never counts as closing on an existing corner.
      let best: {
        uv: Vec2;
        midpointOf?: string;
        vertex?: boolean;
        circle?: { c: Vec2; r: number };
        external?: boolean;
      } | null = null;
      let bestD = SNAP_PX;
      for (const c of snapPointsRef.current) {
        const d = distPx(c.uv);
        if (d < bestD) {
          bestD = d;
          best = c;
        }
      }
      for (const c of draftRef.current) {
        const d = distPx(c);
        if (d < bestD) {
          bestD = d;
          best = { uv: c };
        }
      }
      if (best)
        return {
          uv: best.uv,
          kind: "point",
          hv: hvOf(best.uv),
          on: best.midpointOf ? { id: best.midpointOf, mid: true } : undefined,
          atVertex: best.vertex,
          circle: best.circle,
          // Pin to body geometry (a circle centre/quadrant, or a body-edge point).
          onFixed: best.circle || best.external ? best.uv : undefined,
        };
      // 2. nearest point on a coplanar edge
      let bestLine: Vec2 | null = null;
      let bestLineId: string | undefined;
      let bestSeg: [Vec2, Vec2] | undefined;
      let bestConstruction = false;
      let bestLineCircle: { c: Vec2; r: number } | undefined;
      let bestLineExternal = false;
      let bestLD = SNAP_PX;
      for (const seg of snapLinesRef.current) {
        const q = nearestOnSegment(raw, seg.a, seg.b);
        const d = distPx(q);
        if (d < bestLD) {
          bestLD = d;
          bestLine = q;
          bestLineId = seg.id;
          bestSeg = [seg.a, seg.b];
          bestConstruction = !!seg.construction;
          bestLineCircle = undefined;
          bestLineExternal = !!seg.external;
        }
      }
      // On-circle: nearest point on a coplanar ring (a hole rim / cap). Competes
      // at the same tier as edges; the exact centre/quadrants already won above as
      // points. No `id`/`seg` — it's a positional snap, no constraint attached.
      for (const circ of snapCirclesRef.current) {
        const dx = raw[0] - circ.c[0],
          dy = raw[1] - circ.c[1];
        const len = Math.hypot(dx, dy);
        if (len < 1e-6) continue;
        const q: Vec2 = [circ.c[0] + (circ.r * dx) / len, circ.c[1] + (circ.r * dy) / len];
        const d = distPx(q);
        if (d < bestLD) {
          bestLD = d;
          bestLine = q;
          bestLineId = circ.id;
          bestSeg = undefined;
          bestConstruction = false;
          bestLineCircle = circ;
          bestLineExternal = !!circ.external;
        }
      }
      if (bestLine)
        return {
          uv: bestLine,
          kind: "edge",
          hv: hvOf(bestLine),
          on: bestLineId ? { id: bestLineId, mid: false } : undefined,
          onFixed: bestLineExternal ? bestLine : undefined,
          seg: bestSeg,
          construction: bestConstruction,
          circle: bestLineCircle,
        };
      // 3. Inference guides: horizontal/vertical/parallel/perpendicular lines from
      // the draft start, armed key points, and armed edge directions. Subsumes the
      // old draft-start H/V step (the draft start emits its own H/V guides).
      const armed = armedRef.current;
      const guides = buildGuides({
        points: armed.points.map((a) => ({ p: a.uv })),
        draftStart: ref,
        armedDirs: armed.lines.map((l) => ({ dir: l.dir, refId: l.refId })),
      });
      if (guides.length) {
        const pxOf = (uv: Vec2): Vec2 => {
          const w = uvToWorld(frame, uv[0], uv[1]);
          const px = projectToPx(new THREE.Vector3(w[0], w[1], w[2]));
          return [px.x, px.y];
        };
        const gs = snapToGuides(raw, guides, pxOf, SNAP_PX);
        if (gs) {
          const hv = gs.meanings.some((m) => m.meaning === "horizontal")
            ? "horizontal"
            : gs.meanings.some((m) => m.meaning === "vertical")
              ? "vertical"
              : undefined;
          return { uv: gs.uv, kind: "guide", hv, guideLines: gs.guides, meanings: gs.meanings };
        }
      }
      return { uv: raw, kind: "free" };
    };

    // Arm the just-hovered key point / edge direction as an inference source, so
    // its guides show once the cursor moves away. Time-limited + capped so armed
    // sources fade rather than accumulate.
    const ARM_TTL = 4000;
    const ARM_CAP = 3;
    const armFromSnap = (
      kind: "point" | "edge" | "h" | "v" | "guide" | "free",
      uv: Vec2,
      seg: [Vec2, Vec2] | undefined,
      refId: string | undefined,
    ) => {
      const now = performance.now();
      const armed = armedRef.current;
      armed.points = armed.points.filter((a) => now - a.at < ARM_TTL);
      armed.lines = armed.lines.filter((a) => now - a.at < ARM_TTL);
      if (kind === "point") {
        armed.points = armed.points.filter((a) => Math.hypot(a.uv[0] - uv[0], a.uv[1] - uv[1]) > 1e-6);
        armed.points.push({ uv, at: now });
        if (armed.points.length > ARM_CAP) armed.points.shift();
      } else if (kind === "edge" && seg) {
        const dx = seg[1][0] - seg[0][0];
        const dy = seg[1][1] - seg[0][1];
        const n = Math.hypot(dx, dy) || 1;
        const dir: Vec2 = [dx / n, dy / n];
        // Drop a near-parallel armed direction (keep the freshest) before adding.
        armed.lines = armed.lines.filter((a) => Math.abs(a.dir[0] * dir[1] - a.dir[1] * dir[0]) > 1e-3);
        armed.lines.push({ dir, refId, at: now });
        if (armed.lines.length > ARM_CAP) armed.lines.shift();
      }
    };

    // Section view clips body geometry only — datums, user reference planes,
    // sketch entities and regions stay pickable regardless (same exemption as
    // their rendering: see the clippingPlanes assignments above). Routed
    // through the same pure `resolveSectionPlane`/`sectionKeeps` the render
    // sync (syncSectionPlane, below) and the unit tests use — one definition
    // of "which side is kept," so picking and the GPU clip can't drift apart.
    const sectionAllows = (p: THREE.Vector3): boolean => {
      const sv = sectionViewRef.current;
      if (!sv.enabled) return true;
      const plane = resolveSectionPlane(sv.frame, sv.offset, sv.flip);
      return sectionKeeps(plane, [p.x, p.y, p.z]);
    };

    const pick = (clientX: number, clientY: number) => {
      const rect = renderer.domElement.getBoundingClientRect();
      pointer.x = ((clientX - rect.left) / rect.width) * 2 - 1;
      pointer.y = -((clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(pointer, camera);
      // `.visible` filters are load-bearing, not tidiness: three.js raycasts
      // invisible objects happily, and datum visibility is implemented by
      // setting `object.visible` — so without this a datum the user switched OFF
      // still swallows clicks (and hover) meant for the geometry behind it.
      const planeObjs = datums.filter((d) => d.kind === "plane" && d.object.visible).map((d) => d.object);
      const userPlaneObjs = planeGroup.children.filter((c): c is THREE.Mesh => c instanceof THREE.Mesh && c.visible);
      const bodies = group.children.filter((c): c is THREE.Mesh => c instanceof THREE.Mesh && c.visible);
      const hit = raycaster
        .intersectObjects([...planeObjs, ...userPlaneObjs, ...bodies], false)
        .find(
          (h) =>
            planeObjs.includes(h.object) || userPlaneObjs.includes(h.object as THREE.Mesh) || sectionAllows(h.point),
        );
      if (!hit) return null;
      const datum = datums.find((d) => d.object === hit.object);
      if (datum) return { kind: "datum" as const, id: datum.id };
      const planeId = hit.object.userData.planeId as string | undefined;
      if (planeId) return { kind: "userplane" as const, planeId };
      const mesh = hit.object as THREE.Mesh;
      const normal = hit.face
        ? hit.face.normal.clone().transformDirection(mesh.matrixWorld)
        : new THREE.Vector3(0, 0, 1);
      const featureId = mesh.userData.featureId as string | undefined;
      const faceId = hit.faceIndex != null ? getFaceId(hit.faceIndex, mesh.geometry) : undefined;
      return { kind: "face" as const, mesh, point: hit.point.clone(), normal, featureId, faceId };
    };
    // Idle-mode selection with CAD priority: vertex > edge > face > sketch.
    const pickSelection = (clientX: number, clientY: number): Selection | null => {
      const rect = renderer.domElement.getBoundingClientRect();
      pointer.x = ((clientX - rect.left) / rect.width) * 2 - 1;
      pointer.y = -((clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(pointer, camera);

      // The sketch origin is selectable anywhere (not only when a sketch line is
      // under the cursor), so it can be the anchor for a coincident / point-on-
      // line constraint. Highest priority — a click right on it picks the origin.
      const activeSid = activeSketchIdRef.current;
      const activeFrame = activeFrameRef.current;
      if (activeSid && activeFrame) {
        const ow = uvToWorld(activeFrame, 0, 0);
        const px = projectToPx(new THREE.Vector3(ow[0], ow[1], ow[2]));
        if (Math.hypot(px.x - clientX, px.y - clientY) < SNAP_PX) {
          return { kind: "sketchPoint", sketchId: activeSid, point: [0, 0] };
        }
      }

      const faceMeshes = group.children.filter((c): c is THREE.Mesh => c instanceof THREE.Mesh);
      const bodyEdges = group.children.filter(
        (c): c is THREE.LineSegments => c instanceof THREE.LineSegments && c.userData.isBodyEdges,
      );
      const sketchSegs = sketchGroup.children.filter((c): c is THREE.LineSegments => c instanceof THREE.LineSegments);
      const regionMeshes = sketchGroup.children.filter(
        (c): c is THREE.Mesh => c instanceof THREE.Mesh && c.userData.isRegion === true,
      );
      // Faces/regions first (they don't use the Line threshold) to learn the
      // depth under the cursor, then size the edge/line raycast so its search
      // radius equals PICK_DETECT_PX *pixels* at that depth — making edge/vertex
      // detection zoom-independent (see the constants above).
      // Body geometry respects the section clip (a face/edge sliced away can't
      // be picked — you'd otherwise select the invisible far side); sketch
      // regions below are exempt, same as their rendering.
      const faceHit = raycaster.intersectObjects(faceMeshes, false).find((h) => sectionAllows(h.point));
      const regionHit = raycaster.intersectObjects(regionMeshes, false)[0];
      const depth = faceHit ? faceHit.distance : camera.position.distanceTo(controls.target);
      const worldPerPx = worldPerPixel(depth, rect.height);
      raycaster.params.Line = { threshold: worldPerPx * PICK_DETECT_PX };
      const edgeHits = raycaster.intersectObjects(bodyEdges, false).filter((h) => sectionAllows(h.point));
      const sketchHits = raycaster.intersectObjects(sketchSegs, false);

      // Selection filters: which body-geometry kinds the picker may return.
      // (Sketch picks below are unaffected — they belong to sketch editing.)
      const flt = selectionFilterRef.current;

      // Arming a profile: the only thing worth returning is a region, and it
      // wins outright — no depth gate, no thin-element priority. Without this a
      // body (or even the profile's own sketch lines) shadows the fill and the
      // click silently does nothing.
      if (regionPickPriorityRef.current && regionHit) {
        const sid = regionHit.object.userData.sketchId as string | undefined;
        const rid = regionHit.object.userData.regionId as string | undefined;
        if (sid && rid) return { kind: "sketchFace", sketchId: sid, regionId: rid };
      }

      // Thin elements (body edges, sketch lines) take priority over a face when
      // the cursor is near them (in pixels) and they're not behind that face.
      const faceDist = faceHit ? faceHit.distance : Infinity;

      // Resolve the nearest body edge into its pixel gaps: edgePx = distance to
      // the edge polyline, vertexPx = distance to the nearest REAL vertex on it
      // (see realVertexNear — a faceted circle's chord junctions don't count).
      // Vertex and edge are then *independent* pixel gates (vertex ≥ edge), so a
      // click by an endpoint reliably selects the vertex even when the edge body
      // has already fallen outside EDGE_PICK_PX.
      //
      // The edge is chosen by PIXEL distance, not intersect order, for the same
      // reason as the sketch hit below: on a faceted rim seen down its axis every
      // chord ties on depth, so `[0]` returned an arbitrary one — typically a
      // whole chord away, which then failed the EDGE_PICK_PX gate.
      const edgeNear = nearestHitInPixels(edgeHits, projectToPx, clientX, clientY, faceDist + PICK_DEPTH_TOL);
      const edgeHit = edgeNear?.hit;
      let edgeInfo: {
        fid: string;
        edgeId: number | undefined;
        near: THREE.Vector3 | null;
        edgePx: number;
        vertexPx: number;
      } | null = null;
      if (edgeHit && edgeHit.index != null) {
        const mesh = edgeHit.object as THREE.LineSegments;
        const near = realVertexNear(mesh.geometry, edgeHit.index, edgeHit.point);
        const np = near ? projectToPx(near) : null;
        edgeInfo = {
          fid: mesh.userData.featureId as string,
          edgeId: getEdgeId(edgeHit.index, mesh.geometry),
          near,
          edgePx: edgeNear!.px,
          vertexPx: np ? Math.hypot(np.x - clientX, np.y - clientY) : Infinity,
        };
      }
      // Sketch line gated the same way (pixel gap to the line), so it doesn't
      // steal a wide band from the sketch region behind it. The hit is chosen by
      // PIXEL distance, not intersect order — see nearestHitInPixels: taking [0]
      // made circles (and every other tessellated entity) unclickable on their
      // rim. Occluded hits drop out first, so a line behind a face can't win
      // over one in front of it.
      const sketchNear = nearestHitInPixels(sketchHits, projectToPx, clientX, clientY, faceDist + PICK_DEPTH_TOL);
      const sketchHit = sketchNear?.hit;
      const sketchPx = sketchNear ? sketchNear.px : Infinity;
      const sketchOk = !!sketchHit && sketchPx <= EDGE_PICK_PX;

      // Vertex is the highest-priority element (a point beats any edge/face/line).
      if (flt.vertex && edgeInfo?.near && edgeInfo.vertexPx <= VERTEX_PICK_PX) {
        const n = edgeInfo.near;
        return { kind: "vertex", featureId: edgeInfo.fid, point: [n.x, n.y, n.z] };
      }
      // Then the edge — unless a sketch line is both in range and nearer.
      const edgeOk = !!edgeInfo && edgeInfo.edgePx <= EDGE_PICK_PX && edgeInfo.edgeId !== undefined;
      if (flt.edge && edgeOk && (!sketchOk || edgeHit!.distance <= sketchHit!.distance)) {
        return { kind: "edge", featureId: edgeInfo!.fid, edgeId: edgeInfo!.edgeId! };
      }
      if (sketchOk) {
        const obj = sketchHit!.object as THREE.LineSegments;
        const sid = obj.userData.sketchId as string | undefined;
        if (sid) {
          const sketch = sketchesRef.current.find((s) => s.id === sid);
          const frame = obj.userData.frame as PlaneFrameData | undefined;
          // Sketch point takes priority over the entity, under a gate that
          // differs by kind:
          //  • a VERTEX wins within VERTEX_PICK_PX, the same target a body
          //    vertex gets. It can't be asked to also be nearer than the
          //    entity: an endpoint lies ON its own line, so the line is ~0px
          //    away and the endpoint could only ever win by a hair — which is
          //    what made grabbing a line's end to constrain it so fiddly.
          //  • a CENTRE or the ORIGIN must still be nearer than the entity.
          //    Without that a small circle was unselectable (every click on a
          //    rim within 12px of the centre returned the centre), and a line
          //    through the origin couldn't be clicked at its middle.
          // Trim/Extend act on EDGES, never on points — and extend is used by
          // clicking right next to an end, precisely where a vertex would win.
          // Skipping the point candidates keeps those tools (and their hover
          // preview) resolving the edge the cursor is actually on.
          if (sketch && frame && !isTrimTool(sketchToolRef.current)) {
            let best: Vec2 | null = null;
            let bestD = Infinity;
            for (const c of sketchPointCandidates(sketch)) {
              const gate = c.kind === "vertex" ? VERTEX_PICK_PX : Math.min(SNAP_PX, sketchPx);
              const w = uvToWorld(frame, c.uv[0], c.uv[1]);
              const px = projectToPx(new THREE.Vector3(w[0], w[1], w[2]));
              const d = Math.hypot(px.x - clientX, px.y - clientY);
              if (d < gate && d < bestD) {
                bestD = d;
                best = c.uv;
              }
            }
            if (best) return { kind: "sketchPoint", sketchId: sid, point: best };
          }
          const eg = obj.geometry.userData.entityGroups as
            { start: number; count: number; entityId: string }[] | undefined;
          if (eg && sketchHit!.index != null) {
            const grp = eg.find((g) => sketchHit!.index! >= g.start && sketchHit!.index! < g.start + g.count);
            if (grp) return { kind: "sketchEntity", sketchId: sid, entityId: grp.entityId };
          }
          return { kind: "feature", id: sid };
        }
      }
      // Enclosed sketch region (face) — below sketch lines, above body faces.
      if (regionHit && regionHit.distance <= faceDist + PICK_DEPTH_TOL) {
        const sid = regionHit.object.userData.sketchId as string | undefined;
        const rid = regionHit.object.userData.regionId as string | undefined;
        if (sid && rid) return { kind: "sketchFace", sketchId: sid, regionId: rid };
      }
      if (faceHit && faceHit.faceIndex != null && (flt.face || flt.body)) {
        const mesh = faceHit.object as THREE.Mesh;
        const fid = mesh.userData.featureId as string | undefined;
        if (fid !== undefined) {
          const faceId = getFaceId(faceHit.faceIndex, mesh.geometry);
          if (faceId !== undefined && flt.face) return { kind: "face", featureId: fid, faceId };
          if (flt.body) return { kind: "feature", id: fid };
        }
      }
      // Reference planes (user-created) are the LOWEST-priority pick — only when
      // nothing else was hit under the cursor and it's not behind a body face.
      // Selecting one returns a plain feature selection, so it highlights in the
      // viewport AND its timeline row lights up, like any other feature.
      const planeObjs = planeGroup.children.filter((c): c is THREE.Mesh => c instanceof THREE.Mesh);
      const planeHit = raycaster.intersectObjects(planeObjs, false)[0];
      if (planeHit && planeHit.distance <= faceDist + PICK_DEPTH_TOL) {
        const pid = planeHit.object.userData.planeId as string | undefined;
        if (pid) return { kind: "feature", id: pid };
      }
      return null;
    };
    // What a press inside the active sketch (Select tool) would grab to drag: a
    // single vertex, an entity body, or an enclosed region — else null.
    const pickSketchDrag = (
      clientX: number,
      clientY: number,
    ): { origins: Vec2[]; grab: Vec2; single: boolean } | null => {
      const sid = activeSketchIdRef.current;
      const frame = activeFrameRef.current;
      if (!sid || !frame) return null;
      const sketch = sketchesRef.current.find((s) => s.id === sid);
      if (!sketch) return null;
      const grab = planeHitUv(clientX, clientY);
      if (!grab) return null;

      // 1. A single draggable vertex near the cursor → move just that point.
      let best: Vec2 | null = null;
      let bestD = SNAP_PX;
      for (const uv of draggableVertices(sketch)) {
        const w = uvToWorld(frame, uv[0], uv[1]);
        const px = projectToPx(new THREE.Vector3(w[0], w[1], w[2]));
        const d = Math.hypot(px.x - clientX, px.y - clientY);
        if (d < bestD) {
          bestD = d;
          best = uv;
        }
      }
      if (best) return { origins: [best], grab, single: true };

      // Otherwise raycast the active sketch's lines + region fills.
      const rect = renderer.domElement.getBoundingClientRect();
      pointer.x = ((clientX - rect.left) / rect.width) * 2 - 1;
      pointer.y = -((clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(pointer, camera);
      // Screen-space line threshold: world units for PICK_DETECT_PX pixels at
      // the orbit-target depth, so the grab band is constant on screen.
      const dragDepth = camera.position.distanceTo(controls.target);
      const dragWorldPerPx = worldPerPixel(dragDepth, rect.height);
      raycaster.params.Line = { threshold: dragWorldPerPx * PICK_DETECT_PX };

      // 2. An entity body → translate all of its points.
      const seg = sketchGroup.children.find(
        (c): c is THREE.LineSegments => c instanceof THREE.LineSegments && c.userData.sketchId === sid,
      );
      if (seg) {
        const hit = raycaster.intersectObject(seg, false)[0];
        if (hit && hit.index != null) {
          const eg = seg.geometry.userData.entityGroups as
            { start: number; count: number; entityId: string }[] | undefined;
          const g = eg?.find((x) => hit.index! >= x.start && hit.index! < x.start + x.count);
          const e = g && sketch.entities.find((x) => x.id === g.entityId);
          if (e) return { origins: entityDragPoints(e), grab, single: false };
        }
      }

      // 3. An enclosed region (polygon/face interior) → translate the whole loop.
      const regions = sketchGroup.children.filter(
        (c): c is THREE.Mesh => c instanceof THREE.Mesh && c.userData.isRegion === true && c.userData.sketchId === sid,
      );
      const rHit = raycaster.intersectObjects(regions, false)[0];
      if (rHit) {
        const rid = rHit.object.userData.regionId as string | undefined;
        const region = sketch.regions.find((r) => r.id === rid);
        if (region) {
          const seen = new Set<string>();
          const origins: Vec2[] = [];
          for (const id of region.entityIds) {
            const e = sketch.entities.find((x) => x.id === id);
            if (!e) continue;
            for (const p of entityDragPoints(e)) {
              const k = `${p[0].toFixed(4)},${p[1].toFixed(4)}`;
              if (!seen.has(k)) {
                seen.add(k);
                origins.push(p);
              }
            }
          }
          if (origins.length) return { origins, grab, single: false };
        }
      }
      return null;
    };

    const clearHover = () => {
      if (hoverBodyRef.current) {
        hoverBodyRef.current.mesh.material = hoverBodyRef.current.prev;
        hoverBodyRef.current = null;
      }
      if (hoverPlaneRef.current) {
        hoverPlaneRef.current = null;
        applyDatumAppearance(state, null);
      }
      if (hoverUserPlaneRef.current) {
        hoverUserPlaneRef.current = null;
        applyHighlights();
      }
      renderer.domElement.style.cursor = "";
    };

    const onMove = (e: PointerEvent) => {
      // A scale-grip drag owns the pointer: the factor is how far along the
      // pivot→corner line the pointer now sits, as a fraction of where the grab
      // started, measured ON SCREEN. Screen space is what makes this stable — the
      // grab is a corner of the body's own box, comfortably far from the pivot in
      // pixels, so the ratio never approaches 0/0 the way a pivot-anchored
      // handle's does; and it is what the eye is judging anyway.
      //
      // Projected onto that line rather than taken as a raw distance, so moving
      // sideways doesn't resize, and pushing PAST the pivot goes negative and
      // clamps to the floor — it can't come back up the far side (a raw distance
      // would grow again there) and it can't flip the body inside out.
      if (scaleDrag) {
        const te = transformEditRef.current;
        if (!te) return;
        const pivotPx = projectToPx(new THREE.Vector3(...te.pivot));
        const along = (e.clientX - pivotPx.x) * scaleDrag.dir.x + (e.clientY - pivotPx.y) * scaleDrag.dir.y;
        const raw = (scaleDrag.startFactor * Math.max(0, along)) / scaleDrag.grabPx;
        const snapped = Math.round(raw / SCALE_SNAP) * SCALE_SNAP;
        const next = Number.isFinite(snapped) ? THREE.MathUtils.clamp(snapped, SCALE_SNAP, 1000) : scaleDrag.live;
        scaleDrag.moved = true;
        scaleDrag.live = next;
        const ld = state.liveDrag;
        if (ld) poseDraggedBody(ld, transformMatrix(te.pivot, te.tx, te.ty, te.tz, te.angle, te.axis, next));
        onTransformPreviewRef.current({ tx: te.tx, ty: te.ty, tz: te.tz, angle: te.angle, scale: next });
        return;
      }
      // A drag owned by one of the TransformControls gizmos (transform /
      // section / extrude): the controls run their own pointermove (their
      // listeners registered first); skip hover picking underneath so
      // highlights don't churn behind the gizmo.
      if (transformControls.dragging || sectionControls.dragging || extrudeControls.dragging) return;
      // Light up the grip under the pointer, so it reads as grabbable.
      if (scaleGizmoActive()) {
        const hit = pickScaleGrip(e.clientX, e.clientY);
        for (const m of scaleGrips) m.material = m === hit ? scaleGripHoverMaterial : scaleGripMaterial;
        renderer.domElement.style.cursor = hit ? "grab" : "";
      }
      // An active sketch drag owns the pointer: move the grabbed geometry and let
      // App re-solve. Wait for a few px of travel before the first solve so a tap
      // still reads as a click (handled in onUp).
      if (sketchDrag) {
        if (!sketchDrag.moved) {
          const d = Math.hypot(e.clientX - sketchDrag.startClient.x, e.clientY - sketchDrag.startClient.y);
          if (d < DRAG_START_PX) return;
          sketchDrag.moved = true;
        }
        const cur = planeHitUv(e.clientX, e.clientY);
        if (!cur) return;
        const dx = cur[0] - sketchDrag.grab[0];
        const dy = cur[1] - sketchDrag.grab[1];
        const points = sketchDrag.single
          ? [{ from: sketchDrag.origins[0], to: cur }]
          : sketchDrag.origins.map((o) => ({ from: o, to: [o[0] + dx, o[1] + dy] as Vec2 }));
        onSketchDragMoveRef.current(points);
        // Keep the teal marker on the grabbed vertex as it travels (single-vertex
        // drags snap the point to the cursor), so it moves with the line.
        const sid = activeSketchIdRef.current;
        if (sketchDrag.single && sid) {
          hoverSelRef.current = { kind: "sketchPoint", sketchId: sid, point: cur };
          applyHighlights();
        }
        return;
      }
      // ViewCube hover: pick() updates the cube's own highlight and reports the
      // target under the cursor (null when off the cube, which also clears it).
      if (viewCube.pick(renderer, e.clientX, e.clientY)) {
        renderer.domElement.style.cursor = "pointer";
        return;
      }
      // Selection (hover) is active when idle OR editing a sketch with the Select
      // tool. Drop a stale hover when neither applies.
      const selecting = !pickingRef.current && (activeFrameRef.current === null || isPickTool(sketchToolRef.current));
      if (!selecting && hoverSelRef.current) {
        hoverSelRef.current = null;
        applyHighlights();
      }
      // Trim/Extend hover: resolve the same entity + point the CLICK would, so
      // the preview and the edit can never disagree about which piece is meant.
      // Deliberately the raw plane hit, not the snapped one — snapping to a
      // nearby vertex would choose the piece on the other side of it.
      if (activeFrameRef.current && isTrimTool(sketchToolRef.current) && !pickingRef.current) {
        const sel = pickSelection(e.clientX, e.clientY);
        const uv = planeHitUv(e.clientX, e.clientY);
        const hit = sel && sel.kind === "sketchEntity" && uv ? { entityId: sel.entityId, uv } : null;
        renderer.domElement.style.cursor = hit ? "pointer" : "default";
        if (!sameSelection(sel && sel.kind === "sketchEntity" ? sel : null, hoverSelRef.current)) {
          hoverSelRef.current = sel && sel.kind === "sketchEntity" ? sel : null;
          applyHighlights();
        }
        onSketchToolHoverRef.current?.(hit);
        return;
      }
      if (pickingRef.current) {
        // An AXIS pick resolves the same way its click does — the selection
        // raycaster first (sketch line / body edge / face), planes only as the
        // fallback. Hover must not run `pick()` alone: that sees neither lines
        // nor edges, so the thing being aimed at stays unlit while the plane
        // behind it lights up, and the click then lands on that plane.
        if (axisPickRef.current) {
          const sel = pickSelection(e.clientX, e.clientY);
          if (sel && (sel.kind === "edge" || sel.kind === "face" || sel.kind === "sketchEntity")) {
            clearHover();
            renderer.domElement.style.cursor = "pointer";
            if (!sameSelection(sel, hoverSelRef.current)) {
              hoverSelRef.current = sel;
              applyHighlights();
            }
            return;
          }
        }
        const p = pick(e.clientX, e.clientY);
        clearHover();
        const prevHover = hoverSelRef.current;
        let nextHover: Selection | null = null;
        if (!p) {
          if (prevHover) {
            hoverSelRef.current = null;
            applyHighlights();
          }
          return;
        }
        renderer.domElement.style.cursor = "pointer";
        if (p.kind === "datum") {
          hoverPlaneRef.current = p.id;
          applyDatumAppearance(state, p.id);
        } else if (p.kind === "userplane") {
          hoverUserPlaneRef.current = p.planeId;
          applyHighlights();
        } else if (p.kind === "face" && p.faceId !== undefined && p.featureId) {
          // Highlight just the hovered face (+ its boundary edges), not the body.
          nextHover = { kind: "face", featureId: p.featureId, faceId: p.faceId };
        }
        if (!sameSelection(nextHover, prevHover)) {
          hoverSelRef.current = nextHover;
          applyHighlights();
        }
        return;
      }
      const frame = activeFrameRef.current;
      if (frame && !isPickTool(sketchToolRef.current)) {
        const raw = planeHitUv(e.clientX, e.clientY);
        if (!raw) {
          state.previewLine.visible = false;
          state.snapMarker.visible = false;
          state.snapEdgeLine.visible = false;
          state.guideOverlay.visible = false;
          state.anchorOverlay.visible = false;
          state.guideBadge.style.display = "none";
          return;
        }
        const { uv, kind, seg, on, guideLines, meanings, construction, circle } = snap(raw, e.clientX, e.clientY);
        armFromSnap(kind, uv, seg, on?.id);
        const poly = previewPolyline(sketchToolRef.current, draftRef.current, uv, polygonSidesRef.current);
        if (poly && poly.length >= 2) {
          const flat: number[] = [];
          for (const p of poly) {
            const w = uvToWorld(frame, p[0], p[1]);
            flat.push(w[0], w[1], w[2]);
          }
          // Rebuild the geometry fresh rather than setPositions on the reused one:
          // a fat LineGeometry doesn't grow its instance count when the point count
          // increases (same gotcha as the highlight overlay), so a spline preview
          // that gains points per click would otherwise render only its first
          // segment.
          const g = new LineGeometry();
          g.setPositions(flat);
          state.previewLine.geometry.dispose();
          state.previewLine.geometry = g;
          state.previewLine.visible = true;
        } else {
          state.previewLine.visible = false;
        }
        if (kind === "point" || kind === "edge" || kind === "guide") {
          const w = uvToWorld(frame, uv[0], uv[1]);
          state.snapMarker.position.set(w[0], w[1], w[2]);
          (state.snapMarker.material as THREE.MeshBasicMaterial).color.set(
            kind === "edge" ? 0x36d6c3 : kind === "guide" ? GUIDE_COLOR : 0xffe14a,
          );
          state.snapMarker.visible = true;
        } else {
          state.snapMarker.visible = false;
        }
        // Light up the whole edge when snapping to one — dashed if it's a
        // construction line, so the highlight matches the line's own style. A
        // circle snap (centre/quadrant/on-ring) instead outlines the WHOLE ring,
        // so it's clear which hole/rim you're referencing (concentric feedback).
        // Rebuild the geometry fresh each time (a fat LineSegmentsGeometry doesn't
        // grow its instance count on reuse — see previewLine), since a ring (64
        // segments) and a straight edge (1) alternate on this one object.
        const setSnapEdge = (pos: number[], dashed: boolean) => {
          const g = new LineSegmentsGeometry();
          g.setPositions(pos);
          state.snapEdgeLine.geometry.dispose();
          state.snapEdgeLine.geometry = g;
          snapEdgeMaterial.dashed = dashed;
          if (dashed) state.snapEdgeLine.computeLineDistances();
          state.snapEdgeLine.visible = true;
        };
        if (circle) {
          const seg2 = 64,
            ringPos: number[] = [];
          for (let i = 0; i < seg2; i++) {
            const a0 = (2 * Math.PI * i) / seg2,
              a1 = (2 * Math.PI * (i + 1)) / seg2;
            const p = uvToWorld(frame, circle.c[0] + circle.r * Math.cos(a0), circle.c[1] + circle.r * Math.sin(a0));
            const q = uvToWorld(frame, circle.c[0] + circle.r * Math.cos(a1), circle.c[1] + circle.r * Math.sin(a1));
            ringPos.push(p[0], p[1], p[2], q[0], q[1], q[2]);
          }
          setSnapEdge(ringPos, false);
        } else if (kind === "edge" && seg) {
          const a = uvToWorld(frame, seg[0][0], seg[0][1]);
          const b = uvToWorld(frame, seg[1][0], seg[1][1]);
          setSnapEdge([a[0], a[1], a[2], b[0], b[1], b[2]], !!construction);
        } else {
          state.snapEdgeLine.visible = false;
        }
        // Draw each active guide as a dashed line from its anchor (the key point)
        // to the snap point under the cursor, and a small square marker on each
        // distinct anchor (constant screen size).
        if (kind === "guide" && guideLines && guideLines.length) {
          const bw = uvToWorld(frame, uv[0], uv[1]);
          const gpos: number[] = [];
          const anchors: Vec2[] = [];
          for (const g of guideLines) {
            const aw = uvToWorld(frame, g.origin[0], g.origin[1]);
            gpos.push(aw[0], aw[1], aw[2], bw[0], bw[1], bw[2]);
            if (!anchors.some((a) => a[0] === g.origin[0] && a[1] === g.origin[1])) anchors.push(g.origin);
          }
          state.guideOverlay.geometry.setPositions(gpos);
          state.guideOverlay.computeLineDistances();
          state.guideOverlay.visible = true;
          // Anchor squares, sized to a constant pixel extent at the current zoom.
          const bufH = renderer.getDrawingBufferSize(new THREE.Vector2()).y;
          const oc = camera as THREE.OrthographicCamera;
          const worldPerPx = oc.isOrthographicCamera
            ? (oc.top - oc.bottom) / oc.zoom / bufH
            : (2 *
                (camera as THREE.PerspectiveCamera).position.distanceTo(new THREE.Vector3(...frame.origin)) *
                Math.tan(((camera as THREE.PerspectiveCamera).fov * Math.PI) / 360)) /
              bufH;
          const hw = worldPerPx * 14; // half-width in world units (~14 buffer px)
          const spos: number[] = [];
          for (const o of anchors) {
            const c: Vec2[] = [
              [o[0] - hw, o[1] - hw],
              [o[0] + hw, o[1] - hw],
              [o[0] + hw, o[1] + hw],
              [o[0] - hw, o[1] + hw],
            ];
            for (let i = 0; i < 4; i++) {
              const p = uvToWorld(frame, c[i][0], c[i][1]);
              const q = uvToWorld(frame, c[(i + 1) % 4][0], c[(i + 1) % 4][1]);
              spos.push(p[0], p[1], p[2], q[0], q[1], q[2]);
            }
          }
          state.anchorOverlay.geometry.setPositions(spos);
          state.anchorOverlay.visible = true;
          const glyph = { horizontal: "—", vertical: "|", parallel: "//", perpendicular: "⊥" } as const;
          const badge = [...new Set((meanings ?? []).map((m) => glyph[m.meaning]))].join(" ");
          if (badge) {
            state.guideBadge.textContent = badge;
            state.guideBadge.style.left = `${e.clientX + 14}px`;
            state.guideBadge.style.top = `${e.clientY + 14}px`;
            state.guideBadge.style.display = "block";
          } else {
            state.guideBadge.style.display = "none";
          }
        } else {
          state.guideOverlay.visible = false;
          state.anchorOverlay.visible = false;
          state.guideBadge.style.display = "none";
        }
        return;
      }
      // Selection hover (idle, or sketch mode with the Select tool). Hide any
      // leftover draw preview when hovering inside a sketch.
      if (frame) {
        state.previewLine.visible = false;
        state.snapMarker.visible = false;
        state.snapEdgeLine.visible = false;
        state.guideOverlay.visible = false;
        state.anchorOverlay.visible = false;
        state.guideBadge.style.display = "none";
      }
      const sel = pickSelection(e.clientX, e.clientY);
      if (!sameSelection(sel, hoverSelRef.current)) {
        hoverSelRef.current = sel;
        renderer.domElement.style.cursor = sel ? "pointer" : "";
        applyHighlights();
      }
    };
    const onDown = (e: PointerEvent) => {
      // A press claimed by one of the TransformControls gizmos (transform /
      // section / extrude): their pointerdown listeners ran first (registered
      // earlier) and set `dragging`. Leave `down` unset so onUp doesn't turn
      // the release into a selection click, and don't arm a sketch drag
      // underneath.
      if (transformControls.dragging || sectionControls.dragging || extrudeControls.dragging) return;
      down = { x: e.clientX, y: e.clientY };
      // Inside a sketch with the Select tool, a press on grabbable geometry arms a
      // drag. Suspend orbiting and capture the pointer until release; whether it
      // actually moves (drag) or not (click) is decided in onUp.
      if (!pickingRef.current && activeFrameRef.current && sketchToolRef.current === "select") {
        const grabbed = pickSketchDrag(e.clientX, e.clientY);
        if (grabbed) {
          sketchDrag = { startClient: { x: e.clientX, y: e.clientY }, ...grabbed, moved: false };
          controls.enabled = false;
          renderer.domElement.setPointerCapture(e.pointerId);
          renderer.domElement.style.cursor = "grabbing";
        }
      }
    };
    // The snapped uv of a screen point on the active sketch plane (undefined
    // outside sketch editing / off the plane) — the coordinate rider handed to
    // onSelect for pick-tool flows like the circular pattern's center click.
    const snappedUvAt = (x: number, y: number): Vec2 | undefined => {
      if (!activeFrameRef.current) return undefined;
      const raw = planeHitUv(x, y);
      return raw ? snap(raw, x, y).uv : undefined;
    };
    const onUp = (e: PointerEvent) => {
      // Finish a scale-grip drag: commit the final factor ONCE (the only
      // regenerate of the whole gesture) and pin the dragged matrix across the
      // stale rebuild it triggers, until the re-baked geometry arrives.
      if (scaleDrag) {
        const { live, moved } = scaleDrag;
        const te = transformEditRef.current;
        scaleDrag = null;
        const ld = state.liveDrag;
        state.liveDrag = null;
        controls.enabled = true;
        if (renderer.domElement.hasPointerCapture(e.pointerId)) {
          renderer.domElement.releasePointerCapture(e.pointerId);
        }
        renderer.domElement.style.cursor = "";
        down = null;
        if (te && moved) {
          if (ld) {
            const m1 = transformMatrix(te.pivot, te.tx, te.ty, te.tz, te.angle, te.axis, live);
            const entry = meshesRef.current.find((m) => m.id === te.bodyId);
            state.pendingCommit = {
              bodyId: te.bodyId,
              delta: m1.multiply(ld.m0Inverse),
              meshRef: entry?.mesh ?? null,
            };
          }
          onTransformInputRef.current({ tx: te.tx, ty: te.ty, tz: te.tz, angle: te.angle, scale: live });
        } else if (ld) {
          // A tap that never moved: hand the objects back to normal updating.
          for (const o of ld.objects) o.matrixAutoUpdate = true;
        }
        return;
      }
      // Finish (or cancel) a sketch drag. A press that never travelled far enough
      // to become a drag falls through to a normal selection click.
      if (sketchDrag) {
        const wasDrag = sketchDrag.moved;
        sketchDrag = null;
        controls.enabled = true;
        if (renderer.domElement.hasPointerCapture(e.pointerId)) {
          renderer.domElement.releasePointerCapture(e.pointerId);
        }
        renderer.domElement.style.cursor = "";
        down = null;
        if (wasDrag) onSketchDragEndRef.current();
        else onSelectRef.current(pickSelection(e.clientX, e.clientY), snappedUvAt(e.clientX, e.clientY));
        return;
      }
      // A press that started on the ViewCube: a click (barely moved) snaps to that
      // face/corner; a drag was already handled by OrbitControls (grab-orbit). In
      // both cases skip the normal selection click.
      if (cubeHit) {
        const hit = cubeHit;
        const clicked = !down || Math.hypot(e.clientX - down.x, e.clientY - down.y) <= 5;
        cubeHit = null;
        down = null;
        if (clicked) goToCube(hit);
        return;
      }
      if (!down) return;
      const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
      down = null;
      if (moved > 5) return;
      if (pickingRef.current) {
        // Revolve "Select axis" arming: one click stream accepts a sketch line or
        // a body face (both via the normal selection raycaster) or, falling back,
        // a datum/reference plane (only the picking raycaster sees those).
        if (axisPickRef.current) {
          const sel = pickSelection(e.clientX, e.clientY);
          clearHover();
          if (hoverSelRef.current) {
            hoverSelRef.current = null;
            applyHighlightsRef.current();
          }
          if (sel?.kind === "sketchEntity") {
            onAxisPickRef.current({ kind: "line", sketchId: sel.sketchId, entityId: sel.entityId });
            return;
          }
          if (sel?.kind === "edge") {
            onAxisPickRef.current({ kind: "bodyEdge", featureId: sel.featureId, edgeId: sel.edgeId });
            return;
          }
          if (sel?.kind === "face") {
            onAxisPickRef.current({ kind: "bodyFace", featureId: sel.featureId, faceId: sel.faceId });
            return;
          }
          const pp = pick(e.clientX, e.clientY);
          if (!pp) return;
          if (pp.kind === "datum") {
            if (pp.id !== "origin") onAxisPickRef.current({ kind: "plane", ref: { kind: "datum", id: pp.id } });
          } else if (pp.kind === "userplane")
            onAxisPickRef.current({ kind: "plane", ref: { kind: "plane", planeId: pp.planeId } });
          else {
            const featureId = (pp.mesh.userData.featureId as string) ?? "";
            const frame = deriveFaceFrame(
              [pp.point.x, pp.point.y, pp.point.z],
              [pp.normal.x, pp.normal.y, pp.normal.z],
            );
            onAxisPickRef.current({ kind: "plane", ref: { kind: "face", featureId, frame } });
          }
          return;
        }
        const p = pick(e.clientX, e.clientY);
        clearHover();
        if (hoverSelRef.current) {
          hoverSelRef.current = null;
          applyHighlightsRef.current();
        }
        if (!p) return;
        if (p.kind === "datum") {
          if (p.id !== "origin") onPickRef.current({ kind: "datum", id: p.id });
        } else if (p.kind === "userplane") {
          onPickRef.current({ kind: "plane", planeId: p.planeId });
        } else {
          const featureId = (p.mesh.userData.featureId as string) ?? "";
          const frame = deriveFaceFrame([p.point.x, p.point.y, p.point.z], [p.normal.x, p.normal.y, p.normal.z]);
          // `faceId` rides along so a caller that needs the face ITSELF (rather
          // than the plane derived at the click point) can ask about it — the
          // Mirror dialog uses it to refuse a curved face, whose "plane" here is
          // only a tangent at wherever the pointer happened to land.
          onPickRef.current({ kind: "face", featureId, frame }, [p.point.x, p.point.y, p.point.z], p.faceId);
        }
        return;
      }
      const frame = activeFrameRef.current;
      if (frame && !isPickTool(sketchToolRef.current)) {
        const raw = planeHitUv(e.clientX, e.clientY);
        if (!raw) return;
        const s = snap(raw, e.clientX, e.clientY);
        // `onFixed` is set when the snap landed on BODY geometry (a rim/centre/
        // quadrant or a body edge); pass it so the draw commits a lasting
        // coincident-to-{fixed} instead of a positional-only snap.
        onSketchClickRef.current(s.uv, s.hv, s.on, s.atVertex, s.meanings, s.onFixed);
        return;
      }
      // Selection click (idle, or sketch + Select tool). App accumulates into a
      // set and toggles the element off if it is already selected.
      onSelectRef.current(pickSelection(e.clientX, e.clientY), snappedUvAt(e.clientX, e.clientY));
    };
    // Record the ViewCube target under the press but DON'T claim the event, so
    // OrbitControls still gets it and a drag grab-orbits the camera (the cube
    // tracks it). onUp decides click (navigate) vs drag (leave to OrbitControls),
    // and suppresses the selection click either way. Capture-phase so `cubeHit`
    // is set before onUp runs.
    const onGizmoDown = (e: PointerEvent) => {
      if (e.button !== 0) return;
      // A press on a scale grip owns the gesture: start the drag here, in the
      // capture phase, so the selection click underneath never runs. OrbitControls
      // registered its own listener first and has already seen this press, but it
      // only rotates on MOVE and bails when disabled, so switching it off now is
      // enough to keep the camera still — the same thing the TransformControls
      // gizmos do on dragging-changed.
      const te = transformEditRef.current;
      if (te && scaleGizmoActive()) {
        const grip = pickScaleGrip(e.clientX, e.clientY);
        const pivotPx = projectToPx(new THREE.Vector3(...te.pivot));
        const grabPx = Math.hypot(e.clientX - pivotPx.x, e.clientY - pivotPx.y);
        if (grip && grabPx >= SCALE_MIN_GRAB_PX) {
          scaleDrag = {
            grabPx,
            // The line, on screen, from the pivot out through the grabbed corner.
            // The drag is measured ALONG it (see onMove).
            dir: { x: (e.clientX - pivotPx.x) / grabPx, y: (e.clientY - pivotPx.y) / grabPx },
            startFactor: te.scale,
            live: te.scale,
            moved: false,
          };
          controls.enabled = false;
          renderer.domElement.setPointerCapture(e.pointerId);
          // Snapshot the body's objects and the matrix they carry, so each frame
          // can re-pose them locally instead of asking the kernel to rebuild.
          const m0 = transformMatrix(te.pivot, te.tx, te.ty, te.tz, te.angle, te.axis, te.scale);
          const objects = state.group.children.filter((c) => c.userData.featureId === te.bodyId);
          for (const o of objects) o.matrixAutoUpdate = false;
          state.liveDrag = { bodyId: te.bodyId, objects, m0Inverse: m0.clone().invert(), delta: new THREE.Matrix4() };
          e.stopImmediatePropagation();
          return;
        }
      }
      cubeHit = viewCube.pick(renderer, e.clientX, e.clientY);
    };
    const onGizmoLeave = () => viewCube.clearHover();
    // Double-click on a sketch entity (Select tool only): grab its whole
    // connected chain in one gesture. The two constituent single clicks still
    // toggle the entity via onUp; the chain-select that follows replaces it.
    const onDblClick = (e: MouseEvent) => {
      if (!activeFrameRef.current || sketchToolRef.current !== "select") return;
      const sel = pickSelection(e.clientX, e.clientY);
      if (sel?.kind === "sketchEntity") onSketchEntityDoubleRef.current?.(sel.sketchId, sel.entityId);
    };
    renderer.domElement.addEventListener("pointerdown", onGizmoDown, true);
    renderer.domElement.addEventListener("pointerleave", onGizmoLeave);
    renderer.domElement.addEventListener("pointermove", onMove);
    renderer.domElement.addEventListener("pointerdown", onDown);
    renderer.domElement.addEventListener("pointerup", onUp);
    renderer.domElement.addEventListener("dblclick", onDblClick);

    const resize = () => {
      const w = container.clientWidth;
      const h = container.clientHeight;
      if (w === 0 || h === 0) return;
      renderer.setSize(w, h);
      if ((camera as THREE.OrthographicCamera).isOrthographicCamera) {
        // Keep the vertical extent; re-derive the horizontal from the new aspect.
        const oc = camera as THREE.OrthographicCamera;
        const halfH = (oc.top - oc.bottom) / 2;
        oc.left = -halfH * (w / h);
        oc.right = halfH * (w / h);
      } else {
        (camera as THREE.PerspectiveCamera).aspect = w / h;
      }
      camera.updateProjectionMatrix();
      highlightMaterial.resolution.set(w, h); // fat-line width is in screen pixels
      highlightMaterialDash.resolution.set(w, h);
      snapEdgeMaterial.resolution.set(w, h);
      guideMaterial.resolution.set(w, h);
      anchorMaterial.resolution.set(w, h);
      previewMaterial.resolution.set(w, h);
      // Sketch display lines are fat lines too — keep their screen-space width.
      for (const child of sketchGroup.children) {
        if (child.userData.isSketchDisplay) {
          ((child as LineSegments2).material as LineMaterial).resolution.set(w, h);
        }
      }
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(container);

    // Keep near/far bracketing the scene each frame so a fixed frustum never
    // clips geometry — notably the origin datum planes when Home frames a body
    // far from the origin, leaving the origin behind the camera's near plane.
    // The reference box always includes the origin region (grid + datum planes)
    // so those stay visible from any camera pose. An orthographic camera may use
    // a negative near (parallel projection renders "behind" the camera plane
    // correctly); perspective keeps near positive.
    const clipBox = new THREE.Box3();
    const clipSphere = new THREE.Sphere();
    // Bodies-only bounds (clipSphere always includes the ±130 reference box, so it
    // can't size anything to the actual part). Refreshed alongside clipSphere in
    // syncClipPlanes: the sphere scales the section hatch spacing; the AABB is
    // projected onto the cut plane's axes to size the cap/widget tight to the part.
    const partSphere = new THREE.Sphere();
    const partBox = new THREE.Box3();
    const clipDir = new THREE.Vector3();
    const clipTmp = new THREE.Vector3();
    const REF_MIN = new THREE.Vector3(-130, -130, -130); // grid (±120) + datum planes
    const REF_MAX = new THREE.Vector3(130, 130, 130);
    const syncClipPlanes = () => {
      clipBox.makeEmpty();
      for (const c of group.children) {
        if (c instanceof THREE.Mesh && c.userData.featureId && !c.userData.isRegion) clipBox.expandByObject(c);
      }
      for (const c of sketchGroup.children) {
        if (c instanceof THREE.LineSegments && c.userData.sketchId) clipBox.expandByObject(c);
      }
      // Part-only bounds (before the reference box inflates clipBox). Empty scene
      // → radius 0 / empty box, which the size floor and hatch spacing handle.
      if (clipBox.isEmpty()) {
        partSphere.set(partSphere.center.set(0, 0, 0), 0);
        partBox.makeEmpty();
      } else {
        clipBox.getBoundingSphere(partSphere);
        partBox.copy(clipBox);
      }
      clipBox.expandByPoint(REF_MIN);
      clipBox.expandByPoint(REF_MAX);
      clipBox.getBoundingSphere(clipSphere);
      // Signed depth of the sphere centre along the view direction (target − eye).
      clipDir.copy(controls.target).sub(camera.position);
      if (clipDir.lengthSq() < 1e-9) return;
      clipDir.normalize();
      const depth = clipTmp.copy(clipSphere.center).sub(camera.position).dot(clipDir);
      const r = clipSphere.radius + 1; // slack so nothing sits exactly on a plane
      let near = depth - r;
      const far = depth + r;
      // Perspective needs a positive near; ortho is happy with a negative one.
      if (!(camera as THREE.OrthographicCamera).isOrthographicCamera) near = Math.max(r * 1e-3, near);
      if (camera.near !== near || camera.far !== far) {
        camera.near = near;
        camera.far = far;
        camera.updateProjectionMatrix();
      }
    };

    // Re-resolve the section plane, widget, cap group and offset gizmo every
    // frame from the current frame/offset/flip (or, mid-drag, from the gizmo
    // proxy's live position — the prop round trip is one render behind). Cheap:
    // transform-only, no geometry rebuild. Sized off `partBox`/`partSphere`
    // (just refreshed by syncClipPlanes, which always runs first in animate())
    // so the cap/widget hug the actual bodies.
    const sectionOrigin = new THREE.Vector3();
    const sectionEffNormal = new THREE.Vector3();
    const sectionU = new THREE.Vector3();
    const sectionV = new THREE.Vector3();
    const sectionBasis = new THREE.Matrix4();
    const sectionUpZ = new THREE.Vector3(0, 0, 1);
    const sectionBoxC = new THREE.Vector3();
    const sectionBoxS = new THREE.Vector3();
    // Where the quad and the drag handle sit IN the cut plane — the middle of
    // the cross-section, not the plane frame's own origin (see syncSectionPlane).
    const sectionCentre = new THREE.Vector3();
    // Half-extent of the (axis-aligned) part box along an in-plane unit axis, plus
    // the part centre's offset from the cut origin along it → how far the quad must
    // reach along that axis to cover the cross-section. |axis·size|/2 is the AABB's
    // projected half-width; exact because partBox is axis-aligned.
    const reachAlongAxis = (axis: THREE.Vector3): number => {
      const half =
        0.5 * (Math.abs(axis.x) * sectionBoxS.x + Math.abs(axis.y) * sectionBoxS.y + Math.abs(axis.z) * sectionBoxS.z);
      const off = Math.abs(sectionBoxC.x * axis.x + sectionBoxC.y * axis.y + sectionBoxC.z * axis.z);
      return off + half;
    };
    const syncSectionPlane = () => {
      const sv = sectionViewRef.current;
      sectionWidget.visible = sv.enabled;
      sectionCapGroup.visible = sv.enabled;
      sectionHelper.visible = sv.enabled;
      // Picking mode has its own click meaning — the gizmo stays visible but
      // inert there. Sketch editing needs the SAME opt-out, for the same
      // reason: while drawing, a click means
      // "place a point", not "drag the section plane". Without it the gizmo's
      // TransformControls claims the press, `dragging` goes true, and onDown
      // bails before setting `down` — so onUp returns early and the click is
      // swallowed. Every click after the first one was, which made drawing in a
      // sketch impossible whenever section view was on.
      sectionControls.enabled = sv.enabled && !pickingRef.current && !activeFrameRef.current;
      if (!sv.enabled) {
        if (sectionControls.object) sectionControls.detach();
        sectionPlane.set(sectionUpZ, FAR_PLANE_CONSTANT);
        return;
      }
      const f = sv.frame;
      // Mid-drag, read the live offset straight off the gizmo proxy for
      // zero-latency feedback (same projection objectChange emits).
      let offset = sv.offset;
      if (sectionControls.dragging) {
        sectionEffNormal.set(f.normal[0], f.normal[1], f.normal[2]).normalize();
        offset =
          sectionProxy.position.dot(sectionEffNormal) -
          (f.origin[0] * sectionEffNormal.x + f.origin[1] * sectionEffNormal.y + f.origin[2] * sectionEffNormal.z);
      }
      const resolved = resolveSectionPlane(f, offset, sv.flip);
      sectionOrigin.set(resolved.origin[0], resolved.origin[1], resolved.origin[2]);
      sectionEffNormal.set(resolved.normal[0], resolved.normal[1], resolved.normal[2]);
      sectionPlane.setFromNormalAndCoplanarPoint(sectionEffNormal, sectionOrigin);

      // Orient the (square, DoubleSide) cap/widget quad IN the cut plane. Derive
      // v from the effective normal rather than trusting the frame's stored vAxis:
      // some frames are left-handed (the Front datum: uAxis×vAxis = −normal), and
      // makeBasis(u, vAxis, n) on a left-handed triple builds a REFLECTION, from
      // which setFromRotationMatrix can't recover a valid rotation — the quad then
      // lands ~90° out of the cut plane (lying flat on XY for a Front section). u
      // is ⟂ the normal for any orthonormal frame, so v = n×u keeps the basis
      // orthonormal AND right-handed (det +1) for every plane.
      sectionU.set(f.uAxis[0], f.uAxis[1], f.uAxis[2]).normalize();
      sectionV.crossVectors(sectionEffNormal, sectionU).normalize();
      sectionBasis.makeBasis(sectionU, sectionV, sectionEffNormal);
      // Size the cap + plane widget to the ACTUAL bodies, not clipSphere (which is
      // padded to the ±130 reference box, making the plane ~540 units — huge, and
      // overrunning the camera far plane so its corners clip). Project the part's
      // AABB onto the cut plane's own u/v axes so the quad hugs the cross-section
      // tightly — using the 3D radius would let the depth ⟂ to the cut inflate it.
      // The quad spans ±size/2, so size = 2·reach·margin just covers the section.
      //
      // Both the quad and the handle are parked at the middle of the CUT, not at
      // the plane frame's origin: primitives sit on z=0, so the world origin is
      // at the bottom edge of the part and the handle ended up running along the
      // bottom of the cross-section instead of through it. Centring also stops
      // the quad being sized to reach a far-off origin — the u/v offset term in
      // reachAlongAxis falls to zero, so it hugs the section tightly.
      // Only the in-plane position moves; `offset` is measured along the normal
      // and is unchanged by this, so the drag maths is untouched.
      partBox.getCenter(sectionCentre);
      if (partBox.isEmpty()) sectionCentre.copy(sectionOrigin);
      sectionCentre.addScaledVector(
        sectionEffNormal,
        sectionOrigin.dot(sectionEffNormal) - sectionCentre.dot(sectionEffNormal),
      );
      partBox.getCenter(sectionBoxC).sub(sectionCentre);
      partBox.getSize(sectionBoxS);
      const reach = partBox.isEmpty() ? 0 : Math.max(reachAlongAxis(sectionU), reachAlongAxis(sectionV));
      const size = Math.max(SECTION_CAP_MIN_SIZE, reach * 2 * SECTION_CAP_MARGIN);
      // Refresh the section-hatch uniforms: same plane origin/axes as the cap, and
      // a spacing scaled to the model so the stripe density reads the same whether
      // it's a 20 mm bracket or a 2 m assembly (≈24 lines across the part).
      sectionHatchUniforms.uHatchOrigin.value.copy(sectionCentre);
      sectionHatchUniforms.uHatchU.value.copy(sectionU);
      sectionHatchUniforms.uHatchV.value.copy(sectionV);
      const hatchSpacing = Math.max(1.5, partSphere.radius * 0.06);
      sectionHatchUniforms.uHatchSpacing.value = hatchSpacing;
      sectionHatchUniforms.uHatchHalfWidth.value = hatchSpacing * 0.07;
      sectionWidget.position.copy(sectionCentre);
      sectionWidget.quaternion.setFromRotationMatrix(sectionBasis);
      sectionWidget.scale.set(size, size, 1);
      for (const child of sectionCapGroup.children) {
        if ((child as THREE.Mesh).geometry === sectionCapGeometry) {
          child.position.copy(sectionCentre);
          child.quaternion.setFromRotationMatrix(sectionBasis);
          (child as THREE.Mesh).scale.set(size, size, 1);
        }
      }
      // The offset gizmo rides the middle of the cut, its arrow along the
      // effective normal. Mid-drag the proxy is TransformControls' to move —
      // re-posing it would fight the drag; the offset round-trips back here.
      if (!sectionControls.dragging) {
        sectionProxy.position.copy(sectionCentre);
        sectionProxy.quaternion.setFromUnitVectors(sectionUpZ, sectionEffNormal);
      }
      if (sectionControls.object !== sectionProxy) sectionControls.attach(sectionProxy);
    };

    // Drive the extrude-distance gizmo from the prop: proxy at the extrusion's
    // live tip, local +Z along the extrude direction. Mid-drag the proxy is
    // TransformControls' to move — re-posing it would fight the drag (and the
    // `dir` prop can flip under it when a plane crossing is committed); the
    // committed values round-trip back here on release.
    const extrudeArrowDir = new THREE.Vector3();
    // Is the scale gizmo the active tool right now?
    const scaleGizmoActive = () =>
      !!transformEditRef.current && transformModeRef.current === "scale" && !pickingRef.current;

    /** The factor currently being shown — the drag's live value, else the feature's. */
    const shownScaleFactor = (te: TransformEdit) => (scaleDrag ? scaleDrag.live : te.scale);

    /** Where the box sits this frame: the measured bounds scaled about the pivot
     *  by however far the factor has moved since they were measured. */
    const scaleBoxNow = (te: TransformEdit) => {
      if (!scaleBounds) return null;
      const pivot = new THREE.Vector3(...te.pivot);
      const k = scaleBounds.atFactor > 0 ? shownScaleFactor(te) / scaleBounds.atFactor : 1;
      const min = scaleBounds.min.clone().sub(pivot).multiplyScalar(k).add(pivot);
      const max = scaleBounds.max.clone().sub(pivot).multiplyScalar(k).add(pivot);
      return { min, max };
    };

    const syncScaleGizmo = () => {
      const te = transformEditRef.current;
      if (!te || !scaleGizmoActive()) {
        scaleGizmo.visible = false;
        return;
      }
      const entry = meshesRef.current.find((m) => m.id === te.bodyId);
      if (!entry) {
        scaleGizmo.visible = false;
        return;
      }
      // Re-measure whenever the kernel hands back a different mesh for this body
      // (a commit landing, an upstream edit), but never mid-drag — the drag is
      // driving the box itself, and the mesh under it is still the old one.
      if (!scaleDrag && (!scaleBounds || scaleBounds.source !== entry.mesh)) {
        const v = entry.mesh.faces.vertices;
        if (v.length < 3) {
          scaleGizmo.visible = false;
          return;
        }
        const min = new THREE.Vector3(Infinity, Infinity, Infinity);
        const max = new THREE.Vector3(-Infinity, -Infinity, -Infinity);
        for (let i = 0; i < v.length; i += 3) {
          min.min(_scaleTmp.set(v[i], v[i + 1], v[i + 2]));
          max.max(_scaleTmp);
        }
        scaleBounds = { min, max, atFactor: te.scale > 0 ? te.scale : 1, source: entry.mesh };
      }
      const box = scaleBoxNow(te);
      if (!box) {
        scaleGizmo.visible = false;
        return;
      }
      scaleGizmo.visible = true;
      const centre = box.min.clone().add(box.max).multiplyScalar(0.5);
      const size = box.max.clone().sub(box.min);
      // A flat body has a zero extent; the box still has to be drawable.
      scaleWire.position.copy(centre);
      scaleWire.scale.set(Math.max(size.x, 1e-4), Math.max(size.y, 1e-4), Math.max(size.z, 1e-4));
      // Grips keep a constant on-screen size, so they stay grabbable on a 2mm
      // part and don't swallow a 2m one.
      const rect = renderer.domElement.getBoundingClientRect();
      const grip = worldPerPixel(camera.position.distanceTo(centre), rect.height) * SCALE_GRIP_PX;
      for (const m of scaleGrips) {
        const [sx, sy, sz] = m.userData.corner as [number, number, number];
        m.position.set(sx < 0 ? box.min.x : box.max.x, sy < 0 ? box.min.y : box.max.y, sz < 0 ? box.min.z : box.max.z);
        m.scale.setScalar(grip);
      }
    };

    const syncExtrudeGizmo = () => {
      const eg = extrudeGizmoRef.current;
      extrudeHelper.visible = !!eg;
      extrudeControls.enabled = !!eg && !pickingRef.current;
      if (!eg) {
        if (extrudeControls.object) extrudeControls.detach();
        return;
      }
      if (!extrudeControls.dragging) {
        extrudeArrowDir.set(eg.dir[0], eg.dir[1], eg.dir[2]).normalize();
        extrudeProxy.position
          .set(eg.origin[0], eg.origin[1], eg.origin[2])
          .addScaledVector(extrudeArrowDir, eg.symmetric ? eg.distance / 2 : eg.distance);
        extrudeProxy.quaternion.setFromUnitVectors(sectionUpZ, extrudeArrowDir);
      }
      if (extrudeControls.object !== extrudeProxy) extrudeControls.attach(extrudeProxy);
    };

    let frame = 0;
    const animate = () => {
      if (state.tween) {
        const tw = state.tween;
        const t = Math.min(1, (performance.now() - tw.start) / TWEEN_MS);
        const e = 1 - Math.pow(1 - t, 3);
        camera.position.lerpVectors(tw.from, tw.to, e);
        camera.up.copy(tw.up);
        if (t >= 1) state.tween = null;
      }
      controls.update();
      syncClipPlanes();
      syncSectionPlane();
      syncExtrudeGizmo();
      syncScaleGizmo();
      renderer.render(scene, camera);
      viewCube.render(renderer, state.camera);
      frame = requestAnimationFrame(animate);
    };
    animate();

    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      renderer.domElement.removeEventListener("pointerdown", onGizmoDown, true);
      renderer.domElement.removeEventListener("pointerleave", onGizmoLeave);
      renderer.domElement.removeEventListener("pointermove", onMove);
      renderer.domElement.removeEventListener("pointerdown", onDown);
      renderer.domElement.removeEventListener("pointerup", onUp);
      renderer.domElement.removeEventListener("dblclick", onDblClick);
      viewCube.dispose();
      controls.dispose();
      transformControls.detach();
      transformControls.dispose();
      scene.remove(gizmoHelper, gizmoProxy);
      disposeGroup(group);
      disposeSketchGroup(sketchGroup);
      for (const c of [...planeGroup.children, ...ghostPlaneGroup.children]) {
        if (c instanceof THREE.Mesh || c instanceof THREE.LineSegments) {
          c.geometry.dispose();
          (c.material as THREE.Material).dispose();
        }
      }
      for (const c of ghostGroup.children) {
        if (c instanceof THREE.Mesh || c instanceof THREE.LineSegments) c.geometry.dispose();
      }
      ghostMaterial.dispose();
      ghostLineMaterial.dispose();
      ghostFillMaterial.dispose();
      ghostFillLineMaterial.dispose();
      ghostCutMaterial.dispose();
      ghostCutLineMaterial.dispose();
      ghostCutBodyMaterial.dispose();
      previewLine.geometry.dispose();
      (previewLine.material as THREE.Material).dispose();
      snapMarker.geometry.dispose();
      snapEdgeLine.geometry.dispose();
      (snapEdgeLine.material as THREE.Material).dispose();
      guideOverlay.geometry.dispose();
      (guideOverlay.material as THREE.Material).dispose();
      anchorOverlay.geometry.dispose();
      (anchorOverlay.material as THREE.Material).dispose();
      guideBadge.remove();
      pointMarkers.geometry.dispose();
      (pointMarkers.material as THREE.Material).dispose();
      selectedMaterial.dispose();
      hoverMaterial.dispose();
      lineMaterial.dispose();
      highlightMaterial.dispose();
      highlightOverlay.geometry.dispose();
      highlightMaterialDash.dispose();
      highlightOverlayDash.geometry.dispose();
      sectionWidgetGeom.dispose();
      sectionWidgetMat.dispose();
      sectionWidgetBorder.geometry.dispose();
      (sectionWidgetBorder.material as THREE.Material).dispose();
      sectionControls.detach();
      sectionControls.dispose();
      extrudeControls.detach();
      extrudeControls.dispose();
      scene.remove(sectionHelper, sectionProxy, extrudeHelper, extrudeProxy);
      for (const child of sectionCapGroup.children) {
        if (child instanceof THREE.Mesh && child.material !== sectionCapMaterial) {
          (child.material as THREE.Material).dispose();
        }
      }
      sectionCapGeometry.dispose();
      sectionCapMaterial.dispose();
      grid.geometry.dispose();
      (grid.material as THREE.Material).dispose();
      axes.dispose();
      renderer.dispose();
      container.removeChild(renderer.domElement);
      apiRef.current = null;
      stateRef.current = null;
    };
  }, [apiRef]);

  // User settings that the scene reads: the color theme and the mouse bindings.
  // Applied in place on the live scene, so changing a setting mid-model keeps
  // the camera, the selection and every meshed body exactly where they were.
  // The scene renders on rAF, so there is nothing to invalidate — the next
  // frame picks these up.
  useEffect(() => {
    const state = stateRef.current;
    if (!state) return;
    const t = VIEWPORT_THEMES[theme];
    (state.scene.background as THREE.Color).set(t.background);
    // The grid bakes its two colours into per-vertex colours at construction.
    paintGroundGrid(state.grid, t.gridMajor, t.gridMinor);
    // The scale box reads against the backdrop, not against the body, so both it
    // and its grips are themed — as one widget, or the grips would sit on a
    // recoloured box in the wrong grey.
    const wire = state.scaleWire.material as THREE.LineBasicMaterial;
    wire.color.setHex(t.scaleBoxColor);
    wire.opacity = t.scaleBoxOpacity;
    state.scaleGripMaterial.color.setHex(t.scaleBoxColor);
    state.viewCube.setTheme(theme);
    applyMouseBindings(state.controls, mouseMiddle, mouseRight);
    state.controls.enableDamping = cameraInertia;
  }, [theme, mouseMiddle, mouseRight, cameraInertia]);

  // Rebuild the rendered bodies whenever the meshes or selection change.
  useEffect(() => {
    const state = stateRef.current;
    if (!state) return;
    const sectionEnabled = sectionView.enabled;
    hoverBodyRef.current = null;
    disposeGroup(state.group);
    // Section-view stencil caps reference this pass's body geometries directly
    // (no clone — see createSectionCapTriple), so they're rebuilt in lockstep.
    // Only their per-body stencil materials are owned here (the cap quad's
    // material/geometry are shared across bodies and disposed on unmount).
    for (const child of state.sectionCapGroup.children) {
      if (child instanceof THREE.Mesh && child.material !== state.sectionCapMaterial) {
        (child.material as THREE.Material).dispose();
      }
    }
    state.sectionCapGroup.clear();
    let capRenderOrder = SECTION_CAP_RENDER_ORDER_BASE;
    for (const { id, mesh, color, opacity } of meshes) {
      const geometry = syncBodyGeometry(id, mesh.faces, mesh.edges);
      // Material array: index 0 = this body's own color, 1 = hover (shared),
      // 2 = selected. The selected material is per-body: the body's own colour
      // blended toward the highlight orange, so the original colour still shows
      // through instead of a flat orange. syncFaces sets a geometry group per
      // face, so per-face highlighting flips group.materialIndex.
      const baseMaterial = makeBodyMaterial(color, state.sectionClipPlanes);
      baseMaterial.transparent = state.sketchDimActive || opacity < 1;
      baseMaterial.opacity = state.sketchDimActive ? 0.16 : opacity;
      const selColor = new THREE.Color(color).lerp(EDGE_SEL_COLOR, 0.7);
      const selectedMaterial = makeBodyMaterial(selColor.getHex(), state.sectionClipPlanes);
      // The active sketch's own face renders OPAQUE in the body's own colour, so
      // it's a solid surface (occluding any see-through parallel face) rather than
      // dimmed like the rest of the body. Per-body (own colour), like base/selected.
      const sketchFaceMaterial = makeBodyMaterial(color, state.sectionClipPlanes);
      const faceMesh = new THREE.Mesh(geometry.faces, [
        baseMaterial,
        state.hoverMaterial,
        selectedMaterial,
        state.ghostMaterial, // index 3 = boolean intersect operand (translucent cyan)
        sketchFaceMaterial, // index 4 = the active sketch's own face (opaque, body colour)
        state.ghostCutBodyMaterial, // index 5 = boolean SUBTRACT tool (removal red)
      ]);
      faceMesh.userData.featureId = id;
      // The body's own opacity (pre-dim), so the sketch-dim effect can restore
      // it instead of snapping back to a hardcoded 1 when leaving sketch mode.
      faceMesh.userData.opacity = opacity;
      state.group.add(faceMesh);
      // Thin base edge outline. Highlighting is drawn by a separate fat-line
      // overlay; geometry keeps per-edge groups (userData.edgeGroups) for picking.
      const edges = new THREE.LineSegments(geometry.lines, state.lineMaterial);
      edges.userData.featureId = id;
      edges.userData.isBodyEdges = true;
      state.group.add(edges);
      if (sectionEnabled) {
        state.sectionCapGroup.add(
          ...createSectionCapTriple(
            geometry.faces,
            state.sectionPlane,
            state.sectionCapGeometry,
            state.sectionCapMaterial,
            capRenderOrder,
          ),
        );
        capRenderOrder += 3;
      }
    }
    // A drag commit rebuilds the body's objects from the still-stale meshes
    // (original position) before the regenerate returns; re-pin the dragged
    // matrix so it doesn't flash back. Once the body's mesh ref changes (real
    // geometry baked at the new position), release the pin.
    const pc = state.pendingCommit;
    if (pc) {
      const entry = meshes.find((m) => m.id === pc.bodyId);
      if (entry && entry.mesh === pc.meshRef) {
        for (const o of state.group.children) {
          if (o.userData.featureId === pc.bodyId) {
            o.matrixAutoUpdate = false;
            o.matrix.copy(pc.delta);
            o.matrixWorldNeedsUpdate = true;
          }
        }
      } else {
        state.pendingCommit = null; // real geometry arrived (or body gone)
      }
    }
    applyHighlightsRef.current();
    // sectionView.enabled is included so toggling section view rebuilds the
    // stencil-cap group (which must be absent, not just hidden, when off — see
    // the SceneState field comment). This re-syncs body geometries too, which is
    // a bit of wasted work on toggle, but keeping the rebuild logic in ONE place
    // is worth it — see PLAN's "Performance" entry under What's left for a geometry-
    // reuse optimization that won on paper and made real use feel worse.
  }, [meshes, sectionView.enabled]);

  // Rebuild the ghost-preview bodies independently of the real bodies — their
  // own group/materials, so they never enter the raycast-pickable or highlight-
  // eligible sets (those only ever look at `group`/`sketchGroup`/`planeGroup`).
  useEffect(() => {
    const state = stateRef.current;
    if (!state) return;
    for (const c of state.ghostGroup.children) {
      if (c instanceof THREE.Mesh || c instanceof THREE.LineSegments) c.geometry.dispose();
    }
    state.ghostGroup.clear();
    ghostMeshes.forEach((ghost, i) => {
      const geometry = syncBodyGeometry(`ghost${i}`, ghost.mesh.faces, ghost.mesh.edges);
      // Depth-testless delta ghosts also need an explicit renderOrder — with the
      // depth buffer out of the picture, draw order is all that separates them
      // (fill below cut, both above the model).
      const [faceMat, lineMat, order] =
        ghost.variant === "cut"
          ? [state.ghostCutMaterial, state.ghostCutLineMaterial, 3]
          : ghost.variant === "fill"
            ? [state.ghostFillMaterial, state.ghostFillLineMaterial, 2]
            : [state.ghostMaterial, state.ghostLineMaterial, 0];
      const faceMesh = new THREE.Mesh(geometry.faces, faceMat);
      const edges = new THREE.LineSegments(geometry.lines, lineMat);
      faceMesh.renderOrder = order;
      edges.renderOrder = order;
      state.ghostGroup.add(faceMesh, edges);
    });
  }, [ghostMeshes]);

  // Re-apply highlighting when the external selection (or resolved body set)
  // changes.
  useEffect(() => {
    applyHighlightsRef.current();
  }, [selection, emphasize, highlightBodyIds, booleanHighlight]);

  // Datum visibility (user toggle) + sketch mode (dim solids, hide the inactive
  // planes while editing).
  useEffect(() => {
    const state = stateRef.current;
    if (!state) return;
    const active = activeSketch !== null;
    state.sketchDimActive = active;
    for (const child of state.group.children) {
      if (!(child instanceof THREE.Mesh) || !Array.isArray(child.material)) continue;
      const base = child.material[0] as THREE.MeshStandardMaterial;
      const ownOpacity = (child.userData.opacity as number | undefined) ?? 1;
      base.transparent = active || ownOpacity < 1;
      base.opacity = active ? 0.16 : ownOpacity;
      base.needsUpdate = true;
    }
    for (const d of state.datums) {
      const userVisible = datumVisibility[d.id] ?? true;
      if (d.kind === "plane") {
        const visible = userVisible && (!active || d.id === activeSketch?.datumId);
        d.object.visible = visible;
        if (d.outline) d.outline.visible = visible;
        if (active && d.id === activeSketch?.datumId) d.material.opacity = 0.1;
      } else {
        d.object.visible = userVisible; // origin point
      }
    }
    if (!active) applyDatumAppearance(state, null);
  }, [activeSketch, datumVisibility]);

  // Render user reference planes (translucent amber quads, distinct from the
  // grey base datums) and rebuild on change. The face mesh carries userData
  // .planeId so the pick flow can return a plane ref.
  useEffect(() => {
    const state = stateRef.current;
    if (!state) return;
    for (const c of state.planeGroup.children) {
      if (c instanceof THREE.Mesh || c instanceof THREE.LineSegments) {
        c.geometry.dispose();
        (c.material as THREE.Material).dispose();
      }
    }
    state.planeGroup.clear();
    const SIZE = 60;
    for (const rp of userPlanes) {
      const geo = new THREE.PlaneGeometry(SIZE, SIZE);
      // Orient by aligning the quad's own normal (+Z) to the frame normal. A
      // makeBasis(u,v,n) would reflect on left-handed frames (e.g. the Front
      // datum), mis-orienting the quad; the square's in-plane spin doesn't matter.
      const quat = new THREE.Quaternion().setFromUnitVectors(
        new THREE.Vector3(0, 0, 1),
        new THREE.Vector3(...rp.frame.normal).normalize(),
      );
      const pos = new THREE.Vector3(...rp.frame.origin);
      const mesh = new THREE.Mesh(
        geo,
        new THREE.MeshBasicMaterial({
          color: rp.color,
          transparent: true,
          opacity: 0.1,
          side: THREE.DoubleSide,
          depthWrite: false,
        }),
      );
      mesh.quaternion.copy(quat);
      mesh.position.copy(pos);
      mesh.userData.planeId = rp.id;
      const outline = new THREE.LineSegments(
        new THREE.EdgesGeometry(geo),
        new THREE.LineBasicMaterial({ color: rp.color, transparent: true, opacity: 0.5 }),
      );
      outline.quaternion.copy(quat);
      outline.position.copy(pos);
      outline.userData.planeId = rp.id;
      state.planeGroup.add(mesh, outline);
    }
  }, [userPlanes]);

  // The reference-plane dialog's ghost: where the plane WOULD land given the
  // inputs picked so far, in the ghost accent (cyan, dashed outline) rather than
  // a committed plane's amber. Same quad as a real reference plane, minus the
  // `planeId` — and in its own group, so it is never pickable (the user is still
  // clicking through this space to pick the plane's own references).
  useEffect(() => {
    const state = stateRef.current;
    if (!state) return;
    for (const c of state.ghostPlaneGroup.children) {
      if (c instanceof THREE.Mesh || c instanceof THREE.LineSegments) {
        c.geometry.dispose();
        (c.material as THREE.Material).dispose();
      }
    }
    state.ghostPlaneGroup.clear();
    if (!ghostPlane) return;
    const geo = new THREE.PlaneGeometry(60, 60);
    const quat = new THREE.Quaternion().setFromUnitVectors(
      new THREE.Vector3(0, 0, 1),
      new THREE.Vector3(...ghostPlane.normal).normalize(),
    );
    const pos = new THREE.Vector3(...ghostPlane.origin);
    const mesh = new THREE.Mesh(
      geo,
      new THREE.MeshBasicMaterial({
        color: GHOST_COLOR,
        transparent: true,
        opacity: 0.16,
        side: THREE.DoubleSide,
        depthWrite: false,
      }),
    );
    mesh.quaternion.copy(quat);
    mesh.position.copy(pos);
    const outline = new THREE.LineSegments(
      new THREE.EdgesGeometry(geo),
      new THREE.LineDashedMaterial({ color: GHOST_COLOR, transparent: true, opacity: 0.9, dashSize: 2, gapSize: 1.4 }),
    );
    outline.computeLineDistances(); // dashes only show once the distances exist
    outline.quaternion.copy(quat);
    outline.position.copy(pos);
    state.ghostPlaneGroup.add(mesh, outline);
  }, [ghostPlane]);

  // Drive the transform gizmo from the active TransformEdit + mode. The gizmo is
  // attached to a proxy whose pose reflects the feature's current values; while
  // the user is actively dragging we leave the proxy alone (the values we emit
  // round-trip back here, so re-setting would only risk a snap-jitter).
  useEffect(() => {
    const state = stateRef.current;
    if (!state) return;
    const tc = state.transformControls;
    const proxy = state.gizmoProxy;
    const helper = tc.getHelper();
    // Scale has its own gizmo — a box on the body's own bounds, driven from the
    // pointer handlers (see syncScaleGizmo) — so TransformControls stands down
    // entirely for that mode rather than showing a second, competing widget.
    if (!transformEdit || transformMode === "scale") {
      tc.detach();
      tc.enabled = false;
      helper.visible = false;
      return;
    }
    // A gizmo that still answers the mouse while the dialog is asking for a
    // pick will eat the pick. Its handles are invisible donuts and cones several
    // times fatter than what they draw — the rotate picker is a full torus
    // around the pivot — so they cover exactly the geometry the user has been
    // asked to click, and a press that lands on one starts a zero-distance drag
    // instead: the click appears to do nothing, and only a second one, nudged
    // clear of the handle, gets through. So the controls stand down for the
    // duration, staying VISIBLE for context but inert — the same thing the scale
    // gizmo already does via `scaleGizmoActive`.
    tc.enabled = !picking;
    helper.visible = true;
    tc.setMode(transformMode);
    // Translate drags along the WORLD axes, all three arrows shown. Rotate turns
    // about ONE axis that can point anywhere (a picked edge, a sketch line), so
    // it runs in LOCAL space with only the Z ring shown and the proxy turned to
    // put its local Z on that axis — the drag then maps cleanly onto the single
    // (axis, angle) the feature stores, whatever direction the axis points.
    const rotating = transformMode === "rotate";
    tc.setSpace(rotating ? "local" : "world");
    tc.showX = !rotating;
    tc.showY = !rotating;
    tc.showZ = true;
    if (!tc.dragging) {
      const { pivot, tx, ty, tz, angle, axis } = transformEdit;
      if (rotating) {
        // Centre the ring on the axis line, at the point nearest the body — a
        // hinge edge can run far past the body, and a ring stranded at the
        // edge's own origin would read as belonging to nothing.
        const dir = new THREE.Vector3(...axis.dir).normalize();
        const origin = new THREE.Vector3(...axis.origin);
        const centre = new THREE.Vector3(pivot[0] + tx, pivot[1] + ty, pivot[2] + tz);
        const along = centre.clone().sub(origin).dot(dir);
        proxy.position.copy(origin).addScaledVector(dir, along);
        proxy.quaternion
          .copy(axisFrameQuaternionOf(axis.dir))
          .multiply(new THREE.Quaternion().setFromAxisAngle(_unitZ, THREE.MathUtils.degToRad(angle)));
      } else {
        proxy.position.set(pivot[0] + tx, pivot[1] + ty, pivot[2] + tz);
        proxy.quaternion.identity(); // translate is world-space; the pose is irrelevant
      }
    }
    tc.attach(proxy);
  }, [transformEdit, transformMode, picking]);

  // Load the sketch font once; bumping `fontTick` re-runs the sketch render so
  // any text entities (which render nothing until the font is ready) appear.
  const [fontTick, setFontTick] = useState(0);
  useEffect(() => {
    let live = true;
    void loadSketchFont().then(() => {
      if (live) setFontTick((t) => t + 1);
    });
    return () => {
      live = false;
    };
  }, []);

  // Draw what Trim would take away / Extend would add, on the active sketch
  // plane. Cleared whenever there's nothing to show, which is most of the time.
  useEffect(() => {
    const state = stateRef.current;
    if (!state) return;
    const frame = activeFrameRef.current;
    if (!trimPreview || trimPreview.length < 2 || !frame) {
      state.trimLine.visible = false;
      return;
    }
    const flat: number[] = [];
    for (const p of trimPreview) {
      const w = uvToWorld(frame, p[0], p[1]);
      flat.push(w[0], w[1], w[2]);
    }
    // Fresh geometry rather than setPositions: a fat LineGeometry doesn't grow
    // its instance count when the point count rises (same gotcha as the drawing
    // preview), so a longer span would otherwise draw only its first segment.
    const g = new LineGeometry();
    g.setPositions(flat);
    state.trimLine.geometry.dispose();
    state.trimLine.geometry = g;
    state.trimLine.visible = true;
  }, [trimPreview]);

  // Render every sketch (so finished sketches stay visible); set the active
  // frame/entities used for drawing.
  useEffect(() => {
    const state = stateRef.current;
    if (!state) return;
    disposeSketchGroup(state.sketchGroup);
    for (const s of sketches) {
      const pts: number[] = [];
      const entityGroups: {
        start: number;
        count: number;
        entityId: string;
        construction: boolean;
        derived: boolean;
      }[] = [];
      for (const e of s.entities) {
        const startVert = pts.length / 3;
        entitySegments(e, s.frame, pts);
        const count = pts.length / 3 - startVert;
        if (count > 0)
          entityGroups.push({
            start: startVert,
            count,
            entityId: e.id,
            construction: !!e.construction,
            derived: !!e.derivedFrom,
          });
      }
      if (pts.length === 0) continue;
      const geom = new THREE.BufferGeometry();
      geom.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));
      // One geometry group per entity, so individual entities are highlightable.
      // Material index 1 = construction (dashed amber); 2 = derived/associative
      // (offset/mirror/project — a distinct purple, like Onshape's projected
      // geometry); 0 = normal solid line. Derived takes priority over construction.
      for (const g of entityGroups) geom.addGroup(g.start, g.count, g.derived ? 2 : g.construction ? 1 : 0);
      geom.userData.entityGroups = entityGroups;
      // Index 0 = per-sketch base colour (kept invisible — the fat display line
      // below actually draws the solid entities; this thin line stays for picking
      // and as the selection-overlay source). Index 1 = dashed construction.
      const baseMat = new THREE.LineBasicMaterial({
        color: sketchBaseColor(s.id === activeSketchId, sketchFullyConstrainedRef.current),
      });
      // Kept invisible — construction lines are drawn by a fat DASHED display line
      // below (same width + colour as solid sketch lines), so this thin twin only
      // exists for the group structure / picking.
      const constructionMat = new THREE.LineDashedMaterial({
        color: 0xe0a64f,
        dashSize: 1.4,
        gapSize: 0.9,
        transparent: true,
        opacity: 0,
      });
      // Associative/derived geometry (offset/mirror/projected) — a distinct
      // purple so it reads as driven, not free, geometry.
      const derivedMat = new THREE.LineBasicMaterial({ color: 0xb46bff });
      const seg = new THREE.LineSegments(geom, [baseMat, constructionMat, derivedMat]);
      seg.computeLineDistances(); // needed by the dashed construction material
      seg.frustumCulled = false;
      seg.userData.sketchId = s.id;
      seg.userData.frame = s.frame;
      // The thin LineSegments stays the source of truth for picking + the
      // selection/hover overlay (it owns the per-entity geometry groups and a
      // plain `position` attribute). Its solid lines are drawn over by a fat
      // display line below, so make material[0] invisible to avoid z-fighting the
      // two; the dashed construction material (index 1) stays visible as-is.
      baseMat.transparent = true;
      baseMat.opacity = 0;
      state.sketchGroup.add(seg);

      // Fat display lines, coloured by the sketch's constrained state: the solid
      // (non-construction) entities, and the construction entities as a DASHED fat
      // line of the SAME width + colour (only the dash pattern marks them as
      // construction). Both drawn a touch thicker via LineMaterial.
      const size = state.renderer.getSize(new THREE.Vector2());
      const sketchColor = sketchBaseColor(s.id === activeSketchId, sketchFullyConstrainedRef.current);
      const addFat = (want: (g: (typeof entityGroups)[number]) => boolean, dashed: boolean) => {
        const fpts = pts.filter((_, i) => {
          const vert = Math.floor(i / 3);
          const g = entityGroups.find((eg) => vert >= eg.start && vert < eg.start + eg.count);
          return g != null && want(g);
        });
        if (fpts.length < 6) return;
        const fatGeom = new LineSegmentsGeometry();
        fatGeom.setPositions(fpts);
        const fatMat = buttCaps(
          new LineMaterial({
            color: sketchColor,
            linewidth: SKETCH_LINE_WIDTH,
            worldUnits: false,
            ...(dashed && { dashed: true, dashSize: 1.4, gapSize: 0.9 }),
            // Nudge toward the camera so the fat line wins over the (coincident)
            // thin line without turning depth testing off — sketches behind a solid
            // body still read as occluded.
            polygonOffset: true,
            polygonOffsetFactor: -2,
            polygonOffsetUnits: -2,
          }),
        );
        fatMat.resolution.set(size.x, size.y);
        const fat = new LineSegments2(fatGeom, fatMat);
        if (dashed) fat.computeLineDistances();
        fat.frustumCulled = false;
        fat.renderOrder = 4;
        fat.userData.sketchId = s.id;
        fat.userData.isSketchDisplay = true;
        state.sketchGroup.add(fat);
      };
      addFat((g) => !g.construction, false);
      addFat((g) => g.construction, true);

      // Small dots at the active sketch's selectable/draggable vertices, so those
      // key points are visible and grabbable. Rebuilt with the geometry each
      // render, so they follow a live vertex/entity drag (App re-solves → the
      // sketch re-renders → these move with it). Origin excluded (it has the
      // yellow datum dot).
      if (s.id === activeSketchId) {
        const verts = sketchPointCandidates(s).slice(1);
        if (verts.length > 0) {
          const dotPos = new Float32Array(verts.length * 3);
          verts.forEach(({ uv }, i) => {
            const w = uvToWorld(s.frame, uv[0], uv[1]);
            dotPos[i * 3] = w[0];
            dotPos[i * 3 + 1] = w[1];
            dotPos[i * 3 + 2] = w[2];
          });
          const dotGeom = new THREE.BufferGeometry();
          dotGeom.setAttribute("position", new THREE.BufferAttribute(dotPos, 3));
          sketchDotMaterial.color.set(sketchBaseColor(true, sketchFullyConstrainedRef.current));
          const dots = new THREE.Points(dotGeom, sketchDotMaterial);
          dots.frustumCulled = false;
          dots.renderOrder = 12; // above the fat lines, below the hover marker (13)
          dots.userData.isSketchDots = true;
          state.sketchGroup.add(dots);
        }
      }

      // Enclosed regions ("sketch faces"): a transparent, pickable fill that
      // only shows on hover/selection.
      for (const region of s.regions) {
        const shape = new THREE.Shape(region.outline.map((p) => new THREE.Vector2(p[0], p[1])));
        // Carve inner loops out of the fill so the mesh is a true annulus: a
        // click inside a hole falls through to the nested region behind it.
        for (const hole of region.holes ?? []) {
          shape.holes.push(new THREE.Path(hole.map((p) => new THREE.Vector2(p[0], p[1]))));
        }
        const geom2d = new THREE.ShapeGeometry(shape);
        const flat = geom2d.getAttribute("position");
        const world = new Float32Array(flat.count * 3);
        for (let i = 0; i < flat.count; i++) {
          const w = uvToWorld(s.frame, flat.getX(i), flat.getY(i));
          world[i * 3] = w[0];
          world[i * 3 + 1] = w[1];
          world[i * 3 + 2] = w[2];
        }
        const fillGeom = new THREE.BufferGeometry();
        fillGeom.setAttribute("position", new THREE.BufferAttribute(world, 3));
        fillGeom.setIndex(geom2d.getIndex());
        geom2d.dispose();
        const fill = new THREE.Mesh(
          fillGeom,
          new THREE.MeshBasicMaterial({
            color: 0x36d6c3,
            transparent: true,
            opacity: 0,
            side: THREE.DoubleSide,
            depthWrite: false,
          }),
        );
        fill.userData.sketchId = s.id;
        fill.userData.regionId = region.id;
        fill.userData.isRegion = true;
        // Closed boundary loops in world space (line-segment pairs) for fat-line
        // highlighting when the sketch face is selected — the outer outline plus
        // every hole boundary, so an annular frame highlights its inner edge too.
        const ow: number[] = [];
        for (const loop of [region.outline, ...(region.holes ?? [])]) {
          const n = loop.length;
          for (let i = 0; i < n; i++) {
            const p = loop[i];
            const q = loop[(i + 1) % n];
            const wp = uvToWorld(s.frame, p[0], p[1]);
            const wq = uvToWorld(s.frame, q[0], q[1]);
            ow.push(wp[0], wp[1], wp[2], wq[0], wq[1], wq[2]);
          }
        }
        fill.userData.outlineWorld = ow;
        state.sketchGroup.add(fill);
      }
    }
    applyHighlightsRef.current(); // re-apply selection/hover colors
    const active = sketches.find((s) => s.id === activeSketchId) ?? null;
    activeFrameRef.current = active?.frame ?? null;
    activeEntitiesRef.current = active?.entities ?? [];
    if (!active) {
      state.previewLine.visible = false;
      state.snapMarker.visible = false;
      state.snapEdgeLine.visible = false;
      state.guideOverlay.visible = false;
      state.anchorOverlay.visible = false;
      state.guideBadge.style.display = "none";
      armedRef.current = { points: [], lines: [] };
      snapPointsRef.current = [];
      snapLinesRef.current = [];
      snapCirclesRef.current = [];
      return;
    }

    // Gather snap candidates that lie ON the active plane, from every sketch and
    // every body edge — points (endpoints + midpoints) and coplanar edges.
    const frame = active.frame;
    const O = new THREE.Vector3(...frame.origin);
    const N = new THREE.Vector3(...frame.normal).normalize();
    const U = new THREE.Vector3(...frame.uAxis);
    const V = new THREE.Vector3(...frame.vAxis);
    const TOL = 0.05;
    const onPlane = (w: THREE.Vector3) => Math.abs(w.clone().sub(O).dot(N)) < TOL;
    const toUv = (w: THREE.Vector3): Vec2 => {
      const d = w.clone().sub(O);
      return [d.dot(U), d.dot(V)];
    };
    const points: {
      uv: Vec2;
      midpointOf?: string;
      vertex?: boolean;
      circle?: { c: Vec2; r: number };
      external?: boolean;
    }[] = [{ uv: [0, 0], vertex: true }];
    const lines: { a: Vec2; b: Vec2; id?: string; construction?: boolean; external?: boolean }[] = [];
    /** Rings from the sketch's own circles (see the on-circle snap below). */
    const sketchRings: { c: Vec2; r: number; id?: string }[] = [];
    // `id` is the active-sketch line entity this segment belongs to (so a drawn
    // endpoint landing on its body → point-on-line, on its midpoint → midpoint).
    // Endpoints are `vertex` corners (they end the line-tool chain when snapped).
    // `external` marks BODY geometry (no sketch entity to constrain to) — snapping
    // there pins the drawn point to the spot with a coincident-to-{fixed}.
    const addSeg = (aw: THREE.Vector3, bw: THREE.Vector3, id?: string, construction?: boolean, external?: boolean) => {
      const aOn = onPlane(aw);
      const bOn = onPlane(bw);
      if (aOn) points.push({ uv: toUv(aw), vertex: true, external });
      if (bOn) points.push({ uv: toUv(bw), vertex: true, external });
      if (aOn && bOn) {
        const a = toUv(aw);
        const b = toUv(bw);
        points.push({ uv: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], midpointOf: id, external }); // midpoint
        lines.push({ a, b, id, construction, external });
      }
    };
    const addPoint = (uv: Vec2, midpointOf?: string, vertex?: boolean) => {
      const w = new THREE.Vector3(...uvToWorld(active.frame, uv[0], uv[1]));
      if (onPlane(w)) points.push({ uv: toUv(w), midpointOf, vertex });
    };
    for (const s of sketches) {
      const sameFrame = s.frame === active.frame;
      // Only the active sketch's own lines/arcs are constrainable from this sketch.
      const activeId = s.id === activeSketchId;
      for (const e of s.entities) {
        if (e.type === "line") {
          addSeg(
            new THREE.Vector3(...uvToWorld(s.frame, e.a[0], e.a[1])),
            new THREE.Vector3(...uvToWorld(s.frame, e.b[0], e.b[1])),
            activeId ? e.id : undefined,
            e.construction,
          );
        } else if (sameFrame && e.type === "circle") {
          addPoint(e.c); // centre
          // …and the rim: an on-circle snap, so a line drawn from the centre
          // lands exactly on the edge. Carrying the entity id (for the ACTIVE
          // sketch) makes the landing parametric — the click attaches a
          // point-on-circle constraint, so the endpoint rides the rim when the
          // circle is moved or re-dimensioned. Body rims pin instead (`external`)
          // since there's no sketch entity to constrain to.
          sketchRings.push({ c: e.c, r: e.r, id: activeId ? e.id : undefined });
        } else if (sameFrame && e.type === "arc") {
          addPoint(e.c);
          addPoint([e.c[0] + e.r * Math.cos(e.start), e.c[1] + e.r * Math.sin(e.start)], undefined, true);
          addPoint([e.c[0] + e.r * Math.cos(e.end), e.c[1] + e.r * Math.sin(e.end)], undefined, true);
          // Mid-arc point (snapping here locks to the arc's midpoint).
          const m = (e.start + e.end) / 2;
          addPoint([e.c[0] + e.r * Math.cos(m), e.c[1] + e.r * Math.sin(m)], activeId ? e.id : undefined);
        }
      }
    }
    for (const [aw, bw] of collectBodyEdges(state.group)) addSeg(aw, bw, undefined, undefined, true);
    // Circular body edges coplanar with the sketch (a hole rim, a cylinder cap):
    // offer the centre + the four quadrant points as snaps, and the true ring for
    // on-circle snapping — so drawing a concentric circle or hitting the rim is
    // natural instead of chasing faceted chords.
    const circles: { c: Vec2; r: number; external?: boolean; id?: string }[] = [];
    for (const circ of collectBodyCircles(state.group)) {
      if (!onPlane(circ.center)) continue;
      if (Math.abs(circ.normal.dot(N)) < 0.999) continue; // ring must lie in the sketch plane
      const c = toUv(circ.center);
      const r = circ.radius;
      const ring = { c, r, external: true };
      points.push({ uv: c, vertex: true, circle: ring }); // centre
      points.push({ uv: [c[0] + r, c[1]], vertex: true, circle: ring }); // quadrants (u/v of the frame)
      points.push({ uv: [c[0] - r, c[1]], vertex: true, circle: ring });
      points.push({ uv: [c[0], c[1] + r], vertex: true, circle: ring });
      points.push({ uv: [c[0], c[1] - r], vertex: true, circle: ring });
      circles.push(ring);
    }
    snapPointsRef.current = points;
    snapLinesRef.current = lines;
    snapCirclesRef.current = [...circles, ...sketchRings];
  }, [sketches, activeSketchId, meshes, sketchFullyConstrained, fontTick]);

  // Resolve which faces of the sketched body lie on the sketch plane, so the
  // face-material loop can tint them. A planar face is classified from one
  // triangle: coplanar with the frame (point-to-plane distance ~0) and its
  // normal parallel to the frame normal. Re-derived on every build.
  useEffect(() => {
    if (!activeSketchFace) {
      activeSketchFaceRef.current = null;
      return;
    }
    const body = meshes.find((x) => x.id === activeSketchFace.bodyId);
    const faces = body?.mesh.faces;
    if (!faces?.faceGroups) {
      activeSketchFaceRef.current = null;
      return;
    }
    const { origin: O, normal: Nraw } = activeSketchFace.frame;
    const nl = Math.hypot(Nraw[0], Nraw[1], Nraw[2]) || 1;
    const N: Vec3 = [Nraw[0] / nl, Nraw[1] / nl, Nraw[2] / nl];
    const { vertices, triangles } = faces;
    const v = (i: number): Vec3 => [vertices[i * 3], vertices[i * 3 + 1], vertices[i * 3 + 2]];
    const faceIds = new Set<number>();
    for (const g of faces.faceGroups) {
      if (g.count < 3) continue;
      const a = v(triangles[g.start]);
      const b = v(triangles[g.start + 1]);
      const c = v(triangles[g.start + 2]);
      // Coplanar: the first vertex sits on the frame plane.
      if (Math.abs((a[0] - O[0]) * N[0] + (a[1] - O[1]) * N[1] + (a[2] - O[2]) * N[2]) > 0.05) continue;
      // Parallel: the triangle's normal is (anti)parallel to the frame normal.
      const e1: Vec3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
      const e2: Vec3 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
      const fn: Vec3 = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
      const fnl = Math.hypot(fn[0], fn[1], fn[2]);
      if (fnl < 1e-9) continue;
      const sin =
        Math.hypot(fn[1] * N[2] - fn[2] * N[1], fn[2] * N[0] - fn[0] * N[2], fn[0] * N[1] - fn[1] * N[0]) / fnl;
      if (sin > 1e-2) continue;
      faceIds.add(g.faceId);
    }
    activeSketchFaceRef.current = faceIds.size ? { bodyId: activeSketchFace.bodyId, faceIds } : null;
  }, [activeSketchFace, meshes]);

  return <div ref={containerRef} style={{ width: "100%", height: "100%" }} />;
}

/** Append world-space segment endpoints for an entity to a flat buffer. */
function entitySegments(e: SketchEntity, frame: PlaneFrameData, out: number[]) {
  const push = (a: Vec2, b: Vec2) => {
    const wa = uvToWorld(frame, a[0], a[1]);
    const wb = uvToWorld(frame, b[0], b[1]);
    out.push(wa[0], wa[1], wa[2], wb[0], wb[1], wb[2]);
  };
  if (e.type === "line") push(e.a, e.b);
  else if (e.type === "circle") {
    const pts = sampleCircle(e.c, e.r);
    for (let i = 0; i + 1 < pts.length; i++) push(pts[i], pts[i + 1]);
  } else if (e.type === "arc") {
    const pts = sampleArc(e.c, e.r, e.start, e.end);
    for (let i = 0; i + 1 < pts.length; i++) push(pts[i], pts[i + 1]);
  } else if (e.type === "spline") {
    const pts = sampleSpline(e.points);
    for (let i = 0; i + 1 < pts.length; i++) push(pts[i], pts[i + 1]);
  } else if (e.type === "text") {
    const font = getSketchFont();
    if (font) {
      // Each glyph contour is a closed loop; emit its segments (including the
      // closing edge back to the contour start).
      for (const c of textToContours(e.value, e.height, font, { anchor: e.p, rotation: e.rotation ?? 0 })) {
        for (let i = 0; i < c.length; i++) push(c[i], c[(i + 1) % c.length]);
      }
    }
  }
}

/** Live preview polyline (in uv) for the in-progress tool, or null. */
function previewPolyline(tool: SketchTool, draft: Vec2[], cursor: Vec2, sides: number): Vec2[] | null {
  const closed = (pts: Vec2[]): Vec2[] => [...pts, pts[0]];
  switch (tool) {
    case "line":
      return draft.length >= 1 ? [draft[draft.length - 1], cursor] : null;
    case "rect-corner":
      return draft.length === 1 ? closed(rectangleCorners(draft[0], cursor)) : null;
    case "rect-center":
      return draft.length === 1 ? closed(rectangleFromCenter(draft[0], cursor)) : null;
    case "circle-center":
      return draft.length === 1
        ? sampleCircle(draft[0], Math.hypot(cursor[0] - draft[0][0], cursor[1] - draft[0][1]))
        : null;
    case "circle-3p":
      if (draft.length === 1) return [draft[0], cursor];
      if (draft.length === 2) {
        const c = circleFrom3(draft[0], draft[1], cursor);
        return c ? sampleCircle(c.center, c.r) : [draft[0], draft[1], cursor];
      }
      return null;
    case "polygon":
      return draft.length === 1 ? closed(regularPolygon(draft[0], cursor, sides)) : null;
    case "arc-3p":
      if (draft.length === 1) return [draft[0], cursor];
      if (draft.length === 2) {
        const a = arcFrom3(draft[0], cursor, draft[1]); // start, mid(cursor), end
        return a ? sampleArc(a.center, a.r, a.start, a.end) : [draft[0], cursor, draft[1]];
      }
      return null;
    case "spline":
      // The committed points so far + the cursor, drawn as a smooth spline.
      return draft.length >= 1 ? sampleSpline([...draft, cursor]) : null;
    default:
      return null;
  }
}

/** Selectable points of a sketch: line endpoints, circle centres, arc ends. */
/** A pickable sketch point, tagged by what kind it is. The distinction decides
 *  how hard it competes with the entity under the cursor:
 *   • VERTEX — an endpoint, which lies ON the entity you're clicking, so it has
 *     to be able to win against it outright or it's unreachable.
 *   • CENTRE — sits away from its own rim. Letting it win freely is what once
 *     made a small circle unselectable (every click on the rim hit the centre).
 *   • ORIGIN — always a candidate, entity or not. It isn't a vertex of anything,
 *     so it has no reason to beat a line that merely passes through it. */
function sketchPointCandidates(sketch: RenderSketch): { uv: Vec2; kind: "vertex" | "center" | "origin" }[] {
  // The sketch origin (0,0) is always selectable — so it can be picked as the
  // anchor for a coincident / point-on-line constraint even when no entity
  // vertex sits there.
  const out: { uv: Vec2; kind: "vertex" | "center" | "origin" }[] = [{ uv: [0, 0], kind: "origin" }];
  const vertex = (uv: Vec2) => out.push({ uv, kind: "vertex" });
  for (const e of sketch.entities) {
    if (e.type === "line") {
      vertex(e.a);
      vertex(e.b);
    } else if (e.type === "circle") out.push({ uv: e.c, kind: "center" });
    else if (e.type === "arc") {
      out.push({ uv: e.c, kind: "center" });
      vertex([e.c[0] + e.r * Math.cos(e.start), e.c[1] + e.r * Math.sin(e.start)]);
      vertex([e.c[0] + e.r * Math.cos(e.end), e.c[1] + e.r * Math.sin(e.end)]);
    } else if (e.type === "spline") e.points.forEach(vertex);
    else if (e.type === "point") vertex(e.p);
  }
  return out;
}

/** The sketch points that translate when an entity is dragged by its body. Lines
 *  move both endpoints; circles/arcs move their centre (radius/angles ride along);
 *  splines move every control point; a point moves itself. Identifying them by uv
 *  means a vertex shared with another entity (a chained corner) moves on both. */
function entityDragPoints(e: SketchEntity): Vec2[] {
  switch (e.type) {
    case "line":
      return [e.a, e.b];
    case "circle":
      return [e.c];
    case "arc":
      return [e.c];
    case "spline":
      return e.points;
    case "point":
      return [e.p];
    case "text":
      return [e.p];
  }
}

/** Sketch vertices a user can grab to drag a single point (line endpoints, circle
 *  centres, arc centres, spline control points, points). Arc *endpoints* are
 *  omitted — they're derived from centre/radius/angles, so dragging them isn't a
 *  simple point move. */
function draggableVertices(sketch: RenderSketch): Vec2[] {
  return sketch.entities.flatMap(entityDragPoints);
}

/** World-space endpoint pairs of every body edge currently in the scene. */
function collectBodyEdges(group: THREE.Group): [THREE.Vector3, THREE.Vector3][] {
  const segments: [THREE.Vector3, THREE.Vector3][] = [];
  for (const child of group.children) {
    if (!(child instanceof THREE.LineSegments)) continue;
    const pos = child.geometry.getAttribute("position");
    if (!pos) continue;
    for (let i = 0; i + 1 < pos.count; i += 2) {
      segments.push([
        new THREE.Vector3().fromBufferAttribute(pos, i),
        new THREE.Vector3().fromBufferAttribute(pos, i + 1),
      ]);
    }
  }
  return segments;
}

/** Circular edges of the running bodies (a hole rim, a cylinder cap), fitted from
 *  each edge CHAIN (the faceted circle's chords, grouped by chainId). Returns
 *  world-space centre/radius/normal; the sketch snap layer keeps the ones
 *  coplanar with the active plane and offers centre/quadrant/on-ring snaps. */
function collectBodyCircles(group: THREE.Group): { center: THREE.Vector3; radius: number; normal: THREE.Vector3 }[] {
  const out: { center: THREE.Vector3; radius: number; normal: THREE.Vector3 }[] = [];
  for (const child of group.children) {
    if (!(child instanceof THREE.LineSegments)) continue;
    const eg = child.geometry.userData.edgeGroups as
      { start: number; count: number; edgeId: number; chainId?: number }[] | undefined;
    const pos = child.geometry.getAttribute("position");
    if (!eg || !pos) continue;
    // Group segments by chain (an un-chained edge is its own candidate).
    const byChain = new Map<number | string, { start: number; count: number }[]>();
    for (const g of eg) {
      const k = g.chainId ?? `e${g.edgeId}`;
      const arr = byChain.get(k);
      if (arr) arr.push(g);
      else byChain.set(k, [g]);
    }
    for (const groups of byChain.values()) {
      const pts: THREE.Vector3[] = [];
      for (const g of groups)
        for (let v = g.start; v < g.start + g.count; v++) pts.push(new THREE.Vector3().fromBufferAttribute(pos, v));
      const circ = fitCircle(pts);
      if (circ) out.push(circ);
    }
  }
  return out;
}

// --- Ground grid ----------------------------------------------------------

/** Ground grid: half-width, and the pitch of one cell. */
const GRID_HALF = 120;
const GRID_STEP = 10;
/** How far the world axes reach out of the origin. */
const AXES_LENGTH = 45;
/** Vertices the two centre lines occupy — laid down first, so a theme change can
 *  recolour them as a block. Four segments (each centre line is split in two by
 *  the gap the axes fill), two vertices each. */
const GRID_CENTRE_VERTS = 8;

/** The ground grid: a flat XY line grid centred on the origin.
 *
 *  Built by hand rather than with `THREE.GridHelper` for one reason. The
 *  helper's two centre lines run the full width straight along world X and Y —
 *  exactly where the axes helper draws its own. Coincident depth-writing lines
 *  z-fight: which one survives is settled per pixel by the last bit of the
 *  interpolated depth, so the axes came out stippled, the pattern reshuffling
 *  every frame the camera moved and then freezing wherever the orbit stopped.
 *  Here the centre lines just stop short of the stretch the axes cover, so
 *  nothing overlaps and both can keep ordinary depth testing — which is what
 *  makes the axes read as solid geometry, hidden by a body only where the body
 *  is really in front of them. */
function createGroundGrid(major: number, minor: number): THREE.LineSegments {
  // The two centre lines, minus the gap the axes fill on +X and +Y.
  const positions: number[] = [
    -GRID_HALF,
    0,
    0,
    0,
    0,
    0,
    AXES_LENGTH,
    0,
    0,
    GRID_HALF,
    0,
    0,
    0,
    -GRID_HALF,
    0,
    0,
    0,
    0,
    0,
    AXES_LENGTH,
    0,
    0,
    GRID_HALF,
    0,
  ];
  for (let k = -GRID_HALF; k <= GRID_HALF; k += GRID_STEP) {
    if (k === 0) continue; // owned by the centre lines above
    positions.push(-GRID_HALF, k, 0, GRID_HALF, k, 0);
    positions.push(k, -GRID_HALF, 0, k, GRID_HALF, 0);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("color", new THREE.Float32BufferAttribute(positions.length, 3));
  const grid = new THREE.LineSegments(geometry, new THREE.LineBasicMaterial({ vertexColors: true, toneMapped: false }));
  paintGroundGrid(grid, major, minor);
  return grid;
}

/** Recolour the grid in place: centre lines in `major`, cells in `minor`. */
function paintGroundGrid(grid: THREE.LineSegments, major: number, minor: number): void {
  const colors = grid.geometry.getAttribute("color") as THREE.BufferAttribute;
  const hot = new THREE.Color(major);
  const cold = new THREE.Color(minor);
  for (let i = 0; i < colors.count; i++) {
    const c = i < GRID_CENTRE_VERTS ? hot : cold;
    colors.setXYZ(i, c.r, c.g, c.b);
  }
  colors.needsUpdate = true;
}

// --- Datum geometry -------------------------------------------------------

const PLANE_SIZE = 72;
// On-screen radius (in device pixels) the origin dot holds at any zoom level.
const ORIGIN_PIXEL_RADIUS = 10;
// On-screen radius of the snap/hover marker (the ring shown over the origin or a
// snapped edge). Slightly larger than the origin dot so it reads as a highlight.
const SNAP_PIXEL_RADIUS = 12;

/** Rescale a sphere-based marker each frame so its projected radius stays at
 *  `pxRadius` device pixels regardless of zoom — the world-space equivalent of
 *  PointsMaterial's sizeAttenuation:false. `geomRadius` is the mesh's base
 *  SphereGeometry radius. */
function keepConstantPixelRadius(mesh: THREE.Mesh, geomRadius: number, pxRadius: number | (() => number)): void {
  const world = new THREE.Vector3();
  const size = new THREE.Vector2();
  mesh.onBeforeRender = (renderer, _scene, camera) => {
    const h = renderer.getDrawingBufferSize(size).y;
    let worldPerPx: number;
    if ((camera as THREE.OrthographicCamera).isOrthographicCamera) {
      const oc = camera as THREE.OrthographicCamera;
      worldPerPx = (oc.top - oc.bottom) / oc.zoom / h;
    } else {
      const pc = camera as THREE.PerspectiveCamera;
      const dist = pc.position.distanceTo(mesh.getWorldPosition(world));
      worldPerPx = (2 * dist * Math.tan((pc.fov * Math.PI) / 360)) / h;
    }
    const px = typeof pxRadius === "function" ? pxRadius() : pxRadius;
    mesh.scale.setScalar((worldPerPx * px) / geomRadius);
  };
}
const PLANE_TINTS: Record<"plane-top" | "plane-front" | "plane-right", number> = {
  "plane-top": 0x4f8cff,
  "plane-front": 0x3ddc84,
  "plane-right": 0xff6b6b,
};

function createDatums(scene: THREE.Scene): DatumEntry[] {
  const entries: DatumEntry[] = [];

  const originMat = new THREE.MeshBasicMaterial({
    color: 0xffd24a,
    depthTest: false,
    transparent: true,
    opacity: 0.5,
  });
  const origin = new THREE.Mesh(new THREE.SphereGeometry(1.0, 20, 20), originMat);
  origin.renderOrder = 10;
  // Keep the origin dot a constant on-screen size regardless of zoom, the way
  // the vertex points (sizeAttenuation:false) do.
  keepConstantPixelRadius(origin, 1.0, ORIGIN_PIXEL_RADIUS);
  scene.add(origin);
  entries.push({ id: "origin", object: origin, kind: "point", material: originMat, baseOpacity: 0.5 });

  const planeGeo = new THREE.PlaneGeometry(PLANE_SIZE, PLANE_SIZE);
  const edgeGeo = new THREE.EdgesGeometry(planeGeo);
  const planes: { id: keyof typeof PLANE_TINTS; rot: [number, number, number] }[] = [
    { id: "plane-top", rot: [0, 0, 0] },
    { id: "plane-front", rot: [Math.PI / 2, 0, 0] },
    { id: "plane-right", rot: [0, Math.PI / 2, 0] },
  ];
  for (const { id, rot } of planes) {
    const tint = PLANE_TINTS[id];
    const mat = new THREE.MeshBasicMaterial({
      color: tint,
      transparent: true,
      opacity: 0.06,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    const mesh = new THREE.Mesh(planeGeo, mat);
    mesh.rotation.set(...rot);
    const outline = new THREE.LineSegments(
      edgeGeo,
      new THREE.LineBasicMaterial({ color: tint, transparent: true, opacity: 0.35 }),
    );
    outline.rotation.set(...rot);
    scene.add(mesh, outline);
    entries.push({ id, object: mesh, kind: "plane", material: mat, outline, baseOpacity: 0.06 });
  }
  return entries;
}

function applyDatumAppearance(state: SceneState, hovered: DatumId | null): void {
  for (const d of state.datums) {
    const hot = d.id === hovered;
    if (d.kind === "plane") {
      d.material.opacity = hot ? 0.18 : d.baseOpacity;
      if (d.outline) (d.outline.material as THREE.LineBasicMaterial).opacity = hot ? 0.8 : 0.35;
    } else {
      d.object.scale.setScalar(hot ? 1.35 : 1);
      d.material.opacity = hot ? 0.85 : d.baseOpacity;
    }
  }
}

function disposeGroup(group: THREE.Group): void {
  for (const child of group.children) {
    if (child instanceof THREE.Mesh) {
      child.geometry.dispose();
      // material[0] (base colour), [2] (per-body selected tint) and [4] (per-body
      // opaque active-sketch face) are created per-body in the rebuild effect;
      // [1] (hover) and [3] (ghost) are shared and disposed on unmount instead.
      if (Array.isArray(child.material)) {
        child.material[0]?.dispose();
        child.material[2]?.dispose();
        child.material[4]?.dispose();
      }
    } else if (child instanceof THREE.LineSegments) {
      child.geometry.dispose();
    }
  }
  group.clear();
}

function disposeSketchGroup(group: THREE.Group): void {
  for (const child of group.children) {
    if (child.userData.isSketchDots) {
      // Dispose only the per-render geometry; the dot material is shared.
      (child as THREE.Points).geometry.dispose();
    } else if (
      child instanceof THREE.LineSegments ||
      child.userData.isSketchDisplay ||
      (child instanceof THREE.Mesh && child.userData.isRegion)
    ) {
      (child as LineSegments2).geometry.dispose();
      const m = (child as THREE.Mesh).material as THREE.Material | THREE.Material[];
      if (Array.isArray(m)) m.forEach((x) => x.dispose());
      else m.dispose();
    }
  }
  group.clear();
}
