import { useEffect, useRef } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { syncGeometries } from "replicad-threejs-helper";
import type { ShapeMeshPayload } from "../kernel/types";
import type { SketchEntity, Vec2 } from "../document/types";
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
}

export interface RenderSketch {
  id: string;
  frame: PlaneFrameData;
  entities: SketchEntity[];
}

export type DatumId = "origin" | SketchPlaneId;
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
  faceMaterial: THREE.MeshStandardMaterial;
  selectedMaterial: THREE.MeshStandardMaterial;
  hoverMaterial: THREE.MeshStandardMaterial;
  lineMaterial: THREE.LineBasicMaterial;
  datums: DatumEntry[];
  sketchGroup: THREE.Group;
  previewLine: THREE.Line;
  snapMarker: THREE.Mesh;
  tween: { from: THREE.Vector3; to: THREE.Vector3; up: THREE.Vector3; start: number } | null;
}

const VIEW_DISTANCE = 220;
const TWEEN_MS = 300;
const SNAP_PX = 12;
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
  selectedId,
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
  apiRef,
}: {
  meshes: FeatureMesh[];
  selectedId: string | null;
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
  apiRef: { current: ViewportApi | null };
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const stateRef = useRef<SceneState | null>(null);

  const pickingRef = useRef(picking);
  pickingRef.current = picking;
  const onPickRef = useRef(onPick);
  onPickRef.current = onPick;
  const sketchToolRef = useRef(sketchTool);
  sketchToolRef.current = sketchTool;
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const polygonSidesRef = useRef(polygonSides);
  polygonSidesRef.current = polygonSides;
  const sketchFullyConstrainedRef = useRef(sketchFullyConstrained);
  sketchFullyConstrainedRef.current = sketchFullyConstrained;
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

    const makeFaceMaterial = (color: number) =>
      new THREE.MeshStandardMaterial({
        color, metalness: 0.1, roughness: 0.55, side: THREE.DoubleSide,
        polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1,
      });
    const faceMaterial = makeFaceMaterial(0x4f8cff);
    const selectedMaterial = makeFaceMaterial(0xff9d3c);
    const hoverMaterial = makeFaceMaterial(0x36d6c3);
    const lineMaterial = new THREE.LineBasicMaterial({ color: 0x0d0f14 });

    const group = new THREE.Group();
    const sketchGroup = new THREE.Group();
    scene.add(group, sketchGroup);

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
      faceMaterial, selectedMaterial, hoverMaterial, lineMaterial,
      datums, sketchGroup, previewLine, snapMarker, tween: null,
    };
    stateRef.current = state;
    applyDatumAppearance(state, null);

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
    const snap = (raw: Vec2, clientX: number, clientY: number): { uv: Vec2; kind: "point" | "edge" | "h" | "v" | "free" } => {
      const frame = activeFrameRef.current!;
      const distPx = (c: Vec2) => {
        const w = uvToWorld(frame, c[0], c[1]);
        const px = projectToPx(new THREE.Vector3(w[0], w[1], w[2]));
        return Math.hypot(px.x - clientX, px.y - clientY);
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
      if (best) return { uv: best, kind: "point" };
      // 2. nearest point on a coplanar edge
      let bestLine: Vec2 | null = null;
      let bestLD = SNAP_PX;
      for (const [a, b] of snapLinesRef.current) {
        const q = nearestOnSegment(raw, a, b);
        const d = distPx(q);
        if (d < bestLD) { bestLD = d; bestLine = q; }
      }
      if (bestLine) return { uv: bestLine, kind: "edge" };
      // 3. horizontal / vertical inference relative to the last placed point
      const ref = draftRef.current[draftRef.current.length - 1];
      if (ref) {
        const ang = Math.atan2(raw[1] - ref[1], raw[0] - ref[0]);
        const dH = Math.min(Math.abs(ang), Math.abs(Math.abs(ang) - Math.PI));
        const dV = Math.abs(Math.abs(ang) - Math.PI / 2);
        if (dH < ANGLE_SNAP) return { uv: [raw[0], ref[1]], kind: "h" };
        if (dV < ANGLE_SNAP) return { uv: [ref[0], raw[1]], kind: "v" };
      }
      return { uv: raw, kind: "free" };
    };

    const pick = (clientX: number, clientY: number) => {
      const rect = renderer.domElement.getBoundingClientRect();
      pointer.x = ((clientX - rect.left) / rect.width) * 2 - 1;
      pointer.y = -((clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(pointer, camera);
      const planeObjs = datums.filter((d) => d.kind === "plane").map((d) => d.object);
      const bodies = group.children.filter((c): c is THREE.Mesh => c instanceof THREE.Mesh);
      const hit = raycaster.intersectObjects([...planeObjs, ...bodies], false)[0];
      if (!hit) return null;
      const datum = datums.find((d) => d.object === hit.object);
      if (datum) return { kind: "datum" as const, id: datum.id };
      const mesh = hit.object as THREE.Mesh;
      const normal = hit.face
        ? hit.face.normal.clone().transformDirection(mesh.matrixWorld)
        : new THREE.Vector3(0, 0, 1);
      return { kind: "face" as const, mesh, point: hit.point.clone(), normal };
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
      if (pickingRef.current) {
        const p = pick(e.clientX, e.clientY);
        clearHover();
        if (!p) return;
        renderer.domElement.style.cursor = "pointer";
        if (p.kind === "datum") {
          hoverPlaneRef.current = p.id;
          applyDatumAppearance(state, p.id);
        } else {
          hoverBodyRef.current = { mesh: p.mesh, prev: p.mesh.material };
          p.mesh.material = hoverMaterial;
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
        if (!p) return;
        if (p.kind === "datum") {
          if (p.id !== "origin") onPickRef.current({ kind: "datum", id: p.id });
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
        onSketchClickRef.current(s.uv, s.kind === "h" ? "horizontal" : s.kind === "v" ? "vertical" : undefined);
      }
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
      disposeGroup(group);
      disposeSketchGroup(sketchGroup);
      previewLine.geometry.dispose();
      snapMarker.geometry.dispose();
      faceMaterial.dispose();
      selectedMaterial.dispose();
      hoverMaterial.dispose();
      lineMaterial.dispose();
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
    for (const { id, mesh } of meshes) {
      const [geometry] = syncGeometries([{ name: id, faces: mesh.faces, edges: mesh.edges }], []);
      const material = id === selectedId ? state.selectedMaterial : state.faceMaterial;
      const faceMesh = new THREE.Mesh(geometry.faces, material);
      faceMesh.userData.featureId = id;
      state.group.add(faceMesh);
      state.group.add(new THREE.LineSegments(geometry.lines, state.lineMaterial));
    }
  }, [meshes, selectedId]);

  // Sketch mode: dim solids and hide the inactive datum planes.
  useEffect(() => {
    const state = stateRef.current;
    if (!state) return;
    const active = activeSketch !== null;
    state.faceMaterial.transparent = active;
    state.faceMaterial.opacity = active ? 0.16 : 1;
    state.faceMaterial.needsUpdate = true;
    for (const d of state.datums) {
      if (d.kind !== "plane") continue;
      const visible = !active || d.id === activeSketch?.datumId;
      d.object.visible = visible;
      if (d.outline) d.outline.visible = visible;
      if (active && d.id === activeSketch?.datumId) d.material.opacity = 0.1;
    }
    if (!active) applyDatumAppearance(state, null);
  }, [activeSketch]);

  // Render every sketch (so finished sketches stay visible); set the active
  // frame/entities used for drawing.
  useEffect(() => {
    const state = stateRef.current;
    if (!state) return;
    disposeSketchGroup(state.sketchGroup);
    for (const s of sketches) {
      const pts: number[] = [];
      for (const e of s.entities) entitySegments(e, s.frame, pts);
      if (pts.length === 0) continue;
      const geom = new THREE.BufferGeometry();
      geom.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));
      const mat = new THREE.LineBasicMaterial({
        // Fully-constrained active sketch turns green (Onshape-style).
        color: s.id === activeSketchId
          ? sketchFullyConstrainedRef.current
            ? 0x4ad07a
            : 0xeaf0ff
          : 0xaeb9e0,
      });
      const seg = new THREE.LineSegments(geom, mat);
      seg.frustumCulled = false;
      state.sketchGroup.add(seg);
    }
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
    if (child instanceof THREE.Mesh || child instanceof THREE.LineSegments) {
      child.geometry.dispose();
    }
  }
  group.clear();
}

function disposeSketchGroup(group: THREE.Group): void {
  for (const child of group.children) {
    if (child instanceof THREE.LineSegments) {
      child.geometry.dispose();
      (child.material as THREE.Material).dispose();
    }
  }
  group.clear();
}
