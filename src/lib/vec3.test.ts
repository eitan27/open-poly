import { describe, expect, it } from "vitest";
import { vlen, vunit, vcross, vdot } from "./vec3";

describe("vec3", () => {
  it("vlen computes Euclidean length", () => {
    expect(vlen([3, 4, 0])).toBe(5);
  });

  it("vlen floors zero-length vectors at 1", () => {
    expect(vlen([0, 0, 0])).toBe(1);
  });

  it("vunit normalizes to length 1", () => {
    const u = vunit([3, 4, 0]);
    expect(u[0]).toBeCloseTo(0.6);
    expect(u[1]).toBeCloseTo(0.8);
    expect(u[2]).toBeCloseTo(0);
  });

  it("vcross returns the right-handed cross product", () => {
    expect(vcross([1, 0, 0], [0, 1, 0])).toEqual([0, 0, 1]);
  });

  it("vdot returns the dot product", () => {
    expect(vdot([1, 2, 3], [4, 5, 6])).toBe(32);
  });

  it("vdot of perpendicular unit vectors is 0", () => {
    expect(vdot([1, 0, 0], [0, 1, 0])).toBe(0);
  });
});
