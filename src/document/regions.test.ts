import { describe, expect, it } from "vitest";
import { detectSketchRegions, regionProfileSegments, regionsEnclosedBy } from "./regions";
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

const arc = (c: Vec2, r: number, start: number, end: number): SketchEntity => ({ type: "arc", id: `a${n++}`, c, r, start, end });
const spline = (points: Vec2[]): SketchEntity => ({ type: "spline", id: `s${n++}`, points });

describe("detectSketchRegions — arcs & splines as boundaries", () => {
  it("closes a half-disk from a semicircle arc + its chord", () => {
    const ents = [arc([0, 0], 2, 0, Math.PI), line([-2, 0], [2, 0])];
    const regions = detectSketchRegions(ents);
    expect(regions).toHaveLength(1);
    // ~π·r²/2 = 6.28, slightly under from the 48-segment tessellation.
    expect(regions[0].area).toBeGreaterThan(6.1);
    expect(regions[0].area).toBeLessThan(6.29);
    expect(regions[0].entityIds).toHaveLength(2);
  });

  it("closes a region bounded by a spline + a line", () => {
    const sp = spline([[0, 0], [1, 1.5], [2, 0]]);
    const ln = line([2, 0], [0, 0]);
    const regions = detectSketchRegions([sp, ln]);
    expect(regions).toHaveLength(1);
    expect(regions[0].area).toBeGreaterThan(0);
    expect(regions[0].entityIds.sort()).toEqual([sp.id, ln.id].sort());
  });

  it("ignores an open spline that closes nothing (a sweep path)", () => {
    expect(detectSketchRegions([spline([[0, 0], [2, 1], [4, 0]])])).toHaveLength(0);
  });

  it("regionsEnclosedBy works from a curve's edge selection", () => {
    const a = arc([0, 0], 2, 0, Math.PI);
    const ln = line([-2, 0], [2, 0]);
    const found = regionsEnclosedBy([a, ln], new Set([a.id, ln.id]));
    expect(found).toHaveLength(1);
    // Missing the chord → not enclosed.
    expect(regionsEnclosedBy([a, ln], new Set([a.id]))).toHaveLength(0);
  });
});

describe("regionsEnclosedBy", () => {
  it("finds the region bounded by exactly the selected lines", () => {
    const square = [line(A, B), line(B, C), line(C, D), line(D, A)];
    const ids = new Set(square.map((l) => l.id));
    const found = regionsEnclosedBy(square, ids);
    expect(found).toHaveLength(1);
    expect(found[0].area).toBeCloseTo(4, 5);
  });

  it("ignores a partial loop (not fully enclosed)", () => {
    const square = [line(A, B), line(B, C), line(C, D), line(D, A)];
    const ids = new Set([square[0].id, square[1].id, square[2].id]); // missing D-A
    expect(regionsEnclosedBy(square, ids)).toHaveLength(0);
  });

  it("tolerates extra selected entities outside the loop", () => {
    const square = [line(A, B), line(B, C), line(C, D), line(D, A)];
    const stray = line(E, F);
    const ids = new Set([...square.map((l) => l.id), stray.id]);
    const found = regionsEnclosedBy([...square, stray], ids);
    expect(found).toHaveLength(1);
    expect(found[0].area).toBeCloseTo(4, 5);
  });

  it("finds a circle's region from its own edge selection", () => {
    const circle: SketchEntity = { type: "circle", id: "c1", c: [0, 0], r: 2 };
    const found = regionsEnclosedBy([circle], new Set(["c1"]));
    expect(found).toHaveLength(1);
    expect(found[0].area).toBeCloseTo(Math.PI * 4, 5);
  });

  it("finds both bridged regions when all their boundary lines are selected", () => {
    const ents = [
      line([0, 0], [2, 0]), line([2, 0], [2, 2]), line([2, 2], [0, 2]), line([0, 2], [0, 0]),
      line([4, 0], [6, 0]), line([6, 0], [6, 2]), line([6, 2], [4, 2]), line([4, 2], [4, 0]),
      line([2, 0], [4, 0]), line([4, 2], [2, 2]),
    ];
    const ids = new Set(ents.map((l) => l.id));
    const found = regionsEnclosedBy(ents, ids);
    expect(found.map((r) => Math.round(r.area * 100) / 100).sort((a, b) => a - b)).toEqual([4, 4, 4]);
  });
});

describe("regionProfileSegments", () => {
  const seg = (ents: SketchEntity[]) => {
    const r = detectSketchRegions(ents)[0];
    return regionProfileSegments(r, ents);
  };

  it("turns a lone circle into two half-arcs forming a true circle", () => {
    const ents: SketchEntity[] = [{ type: "circle", id: "c", c: [3, 1], r: 2 }];
    const res = seg(ents)!;
    expect(res.start).toEqual([5, 1]); // c + (r, 0)
    expect(res.segments).toEqual([
      { kind: "arc", mid: [3, 3], to: [1, 1] }, // through the top
      { kind: "arc", mid: [3, -1], to: [5, 1] }, // through the bottom, back to start
    ]);
  });

  it("chains a line/arc loop into one closed, oriented sequence", () => {
    // A half-disc: diameter line from (-2,0)→(2,0) + a semicircle arc back.
    const ents: SketchEntity[] = [
      { type: "line", id: "l", a: [-2, 0], b: [2, 0] },
      { type: "arc", id: "a", c: [0, 0], r: 2, start: 0, end: Math.PI },
    ];
    const res = seg(ents)!;
    expect(res.segments).toHaveLength(2);
    // Walk the chain and confirm it returns to the start.
    let cur = res.start;
    for (const s of res.segments) cur = s.to;
    expect(Math.hypot(cur[0] - res.start[0], cur[1] - res.start[1])).toBeLessThan(1e-9);
    expect(res.segments.some((s) => s.kind === "arc")).toBe(true);
  });

  it("keeps a pure polygon as exact line segments", () => {
    const ents: SketchEntity[] = [
      { type: "line", id: "a", a: [0, 0], b: [2, 0] },
      { type: "line", id: "b", a: [2, 0], b: [2, 2] },
      { type: "line", id: "c", a: [2, 2], b: [0, 2] },
      { type: "line", id: "d", a: [0, 2], b: [0, 0] },
    ];
    const res = seg(ents)!;
    expect(res.segments).toHaveLength(4);
    expect(res.segments.every((s) => s.kind === "line")).toBe(true);
  });

  it("falls back (undefined) when the boundary contains a spline", () => {
    const ents: SketchEntity[] = [
      { type: "spline", id: "s", points: [[0, 0], [2, 0], [2, 2], [0, 2], [0, 0]] },
    ];
    const r = detectSketchRegions(ents)[0];
    expect(r ? regionProfileSegments(r, ents) : undefined).toBeUndefined();
  });
});
