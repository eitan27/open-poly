import { describe, expect, it } from "vitest";
import * as THREE from "three";
import type { ShapeMeshPayload } from "../kernel/types";
import { IDENTITY, applyPoint, meshBounds, multiply, placeMesh, translation } from "./placement";

/** Rotation about Z by 90°, then a move, as three.js builds it — the matrices
 *  must agree with the viewport's, which composes them with three.js. */
const rotZ90 = new THREE.Matrix4().makeRotationZ(Math.PI / 2).elements;

describe("matrices", () => {
  it("multiply agrees with three.js", () => {
    const a = new THREE.Matrix4().makeTranslation(1, 2, 3);
    const b = new THREE.Matrix4().makeRotationX(0.7);
    const ours = multiply(a.elements, b.elements);
    const theirs = a.clone().multiply(b).elements;
    ours.forEach((v, i) => expect(v).toBeCloseTo(theirs[i], 12));
  });

  it("b applies first", () => {
    const m = multiply(translation([10, 0, 0]), rotZ90);
    const p = applyPoint(m, [1, 0, 0]);
    expect(p[0]).toBeCloseTo(10);
    expect(p[1]).toBeCloseTo(1);
  });
});

describe("placeMesh", () => {
  const mesh: ShapeMeshPayload = {
    name: "p",
    faces: {
      vertices: [0, 0, 0, 1, 0, 0, 0, 1, 0],
      triangles: [0, 1, 2],
      normals: [0, 0, 1, 0, 0, 1, 0, 0, 1],
      faceGroups: [{ start: 0, count: 3, faceId: 7, name: "top" }],
    },
    edges: { lines: [0, 0, 0, 1, 0, 0], edgeGroups: [{ start: 0, count: 2, edgeId: 3, name: "e" }] },
  };

  it("returns the mesh itself for the identity", () => {
    expect(placeMesh(mesh, IDENTITY)).toBe(mesh);
  });

  it("moves points, turns normals, and keeps every group and name", () => {
    const placed = placeMesh(mesh, multiply(translation([5, 0, 0]), rotZ90));
    expect(Array.from(placed.faces.vertices.slice(3, 6)).map((v) => Math.round(v))).toEqual([5, 1, 0]);
    expect(Array.from(placed.faces.normals!.slice(0, 3)).map((v) => Math.round(v))).toEqual([0, 0, 1]);
    expect(placed.faces.faceGroups).toEqual(mesh.faces.faceGroups);
    expect(placed.edges.edgeGroups).toEqual(mesh.edges.edgeGroups);
    expect(placed.faces.triangles).toBe(mesh.faces.triangles);
    // The source is untouched.
    expect(mesh.faces.vertices.slice(3, 6)).toEqual([1, 0, 0]);
  });

  it("bounds what was placed", () => {
    const b = meshBounds(placeMesh(mesh, translation([0, 0, 4])));
    expect(b).toEqual({ min: [0, 0, 4], max: [1, 1, 4] });
  });
});
