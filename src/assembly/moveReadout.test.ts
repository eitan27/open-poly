import { describe, expect, it } from "vitest";
import { addMoves, moveReadout, NO_MOVE } from "./moveReadout";
import { multiply, translation } from "./placement";
import { rotZ } from "./solve";

describe("moveReadout", () => {
  it("reads a shift as the pivot's move", () => {
    const r = moveReadout(translation([3, -4, 12.5]), [10, 10, 10], [0, 0, 1]);
    expect(r).toEqual({ tx: 3, ty: -4, tz: 12.5, angle: 0 });
  });

  it("reads a turn about the pivot as an angle and no shift", () => {
    const pivot: [number, number, number] = [5, 5, 0];
    const m = multiply(translation(pivot), multiply(rotZ((30 * Math.PI) / 180), translation([-5, -5, 0])));
    const r = moveReadout(m, pivot, [0, 0, 1]);
    expect(r.angle).toBeCloseTo(30, 9);
    expect(Math.hypot(r.tx, r.ty, r.tz)).toBeLessThan(1e-9);
    // About the opposite direction it's the opposite angle.
    expect(moveReadout(m, pivot, [0, 0, -1]).angle).toBeCloseTo(-30, 9);
  });

  it("adds moves", () => {
    expect(addMoves(NO_MOVE, { tx: 1, ty: 2, tz: 3, angle: 4 })).toEqual({ tx: 1, ty: 2, tz: 3, angle: 4 });
  });
});
