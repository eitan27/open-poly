// The marker drawn at a mate connector while a mate is being made: a flat ring
// in the frame's XY plane and an arrow up its Z, so both where the frame is and
// which way it faces read at a glance. Drawn as a ghost (no depth test), so a
// connector inside a bore still shows.
import type { ShapeMeshPayload } from "../kernel/types";
import { applyPoint, type Vec3 } from "./placement";
import type { Mat4 } from "./types";

const SIDES = 24;

/** A connector marker of overall size `size` (mm) at the world frame `m`. */
export function connectorGlyph(m: Mat4, size: number): ShapeMeshPayload {
  const pts: Vec3[] = [];
  const tris: number[] = [];
  const ring = (r0: number, r1: number, z: number) => {
    const base = pts.length;
    for (let i = 0; i < SIDES; i++) {
      const a = (i / SIDES) * 2 * Math.PI;
      pts.push([r0 * Math.cos(a), r0 * Math.sin(a), z], [r1 * Math.cos(a), r1 * Math.sin(a), z]);
    }
    for (let i = 0; i < SIDES; i++) {
      const j = (i + 1) % SIDES;
      const [a, b, c, d] = [base + 2 * i, base + 2 * i + 1, base + 2 * j, base + 2 * j + 1];
      tris.push(a, b, d, a, d, c);
    }
  };
  // A cone from radius r at height z0 to a point at z1.
  const cone = (r: number, z0: number, z1: number) => {
    const base = pts.length;
    for (let i = 0; i < SIDES; i++) {
      const a = (i / SIDES) * 2 * Math.PI;
      pts.push([r * Math.cos(a), r * Math.sin(a), z0]);
    }
    const tip = pts.length;
    pts.push([0, 0, z1]);
    for (let i = 0; i < SIDES; i++) tris.push(base + i, base + ((i + 1) % SIDES), tip);
  };
  // A thin tube for the arrow's shaft.
  const shaft = (r: number, z0: number, z1: number) => {
    const base = pts.length;
    for (let i = 0; i < SIDES; i++) {
      const a = (i / SIDES) * 2 * Math.PI;
      pts.push([r * Math.cos(a), r * Math.sin(a), z0], [r * Math.cos(a), r * Math.sin(a), z1]);
    }
    for (let i = 0; i < SIDES; i++) {
      const j = (i + 1) % SIDES;
      tris.push(base + 2 * i, base + 2 * j, base + 2 * j + 1, base + 2 * i, base + 2 * j + 1, base + 2 * i + 1);
    }
  };
  ring(size * 0.28, size * 0.4, 0);
  shaft(size * 0.04, 0, size * 0.7);
  cone(size * 0.12, size * 0.7, size);

  const vertices = new Float32Array(pts.length * 3);
  pts.forEach((p, i) => vertices.set(applyPoint(m, p), i * 3));
  return {
    name: "connector",
    faces: { vertices, triangles: new Uint32Array(tris) },
    edges: { lines: new Float32Array(0) },
  };
}
