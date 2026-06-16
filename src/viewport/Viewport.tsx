import { useEffect, useRef } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { syncGeometries } from "replicad-threejs-helper";
import type { ShapeMeshPayload } from "../kernel/types";

export interface FeatureMesh {
  id: string;
  mesh: ShapeMeshPayload;
}

export type DatumId = "origin" | "plane-top" | "plane-front" | "plane-right";

export type ViewName =
  | "front"
  | "back"
  | "left"
  | "right"
  | "top"
  | "bottom"
  | "iso";

export interface ViewportApi {
  setView(name: ViewName): void;
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
  lineMaterial: THREE.LineBasicMaterial;
  datums: DatumEntry[];
  tween: { from: THREE.Vector3; to: THREE.Vector3; up: THREE.Vector3; t: number } | null;
}

const VIEW_DISTANCE = 220;

// Camera direction (from target toward camera) and up-vector per named view, in
// the Z-up CAD world.
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
  selectedDatum,
  onSelectDatum,
  apiRef,
}: {
  meshes: FeatureMesh[];
  selectedId: string | null;
  selectedDatum: DatumId | null;
  onSelectDatum: (datum: DatumId | null) => void;
  apiRef: { current: ViewportApi | null };
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const stateRef = useRef<SceneState | null>(null);
  const hoveredRef = useRef<DatumId | null>(null);
  const selectedDatumRef = useRef<DatumId | null>(selectedDatum);
  const onSelectDatumRef = useRef(onSelectDatum);
  onSelectDatumRef.current = onSelectDatum;

  // One-time scene setup.
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
    const key = new THREE.DirectionalLight(0xffffff, 1.6);
    key.position.set(60, 100, 80);
    scene.add(key);
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
        color,
        metalness: 0.1,
        roughness: 0.55,
        side: THREE.DoubleSide,
        polygonOffset: true,
        polygonOffsetFactor: 1,
        polygonOffsetUnits: 1,
      });
    const faceMaterial = makeFaceMaterial(0x4f8cff);
    const selectedMaterial = makeFaceMaterial(0xff9d3c);
    const lineMaterial = new THREE.LineBasicMaterial({ color: 0x0d0f14 });

    const group = new THREE.Group();
    scene.add(group);

    const state: SceneState = {
      renderer,
      scene,
      camera,
      controls,
      group,
      faceMaterial,
      selectedMaterial,
      lineMaterial,
      datums,
      tween: null,
    };
    stateRef.current = state;
    applyDatumAppearance(state, hoveredRef.current, selectedDatumRef.current);

    // Expose imperative view navigation.
    apiRef.current = {
      setView(name) {
        const v = VIEWS[name];
        const to = new THREE.Vector3(...v.dir).normalize().multiplyScalar(VIEW_DISTANCE);
        state.tween = {
          from: camera.position.clone(),
          to,
          up: new THREE.Vector3(...v.up),
          t: 0,
        };
        controls.target.set(0, 0, 0);
      },
    };

    // --- Picking (hover + click) for datums ---
    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    const datumObjects = datums.map((d) => d.object);
    let down: { x: number; y: number } | null = null;

    const pick = (clientX: number, clientY: number): DatumId | null => {
      const rect = renderer.domElement.getBoundingClientRect();
      pointer.x = ((clientX - rect.left) / rect.width) * 2 - 1;
      pointer.y = -((clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(pointer, camera);
      const hit = raycaster.intersectObjects(datumObjects, false)[0];
      if (!hit) return null;
      return datums.find((d) => d.object === hit.object)?.id ?? null;
    };

    const onMove = (e: PointerEvent) => {
      const id = pick(e.clientX, e.clientY);
      if (id !== hoveredRef.current) {
        hoveredRef.current = id;
        renderer.domElement.style.cursor = id ? "pointer" : "";
        applyDatumAppearance(state, hoveredRef.current, selectedDatumRef.current);
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
      onSelectDatumRef.current(pick(e.clientX, e.clientY));
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
        const e = 1 - Math.pow(1 - tw.t, 3); // easeOutCubic
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
      faceMaterial.dispose();
      selectedMaterial.dispose();
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
    disposeGroup(state.group);
    for (const { id, mesh } of meshes) {
      const [geometry] = syncGeometries(
        [{ name: id, faces: mesh.faces, edges: mesh.edges }],
        [],
      );
      const material = id === selectedId ? state.selectedMaterial : state.faceMaterial;
      state.group.add(new THREE.Mesh(geometry.faces, material));
      state.group.add(new THREE.LineSegments(geometry.lines, state.lineMaterial));
    }
  }, [meshes, selectedId]);

  // Reflect datum selection coming from outside (e.g. cleared on Escape).
  useEffect(() => {
    selectedDatumRef.current = selectedDatum;
    const state = stateRef.current;
    if (state) applyDatumAppearance(state, hoveredRef.current, selectedDatum);
  }, [selectedDatum]);

  return <div ref={containerRef} style={{ width: "100%", height: "100%" }} />;
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

  // Clickable origin point — drawn on top so it is always visible.
  const originMat = new THREE.MeshBasicMaterial({
    color: 0xffd24a,
    depthTest: false,
    transparent: true,
    opacity: 0.5,
  });
  const origin = new THREE.Mesh(new THREE.SphereGeometry(1.0, 20, 20), originMat);
  origin.renderOrder = 10;
  scene.add(origin);
  entries.push({ id: "origin", object: origin, kind: "point", material: originMat, baseOpacity: 0.5 });

  const planeGeo = new THREE.PlaneGeometry(PLANE_SIZE, PLANE_SIZE);
  const edgeGeo = new THREE.EdgesGeometry(planeGeo);

  const planes: { id: keyof typeof PLANE_TINTS; rot: [number, number, number] }[] = [
    { id: "plane-top", rot: [0, 0, 0] }, // XY
    { id: "plane-front", rot: [Math.PI / 2, 0, 0] }, // XZ
    { id: "plane-right", rot: [0, Math.PI / 2, 0] }, // YZ
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
    scene.add(mesh);
    scene.add(outline);
    entries.push({ id, object: mesh, kind: "plane", material: mat, outline, baseOpacity: 0.06 });
  }

  return entries;
}

function applyDatumAppearance(
  state: SceneState,
  hovered: DatumId | null,
  selected: DatumId | null,
): void {
  for (const d of state.datums) {
    const active = d.id === selected;
    const hot = d.id === hovered;
    if (d.kind === "plane") {
      d.material.opacity = active ? 0.28 : hot ? 0.16 : d.baseOpacity;
      if (d.outline) {
        (d.outline.material as THREE.LineBasicMaterial).opacity = active ? 1 : hot ? 0.7 : 0.35;
      }
    } else {
      const scale = active ? 1.6 : hot ? 1.35 : 1;
      d.object.scale.setScalar(scale);
      d.material.opacity = active ? 0.95 : hot ? 0.8 : d.baseOpacity;
      (d.material as THREE.MeshBasicMaterial).color.set(active || hot ? 0xffffff : 0xffd24a);
    }
  }
}

/** Remove and dispose every child geometry of a group (materials are shared). */
function disposeGroup(group: THREE.Group): void {
  for (const child of group.children) {
    if (child instanceof THREE.Mesh || child instanceof THREE.LineSegments) {
      child.geometry.dispose();
    }
  }
  group.clear();
}
