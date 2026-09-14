// The navigation cube in the viewport's top-right corner: an independent little
// scene with its own camera, rendered as an overlay, that reports which view a
// click on it means.
//
// Already self-contained before the move — it takes a theme and returns a small
// imperative interface. Its textures are painted onto a 2D canvas, so unlike its
// three sibling modules it cannot be unit-tested under Vitest's node
// environment (there is no `document`); it is verified in the browser instead.

import * as THREE from "three";
import { VIEWPORT_THEMES, type ViewCubePalette } from "../settings/viewportTheme";
import type { ResolvedTheme } from "../settings/settings";
import type { ViewName } from "./Viewport";

// Corner size and inset (CSS px). The cube is drawn as an overlay into the SAME
// WebGL canvas, with `autoClear` managed so its pass never wipes the main scene.
const VIEWCUBE_DIM = 108;
const VIEWCUBE_TOP = 60; // px from the canvas top — clears the modeling toolbar
const VIEWCUBE_RIGHT = 14;

const VIEWCUBE_FACES: {
  view: ViewName;
  label: string;
  normal: [number, number, number];
  up: [number, number, number];
}[] = [
  { view: "right", label: "RIGHT", normal: [1, 0, 0], up: [0, 0, 1] },
  { view: "left", label: "LEFT", normal: [-1, 0, 0], up: [0, 0, 1] },
  { view: "back", label: "BACK", normal: [0, 1, 0], up: [0, 0, 1] },
  { view: "front", label: "FRONT", normal: [0, -1, 0], up: [0, 0, 1] },
  { view: "top", label: "TOP", normal: [0, 0, 1], up: [0, 1, 0] },
  { view: "bottom", label: "BOTTOM", normal: [0, 0, -1], up: [0, 1, 0] },
];

/** A tiny solid-colour sRGB texture — used for the corner nubs so they render
 *  through the same path as the face backgrounds (identical gray). */
function solidCubeTexture(color: string): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = c.height = 2;
  const g = c.getContext("2d")!;
  g.fillStyle = color;
  g.fillRect(0, 0, 2, 2);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** A face label rendered to a canvas texture. `hover` swaps to an accent look. */
function viewCubeFaceTexture(label: string, hover: boolean, p: ViewCubePalette): THREE.CanvasTexture {
  const S = 128;
  const c = document.createElement("canvas");
  c.width = c.height = S;
  const g = c.getContext("2d")!;
  g.fillStyle = hover ? p.faceFillHover : p.faceFill;
  g.fillRect(0, 0, S, S);
  g.strokeStyle = hover ? p.faceBorderHover : p.faceBorder;
  g.lineWidth = hover ? 8 : 6;
  g.strokeRect(3, 3, S - 6, S - 6);
  g.fillStyle = hover ? p.faceLabelHover : p.faceLabel;
  g.font = "600 23px ui-sans-serif, system-ui, -apple-system, sans-serif";
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.fillText(label, S / 2, S / 2 + 1);
  const tex = new THREE.CanvasTexture(c);
  // The canvas colours are authored in sRGB; tag the texture so they render as
  // authored — matching the (also-sRGB) flat material colour of the corner nubs,
  // so a nub is exactly the same gray as the face background it sits on.
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

export type CubeHit = { view: ViewName } | { dir: [number, number, number]; up: [number, number, number] };

export interface ViewCube {
  /** Overlay the cube into the top-right corner, oriented to mirror `mainCamera`. */
  render(renderer: THREE.WebGLRenderer, mainCamera: THREE.Camera): void;
  /** The nav target under a client point (updating the hover highlight), or null
   *  if the cursor isn't over the cube. */
  pick(renderer: THREE.WebGLRenderer, clientX: number, clientY: number): CubeHit | null;
  /** Drop any hover highlight (e.g. when the pointer leaves the canvas). */
  clearHover(): void;
  /** Repaint for a colour theme. Both themes' face/nub textures are built up
   *  front and simply swapped — a theme flip is a handful of pointer
   *  assignments, not a canvas re-render, and there is nothing to dispose. */
  setTheme(theme: ResolvedTheme): void;
  dispose(): void;
}

export function createViewCube(initialTheme: ResolvedTheme): ViewCube {
  const cubeScene = new THREE.Scene();
  // Frustum snug around the unit cube's iso silhouette (~±0.87 at the corners)
  // so it fills the corner region — a big, easy click target.
  const cam = new THREE.OrthographicCamera(-0.92, 0.92, 0.92, -0.92, 0.1, 10);
  cam.position.set(0, 0, 3);
  cam.lookAt(0, 0, 0);
  cam.updateMatrixWorld(true);
  const group = new THREE.Group();
  cubeScene.add(group);

  // Every themed texture is built once, for both themes, and indexed by theme
  // below — see setTheme. `pal` is whichever one is currently showing.
  const palettes = { dark: VIEWPORT_THEMES.dark.cube, light: VIEWPORT_THEMES.light.cube };
  let pal = palettes[initialTheme];

  // A solid body + crisp edges so the six label planes read as one cube.
  const bodyMat = new THREE.MeshBasicMaterial({ color: pal.body });
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.98, 0.98, 0.98), bodyMat);
  const edgeMat = new THREE.LineBasicMaterial({ color: pal.edge });
  const edges = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1)), edgeMat);
  group.add(body, edges);
  const disposables: { dispose(): void }[] = [
    body.geometry,
    body.material as THREE.Material,
    edges.geometry,
    edges.material as THREE.Material,
  ];

  // Per-object hover appearance: faces swap their label texture, corners swap
  // colour. Stored on userData so a single applyHover handles both.
  const targets: THREE.Mesh[] = [];

  // One label plane per face, oriented by an explicit basis (local +Z → outward
  // normal, local +Y → the face's up) so every label reads upright.
  const x = new THREE.Vector3(),
    y = new THREE.Vector3(),
    z = new THREE.Vector3();
  for (const f of VIEWCUBE_FACES) {
    const themed = {
      dark: {
        normal: viewCubeFaceTexture(f.label, false, palettes.dark),
        hover: viewCubeFaceTexture(f.label, true, palettes.dark),
      },
      light: {
        normal: viewCubeFaceTexture(f.label, false, palettes.light),
        hover: viewCubeFaceTexture(f.label, true, palettes.light),
      },
    };
    const texNormal = themed[initialTheme].normal;
    const texHover = themed[initialTheme].hover;
    const mat = new THREE.MeshBasicMaterial({ map: texNormal });
    const plane = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mat);
    z.set(...f.normal).normalize();
    y.set(...f.up).normalize();
    x.crossVectors(y, z).normalize();
    plane.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y, z));
    plane.position.copy(z).multiplyScalar(0.5);
    plane.userData = { hit: { view: f.view } as CubeHit, kind: "face", texNormal, texHover, themed };
    group.add(plane);
    targets.push(plane);
    disposables.push(
      plane.geometry,
      mat,
      themed.dark.normal,
      themed.dark.hover,
      themed.light.normal,
      themed.light.hover,
    );
  }

  // A small nub at each of the 8 corners → the iso view looking down that corner's
  // diagonal (camera position = the corner direction, Z-up). They use the SAME
  // solid-colour textures as the face backgrounds (not a flat material colour,
  // which renders through a different colour-space path) so a nub is exactly the
  // same gray as the face it sits on, hinting it's pressable without reading as a
  // loud dot.
  const cornerThemed = {
    dark: { normal: solidCubeTexture(palettes.dark.corner), hover: solidCubeTexture(palettes.dark.cornerHover) },
    light: { normal: solidCubeTexture(palettes.light.corner), hover: solidCubeTexture(palettes.light.cornerHover) },
  };
  const cornerGeom = new THREE.SphereGeometry(0.09, 16, 12);
  // A slightly larger BackSide sphere behind each nub = a blue outline ring, shown
  // only on hover (matching the faces' blue hover border).
  const cornerOutlineGeom = new THREE.SphereGeometry(0.125, 16, 12);
  disposables.push(
    cornerGeom,
    cornerOutlineGeom,
    cornerThemed.dark.normal,
    cornerThemed.dark.hover,
    cornerThemed.light.normal,
    cornerThemed.light.hover,
  );
  const outlineMats: THREE.MeshBasicMaterial[] = [];
  for (const sx of [-1, 1])
    for (const sy of [-1, 1])
      for (const sz of [-1, 1]) {
        const outlineMat = new THREE.MeshBasicMaterial({ color: pal.cornerOutline, side: THREE.BackSide });
        outlineMats.push(outlineMat);
        const outline = new THREE.Mesh(cornerOutlineGeom, outlineMat);
        outline.position.set(sx * 0.5, sy * 0.5, sz * 0.5);
        outline.visible = false;
        group.add(outline);
        const mat = new THREE.MeshBasicMaterial({ map: cornerThemed[initialTheme].normal });
        const nub = new THREE.Mesh(cornerGeom, mat);
        nub.position.set(sx * 0.5, sy * 0.5, sz * 0.5);
        nub.userData = {
          hit: { dir: [sx, sy, sz], up: [0, 0, 1] } as CubeHit,
          texNormal: cornerThemed[initialTheme].normal,
          texHover: cornerThemed[initialTheme].hover,
          themed: cornerThemed,
          outline,
        };
        group.add(nub);
        targets.push(nub);
        disposables.push(outlineMat, mat);
      }

  const raycaster = new THREE.Raycaster();
  const size = new THREE.Vector2();
  const prevVp = new THREE.Vector4();
  let hovered: THREE.Mesh | null = null;

  const applyHover = (obj: THREE.Mesh | null, on: boolean) => {
    if (!obj) return;
    const ud = obj.userData;
    const mat = obj.material as THREE.MeshBasicMaterial;
    // Faces and corner nubs both swap their (solid or labelled) texture on hover.
    mat.map = on ? ud.texHover : ud.texNormal;
    // Corner nubs also show their blue outline ring on hover (faces draw theirs
    // into the texture; a sphere gets it from a BackSide shell behind it).
    if (ud.outline) (ud.outline as THREE.Mesh).visible = on;
  };
  const setHovered = (obj: THREE.Mesh | null) => {
    if (obj === hovered) return;
    applyHover(hovered, false);
    hovered = obj;
    applyHover(hovered, true);
  };

  return {
    render(renderer, mainCamera) {
      group.quaternion.copy(mainCamera.quaternion).invert();
      renderer.getSize(size);
      renderer.autoClear = false;
      renderer.clearDepth();
      renderer.getViewport(prevVp);
      // WebGL viewport y is measured from the bottom.
      renderer.setViewport(
        size.x - VIEWCUBE_DIM - VIEWCUBE_RIGHT,
        size.y - VIEWCUBE_DIM - VIEWCUBE_TOP,
        VIEWCUBE_DIM,
        VIEWCUBE_DIM,
      );
      renderer.render(cubeScene, cam);
      renderer.setViewport(prevVp.x, prevVp.y, prevVp.z, prevVp.w);
      renderer.autoClear = true;
    },
    pick(renderer, clientX, clientY) {
      const rect = renderer.domElement.getBoundingClientRect();
      renderer.getSize(size);
      const left = rect.left + size.x - VIEWCUBE_DIM - VIEWCUBE_RIGHT;
      const top = rect.top + VIEWCUBE_TOP;
      const lx = clientX - left,
        ly = clientY - top;
      if (lx < 0 || lx > VIEWCUBE_DIM || ly < 0 || ly > VIEWCUBE_DIM) {
        setHovered(null);
        return null;
      }
      group.updateMatrixWorld(true);
      raycaster.setFromCamera(new THREE.Vector2((lx / VIEWCUBE_DIM) * 2 - 1, -(ly / VIEWCUBE_DIM) * 2 + 1), cam);
      const obj = raycaster.intersectObjects(targets, false)[0]?.object as THREE.Mesh | undefined;
      setHovered(obj ?? null);
      return (obj?.userData.hit as CubeHit | undefined) ?? null;
    },
    clearHover() {
      setHovered(null);
    },
    setTheme(theme) {
      pal = palettes[theme];
      bodyMat.color.set(pal.body);
      edgeMat.color.set(pal.edge);
      for (const m of outlineMats) m.color.set(pal.cornerOutline);
      // Re-point every face/nub at its texture pair for the new theme. Anything
      // currently hovered keeps its hover texture, so a theme change mid-hover
      // doesn't blink the highlight off.
      for (const obj of targets) {
        const ud = obj.userData as {
          texNormal: THREE.Texture;
          texHover: THREE.Texture;
          themed: Record<ResolvedTheme, { normal: THREE.Texture; hover: THREE.Texture }>;
        };
        ud.texNormal = ud.themed[theme].normal;
        ud.texHover = ud.themed[theme].hover;
        (obj.material as THREE.MeshBasicMaterial).map = obj === hovered ? ud.texHover : ud.texNormal;
      }
    },
    dispose() {
      for (const d of disposables) d.dispose();
    },
  };
}
