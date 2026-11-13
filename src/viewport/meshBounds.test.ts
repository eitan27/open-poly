import { describe, expect, it } from "vitest";
import { meshBounds } from "./meshBounds";
import type { ShapeMeshPayload } from "../kernel/types";

const mesh = (vertices: number[]) =>
  ({ name: "m", faces: { vertices, triangles: [] }, edges: {} }) as unknown as ShapeMeshPayload;

describe("meshBounds", () => {
  it("boxes the vertices", () => {
    expect(meshBounds(mesh([1, -2, 3, -4, 5, 0, 2, 2, 9]))).toEqual({ min: [-4, -2, 0], max: [2, 5, 9] });
  });
  it("is null for an empty mesh", () => {
    expect(meshBounds(mesh([]))).toBeNull();
  });
});
