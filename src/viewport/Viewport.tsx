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

export interface FeatureMesh {
  id: string;
  mesh: ShapeMeshPayload;
}

export type DatumId = "origin" | SketchPlaneId;
export type SketchTool = "select" | "line";
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
  sketchLines: THREE.LineSegments;
  previewLine: THREE.Line;
  snapMarker: THREE.Mesh;
  tween: { from: THREE.Vector3; to: THREE.Vector3; up: THREE.Vector3; t: number } | null;
}

const VIEW_DISTANCE = 220;
const GRID_SNAP = 5;
const SNAP_PX = 12;

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
  sketchFrame,
  sketchEntities,
  lineStart,
  onSketchClick,
  apiRef,
}: {
  meshes: FeatureMesh[];
  selectedId: string | null;
  picking: boolean;
  onPick: (ref: SketchPlaneRef) => void;
  activeSketch: { datumId: SketchPlaneId | null } | null;
  sketchTool: SketchTool;
  sketchFrame: PlaneFrameData | null;
  sketchEntities: SketchEntity[];
  lineStart: Vec2 | null;
  onSketchClick: (uv: Vec2) => void;
  apiRef: { current: ViewportApi | null };
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const stateRef = useRef<SceneState | null>(null);

  // live values for the once-bound pointer handlers
  const pickingRef = useRef(picking);
  pickingRef.current = picking;
  const onPickRef = useRef(onPick);
  onPickRef.current = onPick;
  const sketchFrameRef = useRef(sketchFrame);
  sketchFrameRef.current = sketchFrame;
  const sketchToolRef = useRef(sketchTool);
  sketchToolRef.current = sketchTool;
  const sketchEntitiesRef = useRef(sketchEntities);
  sketchEntitiesRef.current = sketchEntities;
  const lineStartRef = useRef(lineStart);
  lineStartRef.current = lineStart;
  const onSketchClickRef = useRef(onSketchClick);
  onSketchClickRef.current = onSketchClick;

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
    scene.add(group);

    // Sketch overlay objects (committed entities, rubber-band preview, snap dot).
    const sketchLines = new THREE.LineSegments(
      new THREE.BufferGeometry(),
      new THREE.LineBasicMaterial({ color: 0xeaf0ff }),
    );
    sketchLines.frustumCulled = false;
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
    scene.add(sketchLines, previewLine, snapMarker);

    const state: SceneState = {
      renderer, scene, camera, controls, group,
      faceMaterial, selectedMaterial, hoverMaterial, lineMaterial,
      datums, sketchLines, previewLine, snapMarker, tween: null,
    };
    stateRef.current = state;
    applyDatumAppearance(state, null);

    apiRef.current = {
      setView(name) {
        const v = VIEWS[name];
        const to = new THREE.Vector3(...v.dir).normalize().multiplyScalar(VIEW_DISTANCE);
        state.tween = { from: camera.position.clone(), to, up: new THREE.Vector3(...v.up), t: 0 };
        controls.target.set(0, 0, 0);
      },
      lookAtFrame(frame) {
        const origin = new THREE.Vector3(...frame.origin);
        const normal = new THREE.Vector3(...frame.normal).normalize();
        const to = origin.clone().add(normal.multiplyScalar(VIEW_DISTANCE));
        state.tween = { from: camera.position.clone(), to, up: new THREE.Vector3(...frame.vAxis), t: 0 };
        controls.target.copy(origin);
      },
    };

    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    let down: { x: number; y: number } | null = null;

    // --- helpers ---
    const projectToPx = (world: THREE.Vector3) => {
      const v = world.clone().project(camera);
      const rect = renderer.domElement.getBoundingClientRect();
      return { x: (v.x * 0.5 + 0.5) * rect.width + rect.left, y: (-v.y * 0.5 + 0.5) * rect.height + rect.top };
    };
    const planeHitUv = (clientX: number, clientY: number): Vec2 | null => {
      const frame = sketchFrameRef.current;
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
    const snap = (raw: Vec2, clientX: number, clientY: number): { uv: Vec2; isPoint: boolean } => {
      const frame = sketchFrameRef.current!;
      const cands: Vec2[] = [[0, 0]];
      for (const e of sketchEntitiesRef.current) {
        if (e.type === "line") cands.push(e.a, e.b);
        else if (e.type === "point") cands.push(e.p);
        else if (e.type === "circle" || e.type === "arc") cands.push(e.c);
      }
      if (lineStartRef.current) cands.push(lineStartRef.current);
      let best: Vec2 | null = null;
      let bestD = SNAP_PX;
      for (const c of cands) {
        const w = uvToWorld(frame, c[0], c[1]);
        const px = projectToPx(new THREE.Vector3(w[0], w[1], w[2]));
        const dist = Math.hypot(px.x - clientX, px.y - clientY);
        if (dist < bestD) { bestD = dist; best = c; }
      }
      if (best) return { uv: best, isPoint: true };
      return {
        uv: [Math.round(raw[0] / GRID_SNAP) * GRID_SNAP, Math.round(raw[1] / GRID_SNAP) * GRID_SNAP],
        isPoint: false,
      };
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
      const frame = sketchFrameRef.current;
      if (frame && sketchToolRef.current === "line") {
        const raw = planeHitUv(e.clientX, e.clientY);
        if (!raw) {
          state.previewLine.visible = false;
          state.snapMarker.visible = false;
          return;
        }
        const { uv, isPoint } = snap(raw, e.clientX, e.clientY);
        const ls = lineStartRef.current;
        if (ls) {
          setSegment(state.previewLine.geometry, uvToWorld(frame, ls[0], ls[1]), uvToWorld(frame, uv[0], uv[1]));
          state.previewLine.visible = true;
        } else {
          state.previewLine.visible = false;
        }
        const w = uvToWorld(frame, uv[0], uv[1]);
        state.snapMarker.position.set(w[0], w[1], w[2]);
        state.snapMarker.visible = true;
        (state.snapMarker.material as THREE.MeshBasicMaterial).color.set(isPoint ? 0xffe14a : 0x6fd0ff);
      }
    };
    const onDown = (e: PointerEvent) => {
      down = { x: e.clientX, y: e.clientY };
    };
    const onUp = (e: PointerEvent) => {
      if (!down) return;
      const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
      down = null;
      if (moved > 5) return; // a drag (orbit/pan), not a click
      if (pickingRef.current) {
        const p = pick(e.clientX, e.clientY);
        clearHover();
        if (!p) return;
        if (p.kind === "datum") {
          if (p.id !== "origin") onPickRef.current({ kind: "datum", id: p.id });
        } else {
          const featureId = (p.mesh.userData.featureId as string) ?? "";
          const frame = deriveFaceFrame(
            [p.point.x, p.point.y, p.point.z],
            [p.normal.x, p.normal.y, p.normal.z],
          );
          onPickRef.current({ kind: "face", featureId, frame });
        }
        return;
      }
      const frame = sketchFrameRef.current;
      if (frame && sketchToolRef.current === "line") {
        const raw = planeHitUv(e.clientX, e.clientY);
        if (!raw) return;
        onSketchClickRef.current(snap(raw, e.clientX, e.clientY).uv);
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
        tw.t = Math.min(1, tw.t + 0.12);
        const e = 1 - Math.pow(1 - tw.t, 3);
        camera.position.lerpVectors(tw.from, tw.to, e);
        camera.up.copy(tw.up);
        if (tw.t >= 1) state.tween = null;
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
      sketchLines.geometry.dispose();
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

  // Render committed sketch entities; hide the overlay when not sketching.
  useEffect(() => {
    const state = stateRef.current;
    if (!state) return;
    const visible = sketchFrame !== null;
    state.sketchLines.visible = visible;
    if (!visible) {
      state.previewLine.visible = false;
      state.snapMarker.visible = false;
      return;
    }
    const pts: number[] = [];
    for (const e of sketchEntities) {
      if (e.type === "line") {
        const a = uvToWorld(sketchFrame, e.a[0], e.a[1]);
        const b = uvToWorld(sketchFrame, e.b[0], e.b[1]);
        pts.push(a[0], a[1], a[2], b[0], b[1], b[2]);
      }
    }
    state.sketchLines.geometry.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));
    state.sketchLines.geometry.computeBoundingSphere();
  }, [sketchEntities, sketchFrame]);

  return <div ref={containerRef} style={{ width: "100%", height: "100%" }} />;
}

function setSegment(geom: THREE.BufferGeometry, a: [number, number, number], b: [number, number, number]) {
  geom.setAttribute("position", new THREE.Float32BufferAttribute([...a, ...b], 3));
  geom.computeBoundingSphere();
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
