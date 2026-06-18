import { describe, expect, it } from "vitest";
import { detectSketchRegions } from "./regions";
import type { SketchEntity, Vec2 } from "./types";

let n = 0;
const line = (a: Vec2, b: Vec2): SketchEntity => ({ type: "line", id: `l${n++}`, a, b });

// Shared geometry: two 4-sided polygons sharing edge B-C, plus a 3-sided polygon
// sharing edge C-D with the first square.
//   A(0,0) B(2,0) C(2,2) D(0,2)   E(4,0) F(4,2)   G(1,4)
const A: Vec2 = [0, 0], B: Vec2 = [2, 0], C: Vec2 = [2, 2], D: Vec2 = [0, 2];
const E: Vec2 = [4, 0], F: Vec2 = [4, 2], G: Vec2 = [1, 4];

const areas = (ents: SketchEntity[]) =>
  detectSketchRegions(ents)
    .map((r) => Math.round(r.area * 100) / 100)
    .sort((x, y) => x - y);

describe("detectSketchRegions", () => {
  it("finds two squares bridged into a middle region", () => {
    // Left square, right square, and two bridge lines forming a middle rect.
    const ents = [
      line([0, 0], [2, 0]), line([2, 0], [2, 2]), line([2, 2], [0, 2]), line([0, 2], [0, 0]),
      line([4, 0], [6, 0]), line([6, 0], [6, 2]), line([6, 2], [4, 2]), line([4, 2], [4, 0]),
      line([2, 0], [4, 0]), line([4, 2], [2, 2]),
    ];
    expect(areas(ents)).toEqual([4, 4, 4]);
  });

  it("finds all three faces when shared edges appear once (single stroke)", () => {
    const ents = [
      line(A, B), line(B, C), line(C, D), line(D, A), // square 1
      line(B, E), line(E, F), line(F, C), // square 2 (shares B-C)
      line(C, G), line(G, D), // triangle (shares C-D)
    ];
    expect(areas(ents)).toEqual([2, 4, 4]);
  });

  it("finds all three faces when shared edges are duplicated (drawn per-polygon)", () => {
    // Regression: drawing each polygon separately duplicates the shared edges
    // (B-C and C-D each twice). The duplicates must not collapse the inner
    // faces into a single outer region. (Previously this returned 1 region.)
    const ents = [
      line(A, B), line(B, C), line(C, D), line(D, A), // square 1
      line(B, E), line(E, F), line(F, C), line(C, B), // square 2 (+ dup C-B)
      line(D, C), line(C, G), line(G, D), // triangle (+ dup D-C)
    ];
    expect(areas(ents)).toEqual([2, 4, 4]);
  });

  it("treats a circle as one region", () => {
    const ents: SketchEntity[] = [{ type: "circle", id: "c0", c: [0, 0], r: 2 }];
    const regions = detectSketchRegions(ents);
    expect(regions).toHaveLength(1);
    expect(regions[0].area).toBeCloseTo(Math.PI * 4, 5);
  });
});
