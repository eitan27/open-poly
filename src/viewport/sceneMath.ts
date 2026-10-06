// Pure vector/matrix math for the viewport — no renderer, no component state,
// nothing that needs a WebGL context to be true.

import * as THREE from "three";
import { clamp } from "../lib/clamp";
import type { Vec2 } from "../document/types";
import type { TransformEdit } from "./types";

/** Build the world matrix for a transform feature's values, matching the kernel's
 *  composition exactly: uniformly scale about the pivot, then rotate about the
 *  axis LINE, then translate (M = T·R·S). Keeps the live drag preview
 *  pixel-aligned with what regenerate will bake. */
export function transformMatrix(
  pivot: [number, number, number],
  tx: number,
  ty: number,
  tz: number,
  angle: number,
  axis: TransformEdit["axis"],
  scale: number,
): THREE.Matrix4 {
  const toPivot = new THREE.Matrix4().makeTranslation(-pivot[0], -pivot[1], -pivot[2]);
  const fromPivot = new THREE.Matrix4().makeTranslation(pivot[0], pivot[1], pivot[2]);
  const m = new THREE.Matrix4(); // identity = no rotation, no scale
  if (angle !== 0) {
    // About the axis LINE, not the pivot: for a world axis the two coincide
    // (axis.origin IS the pivot), for a picked edge they are metres apart.
    const [ox, oy, oz] = axis.origin;
    const toAxis = new THREE.Matrix4().makeTranslation(-ox, -oy, -oz);
    const fromAxis = new THREE.Matrix4().makeTranslation(ox, oy, oz);
    const axisVec = new THREE.Vector3(...axis.dir).normalize();
    const rot = new THREE.Matrix4().makeRotationAxis(axisVec, THREE.MathUtils.degToRad(angle));
    m.multiply(fromAxis).multiply(rot).multiply(toAxis);
  }
  if (scale !== 1) {
    const sc = new THREE.Matrix4().makeScale(scale, scale, scale);
    // Scale about the same pivot, applied BEFORE the rotation (R · S).
    m.multiply(fromPivot).multiply(sc).multiply(toPivot);
  }
  // Translation applies last, so the final matrix is T · R · S.
  return new THREE.Matrix4().makeTranslation(tx, ty, tz).multiply(m);
}

/** Closest point on segment a-b to p, all in 2D (uv). */
export function nearestOnSegment(p: Vec2, a: Vec2, b: Vec2): Vec2 {
  const abx = b[0] - a[0];
  const aby = b[1] - a[1];
  const len2 = abx * abx + aby * aby || 1;
  const t = ((p[0] - a[0]) * abx + (p[1] - a[1]) * aby) / len2;
  const tc = clamp(t, 0, 1);
  return [a[0] + abx * tc, a[1] + aby * tc];
}

/** Fit a circle to a set of points, or null if they don't form one. Centre is
 *  the centroid, radius the mean distance; accepted only when every point sits
 *  within 2% of that radius (a closed ring). The plane normal is taken from three
 *  well-separated points, so it's independent of the points' storage order. */
export function fitCircle(
  pts: THREE.Vector3[],
): { center: THREE.Vector3; radius: number; normal: THREE.Vector3 } | null {
  if (pts.length < 8) return null;
  const center = new THREE.Vector3();
  for (const p of pts) center.add(p);
  center.divideScalar(pts.length);
  let sum = 0;
  const radii = pts.map((p) => {
    const r = p.distanceTo(center);
    sum += r;
    return r;
  });
  const radius = sum / radii.length;
  if (radius < 1e-3) return null;
  for (const r of radii) if (Math.abs(r - radius) > 0.02 * radius) return null;
  const p0 = pts[0],
    p1 = pts[Math.floor(pts.length / 3)],
    p2 = pts[Math.floor((2 * pts.length) / 3)];
  const normal = new THREE.Vector3().crossVectors(p1.clone().sub(p0), p2.clone().sub(p0));
  if (normal.lengthSq() < 1e-9) return null;
  return { center, radius, normal: normal.normalize() };
}
