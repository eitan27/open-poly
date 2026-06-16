import { useEffect, useRef } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { syncGeometries } from "replicad-threejs-helper";
import type { ShapeMeshPayload } from "../kernel/types";

interface SceneState {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
  faceMesh: THREE.Mesh;
  lineSegments: THREE.LineSegments;
}

export function Viewport({ mesh }: { mesh: ShapeMeshPayload | null }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const stateRef = useRef<SceneState | null>(null);

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

    // CAD convention: Z is up (matches replicad/OCCT), so the camera's up axis
    // and the ground grid live in the XY plane — not three.js's default Y-up.
    const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 10_000);
    camera.up.set(0, 0, 1);
    camera.position.set(110, -120, 90);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    // Frame the origin (centre of the coordinate system) by default.
    controls.target.set(0, 0, 0);
    controls.update();

    scene.add(new THREE.AmbientLight(0xffffff, 0.65));
    const key = new THREE.DirectionalLight(0xffffff, 1.6);
    key.position.set(60, 100, 80);
    scene.add(key);
    const fill = new THREE.DirectionalLight(0xffffff, 0.5);
    fill.position.set(-80, -40, -60);
    scene.add(fill);

    // GridHelper lies in the XZ plane by default; rotate it onto XY (the ground
    // plane in a Z-up world).
    const grid = new THREE.GridHelper(240, 24, 0x3a3d48, 0x282b33);
    grid.rotation.x = Math.PI / 2;
    scene.add(grid);
    scene.add(new THREE.AxesHelper(45));

    const faceMaterial = new THREE.MeshStandardMaterial({
      color: 0x4f8cff,
      metalness: 0.1,
      roughness: 0.55,
      side: THREE.DoubleSide,
      // Push faces back slightly so edge lines render cleanly on top.
      polygonOffset: true,
      polygonOffsetFactor: 1,
      polygonOffsetUnits: 1,
    });
    const faceMesh = new THREE.Mesh(new THREE.BufferGeometry(), faceMaterial);
    scene.add(faceMesh);

    const lineMaterial = new THREE.LineBasicMaterial({ color: 0x0d0f14 });
    const lineSegments = new THREE.LineSegments(
      new THREE.BufferGeometry(),
      lineMaterial,
    );
    scene.add(lineSegments);

    stateRef.current = {
      renderer,
      scene,
      camera,
      controls,
      faceMesh,
      lineSegments,
    };

    const resize = () => {
      const w = container.clientWidth;
      const h = container.clientHeight;
      if (w === 0 || h === 0) return;
      // updateStyle (default) must stay on: it keeps the canvas CSS size equal
      // to the container while the drawing buffer scales by devicePixelRatio.
      // Passing `false` here makes the canvas overflow on Retina (DPR > 1).
      renderer.setSize(w, h);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(container);

    let frame = 0;
    const animate = () => {
      controls.update();
      renderer.render(scene, camera);
      frame = requestAnimationFrame(animate);
    };
    animate();

    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      controls.dispose();
      faceMesh.geometry.dispose();
      lineSegments.geometry.dispose();
      faceMaterial.dispose();
      lineMaterial.dispose();
      renderer.dispose();
      container.removeChild(renderer.domElement);
      stateRef.current = null;
    };
  }, []);

  // Upload new geometry whenever the meshed shape changes.
  useEffect(() => {
    const state = stateRef.current;
    if (!state || !mesh) return;
    const [geometry] = syncGeometries(
      [{ name: mesh.name, faces: mesh.faces, edges: mesh.edges }],
      [{ faces: state.faceMesh.geometry, lines: state.lineSegments.geometry }],
    );
    state.faceMesh.geometry = geometry.faces;
    state.lineSegments.geometry = geometry.lines;
  }, [mesh]);

  return <div ref={containerRef} style={{ width: "100%", height: "100%" }} />;
}
