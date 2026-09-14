// three.js material and mesh construction for the viewport. Self-contained
// factories: they take their inputs and hand back an object, closing over
// nothing. The section-cap builder is the interesting one — it encodes the
// standard clipping-stencil technique, which is easy to get subtly wrong.

import * as THREE from "three";
import type { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";

/** Material for a body's faces (base color, hover, or selected highlight).
 *  `clippingPlanes` is the shared section-view array (see SceneState) — passed
 *  in at construction so every body/hover/selected/sketch-face material clips
 *  identically without ever needing to be touched again after creation. */
export const makeBodyMaterial = (color: number, clippingPlanes: THREE.Plane[]) =>
  new THREE.MeshStandardMaterial({
    color,
    metalness: 0.1,
    roughness: 0.55,
    side: THREE.DoubleSide,
    polygonOffset: true,
    polygonOffsetFactor: 1,
    polygonOffsetUnits: 1,
    clippingPlanes,
  });

/** Build the invisible stencil-writer pair + visible neutral cap quad for one
 *  body's section-view cross-section, per the standard clipping-stencil
 *  technique (back faces increment, front faces decrement, unconditionally, at
 *  every clip-surviving fragment; a quad at the plane then draws only where the
 *  accumulated stencil is nonzero — i.e. exactly the solid's interior at the cut).
 *  `renderOrder` must be a 3-value range unique to this body (see the caller). */
export function createSectionCapTriple(
  faceGeometry: THREE.BufferGeometry,
  clipPlane: THREE.Plane,
  capGeometry: THREE.PlaneGeometry,
  capMaterial: THREE.MeshStandardMaterial,
  renderOrder: number,
): THREE.Mesh[] {
  const stencilBase = {
    colorWrite: false,
    depthWrite: false,
    depthTest: false,
    stencilWrite: true,
    stencilFunc: THREE.AlwaysStencilFunc,
    clippingPlanes: [clipPlane],
  };
  const back = new THREE.Mesh(
    faceGeometry,
    new THREE.MeshBasicMaterial({
      ...stencilBase,
      side: THREE.BackSide,
      stencilFail: THREE.IncrementWrapStencilOp,
      stencilZFail: THREE.IncrementWrapStencilOp,
      stencilZPass: THREE.IncrementWrapStencilOp,
    }),
  );
  const front = new THREE.Mesh(
    faceGeometry,
    new THREE.MeshBasicMaterial({
      ...stencilBase,
      side: THREE.FrontSide,
      stencilFail: THREE.DecrementWrapStencilOp,
      stencilZFail: THREE.DecrementWrapStencilOp,
      stencilZPass: THREE.DecrementWrapStencilOp,
    }),
  );
  const cap = new THREE.Mesh(capGeometry, capMaterial);
  cap.onAfterRender = (r) => r.clearStencil();
  for (const [i, m] of [back, front, cap].entries()) {
    m.renderOrder = renderOrder + i;
    m.frustumCulled = false;
    m.userData.isSectionCap = true;
  }
  return [back, front, cap];
}

// Fat lines (LineMaterial) draw half-linewidth ROUND endcaps that overhang the
// segment on both ends, so a highlighted/sketch line reads longer than its true
// extent. The instanced box's uv.y is 1..-1 over the line body and runs out to
// ±2 for the caps (see LineSegmentsGeometry), so discarding uv.y outside [-1, 1]
// squares the ends off exactly at the endpoints — butt caps, no overhang.
export const buttCaps = (mat: LineMaterial): LineMaterial => {
  mat.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace(
      "void main() {",
      "void main() {\n\t\t\tif ( vUv.y < - 1.0 || vUv.y > 1.0 ) discard; // butt caps",
    );
  };
  return mat;
};
