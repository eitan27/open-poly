import { describe, expect, it } from "vitest";
import { clamp } from "./clamp";

describe("clamp", () => {
  it("passes values already inside the range through unchanged", () => {
    expect(clamp(5, 0, 10)).toBe(5);
  });

  it("clamps below the minimum", () => {
    expect(clamp(-3, 0, 10)).toBe(0);
  });

  it("clamps above the maximum", () => {
    expect(clamp(15, 0, 10)).toBe(10);
  });

  it("handles min === max", () => {
    expect(clamp(7, 4, 4)).toBe(4);
  });

  it("works with negative ranges", () => {
    expect(clamp(-1, -5, -2)).toBe(-2);
  });
});
