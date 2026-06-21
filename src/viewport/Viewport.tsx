import { useEffect, useRef } from "react";
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
} from "../document/sketchTools";

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
  | "arc-3p";
export type ViewName = "front" | "back" | "left" | "right" | "top" | "bottom" | "iso";

export interface ViewportApi {
  setView(name: ViewName): void;
  lookAtFrame(frame: PlaneFrameData): void;
  /** Project a world point to pixel coords relative to the canvas top-left. */
  worldToScreen(p: [number, number, number]): { x: number; y: number };
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
  previewLine: THREE.Line;
  snapMarker: THREE.Mesh;
  tween: { from: THREE.Vector3; to: THREE.Vector3; up: THREE.Vector3; start: number } | null;
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
const EDGE_SEL_COLOR = new THREE.Color(0xff9d3c);
const EDGE_HOV_COLOR = new THREE.Color(0x36d6c3);
const EDGE_PICK_WORLD = 1.6; // ray-distance threshold for grabbing an edge
const VERTEX_PICK_WORLD = 3; // proximity to an edge endpoint that grabs the vertex

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
  onSelect,
  datumVisibility,
  userPlanes,
  transformEdit,
  transformMode,
  onTransformInput,
  picking,
  onPick,
  activeSketch,
  sketchTool,
  sketches,
  activeSketchId,
  sketchFullyConstrained,
  draft,
  polygonSides,
  onSketchClick,
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
  onSelect: (picked: Selection | null) => void;
  datumVisibility: Record<DatumId, boolean>;
  /** User reference planes to render + make pickable (for sketch / plane base). */
  userPlanes: RenderPlane[];
  /** The active Transform gizmo (null = no gizmo shown). */
  transformEdit: TransformEdit | null;
  /** Which gizmo to show while editing a transform. */
  transformMode: TransformMode;
  /** Live numeric values emitted as the gizmo is dragged. */
  onTransformInput: (delta: TransformDelta) => void;
  picking: boolean;
  onPick: (ref: SketchPlaneRef) => void;
  activeSketch: { datumId: SketchPlaneId | null } | null;
  sketchTool: SketchTool;
  sketches: RenderSketch[];
  activeSketchId: string | null;
  sketchFullyConstrained: boolean;
  draft: Vec2[];
  polygonSides: number;
  onSketchClick: (uv: Vec2, hv?: "horizontal" | "vertical") => void;
  selectionFilter: SelectionFilter;
  apiRef: { current: ViewportApi | null };
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const stateRef = useRef<SceneState | null>(null);

  const selectionRef = useRef(selection);
  selectionRef.current = selection;
  const highlightBodyIdsRef = useRef(highlightBodyIds);
  highlightBodyIdsRef.current = highlightBodyIds;
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;
  const userPlanesRef = useRef(userPlanes);
  userPlanesRef.current = userPlanes;
  const transformEditRef = useRef(transformEdit);
  transformEditRef.current = transformEdit;
  const onTransformInputRef = useRef(onTransformInput);
  onTransformInputRef.current = onTransformInput;
  const hoverSelRef = useRef<Selection | null>(null);
  const applyHighlightsRef = useRef<() => void>(() => {});

  const pickingRef = useRef(picking);
  pickingRef.current = picking;
  const onPickRef = useRef(onPick);
  onPickRef.current = onPick;
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
  // derived from sketches + activeSketchId in the render effect
  const activeFrameRef = useRef<PlaneFrameData | null>(null);
  const activeEntitiesRef = useRef<SketchEntity[]>([]);
  // snap candidates on the active plane (in uv): points (origin, endpoints,
  // midpoints from any sketch or body edge) and lines (coplanar edges).
  const snapPointsRef = useRef<Vec2[]>([]);
  const snapLinesRef = useRef<[Vec2, Vec2][]>([]);

  const hoverPlaneRef = useRef<DatumId | null>(null);
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

    const selectedMaterial = makeBodyMaterial(0xff9d3c);
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

    const pointMarkers = new THREE.Points(
      new THREE.BufferGeometry(),
      new THREE.PointsMaterial({ size: 9, sizeAttenuation: false, vertexColors: true, depthTest: false }),
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
      color: 0x4fd1ff, metalness: 0.1, roughness: 0.55, side: THREE.DoubleSide,
      transparent: true, opacity: 0.35, depthWrite: false,
    });
    const ghostLineMaterial = new THREE.LineBasicMaterial({
      color: 0x4fd1ff, transparent: true, opacity: 0.7,
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
    transformControls.addEventListener("dragging-changed", (e) => {
      controls.enabled = !(e as unknown as { value: boolean }).value;
    });
    // On each drag, derive translate/rotate from the proxy and emit upward.
    transformControls.addEventListener("objectChange", () => {
      if (!transformControls.dragging) return;
      const te = transformEditRef.current;
      if (!te) return;
      const p = gizmoProxy.position;
      const r = gizmoProxy.rotation;
      const rad = te.axis === "x" ? r.x : te.axis === "y" ? r.y : r.z;
      onTransformInputRef.current({
        tx: p.x - te.pivot[0],
        ty: p.y - te.pivot[1],
        tz: p.z - te.pivot[2],
        angle: THREE.MathUtils.radToDeg(rad),
      });
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
    scene.add(previewLine, snapMarker);

    const state: SceneState = {
      renderer, scene, camera, controls, group,
      sketchDimActive: false, selectedMaterial, hoverMaterial, lineMaterial,
      highlightMaterial, highlightOverlay, pointMarkers,
      datums, sketchGroup, planeGroup, transformControls, gizmoProxy,
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
        let dirty = false;
        geom.groups.forEach((g: { materialIndex?: number }, i: number) => {
          const faceId = fg[i]?.faceId;
          const selF = wholeSel || sels.some((s) => s.kind === "face" && s.featureId === fid && s.faceId === faceId);
          const hovF = wholeHov || (hovered?.kind === "face" && hovered.featureId === fid && hovered.faceId === faceId);
          const idx = selF ? 2 : hovF ? 1 : 0;
          if (g.materialIndex !== idx) { g.materialIndex = idx; dirty = true; }
        });
        if (dirty) (geom as THREE.BufferGeometry & { groupsNeedUpdate: boolean }).groupsNeedUpdate = true;
      }

      // Fat-line overlay: body edges + sketch entities + whole sketches.
      const overlayPos: number[] = [];
      const overlayCol: number[] = [];
      const pushRange = (geom: THREE.BufferGeometry, start: number, count: number, c: THREE.Color) => {
        const pos = geom.getAttribute("position");
        for (let v = start; v < start + count; v++) {
          overlayPos.push(pos.getX(v), pos.getY(v), pos.getZ(v));
          overlayCol.push(c.r, c.g, c.b);
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
          const eg = child?.geometry.userData.entityGroups as { start: number; count: number; entityId: string }[] | undefined;
          const g = eg?.find((x) => x.entityId === s.entityId);
          if (child && g) pushRange(child.geometry, g.start, g.count, c);
        } else if (s.kind === "feature" && isSketchId(s.id)) {
          const child = sketchChild(s.id);
          if (child) pushRange(child.geometry, 0, child.geometry.getAttribute("position").count, c);
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
        if (child instanceof THREE.LineSegments) {
          const sid = child.userData.sketchId as string;
          const isActive = sid === activeSketchIdRef.current;
          // material[0] = solid base line; material[1] (if present) = the dashed
          // construction line, whose amber colour stays fixed.
          const base = (Array.isArray(child.material) ? child.material[0] : child.material) as THREE.LineBasicMaterial;
          base.color.set(
            isActive ? (sketchFullyConstrainedRef.current ? 0x4ad07a : 0xeaf0ff) : 0xaeb9e0,
          );
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
    };

    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    let down: { x: number; y: number } | null = null;

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
    ): { uv: Vec2; kind: "point" | "edge" | "h" | "v" | "free"; hv?: "horizontal" | "vertical" } => {
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
      let best: Vec2 | null = null;
      let bestD = SNAP_PX;
      for (const c of snapPointsRef.current) {
        const d = distPx(c);
        if (d < bestD) { bestD = d; best = c; }
      }
      for (const c of draftRef.current) {
        const d = distPx(c);
        if (d < bestD) { bestD = d; best = c; }
      }
      if (best) return { uv: best, kind: "point", hv: hvOf(best) };
      // 2. nearest point on a coplanar edge
      let bestLine: Vec2 | null = null;
      let bestLD = SNAP_PX;
      for (const [a, b] of snapLinesRef.current) {
        const q = nearestOnSegment(raw, a, b);
        const d = distPx(q);
        if (d < bestLD) { bestLD = d; bestLine = q; }
      }
      if (bestLine) return { uv: bestLine, kind: "edge", hv: hvOf(bestLine) };
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
      raycaster.params.Line = { threshold: EDGE_PICK_WORLD };

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
      const faceHit = raycaster.intersectObjects(faceMeshes, false)[0];
      const edgeHit = raycaster.intersectObjects(bodyEdges, false)[0];
      const sketchHit = raycaster.intersectObjects(sketchSegs, false)[0];
      const regionHit = raycaster.intersectObjects(regionMeshes, false)[0];

      // Selection filters: which body-geometry kinds the picker may return.
      // (Sketch picks below are unaffected — they belong to sketch editing.)
      const flt = selectionFilterRef.current;

      // Thin elements (body edges, sketch lines) take priority over a face when
      // the cursor is near them and they're not behind that face. Pick the nearer.
      const faceDist = faceHit ? faceHit.distance : Infinity;
      const edgeOk = !!edgeHit && edgeHit.index != null && edgeHit.distance <= faceDist + 1;
      const sketchOk = !!sketchHit && sketchHit.distance <= faceDist + 1;

      if ((flt.edge || flt.vertex) && edgeOk && (!sketchOk || edgeHit!.distance <= sketchHit!.distance)) {
        const mesh = edgeHit!.object as THREE.LineSegments;
        const fid = mesh.userData.featureId as string;
        const pos = mesh.geometry.getAttribute("position");
        const a = new THREE.Vector3().fromBufferAttribute(pos, edgeHit!.index!);
        const bpt = new THREE.Vector3().fromBufferAttribute(pos, edgeHit!.index! + 1);
        const near = a.distanceTo(edgeHit!.point) <= bpt.distanceTo(edgeHit!.point) ? a : bpt;
        if (flt.vertex && near.distanceTo(edgeHit!.point) < VERTEX_PICK_WORLD) {
          return { kind: "vertex", featureId: fid, point: [near.x, near.y, near.z] };
        }
        const edgeId = getEdgeId(edgeHit!.index!, mesh.geometry);
        if (flt.edge && edgeId !== undefined) return { kind: "edge", featureId: fid, edgeId };
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
      if (regionHit && regionHit.distance <= faceDist + 1) {
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
    const clearHover = () => {
      if (hoverBodyRef.current) {
        hoverBodyRef.current.mesh.material = hoverBodyRef.current.prev;
        hoverBodyRef.current = null;
      }
      if (hoverPlaneRef.current) {
        hoverPlaneRef.current = null;
        applyDatumAppearance(state, null);
      }
      renderer.domElement.style.cursor = "";
    };

    const onMove = (e: PointerEvent) => {
      // Selection (hover) is active when idle OR editing a sketch with the Select
      // tool. Drop a stale hover when neither applies.
      const selecting =
        !pickingRef.current &&
        (activeFrameRef.current === null || sketchToolRef.current === "select");
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
          // cursor already set to pointer; no extra hover material for now
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
      if (frame && sketchToolRef.current !== "select") {
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
    };
    const onUp = (e: PointerEvent) => {
      if (!down) return;
      const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
      down = null;
      if (moved > 5) return;
      if (pickingRef.current) {
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
      if (frame && sketchToolRef.current !== "select") {
        const raw = planeHitUv(e.clientX, e.clientY);
        if (!raw) return;
        const s = snap(raw, e.clientX, e.clientY);
        onSketchClickRef.current(s.uv, s.hv);
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
  }, [selection, highlightBodyIds]);

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

  // Render every sketch (so finished sketches stay visible); set the active
  // frame/entities used for drawing.
  useEffect(() => {
    const state = stateRef.current;
    if (!state) return;
    disposeSketchGroup(state.sketchGroup);
    for (const s of sketches) {
      const pts: number[] = [];
      const entityGroups: { start: number; count: number; entityId: string; construction: boolean }[] = [];
      for (const e of s.entities) {
        const startVert = pts.length / 3;
        entitySegments(e, s.frame, pts);
        const count = pts.length / 3 - startVert;
        if (count > 0) entityGroups.push({ start: startVert, count, entityId: e.id, construction: !!e.construction });
      }
      if (pts.length === 0) continue;
      const geom = new THREE.BufferGeometry();
      geom.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));
      // One geometry group per entity, so individual entities are highlightable.
      // Material index 1 = construction (dashed amber); 0 = normal solid line.
      for (const g of entityGroups) geom.addGroup(g.start, g.count, g.construction ? 1 : 0);
      geom.userData.entityGroups = entityGroups;
      // Index 0 = per-sketch base colour (active=white/green, else grey).
      const baseMat = new THREE.LineBasicMaterial({
        color: s.id === activeSketchId
          ? sketchFullyConstrainedRef.current
            ? 0x4ad07a
            : 0xeaf0ff
          : 0xaeb9e0,
      });
      const constructionMat = new THREE.LineDashedMaterial({
        color: 0xe0a64f, dashSize: 1.4, gapSize: 0.9,
      });
      const seg = new THREE.LineSegments(geom, [baseMat, constructionMat]);
      seg.computeLineDistances(); // needed by the dashed construction material
      seg.frustumCulled = false;
      seg.userData.sketchId = s.id;
      seg.userData.frame = s.frame;
      state.sketchGroup.add(seg);

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
    const points: Vec2[] = [[0, 0]];
    const lines: [Vec2, Vec2][] = [];
    const addSeg = (aw: THREE.Vector3, bw: THREE.Vector3) => {
      const aOn = onPlane(aw);
      const bOn = onPlane(bw);
      if (aOn) points.push(toUv(aw));
      if (bOn) points.push(toUv(bw));
      if (aOn && bOn) {
        const a = toUv(aw);
        const b = toUv(bw);
        points.push([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]); // midpoint
        lines.push([a, b]);
      }
    };
    const addPoint = (uv: Vec2) => {
      const w = new THREE.Vector3(...uvToWorld(active.frame, uv[0], uv[1]));
      if (onPlane(w)) points.push(toUv(w));
    };
    for (const s of sketches) {
      const sameFrame = s.frame === active.frame;
      for (const e of s.entities) {
        if (e.type === "line") {
          addSeg(
            new THREE.Vector3(...uvToWorld(s.frame, e.a[0], e.a[1])),
            new THREE.Vector3(...uvToWorld(s.frame, e.b[0], e.b[1])),
          );
        } else if (sameFrame && e.type === "circle") {
          addPoint(e.c); // centre (radius/quadrant snaps are a later refinement)
        } else if (sameFrame && e.type === "arc") {
          addPoint(e.c);
          addPoint([e.c[0] + e.r * Math.cos(e.start), e.c[1] + e.r * Math.sin(e.start)]);
          addPoint([e.c[0] + e.r * Math.cos(e.end), e.c[1] + e.r * Math.sin(e.end)]);
        }
      }
    }
    for (const [aw, bw] of collectBodyEdges(state.group)) addSeg(aw, bw);
    snapPointsRef.current = points;
    snapLinesRef.current = lines;
  }, [sketches, activeSketchId, meshes, sketchFullyConstrained]);

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
    default:
      return null;
  }
}

/** Selectable points of a sketch: line endpoints, circle centres, arc ends. */
function sketchPointCandidates(sketch: RenderSketch): Vec2[] {
  const out: Vec2[] = [];
  for (const e of sketch.entities) {
    if (e.type === "line") out.push(e.a, e.b);
    else if (e.type === "circle") out.push(e.c);
    else if (e.type === "arc") {
      out.push(e.c);
      out.push([e.c[0] + e.r * Math.cos(e.start), e.c[1] + e.r * Math.sin(e.start)]);
      out.push([e.c[0] + e.r * Math.cos(e.end), e.c[1] + e.r * Math.sin(e.end)]);
    } else if (e.type === "point") out.push(e.p);
  }
  return out;
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
    if (child instanceof THREE.LineSegments || (child instanceof THREE.Mesh && child.userData.isRegion)) {
      child.geometry.dispose();
      const m = child.material as THREE.Material | THREE.Material[];
      if (Array.isArray(m)) m.forEach((x) => x.dispose());
      else m.dispose();
    }
  }
  group.clear();
}
