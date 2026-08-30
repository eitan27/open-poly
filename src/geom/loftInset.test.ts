import { describe, expect, it } from "vitest";
import { insetOutline, padOutline, ringEscapes, ringSignedArea, type Vec2 } from "./loftInset";

/** Smallest distance from `p` to the closed polyline `ring`. */
function distToRing(p: Vec2, ring: readonly Vec2[]): number {
  let best = Infinity;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const len2 = dx * dx + dy * dy;
    const t = len2 < 1e-18 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2));
    best = Math.min(best, Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy)));
  }
  return best;
}

const square = (s: number): Vec2[] => [
  [0, 0],
  [s, 0],
  [s, s],
  [0, s],
];

/** A CCW ring sampled from a closed spline-ish curve — the shape class the
 *  whole feature exists for, as a fine polyline rather than analytic curves. */
function blob(n: number): Vec2[] {
  return Array.from({ length: n }, (_, i) => {
    const t = (i * 2 * Math.PI) / n;
    const r = 20 + 6 * Math.sin(3 * t) + 3 * Math.cos(2 * t);
    return [r * Math.cos(t), r * Math.sin(t)] as Vec2;
  });
}

describe("insetOutline", () => {
  it("insets a square by the wall thickness on every side", () => {
    const inset = insetOutline(square(40), 3)!;
    expect(inset).not.toBeNull();
    const xs = inset.map((p) => p[0]);
    const ys = inset.map((p) => p[1]);
    expect(Math.min(...xs)).toBeCloseTo(3, 6);
    expect(Math.max(...xs)).toBeCloseTo(37, 6);
    expect(Math.min(...ys)).toBeCloseTo(3, 6);
    expect(Math.max(...ys)).toBeCloseTo(37, 6);
  });

  it("keeps the source's winding and starts near the source's start point", () => {
    // Both matter to ThruSections: it pairs sections by traversal order, so a
    // cavity station wound or started differently from its outer twin lofts
    // into a twisted side wall.
    const outline = blob(64);
    const inset = insetOutline(outline, 2)!;
    expect(ringSignedArea(outline)).toBeGreaterThan(0);
    expect(ringSignedArea(inset)).toBeGreaterThan(0);
    const startGap = Math.hypot(inset[0][0] - outline[0][0], inset[0][1] - outline[0][1]);
    // Within a wall's reach of the source start — not somewhere across the ring.
    expect(startGap).toBeLessThan(2 * 1.6);
  });

  it("holds the wall thickness all the way round a freeform section", () => {
    const outline = blob(120);
    const wall = 2.5;
    const inset = insetOutline(outline, wall)!;
    expect(inset).not.toBeNull();
    for (const p of inset) {
      // Never thinner than asked; the circumscribed corner joins allow a hair
      // more at convex corners, and a concave corner reaches further still.
      expect(distToRing(p, outline)).toBeGreaterThan(wall - 1e-6);
    }
  });

  it("does not self-intersect at a concave corner deeper than the wall", () => {
    // The naive per-vertex offset folds over here and lofts a cavity that pokes
    // out through the wall; the erosion just rounds the corner off.
    const l: Vec2[] = [
      [0, 0],
      [40, 0],
      [40, 12],
      [12, 12],
      [12, 40],
      [0, 40],
    ];
    const inset = insetOutline(l, 3)!;
    expect(inset).not.toBeNull();
    expect(ringSignedArea(inset)).toBeGreaterThan(0);
    // Every point of the result is inside the source by at least the wall.
    for (const p of inset) expect(distToRing(p, l)).toBeGreaterThan(3 - 1e-6);
    // The area is close to the true erosion: source minus a ~perimeter × wall
    // band, and nowhere near a folded-over ring's inflated or negative area.
    // The true erosion: 816 of section, less a ~160-long perimeter × 3 band,
    // plus what the corners give back. A folded-over ring would land far
    // outside that — inflated by the overlap, or negative outright.
    const a = ringSignedArea(inset);
    expect(a).toBeGreaterThan(340);
    expect(a).toBeLessThan(420);
  });

  it("insets a finely tessellated circle — the section a lofted circle becomes", () => {
    // A circle sketch reaches the kernel as a 96-gon, so its edges (~0.8 long
    // here) are much SHORTER than the wall. That broke the old corner joins:
    // placed only at reflex corners, they left an uncovered sliver at each of
    // the 96 convex ones, and the erosion came back as two polygons — refused
    // as "wall too thick" on a shape with room for five such walls. Worse, it
    // depended on the coordinates: the same circle nudged to a round centre
    // came through fine, so it looked intermittent.
    const c: Vec2 = [-18.6955, 11.1417];
    const r = 12.2034;
    const circle: Vec2[] = Array.from({ length: 96 }, (_, i) => {
      const t = (i * 2 * Math.PI) / 96;
      return [c[0] + r * Math.cos(t), c[1] + r * Math.sin(t)] as Vec2;
    });
    for (const wall of [0.5, 1, 2, 3]) {
      const inset = insetOutline(circle, wall);
      expect(inset, `wall ${wall}`).not.toBeNull();
      for (const p of inset!) {
        expect(distToRing(p, circle), `wall ${wall}`).toBeGreaterThan(wall - 1e-6);
        // …and it really is the concentric ring, not some fragment of one.
        expect(Math.hypot(p[0] - c[0], p[1] - c[1])).toBeLessThan(r - wall + 0.1);
      }
    }
  });

  it("opens a run of edges on a finely tessellated section", () => {
    // The loft case this exists for: a side face of a lofted circle, which
    // reaches the kernel as a run of chords rather than one smooth face.
    const circle: Vec2[] = Array.from({ length: 96 }, (_, i) => {
      const t = (i * 2 * Math.PI) / 96;
      return [12 * Math.cos(t), 12 * Math.sin(t)] as Vec2;
    });
    const open = new Set(Array.from({ length: 12 }, (_, k) => 30 + k));
    const inset = insetOutline(circle, 2, { openEdges: open, overshoot: 4 })!;
    expect(inset).not.toBeNull();
    expect(ringEscapes(inset, circle)).toBe(true);
    // It reaches out past the opened arc, while the rest stays a wall inside.
    expect(Math.max(...inset.map((p) => Math.hypot(p[0], p[1])))).toBeGreaterThan(12);
  });

  it("closes an opening the wall is too wide for, and says so via ringEscapes", () => {
    // One chord of a 96-gon is 0.78 across; walls of 2 either side of it meet
    // in the middle, so there is no opening left. That is the right geometry —
    // but it looks exactly like a sealed shell, so the caller has to be able to
    // tell. It is what made "add a face to open" look like it did nothing.
    const circle: Vec2[] = Array.from({ length: 96 }, (_, i) => {
      const t = (i * 2 * Math.PI) / 96;
      return [12 * Math.cos(t), 12 * Math.sin(t)] as Vec2;
    });
    const inset = insetOutline(circle, 2, { openEdges: new Set([37]), overshoot: 4 })!;
    expect(inset).not.toBeNull();
    expect(ringEscapes(inset, circle)).toBe(false);
    // A thin enough wall does fit through that same chord.
    const thin = insetOutline(circle, 0.25, { openEdges: new Set([37]), overshoot: 1 })!;
    expect(ringEscapes(thin, circle)).toBe(true);
  });

  it("ringEscapes sees an opening on a box, and none on a sealed inset", () => {
    expect(ringEscapes(insetOutline(square(40), 3)!, square(40))).toBe(false);
    const opened = insetOutline(square(40), 3, { openEdges: new Set([0]), overshoot: 5 })!;
    expect(ringEscapes(opened, square(40))).toBe(true);
  });

  // A loft between two DIFFERENTLY SIZED SQUARES: the plainest shape this
  // feature has to hollow, and the one whose side walls a user most obviously
  // expects to be able to open. Four points a section means each side of the
  // loft is ONE face rather than a run of tessellation slivers, so each is
  // individually openable — unlike a lofted circle, which arrives as 96 chords.
  //
  // The kernel half (cavity loft, end trims, subtraction) needs OCCT and lives
  // in verify-shell-loft.mjs; everything below is the 2D half that decides what
  // the opening actually is.
  describe("a loft between two squares", () => {
    const outer = square(30).map(([x, y]) => [x - 15, y - 15] as Vec2); // 30×30
    const inner = square(20).map(([x, y]) => [x - 10, y - 10] as Vec2); // 20×20
    const WALL = 2;
    const OVERSHOOT = 4;
    // Edge 0 of each section runs left→right along its bottom: the −y wall,
    // which is what `<loft>/side0` names.
    const openBottom = { openEdges: new Set([0]), overshoot: OVERSHOOT };

    it("insets both sections by the wall", () => {
      for (const [name, sec, half] of [
        ["outer", outer, 15],
        ["inner", inner, 10],
      ] as const) {
        const r = insetOutline(sec, WALL)!;
        expect(r, name).not.toBeNull();
        expect(Math.min(...r.map((p) => p[0])), name).toBeCloseTo(-half + WALL, 6);
        expect(Math.max(...r.map((p) => p[0])), name).toBeCloseTo(half - WALL, 6);
      }
    });

    it("opens the −y wall of both sections, and only that wall", () => {
      for (const [name, sec, half] of [
        ["outer", outer, 15],
        ["inner", inner, 10],
      ] as const) {
        const r = insetOutline(sec, WALL, openBottom)!;
        expect(r, name).not.toBeNull();
        // A real opening, not a wall that closed back over it.
        expect(ringEscapes(r, sec), name).toBe(true);
        // It crosses the −y boundary by the overshoot…
        expect(Math.min(...r.map((p) => p[1])), name).toBeCloseTo(-half - OVERSHOOT, 6);
        // …and the other three walls keep their full thickness, including
        // below the lip, where the side walls are carried down with it.
        expect(Math.max(...r.map((p) => p[1])), name).toBeCloseTo(half - WALL, 6);
        expect(Math.min(...r.map((p) => p[0])), name).toBeCloseTo(-half + WALL, 6);
        expect(Math.max(...r.map((p) => p[0])), name).toBeCloseTo(half - WALL, 6);
      }
    });

    it("leaves the other three sides openable one at a time", () => {
      // Each side of this loft is its own face, so each has to work alone.
      // Edge i of a CCW square breaches the side named by `ends` index i:
      // bottom (−y), right (+x), top (+y), left (−x).
      const edgeToSide = [0, 3, 1, 2];
      for (let edge = 0; edge < 4; edge++) {
        const r = insetOutline(outer, WALL, { openEdges: new Set([edge]), overshoot: OVERSHOOT })!;
        expect(r, `edge ${edge}`).not.toBeNull();
        expect(ringEscapes(r, outer), `edge ${edge}`).toBe(true);
        // Exactly one side is breached, by exactly the overshoot, and the
        // other three hold their full wall — including below the lip, which is
        // what the rails alongside an opening are for.
        const ends = [
          -Math.min(...r.map((p) => p[1])),
          Math.max(...r.map((p) => p[1])),
          -Math.min(...r.map((p) => p[0])),
          Math.max(...r.map((p) => p[0])),
        ];
        ends.forEach((reach, side) => {
          const expected = side === edgeToSide[edge] ? 15 + OVERSHOOT : 15 - WALL;
          expect(reach, `edge ${edge}, side ${side}`).toBeCloseTo(expected, 6);
        });
      }
    });

    it("hands the cavity two sections of equal length to loft through", () => {
      // An opening adds a lip to each section, and not the same number of
      // points to each — 80 and 83 on the harness's loft. `ThruSections` throws
      // a bare Standard_ConstructionError on section sets whose counts merely
      // differ, so they are padded to match before the cavity is built.
      // A hexagon lofted to a square is the shortest way to make them differ.
      const hexagon: Vec2[] = Array.from({ length: 6 }, (_, i) => {
        const t = (i * 2 * Math.PI) / 6;
        return [18 * Math.cos(t), 18 * Math.sin(t)] as Vec2;
      });
      const a = insetOutline(outer, WALL, openBottom)!;
      const b = insetOutline(hexagon, WALL, openBottom)!;
      expect(a.length).not.toBe(b.length); // …or this test proves nothing
      const target = Math.max(a.length, b.length);
      expect(padOutline(a, target)).toHaveLength(target);
      expect(padOutline(b, target)).toHaveLength(target);
    });

    it("pads a section without moving it", () => {
      const padded = padOutline(outer, 11);
      expect(padded).toHaveLength(11);
      // Same shape: same area, and every point still on the original boundary.
      expect(ringSignedArea(padded)).toBeCloseTo(ringSignedArea(outer), 9);
      for (const p of padded) expect(distToRing(p, outer)).toBeLessThan(1e-9);
      // Every original corner survives — padding only ever inserts.
      for (const corner of outer) {
        expect(padded.some((p) => Math.hypot(p[0] - corner[0], p[1] - corner[1]) < 1e-9)).toBe(true);
      }
      // Already long enough is left alone.
      expect(padOutline(outer, 3)).toHaveLength(4);
    });
  });

  it("holds the wall's full thickness right up to the lip of an opening", () => {
    // Where a wall runs into an opening, the material either side of the lip
    // has to stay a full wall thick — no thinner (the part would be weak there)
    // and no thicker (the opening would be narrower than the face asked for).
    // What delivers that is the RAIL: the wall carried on down the side of the
    // opening. A trapezoid, whose sides slope into the bottom edge, is the
    // shape that can tell: on a box the walls meet the opening at a right
    // angle, and several different constructions coincide.
    const trapezoid: Vec2[] = [
      [0, 0],
      [40, 0],
      [30, 30],
      [10, 30],
    ];
    for (const wall of [2, 3]) {
      const r = insetOutline(trapezoid, wall, { openEdges: new Set([0]), overshoot: wall * 2 })!;
      expect(r, `wall ${wall}`).not.toBeNull();
      // Both ends of the opening: the cavity comes a wall's width from the
      // lip, give or take a hair from the clipper.
      for (const lip of [
        [0, 0],
        [40, 0],
      ] as Vec2[]) {
        const reach = Math.min(...r.map((p) => Math.hypot(p[0] - lip[0], p[1] - lip[1])));
        expect(reach, `wall ${wall} at ${lip}`).toBeGreaterThan(wall - 1e-6);
        expect(reach, `wall ${wall} at ${lip}`).toBeLessThan(wall * 1.05);
      }
    }
  });

  it("refuses when the wall is too thick for the section", () => {
    expect(insetOutline(square(10), 6)).toBeNull();
    expect(insetOutline(square(10), 5)).toBeNull();
  });

  it("refuses a wall that pinches the section into two pieces", () => {
    // A dumbbell: two lobes joined by a 4-wide neck, so a 3 wall erodes the
    // neck away and leaves two rings. A loft carries one wire per station, and
    // quietly lofting the bigger piece would hand back a body with a wall
    // nobody asked for — so this refuses instead.
    const bar: Vec2[] = [
      [0, 0],
      [40, 0],
      [40, 19],
      [22, 19],
      [22, 23],
      [40, 23],
      [40, 42],
      [0, 42],
      [0, 23],
      [18, 23],
      [18, 19],
      [0, 19],
    ];
    expect(insetOutline(bar, 3)).toBeNull();
    // …and a wall the neck can carry still comes through.
    expect(insetOutline(bar, 1.5)).not.toBeNull();
  });

  it("refuses a non-positive or absurd thickness rather than guessing", () => {
    expect(insetOutline(square(40), 0)).toBeNull();
    expect(insetOutline(square(40), -2)).toBeNull();
    expect(insetOutline([[0, 0] as Vec2, [1, 1] as Vec2], 0.1)).toBeNull();
  });

  it("leaves an open edge unwalled and crosses it by the overshoot", () => {
    // Edge 0 runs (0,0) → (40,0), the bottom of the square; opening it is how a
    // lofted enclosure gets an open underside.
    const inset = insetOutline(square(40), 3, { openEdges: new Set([0]), overshoot: 5 })!;
    expect(inset).not.toBeNull();
    const ys = inset.map((p) => p[1]);
    // It reaches PAST the open edge, not just up to it — a coincident face is
    // exactly the boolean that comes back empty.
    expect(Math.min(...ys)).toBeCloseTo(-5, 6);
    expect(Math.max(...ys)).toBeCloseTo(37, 6);
    // …and the other three walls keep their full thickness — including BELOW
    // the opening, where the side walls are carried down with it. A cavity
    // that widened to the full section past the lip would eat the side walls'
    // bottom edge, which is not what opening a face means.
    const xs = inset.map((p) => p[0]);
    expect(Math.min(...xs)).toBeCloseTo(3, 6);
    expect(Math.max(...xs)).toBeCloseTo(37, 6);
    const belowLip = inset.filter((p) => p[1] < -1);
    expect(belowLip.length).toBeGreaterThan(0);
    for (const p of belowLip) {
      expect(p[0]).toBeGreaterThan(3 - 1e-6);
      expect(p[0]).toBeLessThan(37 + 1e-6);
    }
  });

  it("opens several edges at once", () => {
    const inset = insetOutline(square(40), 3, { openEdges: new Set([0, 2]), overshoot: 4 })!;
    expect(inset).not.toBeNull();
    const ys = inset.map((p) => p[1]);
    expect(Math.min(...ys)).toBeCloseTo(-4, 6);
    expect(Math.max(...ys)).toBeCloseTo(44, 6);
  });

  it("refuses when every edge is open — there is no wall left to build", () => {
    expect(insetOutline(square(40), 3, { openEdges: new Set([0, 1, 2, 3]), overshoot: 4 })).toBeNull();
  });

  it("ignores an open-edge index that isn't on the section", () => {
    const inset = insetOutline(square(40), 3, { openEdges: new Set([9]), overshoot: 4 });
    expect(inset).not.toBeNull();
    expect(Math.min(...inset!.map((p) => p[1]))).toBeCloseTo(3, 6);
  });

  it("tolerates a ring handed in with a duplicated closing point", () => {
    const closed: Vec2[] = [...square(40), [0, 0]];
    const inset = insetOutline(closed, 3)!;
    expect(inset).not.toBeNull();
    expect(Math.min(...inset.map((p) => p[0]))).toBeCloseTo(3, 6);
  });
});
