import { describe, it, expect } from "vitest";
import { PLANES, offsetFrame, planeIntersectionLine } from "./planes";

const unit = (v: [number, number, number]): [number, number, number] => {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
};

describe("planeIntersectionLine (revolve plane axis)", () => {
  it("top ∩ front is the world X axis through the origin", () => {
    const line = planeIntersectionLine(PLANES["plane-top"], PLANES["plane-front"]);
    expect(line).not.toBeNull();
    const dir = unit(line!.dir);
    // direction parallel to ±X
    expect(Math.abs(dir[0])).toBeCloseTo(1, 6);
    expect(Math.abs(dir[1])).toBeCloseTo(0, 6);
    expect(Math.abs(dir[2])).toBeCloseTo(0, 6);
    // both datum planes pass through the world origin
    expect(line!.origin[0]).toBeCloseTo(0, 6);
    expect(line!.origin[1]).toBeCloseTo(0, 6);
    expect(line!.origin[2]).toBeCloseTo(0, 6);
  });

  it("offset planes give the foot of the perpendicular on both planes", () => {
    // z = 5 (top offset 5) ∩ y = 3 (front offset 3) → line along X through (0,3,5)
    const a = offsetFrame(PLANES["plane-top"], 5);
    const b = offsetFrame(PLANES["plane-front"], 3);
    const line = planeIntersectionLine(a, b)!;
    expect(line.origin[0]).toBeCloseTo(0, 6);
    expect(line.origin[1]).toBeCloseTo(3, 6);
    expect(line.origin[2]).toBeCloseTo(5, 6);
    // the point lies on both planes: n·p = n·origin
    const onA = line.origin[2]; // top normal is +Z
    expect(onA).toBeCloseTo(5, 6);
    const onB = line.origin[1]; // front normal is +Y
    expect(onB).toBeCloseTo(3, 6);
  });

  it("returns null for parallel planes (no intersection line)", () => {
    const a = PLANES["plane-top"];
    const b = offsetFrame(PLANES["plane-top"], 10);
    expect(planeIntersectionLine(a, b)).toBeNull();
  });
});
