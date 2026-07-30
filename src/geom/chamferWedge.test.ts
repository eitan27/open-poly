import { describe, expect, it } from "vitest";
import {
  chamferLegs,
  chamferTriangle,
  dot,
  inFaceDirection,
  isConvexEdge,
  isRightAngle,
  legFits,
  unit,
  type V3,
} from "./chamferWedge";

// Two concrete configurations, used throughout so the expectations are checkable
// by hand rather than by re-deriving the formula under test.
//
// BOX — the top/front edge of a 20mm box sitting at the origin. The edge runs
// along +x at y = 0, z = 20. Material is y > 0 and z < 20, so the corner sticks
// out: CONVEX.
const box = {
  along: [1, 0, 0] as V3,
  edgeMid: [0, 0, 20] as V3,
  top: { normal: [0, 0, 1] as V3, centre: [0, 10, 20] as V3 },
  front: { normal: [0, -1, 0] as V3, centre: [0, 0, 10] as V3 },
};

// WALL — a wall standing on a top face, as when a semicircle is extruded from a
// cylinder's top. Same edge, but material is y > 0 AND z > 20 for the wall while
// the top face extends to y < 0: the corner is re-entrant, CONCAVE.
const wall = {
  along: [1, 0, 0] as V3,
  edgeMid: [0, 0, 20] as V3,
  wall: { normal: [0, -1, 0] as V3, centre: [0, 0, 30] as V3 },
  top: { normal: [0, 0, 1] as V3, centre: [0, -10, 20] as V3 },
};

describe("isRightAngle", () => {
  it("accepts perpendicular normals", () => {
    expect(isRightAngle([0, 0, 1], [0, -1, 0])).toBe(true);
    expect(isRightAngle([1, 0, 0], [0, 1, 0])).toBe(true);
  });
  it("rejects anything else, including parallel and anti-parallel", () => {
    expect(isRightAngle([0, 0, 1], [0, 0, 1])).toBe(false);
    expect(isRightAngle([0, 0, 1], [0, 0, -1])).toBe(false);
    const n = unit([0, 1, 1])!;
    expect(isRightAngle([0, 0, 1], n)).toBe(false);
  });
});

describe("inFaceDirection", () => {
  it("points into the face, not out of it", () => {
    // Into the box's top face from the front edge is +y (toward its centre).
    expect(inFaceDirection(box.along, box.top.normal, box.edgeMid, box.top.centre)).toEqual([0, 1, 0]);
    // Into the box's front face from the top edge is −z (downward).
    expect(inFaceDirection(box.along, box.front.normal, box.edgeMid, box.front.centre)).toEqual([0, 0, -1]);
  });

  it("flips when the face lies the other way", () => {
    // Same top plane, but this face extends to −y (the wall case).
    expect(inFaceDirection(wall.along, wall.top.normal, wall.edgeMid, wall.top.centre)).toEqual([0, -1, 0]);
  });

  it("is perpendicular to the edge and lies in the face", () => {
    const t = inFaceDirection(box.along, box.top.normal, box.edgeMid, box.top.centre)!;
    expect(dot(t, box.along)).toBeCloseTo(0, 12);
    expect(dot(t, box.top.normal)).toBeCloseTo(0, 12);
  });

  it("returns null when the edge runs along the normal (no tangent)", () => {
    expect(inFaceDirection([0, 0, 1], [0, 0, 1], [0, 0, 0], [0, 1, 0])).toBeNull();
  });
});

describe("isConvexEdge", () => {
  it("calls a box's outside corner convex", () => {
    const intoTop = inFaceDirection(box.along, box.top.normal, box.edgeMid, box.top.centre)!;
    expect(isConvexEdge(intoTop, box.front.normal)).toBe(true);
  });

  it("calls a wall standing on a face concave", () => {
    const intoWall = inFaceDirection(wall.along, wall.wall.normal, wall.edgeMid, wall.wall.centre)!;
    expect(intoWall).toEqual([0, 0, 1]); // up the wall
    expect(isConvexEdge(intoWall, wall.top.normal)).toBe(false);
  });

  // The two cases must disagree — a test that passed for both would be vacuous.
  it("separates the two configurations", () => {
    const intoTop = inFaceDirection(box.along, box.top.normal, box.edgeMid, box.top.centre)!;
    const intoWall = inFaceDirection(wall.along, wall.wall.normal, wall.edgeMid, wall.wall.centre)!;
    expect(isConvexEdge(intoTop, box.front.normal)).not.toBe(isConvexEdge(intoWall, wall.top.normal));
  });
});

describe("chamferLegs", () => {
  it("is symmetric at 45 degrees", () => {
    const l = chamferLegs(2, 45)!;
    expect(l.ref).toBe(2);
    expect(l.other).toBeCloseTo(2, 12);
  });

  it("follows size*tan(angle) off 45", () => {
    expect(chamferLegs(2, 30)!.other).toBeCloseTo(2 * Math.tan(Math.PI / 6), 12);
    expect(chamferLegs(2, 60)!.other).toBeCloseTo(2 * Math.tan(Math.PI / 3), 12);
    // Shallower than 45 gives a shorter far leg, steeper a longer one.
    expect(chamferLegs(2, 30)!.other).toBeLessThan(2);
    expect(chamferLegs(2, 60)!.other).toBeGreaterThan(2);
  });

  it("refuses degenerate sizes and angles", () => {
    expect(chamferLegs(0, 45)).toBeNull();
    expect(chamferLegs(-1, 45)).toBeNull();
    expect(chamferLegs(2, 0)).toBeNull();   // zero far leg: no wedge
    expect(chamferLegs(2, 90)).toBeNull();  // tan blows up
    expect(chamferLegs(2, 180)).toBeNull(); // tan(180) is ~0 and negative
    expect(chamferLegs(Number.NaN, 45)).toBeNull();
  });
});

describe("legFits", () => {
  it("passes when the leg is inside the face's reach", () => {
    expect(legFits(2, 20)).toBe(true);
  });
  it("fails at or past the reach — a 999mm chamfer on a 40mm box", () => {
    expect(legFits(999, 20)).toBe(false);
    expect(legFits(20, 20)).toBe(false);
  });
});

describe("chamferTriangle", () => {
  it("starts on the edge and steps each leg along its own face", () => {
    const legs = chamferLegs(2, 45)!;
    const tri = chamferTriangle([0, 0, 20], [0, 1, 0], [0, 0, -1], legs);
    expect(tri[0]).toEqual([0, 0, 20]);
    expect(tri[1]).toEqual([0, 2, 20]);
    expect(tri[2]).toEqual([0, 0, 18]);
  });

  it("puts the legs on the right faces when they differ", () => {
    const legs = chamferLegs(2, 60)!; // far leg ~3.46
    const tri = chamferTriangle([0, 0, 0], [1, 0, 0], [0, 1, 0], legs);
    expect(tri[1][0]).toBeCloseTo(2, 12);
    expect(tri[2][1]).toBeCloseTo(2 * Math.tan(Math.PI / 3), 12);
  });

  it("spans a real area, so the swept wedge is a solid", () => {
    const legs = chamferLegs(2, 45)!;
    const [a, b, c] = chamferTriangle([0, 0, 20], [0, 1, 0], [0, 0, -1], legs);
    const ab: V3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const ac: V3 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const n: V3 = [ab[1] * ac[2] - ab[2] * ac[1], ab[2] * ac[0] - ab[0] * ac[2], ab[0] * ac[1] - ab[1] * ac[0]];
    expect(Math.hypot(...n) / 2).toBeCloseTo(2, 12); // half of 2x2
  });
});
