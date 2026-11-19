import { describe, expect, it } from "vitest";
import type { ResolvedFeature, ResolvedFrame, ShapeMeshPayload } from "../kernel/types";
import { ghostPlacement, moveGhostMesh } from "./ghostMove";

type V3 = [number, number, number];
const TOP: ResolvedFrame = { origin: [0, 0, 0], uAxis: [1, 0, 0], vAxis: [0, 1, 0], normal: [0, 0, 1] };
// A face on the Front side of a part, offset in space.
const FACE: ResolvedFrame = { origin: [5, -15, 7], uAxis: [1, 0, 0], vAxis: [0, 0, 1], normal: [0, -1, 0] };
// The Front datum: u × v = −normal, a mirrored frame.
const FRONT: ResolvedFrame = { origin: [0, 0, 0], uAxis: [1, 0, 0], vAxis: [0, 0, 1], normal: [0, 1, 0] };

const shape: [number, number][] = [
  [0, 0],
  [4, 0],
  [4, 3],
  [1, 2],
];
const gear = (frame: ResolvedFrame, [cx, cy]: [number, number], thickness = 8): ResolvedFeature =>
  ({
    id: "draft",
    type: "extrude",
    profiles: [{ kind: "sketchRegion", outline: shape.map(([x, y]) => [x + cx, y + cy]), frame, holes: [] }],
    distance: thickness,
    flip: false,
    extent: "blind",
    mode: "new",
  }) as ResolvedFeature;

/** A plane point (u, v) lifted w along the normal. */
const world = (f: ResolvedFrame, u: number, v: number, w: number): V3 =>
  [0, 1, 2].map((k) => f.origin[k] + u * f.uAxis[k] + v * f.vAxis[k] + w * f.normal[k]) as V3;
/** A "mesh" of the outline's points at the bottom and top of an 8 mm prism. */
const meshAt = (f: ResolvedFrame, [cx, cy]: [number, number]): ShapeMeshPayload => {
  const pts = [0, 8].flatMap((w) => shape.flatMap(([x, y]) => world(f, x + cx, y + cy, w)));
  return {
    name: "draft",
    faces: { vertices: pts, triangles: [0, 1, 2], normals: shape.flatMap(() => [...f.normal, ...f.normal]) },
    edges: { lines: pts.slice(0, 6) },
  };
};
const close = (a: ArrayLike<number>, b: ArrayLike<number>) => {
  expect(a.length).toBe(b.length);
  for (let i = 0; i < a.length; i++) expect(a[i]).toBeCloseTo(b[i], 4);
};

describe("moving a gear's ghost to a new location", () => {
  it("lands where the kernel would have built it", () => {
    const from = ghostPlacement(gear(TOP, [0, 0]))!;
    const to = ghostPlacement(gear(FACE, [12, -3]))!;
    expect(from.sig).toBe(to.sig);
    const moved = moveGhostMesh(meshAt(TOP, [0, 0]), from, to);
    const want = meshAt(FACE, [12, -3]);
    close(moved.faces.vertices, want.faces.vertices);
    close(moved.faces.normals!, want.faces.normals!);
    close(moved.edges.lines, want.edges.lines);
    expect(Array.from(moved.faces.triangles)).toEqual([0, 1, 2]);
  });

  it("onto the mirrored Front datum: reflected, with each triangle turned around", () => {
    const from = ghostPlacement(gear(TOP, [0, 0]))!;
    const to = ghostPlacement(gear(FRONT, [2, 5]))!;
    expect([from.hand, to.hand]).toEqual([1, -1]);
    expect(from.sig).toBe(to.sig);
    const moved = moveGhostMesh(meshAt(TOP, [0, 0]), from, to);
    const want = meshAt(FRONT, [2, 5]);
    close(moved.faces.vertices, want.faces.vertices);
    close(moved.faces.normals!, want.faces.normals!);
    expect(Array.from(moved.faces.triangles)).toEqual([0, 2, 1]);
    // …and back again restores the winding.
    expect(Array.from(moveGhostMesh(moved, to, from).faces.triangles)).toEqual([0, 1, 2]);
  });

  it("won't move a different gear", () => {
    const at = ghostPlacement(gear(TOP, [0, 0]))!;
    expect(ghostPlacement(gear(TOP, [3, 3], 10))!.sig).not.toBe(at.sig);
  });

  it("leaves an extrude that depends on other bodies to the kernel", () => {
    const f = gear(TOP, [0, 0]) as Extract<ResolvedFeature, { type: "extrude" }>;
    expect(ghostPlacement({ ...f, extent: "upToNext" })).toBeNull();
    expect(ghostPlacement({ ...f, mode: "add" })).toBeNull();
  });
});
