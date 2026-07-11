import { describe, expect, it } from "vitest";
import { measureBetween, resolveSide, footOnLine, type ResolvedSide } from "./distanceDim";
import type { DistanceRef, SketchEntity } from "../document/types";

const circle: SketchEntity = { type: "circle", id: "C", c: [0, 0], r: 3 };
const arc: SketchEntity = { type: "arc", id: "A", c: [5, 0], r: 2, start: 0, end: Math.PI };
const lineE: SketchEntity = { type: "line", id: "L", a: [-1, 0], b: [1, 0] };

describe("resolveSide", () => {
  it("resolves a point (circle centre), a line, and a rim", () => {
    const p: DistanceRef = { on: "point", ref: { entity: "C", at: "c" } };
    expect(resolveSide(p, [circle])).toEqual({ kind: "point", p: [0, 0] });
    expect(resolveSide({ on: "line", entity: "L" }, [lineE])).toEqual({ kind: "line", a: [-1, 0], b: [1, 0] });
    expect(resolveSide({ on: "rim", entity: "A" }, [arc])).toEqual({ kind: "rim", c: [5, 0], r: 2 });
  });

  it("rejects a mismatched on/entity kind and a missing entity", () => {
    expect(resolveSide({ on: "line", entity: "C" }, [circle])).toBeNull(); // circle isn't a line
    expect(resolveSide({ on: "rim", entity: "L" }, [lineE])).toBeNull(); // line isn't a rim
    expect(resolveSide({ on: "line", entity: "nope" }, [lineE])).toBeNull();
  });
});

describe("footOnLine", () => {
  it("drops a perpendicular onto the infinite line", () => {
    expect(footOnLine([3, 5], [0, 0], [10, 0])).toEqual([3, 0]);
    expect(footOnLine([-4, 2], [0, 0], [0, 10])).toEqual([0, 2]);
  });
});

const pt = (p: [number, number]): ResolvedSide => ({ kind: "point", p });
const rim = (c: [number, number], r: number): ResolvedSide => ({ kind: "rim", c, r });
const ln = (a: [number, number], b: [number, number]): ResolvedSide => ({ kind: "line", a, b });

describe("measureBetween", () => {
  it("point–point: straight distance, witnesses at the points", () => {
    const m = measureBetween(pt([0, 0]), pt([3, 4]))!;
    expect(m.value).toBeCloseTo(5);
    expect(m.wa).toEqual([0, 0]);
    expect(m.wb).toEqual([3, 4]);
  });

  it("point–line: perpendicular distance, witness from point to its foot", () => {
    const m = measureBetween(pt([0, 4]), ln([-5, 0], [5, 0]))!;
    expect(m.value).toBeCloseTo(4);
    expect(m.wa).toEqual([0, 4]);
    expect(m.wb).toEqual([0, 0]);
  });

  it("point–rim: nearest gap = centre distance − r, witness to the near rim point", () => {
    const m = measureBetween(pt([10, 0]), rim([0, 0], 3))!;
    expect(m.value).toBeCloseTo(7);
    expect(m.wb).toEqual([3, 0]); // near rim point
  });

  it("line–line parallel: perpendicular separation", () => {
    const m = measureBetween(ln([0, 0], [10, 0]), ln([0, 4], [10, 4]))!;
    expect(m.value).toBeCloseTo(4);
  });

  it("line–rim: tangent gap = perpendicular centre distance − r", () => {
    const m = measureBetween(ln([-5, 0], [5, 0]), rim([0, 8], 2))!;
    expect(m.value).toBeCloseTo(6);
    expect(m.wa).toEqual([0, 0]); // foot on the line
    expect(m.wb).toEqual([0, 6]); // near rim point
  });

  it("rim–rim: gap between the two boundaries along the centre line", () => {
    const m = measureBetween(rim([0, 0], 3), rim([10, 0], 2))!;
    expect(m.value).toBeCloseTo(5);
    expect(m.wa).toEqual([3, 0]);
    expect(m.wb).toEqual([8, 0]);
  });

  it("is order-independent (witnesses swap, value unchanged)", () => {
    const a = measureBetween(pt([0, 4]), ln([-5, 0], [5, 0]))!;
    const b = measureBetween(ln([-5, 0], [5, 0]), pt([0, 4]))!;
    expect(b.value).toBeCloseTo(a.value);
    expect(b.wa).toEqual(a.wb);
    expect(b.wb).toEqual(a.wa);
  });

  it("returns null for degenerate pairs (point on a circle's centre, concentric rims)", () => {
    expect(measureBetween(pt([0, 0]), rim([0, 0], 3))).toBeNull();
    expect(measureBetween(rim([0, 0], 3), rim([0, 0], 1))).toBeNull();
  });
});
