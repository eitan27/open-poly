import { describe, expect, it } from "vitest";
import type { FeatureMesh } from "../viewport/types";
import { measureSelection } from "./measure";
import type { Selection } from "./types";

type V = [number, number, number];

/** A box from `o` with sides `s`: faces 0..5 = −z, +z, −y, +y, −x, +x, and its
 *  12 edges, each a separate group. */
function box(id: string, o: V, s: V): FeatureMesh {
  const P = (x: number, y: number, z: number): V => [o[0] + x * s[0], o[1] + y * s[1], o[2] + z * s[2]];
  const quads: V[][] = [
    [P(0, 0, 0), P(0, 1, 0), P(1, 1, 0), P(1, 0, 0)],
    [P(0, 0, 1), P(1, 0, 1), P(1, 1, 1), P(0, 1, 1)],
    [P(0, 0, 0), P(1, 0, 0), P(1, 0, 1), P(0, 0, 1)],
    [P(0, 1, 0), P(0, 1, 1), P(1, 1, 1), P(1, 1, 0)],
    [P(0, 0, 0), P(0, 0, 1), P(0, 1, 1), P(0, 1, 0)],
    [P(1, 0, 0), P(1, 1, 0), P(1, 1, 1), P(1, 0, 1)],
  ];
  const vertices: number[] = [];
  const triangles: number[] = [];
  const faceGroups: { start: number; count: number; faceId: number }[] = [];
  quads.forEach((q, faceId) => {
    const b = vertices.length / 3;
    for (const p of q) vertices.push(...p);
    faceGroups.push({ start: triangles.length, count: 6, faceId });
    triangles.push(b, b + 1, b + 2, b, b + 2, b + 3);
  });
  // Edges: the 4 bottom, 4 top, 4 upright, in that order.
  const c = (i: number, z: number) => P([0, 1, 1, 0][i], [0, 0, 1, 1][i], z);
  const segs: [V, V][] = [];
  for (let i = 0; i < 4; i++) segs.push([c(i, 0), c((i + 1) % 4, 0)]);
  for (let i = 0; i < 4; i++) segs.push([c(i, 1), c((i + 1) % 4, 1)]);
  for (let i = 0; i < 4; i++) segs.push([c(i, 0), c(i, 1)]);
  const lines: number[] = [];
  const edgeGroups = segs.map(([a, b], edgeId) => {
    const start = lines.length / 3;
    lines.push(...a, ...b);
    return { start, count: 2, edgeId };
  });
  return {
    id,
    mesh: { name: id, faces: { vertices, triangles, faceGroups }, edges: { lines, edgeGroups } },
    color: 0,
    opacity: 1,
  } as unknown as FeatureMesh;
}

/** A faceted cylinder (n facets in one cluster) of radius `r` along Z at (x, y). */
function rod(id: string, x: number, y: number, r: number, h = 10, n = 96): FeatureMesh {
  const vertices: number[] = [];
  const triangles: number[] = [];
  const faceGroups: { start: number; count: number; faceId: number; clusterId: number }[] = [];
  const at = (i: number, z: number) => [
    x + r * Math.cos((2 * Math.PI * i) / n),
    y + r * Math.sin((2 * Math.PI * i) / n),
    z,
  ];
  for (let i = 0; i < n; i++) {
    const b = vertices.length / 3;
    vertices.push(...at(i, 0), ...at(i + 1, 0), ...at(i + 1, h), ...at(i, h));
    faceGroups.push({ start: triangles.length, count: 6, faceId: i, clusterId: 1 });
    triangles.push(b, b + 1, b + 2, b, b + 2, b + 3);
  }
  return {
    id,
    mesh: { name: id, faces: { vertices, triangles, faceGroups }, edges: { lines: [] } },
    color: 0,
    opacity: 1,
  } as unknown as FeatureMesh;
}

const face = (featureId: string, faceId: number): Selection => ({ kind: "face", featureId, faceId });
const edge = (featureId: string, edgeId: number): Selection => ({ kind: "edge", featureId, edgeId });
const vertex = (featureId: string, point: V): Selection => ({ kind: "vertex", featureId, point });
const rows = (sel: Selection[], meshes: FeatureMesh[]) => {
  const m = measureSelection(sel, null, meshes)!;
  return { title: m.title, ...Object.fromEntries(m.rows.map((r) => [r.label, r.value])) } as Record<string, string>;
};

// Two 10 mm cubes, the second 30 mm along X: a 20 mm gap between them.
const A = box("A", [0, 0, 0], [10, 10, 10]);
const B = box("B", [30, 0, 0], [10, 10, 10]);

describe("two faces", () => {
  it("measures the gap between facing faces of two parts", () => {
    expect(rows([face("A", 5), face("B", 4)], [A, B])).toEqual({
      title: "Face ↔ Face",
      Distance: "20",
      "Parallel distance": "20",
    });
  });
  it("gives the angle between faces that meet, and 0 apart", () => {
    expect(rows([face("A", 1), face("A", 5)], [A])).toEqual({ title: "Face ↔ Face", Distance: "0", Angle: "90°" });
  });
  it("reads 0 where parts overlap", () => {
    const C = box("C", [5, 5, 5], [10, 10, 10]);
    expect(rows([face("A", 1), face("C", 2)], [A, C]).Distance).toBe("0");
  });
  it("measures the true minimum between offset parallel faces, beside their planes' distance", () => {
    // B's top, 10 up and 20 across from A's top: the planes are 0 apart, the faces 20.
    expect(rows([face("A", 1), face("B", 1)], [A, B])).toMatchObject({ Distance: "20", "Parallel distance": "0" });
  });
});

describe("vertices", () => {
  it("measures between two corners, with the differences", () => {
    expect(rows([vertex("A", [10, 10, 10]), vertex("B", [30, 0, 0])], [A, B])).toEqual({
      title: "Vertex ↔ Vertex",
      Distance: fmtLen([20, -10, -10]),
      ΔX: "20",
      ΔY: "-10",
      ΔZ: "-10",
    });
  });
  it("measures a corner to a face, and to its plane", () => {
    // B's −x face spans y 0..10; a point at y = 20 is farther from the face
    // than from its plane.
    expect(rows([vertex("A", [10, 20, 5]), face("B", 4)], [A, B])).toEqual({
      title: "Vertex ↔ Face",
      Distance: fmtLen([20, 10, 0]),
      "To plane": "20",
    });
  });
  it("measures a corner to an edge's line", () => {
    expect(rows([vertex("A", [0, 0, 5]), edge("B", 0)], [A, B])).toMatchObject({ "To line": fmtLen([0, 0, 5]) });
  });
});

describe("edges", () => {
  it("gives the angle between edges at a corner", () => {
    expect(rows([edge("A", 0), edge("A", 8)], [A])).toEqual({ title: "Edge ↔ Edge", Distance: "0", Angle: "90°" });
  });
  it("measures an edge parallel to a face", () => {
    // A's top front edge (along X at y 0, z 10) against B's bottom face (z 0).
    expect(rows([edge("A", 4), face("B", 0)], [A, B])).toMatchObject({ "Parallel distance": "10" });
  });
  it("gives an edge's angle to a face it meets", () => {
    expect(rows([edge("A", 8), face("A", 0)], [A])).toMatchObject({ Angle: "90°" });
  });
});

describe("round features", () => {
  it("measures two rods' axes, and the gap between their surfaces", () => {
    const r = rows([face("R1", 3), face("R2", 50)], [rod("R1", 0, 0, 4), rod("R2", 20, 0, 3)]);
    expect(r["Axis distance"]).toBe("20");
    // 20 − 4 − 3 = 13, give or take the facets.
    expect(Math.abs(Number(r.Distance) - 13)).toBeLessThan(0.02);
  });
  it("measures a point to a rod's axis", () => {
    expect(rows([vertex("A", [10, 0, 5]), face("R", 0)], [A, rod("R", 0, 0, 4)])).toMatchObject({ "To axis": "10" });
  });
});

describe("more than two picks", () => {
  it("still counts them and totals the faces' area", () => {
    expect(rows([face("A", 0), face("A", 1), face("A", 2)], [A])).toEqual({
      title: "Selection",
      Selected: "3",
      "Total area": "300",
    });
  });
});

function fmtLen(d: V): string {
  return String(Math.round(Math.hypot(...d) * 1000) / 1000);
}
