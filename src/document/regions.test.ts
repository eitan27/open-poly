import { describe, expect, it } from "vitest";
import { detectSketchRegions, regionProfileSegments, regionsEnclosedBy } from "./regions";
import type { SketchEntity, Vec2 } from "./types";

let n = 0;
const line = (a: Vec2, b: Vec2): SketchEntity => ({ type: "line", id: `l${n++}`, a, b });

// Shared geometry: two 4-sided polygons sharing edge B-C, plus a 3-sided polygon
// sharing edge C-D with the first square.
//   A(0,0) B(2,0) C(2,2) D(0,2)   E(4,0) F(4,2)   G(1,4)
const A: Vec2 = [0, 0],
  B: Vec2 = [2, 0],
  C: Vec2 = [2, 2],
  D: Vec2 = [0, 2];
const E: Vec2 = [4, 0],
  F: Vec2 = [4, 2],
  G: Vec2 = [1, 4];

const areas = (ents: SketchEntity[]) =>
  detectSketchRegions(ents)
    .map((r) => Math.round(r.area * 100) / 100)
    .sort((x, y) => x - y);

describe("detectSketchRegions", () => {
  it("finds two squares bridged into a middle region", () => {
    // Left square, right square, and two bridge lines forming a middle rect.
    const ents = [
      line([0, 0], [2, 0]),
      line([2, 0], [2, 2]),
      line([2, 2], [0, 2]),
      line([0, 2], [0, 0]),
      line([4, 0], [6, 0]),
      line([6, 0], [6, 2]),
      line([6, 2], [4, 2]),
      line([4, 2], [4, 0]),
      line([2, 0], [4, 0]),
      line([4, 2], [2, 2]),
    ];
    expect(areas(ents)).toEqual([4, 4, 4]);
  });

  it("finds all three faces when shared edges appear once (single stroke)", () => {
    const ents = [
      line(A, B),
      line(B, C),
      line(C, D),
      line(D, A), // square 1
      line(B, E),
      line(E, F),
      line(F, C), // square 2 (shares B-C)
      line(C, G),
      line(G, D), // triangle (shares C-D)
    ];
    expect(areas(ents)).toEqual([2, 4, 4]);
  });

  it("finds all three faces when shared edges are duplicated (drawn per-polygon)", () => {
    // Regression: drawing each polygon separately duplicates the shared edges
    // (B-C and C-D each twice). The duplicates must not collapse the inner
    // faces into a single outer region. (Previously this returned 1 region.)
    const ents = [
      line(A, B),
      line(B, C),
      line(C, D),
      line(D, A), // square 1
      line(B, E),
      line(E, F),
      line(F, C),
      line(C, B), // square 2 (+ dup C-B)
      line(D, C),
      line(C, G),
      line(G, D), // triangle (+ dup D-C)
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

describe("detectSketchRegions — subregions at T-junctions and crossings", () => {
  // A 4×2 box whose corners are shared vertices; interior lines below land
  // mid-edge (T-junctions) or cross each other (X), not on those corners.
  const box = () => [line([0, 0], [4, 0]), line([4, 0], [4, 2]), line([4, 2], [0, 2]), line([0, 2], [0, 0])];

  it("splits a box at a T-to-T chord into two cells", () => {
    // Vertical chord from mid-bottom (2,0) to mid-top (2,2): both endpoints are
    // T-junctions on edge interiors, not box vertices.
    const chord = line([2, 0], [2, 2]);
    expect(areas([...box(), chord])).toEqual([4, 4]);
  });

  it("splits a box at crossing diagonals into four cells", () => {
    const d1 = line([0, 0], [4, 2]);
    const d2 = line([0, 2], [4, 0]);
    const regions = detectSketchRegions([...box(), d1, d2]);
    expect(regions).toHaveLength(4);
    expect(regions.reduce((s, r) => s + r.area, 0)).toBeCloseTo(8, 5);
    // Ids must be unique so each cell is independently selectable/persistable.
    expect(new Set(regions.map((r) => r.id)).size).toBe(4);
  });

  it("splits a box by two edge-to-edge lines that also cross each other", () => {
    // A vertical and a horizontal chord crossing at (2,1): four 2×1 cells.
    const v = line([2, 0], [2, 2]);
    const h = line([0, 1], [4, 1]);
    expect(areas([...box(), v, h])).toEqual([2, 2, 2, 2]);
  });

  it("a line crossing clear through the box splits it (overhangs dangle)", () => {
    // The chord extends past both edges; the outside stubs are dangling edges.
    const long = line([2, -1], [2, 3]);
    expect(areas([...box(), long])).toEqual([4, 4]);
  });

  it("a dangling interior line creates no extra region", () => {
    // One end on the bottom edge, the other floating inside.
    const dangler = line([2, 0], [2, 1]);
    expect(areas([...box(), dangler])).toEqual([8]);
  });

  it("splits a circle crossed by a diameter line into two half-disks", () => {
    const circle: SketchEntity = { type: "circle", id: "c", c: [0, 0], r: 2 };
    // Vertical line through the center, overhanging both sides.
    const cut = line([0, -3], [0, 3]);
    const regions = detectSketchRegions([circle, cut]);
    expect(regions).toHaveLength(2);
    // Each ≈ half the 48-gon area.
    for (const r of regions) {
      expect(r.area).toBeGreaterThan(6.1);
      expect(r.area).toBeLessThan(Math.PI * 2 + 0.01);
    }
  });

  it("splits a circle crossed at its 0° seam (horizontal diameter)", () => {
    // The circle's polyline seam sits at angle 0 = (r, 0); a horizontal line
    // through the center crosses exactly there.
    const circle: SketchEntity = { type: "circle", id: "c", c: [0, 0], r: 2 };
    const cut = line([-3, 0], [3, 0]);
    const regions = detectSketchRegions([circle, cut]);
    expect(regions).toHaveLength(2);
    expect(regions.reduce((s, r) => s + r.area, 0)).toBeGreaterThan(12.2); // ≈ π·4
  });

  it("gives the four quadrants of a crossed circle unique, stable ids", () => {
    const circle: SketchEntity = { type: "circle", id: "c", c: [0, 0], r: 2 };
    const h = line([-3, 0], [3, 0]);
    const v = line([0, -3], [0, 3]);
    const regions = detectSketchRegions([circle, h, v]);
    expect(regions).toHaveLength(4);
    const ids1 = regions.map((r) => r.id).sort();
    expect(new Set(ids1).size).toBe(4);
    // Re-detection yields the same ids (features persist them).
    const ids2 = detectSketchRegions([circle, h, v])
      .map((r) => r.id)
      .sort();
    expect(ids2).toEqual(ids1);
  });

  it("a lone circle keeps its exact area and id (no junctions → old behavior)", () => {
    const circle: SketchEntity = { type: "circle", id: "c9", c: [1, 1], r: 1.5 };
    const regions = detectSketchRegions([circle]);
    expect(regions).toHaveLength(1);
    expect(regions[0].id).toBe("region-c9");
    expect(regions[0].area).toBeCloseTo(Math.PI * 2.25, 5);
  });

  it("regionsEnclosedBy resolves a subregion from its bounding entities", () => {
    const [bot, right, top, left] = box();
    const chord = line([2, 0], [2, 2]);
    const ents = [bot, right, top, left, chord];
    // Selecting the left cell's boundary (left edge + chord + split bottom/top)
    // encloses exactly the left cell.
    const found = regionsEnclosedBy(ents, new Set([left.id, chord.id, bot.id, top.id]));
    expect(found).toHaveLength(1);
    expect(found[0].area).toBeCloseTo(4, 5);
    // Selecting everything encloses both cells.
    expect(regionsEnclosedBy(ents, new Set(ents.map((e) => e.id)))).toHaveLength(2);
  });
});

describe("detectSketchRegions — nested island loops (holes)", () => {
  // A big box with a smaller, free-floating box entirely inside it (the inner
  // box touches nothing). The outer region should read as the frame (big minus
  // small), the inner box as its own face — each independently selectable.
  const big = () => [line([0, 0], [10, 0]), line([10, 0], [10, 10]), line([10, 10], [0, 10]), line([0, 10], [0, 0])];
  const small = () => [line([3, 3], [6, 3]), line([6, 3], [6, 6]), line([6, 6], [3, 6]), line([3, 6], [3, 3])];

  it("makes the outer region an annulus and the inner box its own region", () => {
    const regions = detectSketchRegions([...big(), ...small()]);
    expect(regions).toHaveLength(2);
    const outer = regions.find((r) => r.area > 50)!;
    const inner = regions.find((r) => r.area < 50)!;
    expect(inner.area).toBeCloseTo(9, 5); // 3×3 box
    expect(outer.area).toBeCloseTo(100 - 9, 5); // big minus the hole
    expect(outer.holes ?? []).toHaveLength(1); // the inner box is a hole
    expect(inner.holes ?? []).toHaveLength(0);
  });

  it("keeps three concentric boxes as three rings/faces with subtracted areas", () => {
    const mid = [line([2, 2], [8, 2]), line([8, 2], [8, 8]), line([8, 8], [2, 8]), line([2, 8], [2, 2])]; // 6×6 = 36
    const tiny = [line([4, 4], [6, 4]), line([6, 4], [6, 6]), line([6, 6], [4, 6]), line([4, 6], [4, 4])]; // 2×2 = 4
    const regions = detectSketchRegions([...big(), ...mid, ...tiny]);
    expect(regions).toHaveLength(3);
    expect(areas([...big(), ...mid, ...tiny])).toEqual([4, 32, 64]); // 4, 36−4, 100−36
  });

  it("a free-floating circle inside a box becomes a hole of the box", () => {
    const circle: SketchEntity = { type: "circle", id: "c", c: [5, 5], r: 2 };
    const regions = detectSketchRegions([...big(), circle]);
    expect(regions).toHaveLength(2);
    const box = regions.find((r) => r.area > 50)!;
    expect(box.holes ?? []).toHaveLength(1);
    expect(box.area).toBeCloseTo(100 - Math.PI * 4, 1); // 48-gon disk area
  });

  it("side-by-side (non-nested) regions get no holes", () => {
    // Two separate boxes; neither contains the other.
    const a = [line([0, 0], [2, 0]), line([2, 0], [2, 2]), line([2, 2], [0, 2]), line([0, 2], [0, 0])];
    const b = [line([5, 0], [7, 0]), line([7, 0], [7, 2]), line([7, 2], [5, 2]), line([5, 2], [5, 0])];
    const regions = detectSketchRegions([...a, ...b]);
    expect(regions).toHaveLength(2);
    for (const r of regions) expect(r.holes ?? []).toHaveLength(0);
  });
});

const arc = (c: Vec2, r: number, start: number, end: number): SketchEntity => ({
  type: "arc",
  id: `a${n++}`,
  c,
  r,
  start,
  end,
});
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
    const sp = spline([
      [0, 0],
      [1, 1.5],
      [2, 0],
    ]);
    const ln = line([2, 0], [0, 0]);
    const regions = detectSketchRegions([sp, ln]);
    expect(regions).toHaveLength(1);
    expect(regions[0].area).toBeGreaterThan(0);
    expect(regions[0].entityIds.sort()).toEqual([sp.id, ln.id].sort());
  });

  it("ignores an open spline that closes nothing (a sweep path)", () => {
    expect(
      detectSketchRegions([
        spline([
          [0, 0],
          [2, 1],
          [4, 0],
        ]),
      ]),
    ).toHaveLength(0);
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
      line([0, 0], [2, 0]),
      line([2, 0], [2, 2]),
      line([2, 2], [0, 2]),
      line([0, 2], [0, 0]),
      line([4, 0], [6, 0]),
      line([6, 0], [6, 2]),
      line([6, 2], [4, 2]),
      line([4, 2], [4, 0]),
      line([2, 0], [4, 0]),
      line([4, 2], [2, 2]),
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
      {
        type: "spline",
        id: "s",
        points: [
          [0, 0],
          [2, 0],
          [2, 2],
          [0, 2],
          [0, 0],
        ],
      },
    ];
    const r = detectSketchRegions(ents)[0];
    expect(r ? regionProfileSegments(r, ents) : undefined).toBeUndefined();
  });
});
