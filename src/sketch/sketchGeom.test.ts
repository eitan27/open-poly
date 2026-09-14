import { describe, expect, it } from "vitest";
import type { PlaneFrameData } from "../document/planes";
import type { SketchEntity, Vec2 } from "../document/types";
import {
  bodyUnderRegion,
  lineLineIntersection,
  moveSketchPoints,
  pointInTriangle,
  rayFromCorner,
  sketchBoundsCenter,
  type RegionMesh,
} from "./sketchGeom";

type Line = Extract<SketchEntity, { type: "line" }>;

describe("pointInTriangle", () => {
  const a: Vec2 = [0, 0],
    b: Vec2 = [4, 0],
    c: Vec2 = [0, 4];

  it("is true for a point inside", () => {
    expect(pointInTriangle([1, 1], a, b, c)).toBe(true);
  });

  it("is false for a point outside", () => {
    expect(pointInTriangle([5, 5], a, b, c)).toBe(false);
  });

  it("is true on the boundary — a pick on a shared edge must hit something", () => {
    expect(pointInTriangle([2, 0], a, b, c)).toBe(true);
    expect(pointInTriangle([2, 2], a, b, c)).toBe(true);
  });

  it("does not care which way the triangle is wound", () => {
    expect(pointInTriangle([1, 1], a, c, b)).toBe(true);
    expect(pointInTriangle([5, 5], a, c, b)).toBe(false);
  });
});

describe("lineLineIntersection", () => {
  it("finds the crossing point of two non-parallel lines", () => {
    const p = lineLineIntersection([0, 0], [4, 4], [0, 4], [4, 0]);
    expect(p?.[0]).toBeCloseTo(2);
    expect(p?.[1]).toBeCloseTo(2);
  });

  it("treats the lines as infinite — the crossing may be off both segments", () => {
    const p = lineLineIntersection([0, 0], [1, 0], [5, 1], [5, 2]);
    expect(p?.[0]).toBeCloseTo(5);
    expect(p?.[1]).toBeCloseTo(0);
  });

  it("returns null for parallel lines", () => {
    expect(lineLineIntersection([0, 0], [1, 0], [0, 1], [1, 1])).toBeNull();
  });

  it("returns null for anti-parallel lines too", () => {
    expect(lineLineIntersection([0, 0], [1, 0], [1, 1], [0, 1])).toBeNull();
  });
});

describe("rayFromCorner", () => {
  it("points toward the farther endpoint of the line", () => {
    const line: Line = { type: "line", id: "l1", a: [0, 0], b: [10, 0] };
    const dir = rayFromCorner(line, [0, 0]);
    expect(dir[0]).toBeCloseTo(1);
    expect(dir[1]).toBeCloseTo(0);
  });

  it("picks the far end even when the corner is the `b` endpoint", () => {
    const line: Line = { type: "line", id: "l1", a: [0, 0], b: [10, 0] };
    const dir = rayFromCorner(line, [10, 0]);
    expect(dir[0]).toBeCloseTo(-1);
    expect(dir[1]).toBeCloseTo(0);
  });

  it("returns a unit vector for a diagonal line", () => {
    const line: Line = { type: "line", id: "l1", a: [0, 0], b: [3, 4] };
    expect(Math.hypot(...rayFromCorner(line, [0, 0]))).toBeCloseTo(1);
  });
});

describe("sketchBoundsCenter", () => {
  it("computes the bbox midpoint of mixed entity types", () => {
    const entities: SketchEntity[] = [
      { type: "line", id: "l1", a: [0, 0], b: [10, 0] },
      { type: "circle", id: "c1", c: [5, 10], r: 2 },
    ];
    const center = sketchBoundsCenter(entities);
    expect(center[0]).toBeCloseTo(5);
    expect(center[1]).toBeCloseTo(6);
  });

  it("takes a circle's extent from its rim, not its centre", () => {
    expect(sketchBoundsCenter([{ type: "circle", id: "c1", c: [0, 0], r: 3 }])).toEqual([0, 0]);
    const off = sketchBoundsCenter([
      { type: "circle", id: "c1", c: [0, 0], r: 3 },
      { type: "point", id: "p1", p: [9, 0] },
    ]);
    expect(off[0]).toBeCloseTo(3); // (-3 .. 9), not (0 .. 9)
  });

  it("includes every control point of a spline", () => {
    const c = sketchBoundsCenter([
      {
        type: "spline",
        id: "s1",
        points: [
          [0, 0],
          [4, 8],
          [2, 2],
        ],
      },
    ]);
    expect(c).toEqual([2, 4]);
  });

  it("ignores text, which the solver and region detector also skip", () => {
    const c = sketchBoundsCenter([
      { type: "line", id: "l1", a: [0, 0], b: [10, 0] },
      { type: "text", id: "t1", p: [1000, 1000], value: "hi", height: 5 },
    ]);
    expect(c).toEqual([5, 0]);
  });

  it("returns the origin for no entities, and for a text-only sketch", () => {
    expect(sketchBoundsCenter([])).toEqual([0, 0]);
    expect(sketchBoundsCenter([{ type: "text", id: "t1", p: [9, 9], value: "hi", height: 5 }])).toEqual([0, 0]);
  });
});

describe("moveSketchPoints", () => {
  it("moves matching endpoints, preserving shared coincidence", () => {
    const entities: SketchEntity[] = [
      { type: "line", id: "l1", a: [0, 0], b: [10, 0] },
      { type: "line", id: "l2", a: [10, 0], b: [10, 10] },
    ];
    const moved = moveSketchPoints(entities, [{ from: [10, 0], to: [12, 1] }]);
    expect((moved[0] as Line).b).toEqual([12, 1]);
    expect((moved[1] as Line).a).toEqual([12, 1]);
  });

  it("matches on a 4-decimal key, so a sub-tolerance difference still counts as the same vertex", () => {
    const entities: SketchEntity[] = [{ type: "line", id: "l1", a: [0, 0], b: [10.000001, 0] }];
    const moved = moveSketchPoints(entities, [{ from: [10, 0], to: [12, 0] }]);
    expect((moved[0] as Line).b).toEqual([12, 0]);
  });

  it("moves a circle's and an arc's centre, translating the whole entity", () => {
    const entities: SketchEntity[] = [
      { type: "circle", id: "c1", c: [1, 1], r: 4 },
      { type: "arc", id: "a1", c: [1, 1], r: 2, start: 0, end: 1 },
    ];
    const moved = moveSketchPoints(entities, [{ from: [1, 1], to: [5, 5] }]);
    expect(moved[0]).toEqual({ type: "circle", id: "c1", c: [5, 5], r: 4 });
    expect(moved[1]).toEqual({ type: "arc", id: "a1", c: [5, 5], r: 2, start: 0, end: 1 });
  });

  it("moves a spline's control points and a text's anchor", () => {
    const entities: SketchEntity[] = [
      {
        type: "spline",
        id: "s1",
        points: [
          [0, 0],
          [1, 1],
        ],
      },
      { type: "text", id: "t1", p: [0, 0], value: "hi", height: 5 },
    ];
    const moved = moveSketchPoints(entities, [{ from: [0, 0], to: [7, 7] }]);
    expect((moved[0] as Extract<SketchEntity, { type: "spline" }>).points).toEqual([
      [7, 7],
      [1, 1],
    ]);
    expect((moved[1] as Extract<SketchEntity, { type: "text" }>).p).toEqual([7, 7]);
  });

  it("leaves points with no matching `from` untouched", () => {
    const entities: SketchEntity[] = [{ type: "point", id: "p1", p: [1, 1] }];
    const moved = moveSketchPoints(entities, [{ from: [9, 9], to: [0, 0] }]);
    expect((moved[0] as Extract<SketchEntity, { type: "point" }>).p).toEqual([1, 1]);
  });

  it("keeps the other fields of each entity", () => {
    const entities: SketchEntity[] = [
      { type: "line", id: "l1", a: [0, 0], b: [1, 0], construction: true, exprs: { length: "w" } },
    ];
    const moved = moveSketchPoints(entities, [{ from: [0, 0], to: [2, 0] }]) as Line[];
    expect(moved[0].construction).toBe(true);
    expect(moved[0].exprs).toEqual({ length: "w" });
  });
});

describe("bodyUnderRegion", () => {
  const frame: PlaneFrameData = { origin: [0, 0, 0], normal: [0, 0, 1], uAxis: [1, 0, 0], vAxis: [0, 1, 0] };
  const square: Vec2[] = [
    [-1, -1],
    [1, -1],
    [1, 1],
    [-1, 1],
  ];

  /** One planar face spanning (-10..10)^2 at height `z`. */
  const slab = (id: string, z: number): RegionMesh => ({
    id,
    mesh: {
      faces: {
        vertices: [-10, -10, z, 10, -10, z, 10, 10, z, -10, 10, z],
        triangles: [0, 1, 2, 0, 2, 3],
        faceGroups: [{ start: 0, count: 6, faceId: 1 }],
      },
    },
  });

  it("finds the body whose coplanar face contains the region", () => {
    expect(bodyUnderRegion(frame, square, [slab("body1", 0)])).toBe("body1");
  });

  it("returns null when no face is coplanar with the sketch frame", () => {
    expect(bodyUnderRegion(frame, square, [slab("body1", 5)])).toBeNull();
  });

  it("tolerates a face a hair off the plane, but not one 0.1mm away", () => {
    expect(bodyUnderRegion(frame, square, [slab("body1", 0.04)])).toBe("body1");
    expect(bodyUnderRegion(frame, square, [slab("body1", 0.1)])).toBeNull();
  });

  it("returns null when a coplanar face does not overlap the region", () => {
    const far: RegionMesh = {
      id: "body1",
      mesh: {
        faces: {
          vertices: [50, 50, 0, 60, 50, 0, 60, 60, 0, 50, 60, 0],
          triangles: [0, 1, 2, 0, 2, 3],
          faceGroups: [{ start: 0, count: 6, faceId: 1 }],
        },
      },
    };
    expect(bodyUnderRegion(frame, square, [far])).toBeNull();
  });

  it("hits on a single overlapping outline vertex, even with the centroid off the face", () => {
    // The face covers only x >= 0; the square's centroid is at the origin corner
    // but two of its vertices sit inside.
    const half: RegionMesh = {
      id: "body1",
      mesh: {
        faces: {
          vertices: [0.5, -10, 0, 10, -10, 0, 10, 10, 0, 0.5, 10, 0],
          triangles: [0, 1, 2, 0, 2, 3],
          faceGroups: [{ start: 0, count: 6, faceId: 1 }],
        },
      },
    };
    expect(bodyUnderRegion(frame, square, [half])).toBe("body1");
  });

  it("skips a mesh with no face groups", () => {
    const ungrouped: RegionMesh = {
      id: "body1",
      mesh: { faces: { vertices: [-10, -10, 0, 10, -10, 0, 10, 10, 0], triangles: [0, 1, 2] } },
    };
    expect(bodyUnderRegion(frame, square, [ungrouped])).toBeNull();
  });

  it("works on a tilted sketch plane, in that plane's own uv", () => {
    const yz: PlaneFrameData = { origin: [3, 0, 0], normal: [1, 0, 0], uAxis: [0, 1, 0], vAxis: [0, 0, 1] };
    const wall: RegionMesh = {
      id: "wall",
      mesh: {
        faces: {
          vertices: [3, -10, -10, 3, 10, -10, 3, 10, 10, 3, -10, 10],
          triangles: [0, 1, 2, 0, 2, 3],
          faceGroups: [{ start: 0, count: 6, faceId: 1 }],
        },
      },
    };
    expect(bodyUnderRegion(yz, square, [wall])).toBe("wall");
  });

  it("returns null for an empty outline", () => {
    expect(bodyUnderRegion(frame, [], [slab("body1", 0)])).toBeNull();
  });
});
