import { describe, expect, it } from "vitest";
import { dist2, mag2, approxEqual2, angleOf2 } from "./vec2";

describe("vec2", () => {
  it("dist2 computes distance between two points", () => {
    expect(dist2([0, 0], [3, 4])).toBe(5);
  });

  it("mag2 computes vector magnitude", () => {
    expect(mag2([3, 4])).toBe(5);
  });

  it("approxEqual2 is true within eps", () => {
    expect(approxEqual2([0, 0], [0, 0.0001], 0.001)).toBe(true);
  });

  it("approxEqual2 is false beyond eps", () => {
    expect(approxEqual2([0, 0], [1, 0], 0.001)).toBe(false);
  });

  it("angleOf2 returns 0 for a point directly to the right", () => {
    expect(angleOf2([0, 0], [1, 0])).toBeCloseTo(0);
  });

  it("angleOf2 returns pi/2 for a point directly above", () => {
    expect(angleOf2([0, 0], [0, 1])).toBeCloseTo(Math.PI / 2);
  });
});
