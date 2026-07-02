import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { TransformControls } from "three/examples/jsm/controls/TransformControls.js";
import { LineSegments2 } from "three/examples/jsm/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/examples/jsm/lines/LineSegmentsGeometry.js";
import { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";
import { getEdgeId, getFaceId, syncGeometries } from "replicad-threejs-helper";
import type { ShapeMeshPayload } from "../kernel/types";
import type { SketchEntity, Vec2 } from "../document/types";
import type { SketchRegion } from "../document/regions";
import {
  deriveFaceFrame,
  uvToWorld,
  type PlaneFrameData,
  type SketchPlaneId,
  type SketchPlaneRef,
} from "../document/planes";
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

export type TransformMode = "translate" | "rotate";

/** The live state of the Transform gizmo: which body it sits on, its rotation
 *  pivot, and the current (resolved, numeric) translate/rotate values. Numbers,
 *  not expressions — the gizmo is a numeric input device; the dialog owns text. */
export interface TransformEdit {
  featureId: string;
  /** Which rendered body the gizmo moves: the source body (move-in-place) or the
   *  copy keyed by the feature (copy=true). Used for the live drag preview. */
  bodyId: string;
  pivot: [number, number, number];
  tx: number;
  ty: number;
  tz: number;
  /** Rotation angle in degrees about `axis` (a world axis). */
  angle: number;
  axis: "x" | "y" | "z";
}

/** Numeric values the gizmo emits on each drag (written back as the feature's
 *  translate/rotate expressions). */
export interface TransformDelta {
  tx: number;
  ty: number;
  tz: number;
  angle: number;
}

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

/** A revolve-axis pick from the unified "Select axis" arming: a sketch line, a
 *  body face (resolved to a line in the kernel), or a datum/reference plane. */
export type RevolveAxisPick =
  | { kind: "line"; sketchId: string; entityId: string }
  | { kind: "bodyFace"; featureId: string; faceId: number }
  | { kind: "plane"; ref: SketchPlaneRef };

export function sameSelection(a: Selection | null, b: Selection | null): boolean {
  if (a === b) return true;
  if (!a || !b || a.kind !== b.kind) return false;
  if (a.kind === "feature" && b.kind === "feature") return a.id === b.id;
  if (a.kind === "face" && b.kind === "face")
    return a.featureId === b.featureId && a.faceId === b.faceId;
  if (a.kind === "edge" && b.kind === "edge")
    return a.featureId === b.featureId && a.edgeId === b.edgeId;
  if (a.kind === "vertex" && b.kind === "vertex")
    return a.featureId === b.featureId && a.point.every((v, i) => v === b.point[i]);
  if (a.kind === "sketchEntity" && b.kind === "sketchEntity")
    return a.sketchId === b.sketchId && a.entityId === b.entityId;
  if (a.kind === "sketchPoint" && b.kind === "sketchPoint")
    return a.sketchId === b.sketchId && a.point.every((v, i) => v === b.point[i]);
  if (a.kind === "sketchFace" && b.kind === "sketchFace")
    return a.sketchId === b.sketchId && a.regionId === b.regionId;
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
  | "text";
/** Tools that pick/click existing entities (entity selection) rather than draw
 *  new geometry on the plane: Select, the Mirror tool (which clicks an axis line
 *  and then entities to reflect), and Project/Convert (which clicks body edges /
 *  vertices to pull into the sketch). Routes clicks to onSelect, not
 *  onSketchClick, and keeps selection-hover highlighting live. */
function isPickTool(t: SketchTool): boolean {
  return t === "select" || t === "mirror" || t === "project";
}
export type ViewName = "front" | "back" | "left" | "right" | "top" | "bottom" | "iso";

export interface ViewportApi {
  setView(name: ViewName): void;
  lookAtFrame(frame: PlaneFrameData): void;
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
   *  visual feedback (Phase 9). Finalizes any in-flight camera tween first so a
   *  preceding setView is reflected immediately. */
  capturePNG(): string;
}

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
  camera: THREE.PerspectiveCamera;
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
  /** The live ghost-preview bodies (rebuilt from the `ghostMeshes` prop). */
  ghostGroup: THREE.Group;
  ghostMaterial: THREE.MeshStandardMaterial;
  ghostLineMaterial: THREE.LineBasicMaterial;
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
  liveDrag: { objects: THREE.Object3D[]; m0Inverse: THREE.Matrix4 } | null;
  /** A just-released drag whose kernel regenerate is still in flight. The commit
   *  changes the document immediately, which rebuilds the body's objects from the
   *  STILL-STALE meshes (original position) before the new geometry lands — so we
   *  re-pin the dragged matrix onto each rebuild until the body's mesh reference
   *  actually changes (the real geometry), avoiding a flash back to the origin. */
  pendingCommit: { bodyId: string; delta: THREE.Matrix4; meshRef: unknown } | null;
  previewLine: THREE.Line;
  snapMarker: THREE.Mesh;
  tween: { from: THREE.Vector3; to: THREE.Vector3; up: THREE.Vector3; start: number } | null;
}

/** Build the world matrix for a transform feature's values, matching the kernel's
 *  composition exactly: rotate about (pivot, axis) first, then translate (M = T·R).
 *  Keeps the live drag preview pixel-aligned with what regenerate will bake. */
function transformMatrix(
  pivot: [number, number, number],
  tx: number,
  ty: number,
  tz: number,
  angle: number,
  axis: "x" | "y" | "z",
): THREE.Matrix4 {
  const m = new THREE.Matrix4(); // identity = no rotation
  if (angle !== 0) {
    const axisVec = new THREE.Vector3(axis === "x" ? 1 : 0, axis === "y" ? 1 : 0, axis === "z" ? 1 : 0);
    const rot = new THREE.Matrix4().makeRotationAxis(axisVec, THREE.MathUtils.degToRad(angle));
    const toPivot = new THREE.Matrix4().makeTranslation(-pivot[0], -pivot[1], -pivot[2]);
    const fromPivot = new THREE.Matrix4().makeTranslation(pivot[0], pivot[1], pivot[2]);
    m.multiply(fromPivot).multiply(rot).multiply(toPivot); // rotation about the pivot
  }
  // Translation applies after rotation, so the final matrix is T · R.
  return new THREE.Matrix4().makeTranslation(tx, ty, tz).multiply(m);
}

/** Material for a body's faces (base color, hover, or selected highlight). */
const makeBodyMaterial = (color: number) =>
  new THREE.MeshStandardMaterial({
    color, metalness: 0.1, roughness: 0.55, side: THREE.DoubleSide,
    polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1,
  });

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
const EDGE_SEL_COLOR = new THREE.Color(SELECT_COLOR);
const EDGE_HOV_COLOR = new THREE.Color(0x36d6c3);
// Small persistent dots drawn at every selectable/draggable vertex of the ACTIVE
// sketch, so the grabbable key points are discoverable. Colour matches the sketch
// line (recoloured live with its constrained state — see applyHighlights); the
// hover/selection marker is larger and translucent so this dot shows through it.
const sketchDotMaterial = new THREE.PointsMaterial({
  color: 0x4d8dff, size: 5, sizeAttenuation: false, depthTest: false, transparent: true, opacity: 0.95,
});
// Edge/vertex picking is done entirely in SCREEN space (pixels), at every stage,
// so it behaves identically at any zoom. The old design used a world-space ray
// threshold (EDGE_PICK_WORLD = 1.6 mm) for edge *detection*, which had two flaws:
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
/** On-screen width (px) of solid sketch lines — a touch heavier than the 1px
 *  default so entities read clearly and the constrained-state colour is easy to
 *  see. Drawn as fat lines (LineMaterial), since LineBasicMaterial ignores it. */
const SKETCH_LINE_WIDTH = 2.0;
const sketchBaseColor = (active: boolean, fullyConstrained: boolean): number =>
  active ? (fullyConstrained ? SKETCH_COLOR_FULL : SKETCH_COLOR_UNDER) : SKETCH_COLOR_IDLE;

const posKey = (x: number, y: number, z: number) =>
  `${Math.round(x * 1000)},${Math.round(y * 1000)},${Math.round(z * 1000)}`;

/**
 * Returns the [start, count] vertex ranges (into the edge geometry) of every
 * body edge that bounds the given face. An edge is a boundary of the face when
 * all of its tessellation vertices coincide (by rounded position) with the
 * face's triangle vertices. Exact for straight box edges; curved edges on
 * curved faces are a known limitation (face/edge tessellations differ).
 */
function faceBoundaryEdges(
  faceGeom: THREE.BufferGeometry,
  edgeGeom: THREE.BufferGeometry,
  faceId: number,
): [number, number][] {
  const fg = faceGeom.userData.faceGroups as { faceId: number }[] | undefined;
  const eg = edgeGeom.userData.edgeGroups as { start: number; count: number; edgeId: number }[] | undefined;
  if (!fg || !eg) return [];
  const groupIdx = fg.findIndex((g) => g.faceId === faceId);
  if (groupIdx < 0) return [];
  const grp = faceGeom.groups[groupIdx];
  if (!grp) return [];

  // Collect the rounded positions of every vertex used by this face's triangles.
  const faceVerts = new Set<string>();
  const fpos = faceGeom.getAttribute("position");
  const index = faceGeom.getIndex();
  for (let i = grp.start; i < grp.start + grp.count; i++) {
    const v = index ? index.getX(i) : i;
    faceVerts.add(posKey(fpos.getX(v), fpos.getY(v), fpos.getZ(v)));
  }

  const epos = edgeGeom.getAttribute("position");
  const ranges: [number, number][] = [];
  for (const e of eg) {
    let onFace = true;
    for (let v = e.start; v < e.start + e.count; v++) {
      if (!faceVerts.has(posKey(epos.getX(v), epos.getY(v), epos.getZ(v)))) {
        onFace = false;
        break;
      }
    }
    if (onFace) ranges.push([e.start, e.count]);
  }
  return ranges;
}
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

export function Viewport({
  meshes,
  ghostMeshes,
  selection,
  highlightBodyIds,
  booleanHighlight,
  onSelect,
  datumVisibility,
  userPlanes,
  transformEdit,
  transformMode,
  onTransformInput,
  onTransformPreview,
  picking,
  onPick,
  axisPick,
  onAxisPick,
  activeSketch,
  sketchTool,
  sketches,
  activeSketchId,
  sketchFullyConstrained,
  draft,
  polygonSides,
  onSketchClick,
  onSketchDragMove,
  onSketchDragEnd,
  selectionFilter,
  apiRef,
}: {
  meshes: FeatureMesh[];
  /** Live preview bodies to render translucently (empty = none). */
  ghostMeshes: GhostMesh[];
  selection: Selection[];
  /** Body ids whose whole body should highlight (modifier features resolve to
   *  the body they affect — see App). */
  highlightBodyIds: Set<string>;
  /** Boolean-dialog operand highlight (null when the dialog is closed): `orange`
   *  bodies render in the standard selection color, `cyan` bodies render as a
   *  translucent ghost. See SELECT_COLOR / GHOST_COLOR. */
  booleanHighlight: { orange: Set<string>; cyan: Set<string> } | null;
  onSelect: (picked: Selection | null) => void;
  datumVisibility: Record<DatumId, boolean>;
  /** User reference planes to render + make pickable (for sketch / plane base). */
  userPlanes: RenderPlane[];
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
  picking: boolean;
  onPick: (ref: SketchPlaneRef) => void;
  /** When true (during a revolve "Select axis" arming), a pick in `picking` mode
   *  is routed to `onAxisPick` instead of `onPick`, accepting a sketch line, a
   *  body face, or a datum/reference plane from one click stream. */
  axisPick: boolean;
  onAxisPick: (pick: RevolveAxisPick) => void;
  activeSketch: { datumId: SketchPlaneId | null } | null;
  sketchTool: SketchTool;
  sketches: RenderSketch[];
  activeSketchId: string | null;
  sketchFullyConstrained: boolean;
  draft: Vec2[];
  polygonSides: number;
  onSketchClick: (uv: Vec2, hv?: "horizontal" | "vertical", on?: { id: string; mid: boolean }) => void;
  /** Live drag of unconstrained sketch geometry: each frame reports the points
   *  being moved (by original uv → target uv); App re-solves so constraints stay
   *  satisfied while free DOF follow the cursor. */
  onSketchDragMove: (points: { from: Vec2; to: Vec2 }[]) => void;
  /** Drag released — App finalizes the move (drops the pre-drag snapshot). */
  onSketchDragEnd: () => void;
  selectionFilter: SelectionFilter;
  apiRef: { current: ViewportApi | null };
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const stateRef = useRef<SceneState | null>(null);

  const selectionRef = useRef(selection);
  selectionRef.current = selection;
  const highlightBodyIdsRef = useRef(highlightBodyIds);
  highlightBodyIdsRef.current = highlightBodyIds;
  const booleanHighlightRef = useRef(booleanHighlight);
  booleanHighlightRef.current = booleanHighlight;
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;
  const userPlanesRef = useRef(userPlanes);
  userPlanesRef.current = userPlanes;
  const transformEditRef = useRef(transformEdit);
  transformEditRef.current = transformEdit;
  const onTransformInputRef = useRef(onTransformInput);
  onTransformInputRef.current = onTransformInput;
  const onTransformPreviewRef = useRef(onTransformPreview);
  onTransformPreviewRef.current = onTransformPreview;
  const meshesRef = useRef(meshes);
  meshesRef.current = meshes;
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
  const draftRef = useRef(draft);
  draftRef.current = draft;
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
  // Undefined for body edges / other-sketch geometry (not constrainable here).
  const snapPointsRef = useRef<{ uv: Vec2; midpointOf?: string }[]>([]);
  const snapLinesRef = useRef<{ a: Vec2; b: Vec2; id?: string }[]>([]);

  const hoverPlaneRef = useRef<DatumId | null>(null);
  const hoverUserPlaneRef = useRef<string | null>(null);
  const hoverBodyRef = useRef<{ mesh: THREE.Mesh; prev: THREE.Material | THREE.Material[] } | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.domElement.style.display = "block";
    container.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x1b1d23);

    const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 10_000);
    camera.up.set(0, 0, 1);
    camera.position.set(110, -120, 90);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    // Middle mouse pans (like right); zoom stays on the scroll wheel. (Left =
    // rotate.) Middle/right will be differentiated later.
    controls.mouseButtons = {
      LEFT: THREE.MOUSE.ROTATE,
      MIDDLE: THREE.MOUSE.PAN,
      RIGHT: THREE.MOUSE.PAN,
    };
    controls.target.set(0, 0, 0);
    controls.update();

    scene.add(new THREE.AmbientLight(0xffffff, 0.65));
    const keyLight = new THREE.DirectionalLight(0xffffff, 1.6);
    keyLight.position.set(60, 100, 80);
    scene.add(keyLight);
    const fill = new THREE.DirectionalLight(0xffffff, 0.5);
    fill.position.set(-80, -40, -60);
    scene.add(fill);

    const grid = new THREE.GridHelper(240, 24, 0x3a3d48, 0x282b33);
    grid.rotation.x = Math.PI / 2;
    scene.add(grid);
    scene.add(new THREE.AxesHelper(45));

    const datums = createDatums(scene);

    const selectedMaterial = makeBodyMaterial(SELECT_COLOR);
    const hoverMaterial = makeBodyMaterial(0x36d6c3);
    const lineMaterial = new THREE.LineBasicMaterial({ color: 0x0d0f14 });
    // Shared sketch entity highlight materials (per-entity geometry groups flip
    // to these; index 0 is the per-sketch base material set in the render effect).

    // Fat-line overlay (real line width) for the highlighted body edge.
    const highlightMaterial = new LineMaterial({
      vertexColors: true,
      linewidth: 3,
      worldUnits: false,
      depthTest: false,
      transparent: true,
    });
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
      new THREE.PointsMaterial({ size: 11, sizeAttenuation: false, vertexColors: true, depthTest: false, transparent: true, opacity: 0.65 }),
    );
    pointMarkers.renderOrder = 13;
    pointMarkers.visible = false;
    pointMarkers.frustumCulled = false;
    scene.add(pointMarkers);

    const group = new THREE.Group();
    const sketchGroup = new THREE.Group();
    const planeGroup = new THREE.Group();
    const ghostGroup = new THREE.Group();
    scene.add(group, sketchGroup, planeGroup, ghostGroup);

    // Ghost-preview materials: a fixed accent colour (not the body's own
    // colour) so a preview always reads as "not committed yet," regardless of
    // what it's standing in for.
    const ghostMaterial = new THREE.MeshStandardMaterial({
      color: GHOST_COLOR, metalness: 0.1, roughness: 0.55, side: THREE.DoubleSide,
      transparent: true, opacity: 0.35, depthWrite: false,
    });
    const ghostLineMaterial = new THREE.LineBasicMaterial({
      color: GHOST_COLOR, transparent: true, opacity: 0.7,
    });

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
    softenGizmo(gizmoHelper); // mute the default pure-RGB arrows to fit the UI
    scene.add(gizmoHelper);
    // Suspend orbiting while a gizmo handle is being dragged.
    // The gizmo's current translate/rotate, read off the proxy relative to pivot.
    const proxyDelta = (te: TransformEdit): TransformDelta => {
      const p = gizmoProxy.position;
      const r = gizmoProxy.rotation;
      const rad = te.axis === "x" ? r.x : te.axis === "y" ? r.y : r.z;
      return {
        tx: p.x - te.pivot[0],
        ty: p.y - te.pivot[1],
        tz: p.z - te.pivot[2],
        angle: THREE.MathUtils.radToDeg(rad),
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
        const m0 = transformMatrix(te.pivot, te.tx, te.ty, te.tz, te.angle, te.axis);
        const objects = state.group.children.filter((c) => c.userData.featureId === te.bodyId);
        for (const o of objects) o.matrixAutoUpdate = false;
        state.liveDrag = { objects, m0Inverse: m0.clone().invert() };
      } else {
        // Drag end: commit the final values once — that is the only regenerate.
        const ld = state.liveDrag;
        state.liveDrag = null;
        if (!te) return;
        const d = proxyDelta(te);
        if (ld) {
          // Pin the dragged matrix across the stale rebuild that the commit
          // triggers, until the body's real (re-baked) geometry arrives. Keyed
          // by the body's current mesh ref, which changes only when regenerate
          // returns — so the pin releases exactly when the new geometry lands.
          const m1 = transformMatrix(te.pivot, d.tx, d.ty, d.tz, d.angle, te.axis);
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
      const d = proxyDelta(te);
      const ld = state.liveDrag;
      if (ld) {
        const m1 = transformMatrix(te.pivot, d.tx, d.ty, d.tz, d.angle, te.axis);
        const delta = m1.multiply(ld.m0Inverse); // current · committed⁻¹
        for (const o of ld.objects) {
          o.matrix.copy(delta);
          o.matrixWorldNeedsUpdate = true; // matrixAutoUpdate is off; force the world recompute
        }
      }
      onTransformPreviewRef.current(d);
    });

    const previewLine = new THREE.Line(
      new THREE.BufferGeometry(),
      new THREE.LineBasicMaterial({ color: 0x7da8ff }),
    );
    previewLine.frustumCulled = false;
    previewLine.visible = false;
    const snapMarker = new THREE.Mesh(
      new THREE.SphereGeometry(1.4, 16, 16),
      new THREE.MeshBasicMaterial({ color: 0xffe14a, depthTest: false }),
    );
    snapMarker.renderOrder = 12;
    snapMarker.visible = false;
    keepConstantPixelRadius(snapMarker, 1.4, SNAP_PIXEL_RADIUS);
    scene.add(previewLine, snapMarker);

    const state: SceneState = {
      renderer, scene, camera, controls, group,
      sketchDimActive: false, selectedMaterial, hoverMaterial, lineMaterial,
      highlightMaterial, highlightOverlay, highlightMaterialDash, highlightOverlayDash, pointMarkers,
      datums, sketchGroup, planeGroup, transformControls, gizmoProxy,
      liveDrag: null,
      pendingCommit: null,
      ghostGroup, ghostMaterial, ghostLineMaterial,
      previewLine, snapMarker, tween: null,
    };
    stateRef.current = state;
    applyDatumAppearance(state, null);

    // Apply selection (a SET) + hover highlighting. Faces use per-face material
    // index; edges/sketch entities use the fat-line overlay; vertices/points use
    // the point markers; sketches keep their per-sketch base colour.
    const applyHighlights = () => {
      const sels = selectionRef.current;
      const hov = hoverSelRef.current;
      const hovered = hov && !sels.some((s) => sameSelection(s, hov)) ? hov : null;
      const isSketchId = (id: string) =>
        sketchGroup.children.some((c) => c.userData.sketchId === id);

      // Faces
      for (const child of group.children) {
        if (!(child instanceof THREE.Mesh)) continue;
        const fid = child.userData.featureId as string;
        const geom = child.geometry;
        const fg = geom.userData.faceGroups as { faceId: number }[] | undefined;
        if (!fg) continue;
        const wholeSel = highlightBodyIdsRef.current.has(fid);
        const wholeHov = hovered?.kind === "feature" && hovered.id === fid;
        // Boolean-dialog operand highlight overrides normal selection: cyan
        // (ghost, index 3) wins over orange (selected, index 2).
        const bh = booleanHighlightRef.current;
        const wholeGhost = bh?.cyan.has(fid) ?? false;
        const wholeOrange = bh?.orange.has(fid) ?? false;
        let dirty = false;
        geom.groups.forEach((g: { materialIndex?: number }, i: number) => {
          const faceId = fg[i]?.faceId;
          const selF = wholeSel || sels.some((s) => s.kind === "face" && s.featureId === fid && s.faceId === faceId);
          const hovF = wholeHov || (hovered?.kind === "face" && hovered.featureId === fid && hovered.faceId === faceId);
          const idx = wholeGhost ? 3 : selF || wholeOrange ? 2 : hovF ? 1 : 0;
          if (g.materialIndex !== idx) { g.materialIndex = idx; dirty = true; }
        });
        if (dirty) (geom as THREE.BufferGeometry & { groupsNeedUpdate: boolean }).groupsNeedUpdate = true;
      }

      // Fat-line overlay: body edges + sketch entities + whole sketches.
      // Construction (reference) geometry routes to a dashed twin overlay.
      const overlayPos: number[] = [];
      const overlayCol: number[] = [];
      const overlayPosDash: number[] = [];
      const overlayColDash: number[] = [];
      const pushRange = (geom: THREE.BufferGeometry, start: number, count: number, c: THREE.Color, dashed = false) => {
        const pos = geom.getAttribute("position");
        const tp = dashed ? overlayPosDash : overlayPos;
        const tc = dashed ? overlayColDash : overlayCol;
        for (let v = start; v < start + count; v++) {
          tp.push(pos.getX(v), pos.getY(v), pos.getZ(v));
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
          const eg = child?.geometry.userData.edgeGroups as { start: number; count: number; edgeId: number }[] | undefined;
          const g = eg?.find((x) => x.edgeId === s.edgeId);
          if (child && g) pushRange(child.geometry, g.start, g.count, c);
        } else if (s.kind === "sketchEntity") {
          const child = sketchChild(s.sketchId);
          const eg = child?.geometry.userData.entityGroups as { start: number; count: number; entityId: string; construction?: boolean }[] | undefined;
          const g = eg?.find((x) => x.entityId === s.entityId);
          if (child && g) pushRange(child.geometry, g.start, g.count, c, !!g.construction);
        } else if (s.kind === "feature" && isSketchId(s.id)) {
          // While a sketch is being edited it's the selected feature (so the
          // params panel shows), but don't paint all its entities as selected —
          // inside the sketch, individual entity selection is what matters.
          if (s.id === activeSketchIdRef.current) return;
          const child = sketchChild(s.id);
          const eg = child?.geometry.userData.entityGroups as { start: number; count: number; entityId: string; construction?: boolean }[] | undefined;
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
            for (const [start, count] of faceBoundaryEdges(faceMesh.geometry, edgeMesh.geometry, s.faceId)) {
              pushRange(edgeMesh.geometry, start, count, c);
            }
          }
        } else if (s.kind === "sketchFace") {
          const fill = sketchGroup.children.find(
            (x) => x instanceof THREE.Mesh && x.userData.isRegion && x.userData.sketchId === s.sketchId && x.userData.regionId === s.regionId,
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
        if (s.kind === "vertex") return s.point;
        if (s.kind === "sketchPoint") {
          const child = sketchChild(s.sketchId);
          const frame = child?.userData.frame as PlaneFrameData | undefined;
          if (frame) return uvToWorld(frame, s.point[0], s.point[1]);
        }
        return null;
      };
      for (const s of sels) {
        const w = ptWorld(s);
        if (w) { ptPos.push(w[0], w[1], w[2]); ptCol.push(EDGE_SEL_COLOR.r, EDGE_SEL_COLOR.g, EDGE_SEL_COLOR.b); }
      }
      if (hovered) {
        const w = ptWorld(hovered);
        if (w) { ptPos.push(w[0], w[1], w[2]); ptCol.push(EDGE_HOV_COLOR.r, EDGE_HOV_COLOR.g, EDGE_HOV_COLOR.b); }
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
          mat.color.set(isSel ? 0xff9d3c : 0x36d6c3);
        }
      }
    };
    applyHighlightsRef.current = applyHighlights;

    const startTween = (to: THREE.Vector3, up: THREE.Vector3, target: THREE.Vector3) => {
      state.tween = { from: camera.position.clone(), to, up, start: performance.now() };
      controls.target.copy(target);
    };
    // --- Body-edge lookup (shared by the Project/Convert tool's id- and
    // name-based edge queries). Edge groups carry a build-local `edgeId` and a
    // persistent `name`; the LineSegments buffer is consecutive world-space pairs
    // [p0,p1, p1,p2, …] (no mesh transform). ---
    type EdgeGroup = { start: number; count: number; edgeId: number; name?: string };
    const bodyEdgeGroups = (featureId: string): EdgeGroup[] | undefined => {
      const child = group.children.find(
        (x): x is THREE.LineSegments =>
          x instanceof THREE.LineSegments && x.userData.isBodyEdges && x.userData.featureId === featureId,
      );
      return child?.geometry.userData.edgeGroups as EdgeGroup[] | undefined;
    };
    const edgePolyline = (
      featureId: string,
      match: (g: EdgeGroup) => boolean,
    ): [number, number, number][] | null => {
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
        const v = VIEWS[name];
        const to = new THREE.Vector3(...v.dir).normalize().multiplyScalar(VIEW_DISTANCE);
        startTween(to, new THREE.Vector3(...v.up), new THREE.Vector3(0, 0, 0));
      },
      lookAtFrame(frame) {
        const origin = new THREE.Vector3(...frame.origin);
        const normal = new THREE.Vector3(...frame.normal).normalize();
        startTween(origin.clone().add(normal.multiplyScalar(VIEW_DISTANCE)), new THREE.Vector3(...frame.vAxis), origin);
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
      capturePNG() {
        // Snap to the end of any in-flight view tween so the requested camera is
        // captured now, not mid-animation.
        if (state.tween) {
          camera.position.copy(state.tween.to);
          camera.up.copy(state.tween.up);
          state.tween = null;
        }
        controls.update();
        // Read back in the same tick as render — the WebGL drawing buffer isn't
        // preserved across the browser's compositing step.
        renderer.render(scene, camera);
        return renderer.domElement.toDataURL("image/png");
      },
    };

    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    let down: { x: number; y: number } | null = null;
    // An in-progress drag of unconstrained sketch geometry (Select tool, inside a
    // sketch). `origins` are the pre-drag uv of the points being moved; `single`
    // distinguishes a one-vertex drag (snap to cursor) from a body/region
    // translate (every point shifts by the same delta). `moved` gates the click
    // vs. drag decision so a tap still selects.
    let sketchDrag:
      | { startClient: { x: number; y: number }; grab: Vec2; origins: Vec2[]; single: boolean; moved: boolean }
      | null = null;

    const projectToPx = (world: THREE.Vector3) => {
      const v = world.clone().project(camera);
      const rect = renderer.domElement.getBoundingClientRect();
      return { x: (v.x * 0.5 + 0.5) * rect.width + rect.left, y: (-v.y * 0.5 + 0.5) * rect.height + rect.top };
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
      kind: "point" | "edge" | "h" | "v" | "free";
      hv?: "horizontal" | "vertical";
      /** What an active-sketch entity the snapped point should attach to: its
       *  midpoint (`mid: true`) or a point on its body (`mid: false`). */
      on?: { id: string; mid: boolean };
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
      // 1. nearest snap point (static candidates + the current draft points)
      let best: { uv: Vec2; midpointOf?: string } | null = null;
      let bestD = SNAP_PX;
      for (const c of snapPointsRef.current) {
        const d = distPx(c.uv);
        if (d < bestD) { bestD = d; best = c; }
      }
      for (const c of draftRef.current) {
        const d = distPx(c);
        if (d < bestD) { bestD = d; best = { uv: c }; }
      }
      if (best)
        return {
          uv: best.uv,
          kind: "point",
          hv: hvOf(best.uv),
          on: best.midpointOf ? { id: best.midpointOf, mid: true } : undefined,
        };
      // 2. nearest point on a coplanar edge
      let bestLine: Vec2 | null = null;
      let bestLineId: string | undefined;
      let bestLD = SNAP_PX;
      for (const seg of snapLinesRef.current) {
        const q = nearestOnSegment(raw, seg.a, seg.b);
        const d = distPx(q);
        if (d < bestLD) { bestLD = d; bestLine = q; bestLineId = seg.id; }
      }
      if (bestLine)
        return {
          uv: bestLine,
          kind: "edge",
          hv: hvOf(bestLine),
          on: bestLineId ? { id: bestLineId, mid: false } : undefined,
        };
      // 3. horizontal / vertical inference relative to the last placed point
      if (ref) {
        const ang = Math.atan2(raw[1] - ref[1], raw[0] - ref[0]);
        const dH = Math.min(Math.abs(ang), Math.abs(Math.abs(ang) - Math.PI));
        const dV = Math.abs(Math.abs(ang) - Math.PI / 2);
        if (dH < ANGLE_SNAP) return { uv: [raw[0], ref[1]], kind: "h", hv: "horizontal" };
        if (dV < ANGLE_SNAP) return { uv: [ref[0], raw[1]], kind: "v", hv: "vertical" };
      }
      return { uv: raw, kind: "free" };
    };

    const pick = (clientX: number, clientY: number) => {
      const rect = renderer.domElement.getBoundingClientRect();
      pointer.x = ((clientX - rect.left) / rect.width) * 2 - 1;
      pointer.y = -((clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(pointer, camera);
      const planeObjs = datums.filter((d) => d.kind === "plane").map((d) => d.object);
      const userPlaneObjs = planeGroup.children.filter((c): c is THREE.Mesh => c instanceof THREE.Mesh);
      const bodies = group.children.filter((c): c is THREE.Mesh => c instanceof THREE.Mesh);
      const hit = raycaster.intersectObjects([...planeObjs, ...userPlaneObjs, ...bodies], false)[0];
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
      const sketchSegs = sketchGroup.children.filter(
        (c): c is THREE.LineSegments => c instanceof THREE.LineSegments,
      );
      const regionMeshes = sketchGroup.children.filter(
        (c): c is THREE.Mesh => c instanceof THREE.Mesh && c.userData.isRegion === true,
      );
      // Faces/regions first (they don't use the Line threshold) to learn the
      // depth under the cursor, then size the edge/line raycast so its search
      // radius equals PICK_DETECT_PX *pixels* at that depth — making edge/vertex
      // detection zoom-independent (see the constants above).
      const faceHit = raycaster.intersectObjects(faceMeshes, false)[0];
      const regionHit = raycaster.intersectObjects(regionMeshes, false)[0];
      const depth = faceHit ? faceHit.distance : camera.position.distanceTo(controls.target);
      const worldPerPx = (2 * depth * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2)) / rect.height;
      raycaster.params.Line = { threshold: worldPerPx * PICK_DETECT_PX };
      const edgeHit = raycaster.intersectObjects(bodyEdges, false)[0];
      const sketchHit = raycaster.intersectObjects(sketchSegs, false)[0];

      // Selection filters: which body-geometry kinds the picker may return.
      // (Sketch picks below are unaffected — they belong to sketch editing.)
      const flt = selectionFilterRef.current;

      // Thin elements (body edges, sketch lines) take priority over a face when
      // the cursor is near them (in pixels) and they're not behind that face.
      const faceDist = faceHit ? faceHit.distance : Infinity;

      // Resolve the nearest body edge into its pixel gaps: edgePx = distance to
      // the edge polyline, vertexPx = distance to its nearer endpoint. Vertex and
      // edge are then *independent* pixel gates (vertex ≥ edge), so a click by an
      // endpoint reliably selects the vertex even when the edge body has already
      // fallen outside EDGE_PICK_PX.
      let edgeInfo:
        | { fid: string; edgeId: number | undefined; near: THREE.Vector3; edgePx: number; vertexPx: number }
        | null = null;
      if (edgeHit && edgeHit.index != null && edgeHit.distance <= faceDist + PICK_DEPTH_TOL) {
        const mesh = edgeHit.object as THREE.LineSegments;
        const pos = mesh.geometry.getAttribute("position");
        const a = new THREE.Vector3().fromBufferAttribute(pos, edgeHit.index);
        const bpt = new THREE.Vector3().fromBufferAttribute(pos, edgeHit.index + 1);
        const near = a.distanceTo(edgeHit.point) <= bpt.distanceTo(edgeHit.point) ? a : bpt;
        const ep = projectToPx(edgeHit.point);
        const np = projectToPx(near);
        edgeInfo = {
          fid: mesh.userData.featureId as string,
          edgeId: getEdgeId(edgeHit.index, mesh.geometry),
          near,
          edgePx: Math.hypot(ep.x - clientX, ep.y - clientY),
          vertexPx: Math.hypot(np.x - clientX, np.y - clientY),
        };
      }
      // Sketch line gated the same way (pixel gap to the line), so it doesn't
      // steal a wide band from the sketch region behind it.
      const sketchPx = sketchHit
        ? (() => { const p = projectToPx(sketchHit.point); return Math.hypot(p.x - clientX, p.y - clientY); })()
        : Infinity;
      const sketchOk = !!sketchHit && sketchHit.distance <= faceDist + PICK_DEPTH_TOL && sketchPx <= EDGE_PICK_PX;

      // Vertex is the highest-priority element (a point beats any edge/face/line).
      if (flt.vertex && edgeInfo && edgeInfo.vertexPx <= VERTEX_PICK_PX) {
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
          // Sketch point (endpoint / centre) takes priority over the entity.
          if (sketch && frame) {
            let best: Vec2 | null = null;
            let bestD = SNAP_PX;
            for (const uv of sketchPointCandidates(sketch)) {
              const w = uvToWorld(frame, uv[0], uv[1]);
              const px = projectToPx(new THREE.Vector3(w[0], w[1], w[2]));
              const d = Math.hypot(px.x - clientX, px.y - clientY);
              if (d < bestD) { bestD = d; best = uv; }
            }
            if (best) return { kind: "sketchPoint", sketchId: sid, point: best };
          }
          const eg = obj.geometry.userData.entityGroups as
            | { start: number; count: number; entityId: string }[]
            | undefined;
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
        if (d < bestD) { bestD = d; best = uv; }
      }
      if (best) return { origins: [best], grab, single: true };

      // Otherwise raycast the active sketch's lines + region fills.
      const rect = renderer.domElement.getBoundingClientRect();
      pointer.x = ((clientX - rect.left) / rect.width) * 2 - 1;
      pointer.y = -((clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(pointer, camera);
      // Screen-space line threshold (world units for PICK_DETECT_PX pixels at the
      // orbit-target depth) — the old world-space EDGE_PICK_WORLD was removed when
      // picking moved to screen space.
      const dragDepth = camera.position.distanceTo(controls.target);
      const dragWorldPerPx = (2 * dragDepth * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2)) / rect.height;
      raycaster.params.Line = { threshold: dragWorldPerPx * PICK_DETECT_PX };

      // 2. An entity body → translate all of its points.
      const seg = sketchGroup.children.find(
        (c): c is THREE.LineSegments => c instanceof THREE.LineSegments && c.userData.sketchId === sid,
      );
      if (seg) {
        const hit = raycaster.intersectObject(seg, false)[0];
        if (hit && hit.index != null) {
          const eg = seg.geometry.userData.entityGroups as
            | { start: number; count: number; entityId: string }[]
            | undefined;
          const g = eg?.find((x) => hit.index! >= x.start && hit.index! < x.start + x.count);
          const e = g && sketch.entities.find((x) => x.id === g.entityId);
          if (e) return { origins: entityDragPoints(e), grab, single: false };
        }
      }

      // 3. An enclosed region (polygon/face interior) → translate the whole loop.
      const regions = sketchGroup.children.filter(
        (c): c is THREE.Mesh =>
          c instanceof THREE.Mesh && c.userData.isRegion === true && c.userData.sketchId === sid,
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
              if (!seen.has(k)) { seen.add(k); origins.push(p); }
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
        applyUserPlaneAppearance(state, null);
      }
      renderer.domElement.style.cursor = "";
    };

    const onMove = (e: PointerEvent) => {
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
      // Selection (hover) is active when idle OR editing a sketch with the Select
      // tool. Drop a stale hover when neither applies.
      const selecting =
        !pickingRef.current &&
        (activeFrameRef.current === null || isPickTool(sketchToolRef.current));
      if (!selecting && hoverSelRef.current) {
        hoverSelRef.current = null;
        applyHighlights();
      }
      if (pickingRef.current) {
        const p = pick(e.clientX, e.clientY);
        clearHover();
        const prevHover = hoverSelRef.current;
        let nextHover: Selection | null = null;
        if (!p) {
          if (prevHover) { hoverSelRef.current = null; applyHighlights(); }
          return;
        }
        renderer.domElement.style.cursor = "pointer";
        if (p.kind === "datum") {
          hoverPlaneRef.current = p.id;
          applyDatumAppearance(state, p.id);
        } else if (p.kind === "userplane") {
          hoverUserPlaneRef.current = p.planeId;
          applyUserPlaneAppearance(state, p.planeId);
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
          return;
        }
        const { uv, kind } = snap(raw, e.clientX, e.clientY);
        const poly = previewPolyline(sketchToolRef.current, draftRef.current, uv, polygonSidesRef.current);
        if (poly && poly.length >= 2) {
          setPolyline(state.previewLine.geometry, poly.map((p) => uvToWorld(frame, p[0], p[1])));
          state.previewLine.visible = true;
        } else {
          state.previewLine.visible = false;
        }
        if (kind === "point" || kind === "edge") {
          const w = uvToWorld(frame, uv[0], uv[1]);
          state.snapMarker.position.set(w[0], w[1], w[2]);
          (state.snapMarker.material as THREE.MeshBasicMaterial).color.set(kind === "edge" ? 0x36d6c3 : 0xffe14a);
          state.snapMarker.visible = true;
        } else {
          state.snapMarker.visible = false;
        }
        return;
      }
      // Selection hover (idle, or sketch mode with the Select tool). Hide any
      // leftover draw preview when hovering inside a sketch.
      if (frame) {
        state.previewLine.visible = false;
        state.snapMarker.visible = false;
      }
      const sel = pickSelection(e.clientX, e.clientY);
      if (!sameSelection(sel, hoverSelRef.current)) {
        hoverSelRef.current = sel;
        renderer.domElement.style.cursor = sel ? "pointer" : "";
        applyHighlights();
      }
    };
    const onDown = (e: PointerEvent) => {
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
    const onUp = (e: PointerEvent) => {
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
        else onSelectRef.current(pickSelection(e.clientX, e.clientY));
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
          if (hoverSelRef.current) { hoverSelRef.current = null; applyHighlightsRef.current(); }
          if (sel?.kind === "sketchEntity") { onAxisPickRef.current({ kind: "line", sketchId: sel.sketchId, entityId: sel.entityId }); return; }
          if (sel?.kind === "face") { onAxisPickRef.current({ kind: "bodyFace", featureId: sel.featureId, faceId: sel.faceId }); return; }
          const pp = pick(e.clientX, e.clientY);
          if (!pp) return;
          if (pp.kind === "datum") { if (pp.id !== "origin") onAxisPickRef.current({ kind: "plane", ref: { kind: "datum", id: pp.id } }); }
          else if (pp.kind === "userplane") onAxisPickRef.current({ kind: "plane", ref: { kind: "plane", planeId: pp.planeId } });
          else {
            const featureId = (pp.mesh.userData.featureId as string) ?? "";
            const frame = deriveFaceFrame([pp.point.x, pp.point.y, pp.point.z], [pp.normal.x, pp.normal.y, pp.normal.z]);
            onAxisPickRef.current({ kind: "plane", ref: { kind: "face", featureId, frame } });
          }
          return;
        }
        const p = pick(e.clientX, e.clientY);
        clearHover();
        if (hoverSelRef.current) { hoverSelRef.current = null; applyHighlightsRef.current(); }
        if (!p) return;
        if (p.kind === "datum") {
          if (p.id !== "origin") onPickRef.current({ kind: "datum", id: p.id });
        } else if (p.kind === "userplane") {
          onPickRef.current({ kind: "plane", planeId: p.planeId });
        } else {
          const featureId = (p.mesh.userData.featureId as string) ?? "";
          const frame = deriveFaceFrame([p.point.x, p.point.y, p.point.z], [p.normal.x, p.normal.y, p.normal.z]);
          onPickRef.current({ kind: "face", featureId, frame });
        }
        return;
      }
      const frame = activeFrameRef.current;
      if (frame && !isPickTool(sketchToolRef.current)) {
        const raw = planeHitUv(e.clientX, e.clientY);
        if (!raw) return;
        const s = snap(raw, e.clientX, e.clientY);
        onSketchClickRef.current(s.uv, s.hv, s.on);
        return;
      }
      // Selection click (idle, or sketch + Select tool). App accumulates into a
      // set and toggles the element off if it is already selected.
      onSelectRef.current(pickSelection(e.clientX, e.clientY));
    };
    renderer.domElement.addEventListener("pointermove", onMove);
    renderer.domElement.addEventListener("pointerdown", onDown);
    renderer.domElement.addEventListener("pointerup", onUp);

    const resize = () => {
      const w = container.clientWidth;
      const h = container.clientHeight;
      if (w === 0 || h === 0) return;
      renderer.setSize(w, h);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      highlightMaterial.resolution.set(w, h); // fat-line width is in screen pixels
      highlightMaterialDash.resolution.set(w, h);
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
      renderer.render(scene, camera);
      frame = requestAnimationFrame(animate);
    };
    animate();

    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      renderer.domElement.removeEventListener("pointermove", onMove);
      renderer.domElement.removeEventListener("pointerdown", onDown);
      renderer.domElement.removeEventListener("pointerup", onUp);
      controls.dispose();
      transformControls.detach();
      transformControls.dispose();
      scene.remove(gizmoHelper, gizmoProxy);
      disposeGroup(group);
      disposeSketchGroup(sketchGroup);
      for (const c of planeGroup.children) {
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
      previewLine.geometry.dispose();
      snapMarker.geometry.dispose();
      pointMarkers.geometry.dispose();
      (pointMarkers.material as THREE.Material).dispose();
      selectedMaterial.dispose();
      hoverMaterial.dispose();
      lineMaterial.dispose();
      highlightMaterial.dispose();
      highlightOverlay.geometry.dispose();
      highlightMaterialDash.dispose();
      highlightOverlayDash.geometry.dispose();
      renderer.dispose();
      container.removeChild(renderer.domElement);
      apiRef.current = null;
      stateRef.current = null;
    };
  }, [apiRef]);

  // Rebuild the rendered bodies whenever the meshes or selection change.
  useEffect(() => {
    const state = stateRef.current;
    if (!state) return;
    hoverBodyRef.current = null;
    disposeGroup(state.group);
    for (const { id, mesh, color, opacity } of meshes) {
      const [geometry] = syncGeometries([{ name: id, faces: mesh.faces, edges: mesh.edges }], []);
      // Material array: index 0 = this body's own color, 1 = hover (shared),
      // 2 = selected. The selected material is per-body: the body's own colour
      // blended toward the highlight orange, so the original colour still shows
      // through instead of a flat orange. syncFaces sets a geometry group per
      // face, so per-face highlighting flips group.materialIndex.
      const baseMaterial = makeBodyMaterial(color);
      baseMaterial.transparent = state.sketchDimActive || opacity < 1;
      baseMaterial.opacity = state.sketchDimActive ? 0.16 : opacity;
      const selColor = new THREE.Color(color).lerp(EDGE_SEL_COLOR, 0.7);
      const selectedMaterial = makeBodyMaterial(selColor.getHex());
      const faceMesh = new THREE.Mesh(geometry.faces, [
        baseMaterial,
        state.hoverMaterial,
        selectedMaterial,
        state.ghostMaterial, // index 3 = boolean tool / intersect (translucent cyan)
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
  }, [meshes]);

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
      const [geometry] = syncGeometries(
        [{ name: `ghost${i}`, faces: ghost.mesh.faces, edges: ghost.mesh.edges }],
        [],
      );
      const faceMesh = new THREE.Mesh(geometry.faces, state.ghostMaterial);
      const edges = new THREE.LineSegments(geometry.lines, state.ghostLineMaterial);
      state.ghostGroup.add(faceMesh, edges);
    });
  }, [ghostMeshes]);

  // Re-apply highlighting when the external selection (or resolved body set)
  // changes.
  useEffect(() => {
    applyHighlightsRef.current();
  }, [selection, highlightBodyIds, booleanHighlight]);

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
        new THREE.MeshBasicMaterial({ color: rp.color, transparent: true, opacity: 0.1, side: THREE.DoubleSide, depthWrite: false }),
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
    if (!transformEdit) {
      tc.detach();
      tc.enabled = false;
      helper.visible = false;
      return;
    }
    tc.enabled = true;
    helper.visible = true;
    tc.setMode(transformMode);
    // Translate shows all three arrows; rotate shows only the chosen axis ring,
    // so the drag maps cleanly onto a single (axis, angle).
    tc.showX = transformMode === "translate" || transformEdit.axis === "x";
    tc.showY = transformMode === "translate" || transformEdit.axis === "y";
    tc.showZ = transformMode === "translate" || transformEdit.axis === "z";
    if (!tc.dragging) {
      const { pivot, tx, ty, tz, angle, axis } = transformEdit;
      proxy.position.set(pivot[0] + tx, pivot[1] + ty, pivot[2] + tz);
      const a = THREE.MathUtils.degToRad(angle);
      proxy.rotation.set(axis === "x" ? a : 0, axis === "y" ? a : 0, axis === "z" ? a : 0);
    }
    tc.attach(proxy);
  }, [transformEdit, transformMode]);

  // Load the sketch font once; bumping `fontTick` re-runs the sketch render so
  // any text entities (which render nothing until the font is ready) appear.
  const [fontTick, setFontTick] = useState(0);
  useEffect(() => {
    let live = true;
    void loadSketchFont().then(() => { if (live) setFontTick((t) => t + 1); });
    return () => { live = false; };
  }, []);

  // Render every sketch (so finished sketches stay visible); set the active
  // frame/entities used for drawing.
  useEffect(() => {
    const state = stateRef.current;
    if (!state) return;
    disposeSketchGroup(state.sketchGroup);
    for (const s of sketches) {
      const pts: number[] = [];
      const entityGroups: { start: number; count: number; entityId: string; construction: boolean; derived: boolean }[] = [];
      for (const e of s.entities) {
        const startVert = pts.length / 3;
        entitySegments(e, s.frame, pts);
        const count = pts.length / 3 - startVert;
        if (count > 0) entityGroups.push({ start: startVert, count, entityId: e.id, construction: !!e.construction, derived: !!e.derivedFrom });
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
      const constructionMat = new THREE.LineDashedMaterial({
        color: 0xe0a64f, dashSize: 1.4, gapSize: 0.9,
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

      // Fat display line: the solid (non-construction) entity segments rendered a
      // touch thicker via LineMaterial, coloured by the sketch's constrained
      // state. Construction geometry keeps its thin dashed look from `seg`.
      const solidPts = pts.filter((_, i) => {
        const vert = Math.floor(i / 3);
        const g = entityGroups.find((eg) => vert >= eg.start && vert < eg.start + eg.count);
        return g != null && !g.construction;
      });
      if (solidPts.length >= 6) {
        const fatGeom = new LineSegmentsGeometry();
        fatGeom.setPositions(solidPts);
        const fatMat = new LineMaterial({
          color: sketchBaseColor(s.id === activeSketchId, sketchFullyConstrainedRef.current),
          linewidth: SKETCH_LINE_WIDTH,
          worldUnits: false,
          // Nudge toward the camera so the fat line wins over the (coincident)
          // thin line without turning depth testing off — sketches behind a solid
          // body still read as occluded.
          polygonOffset: true,
          polygonOffsetFactor: -2,
          polygonOffsetUnits: -2,
        });
        const size = state.renderer.getSize(new THREE.Vector2());
        fatMat.resolution.set(size.x, size.y);
        const fat = new LineSegments2(fatGeom, fatMat);
        fat.frustumCulled = false;
        fat.renderOrder = 4;
        fat.userData.sketchId = s.id;
        fat.userData.isSketchDisplay = true;
        state.sketchGroup.add(fat);
      }

      // Small dots at the active sketch's selectable/draggable vertices, so those
      // key points are visible and grabbable. Rebuilt with the geometry each
      // render, so they follow a live vertex/entity drag (App re-solves → the
      // sketch re-renders → these move with it). Origin excluded (it has the
      // yellow datum dot).
      if (s.id === activeSketchId) {
        const verts = sketchPointCandidates(s).slice(1);
        if (verts.length > 0) {
          const dotPos = new Float32Array(verts.length * 3);
          verts.forEach((uv, i) => {
            const w = uvToWorld(s.frame, uv[0], uv[1]);
            dotPos[i * 3] = w[0]; dotPos[i * 3 + 1] = w[1]; dotPos[i * 3 + 2] = w[2];
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
          new THREE.MeshBasicMaterial({ color: 0x36d6c3, transparent: true, opacity: 0, side: THREE.DoubleSide, depthWrite: false }),
        );
        fill.userData.sketchId = s.id;
        fill.userData.regionId = region.id;
        fill.userData.isRegion = true;
        // Closed boundary loop in world space (line-segment pairs) for fat-line
        // highlighting when the sketch face is selected.
        const ow: number[] = [];
        const n = region.outline.length;
        for (let i = 0; i < n; i++) {
          const p = region.outline[i];
          const q = region.outline[(i + 1) % n];
          const wp = uvToWorld(s.frame, p[0], p[1]);
          const wq = uvToWorld(s.frame, q[0], q[1]);
          ow.push(wp[0], wp[1], wp[2], wq[0], wq[1], wq[2]);
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
      snapPointsRef.current = [];
      snapLinesRef.current = [];
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
    const points: { uv: Vec2; midpointOf?: string }[] = [{ uv: [0, 0] }];
    const lines: { a: Vec2; b: Vec2; id?: string }[] = [];
    // `id` is the active-sketch line entity this segment belongs to (so a drawn
    // endpoint landing on its body → point-on-line, on its midpoint → midpoint).
    const addSeg = (aw: THREE.Vector3, bw: THREE.Vector3, id?: string) => {
      const aOn = onPlane(aw);
      const bOn = onPlane(bw);
      if (aOn) points.push({ uv: toUv(aw) });
      if (bOn) points.push({ uv: toUv(bw) });
      if (aOn && bOn) {
        const a = toUv(aw);
        const b = toUv(bw);
        points.push({ uv: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], midpointOf: id }); // midpoint
        lines.push({ a, b, id });
      }
    };
    const addPoint = (uv: Vec2, midpointOf?: string) => {
      const w = new THREE.Vector3(...uvToWorld(active.frame, uv[0], uv[1]));
      if (onPlane(w)) points.push({ uv: toUv(w), midpointOf });
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
          );
        } else if (sameFrame && e.type === "circle") {
          addPoint(e.c); // centre (radius/quadrant snaps are a later refinement)
        } else if (sameFrame && e.type === "arc") {
          addPoint(e.c);
          addPoint([e.c[0] + e.r * Math.cos(e.start), e.c[1] + e.r * Math.sin(e.start)]);
          addPoint([e.c[0] + e.r * Math.cos(e.end), e.c[1] + e.r * Math.sin(e.end)]);
          // Mid-arc point (snapping here locks to the arc's midpoint).
          const m = (e.start + e.end) / 2;
          addPoint([e.c[0] + e.r * Math.cos(m), e.c[1] + e.r * Math.sin(m)], activeId ? e.id : undefined);
        }
      }
    }
    for (const [aw, bw] of collectBodyEdges(state.group)) addSeg(aw, bw);
    snapPointsRef.current = points;
    snapLinesRef.current = lines;
  }, [sketches, activeSketchId, meshes, sketchFullyConstrained, fontTick]);

  return <div ref={containerRef} style={{ width: "100%", height: "100%" }} />;
}

function setPolyline(geom: THREE.BufferGeometry, pts: [number, number, number][]) {
  const arr: number[] = [];
  for (const p of pts) arr.push(p[0], p[1], p[2]);
  geom.setAttribute("position", new THREE.Float32BufferAttribute(arr, 3));
  geom.computeBoundingSphere();
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
function sketchPointCandidates(sketch: RenderSketch): Vec2[] {
  // The sketch origin (0,0) is always selectable — so it can be picked as the
  // anchor for a coincident / point-on-line constraint even when no entity
  // vertex sits there.
  const out: Vec2[] = [[0, 0]];
  for (const e of sketch.entities) {
    if (e.type === "line") out.push(e.a, e.b);
    else if (e.type === "circle") out.push(e.c);
    else if (e.type === "arc") {
      out.push(e.c);
      out.push([e.c[0] + e.r * Math.cos(e.start), e.c[1] + e.r * Math.sin(e.start)]);
      out.push([e.c[0] + e.r * Math.cos(e.end), e.c[1] + e.r * Math.sin(e.end)]);
    } else if (e.type === "spline") out.push(...e.points);
    else if (e.type === "point") out.push(e.p);
  }
  return out;
}

/** The sketch points that translate when an entity is dragged by its body. Lines
 *  move both endpoints; circles/arcs move their centre (radius/angles ride along);
 *  splines move every control point; a point moves itself. Identifying them by uv
 *  means a vertex shared with another entity (a chained corner) moves on both. */
function entityDragPoints(e: SketchEntity): Vec2[] {
  switch (e.type) {
    case "line": return [e.a, e.b];
    case "circle": return [e.c];
    case "arc": return [e.c];
    case "spline": return e.points;
    case "point": return [e.p];
    case "text": return [e.p];
  }
}

/** Sketch vertices a user can grab to drag a single point (line endpoints, circle
 *  centres, arc centres, spline control points, points). Arc *endpoints* are
 *  omitted — they're derived from centre/radius/angles, so dragging them isn't a
 *  simple point move. */
function draggableVertices(sketch: RenderSketch): Vec2[] {
  return sketch.entities.flatMap(entityDragPoints);
}

/** Closest point on segment a-b to p, all in 2D (uv). */
function nearestOnSegment(p: Vec2, a: Vec2, b: Vec2): Vec2 {
  const abx = b[0] - a[0];
  const aby = b[1] - a[1];
  const len2 = abx * abx + aby * aby || 1;
  const t = ((p[0] - a[0]) * abx + (p[1] - a[1]) * aby) / len2;
  const tc = Math.max(0, Math.min(1, t));
  return [a[0] + abx * tc, a[1] + aby * tc];
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

/** Mute TransformControls' default pure-RGB arrows so the gizmo fits the muted
 *  UI. TransformControls restores each handle's cached base colour/opacity every
 *  frame, so we override that cache (`_color`/`_opacity`) too — not just the live
 *  material — or the softening would be reset on the next render. The invisible
 *  picker handles (already near-zero opacity) just get fainter; hover-highlight
 *  still brightens the active axis from this softened base. */
function softenGizmo(helper: THREE.Object3D): void {
  const neutral = new THREE.Color(0xc2cad8);
  helper.traverse((o) => {
    const mat = (o as THREE.Mesh).material;
    if (!mat) return;
    for (const raw of Array.isArray(mat) ? mat : [mat]) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const m = raw as any;
      if (!m.color) continue;
      m.transparent = true;
      m.color.lerp(neutral, 0.3);
      m.opacity = m.opacity * 0.82;
      m._color = m.color.clone();
      m._opacity = m.opacity;
    }
  });
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
function keepConstantPixelRadius(mesh: THREE.Mesh, geomRadius: number, pxRadius: number): void {
  const world = new THREE.Vector3();
  const size = new THREE.Vector2();
  mesh.onBeforeRender = (renderer, _scene, camera) => {
    const cam = camera as THREE.PerspectiveCamera;
    const dist = cam.position.distanceTo(mesh.getWorldPosition(world));
    const h = renderer.getDrawingBufferSize(size).y;
    const worldRadius = (dist * Math.tan((cam.fov * Math.PI) / 360) * 2 * pxRadius) / h;
    mesh.scale.setScalar(worldRadius / geomRadius);
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
    color: 0xffd24a, depthTest: false, transparent: true, opacity: 0.5,
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
      color: tint, transparent: true, opacity: 0.06, side: THREE.DoubleSide, depthWrite: false,
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

// Mirrors applyDatumAppearance for user-created reference planes, which live
// in state.planeGroup rather than state.datums.
function applyUserPlaneAppearance(state: SceneState, hovered: string | null): void {
  for (const c of state.planeGroup.children) {
    const hot = c.userData.planeId === hovered;
    if (c instanceof THREE.Mesh) {
      (c.material as THREE.MeshBasicMaterial).opacity = hot ? 0.3 : 0.1;
    } else if (c instanceof THREE.LineSegments) {
      (c.material as THREE.LineBasicMaterial).opacity = hot ? 0.9 : 0.5;
    }
  }
}

function disposeGroup(group: THREE.Group): void {
  for (const child of group.children) {
    if (child instanceof THREE.Mesh) {
      child.geometry.dispose();
      // material[0] (base colour) and [2] (per-body selected tint) are created
      // per-body in the rebuild effect; [1] (hover) is shared and disposed on
      // unmount instead.
      if (Array.isArray(child.material)) {
        child.material[0]?.dispose();
        child.material[2]?.dispose();
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
