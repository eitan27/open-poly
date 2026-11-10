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

/** A small marker at a candidate connector point (`size` across, world
 *  coordinates): an octahedron, so it reads the same from any side. The Mate
 *  dialog draws one at each point the hovered face, edge or vertex offers. */
export function pointGlyph(p: Vec3, size: number): ShapeMeshPayload {
  const r = size / 2;
  const pts: Vec3[] = [
    [r, 0, 0],
    [-r, 0, 0],
    [0, r, 0],
    [0, -r, 0],
    [0, 0, r],
    [0, 0, -r],
  ];
  const tris = [0, 2, 4, 2, 1, 4, 1, 3, 4, 3, 0, 4, 2, 0, 5, 1, 2, 5, 3, 1, 5, 0, 3, 5];
  const vertices = new Float32Array(pts.length * 3);
  pts.forEach((q, i) => vertices.set([p[0] + q[0], p[1] + q[1], p[2] + q[2]], i * 3));
  return {
    name: "candidate",
    faces: { vertices, triangles: new Uint32Array(tris) },
    edges: { lines: new Float32Array(0) },
  };
}
