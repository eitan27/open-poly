import { describe, expect, it } from "vitest";
import { CIRCLE_FACETS, FACET_PITCH, arcStations, circleStations } from "./circleFacets";
import { sampleArc, sampleCircle } from "../document/sketchTools";

const TWO_PI = Math.PI * 2;
/** Every station is an integer multiple of the pitch — the property the whole
 *  module exists to guarantee. */
const onGrid = (a: number) => Math.abs(a / FACET_PITCH - Math.round(a / FACET_PITCH)) < 1e-9;

describe("circleStations", () => {
  it("covers one full turn at the fixed pitch, without repeating the start", () => {
    const s = circleStations();
    expect(s).toHaveLength(CIRCLE_FACETS);
    expect(s[0]).toBe(0);
    expect(s.every(onGrid)).toBe(true);
    for (let i = 1; i < s.length; i++) expect(s[i] - s[i - 1]).toBeCloseTo(FACET_PITCH, 12);
  });
});

describe("arcStations", () => {
  it("keeps both endpoints, exactly", () => {
    const s = arcStations(0.3, 1.7);
    expect(s[0]).toBe(0.3);
    expect(s[s.length - 1]).toBe(1.7);
  });

  it("puts every interior station on the grid, whatever the phase", () => {
    for (const start of [0, 0.01, 0.9, 1.875, 2.4, -0.7]) {
      const s = arcStations(start, start + Math.PI);
      const interior = s.slice(1, -1);
      expect(interior.length).toBeGreaterThan(0);
      expect(interior.every(onGrid)).toBe(true);
    }
  });

  it("emits stations in order and strictly inside the span", () => {
    const s = arcStations(0.4, 3.0);
    for (let i = 1; i < s.length; i++) expect(s[i]).toBeGreaterThan(s[i - 1]);
    for (const a of s.slice(1, -1)) {
      expect(a).toBeGreaterThan(0.4);
      expect(a).toBeLessThan(3.0);
    }
  });

  it("handles a reversed sweep", () => {
    const s = arcStations(2.0, 0.5);
    expect(s[0]).toBe(2.0);
    expect(s[s.length - 1]).toBe(0.5);
    for (let i = 1; i < s.length; i++) expect(s[i]).toBeLessThan(s[i - 1]);
    expect(s.slice(1, -1).every(onGrid)).toBe(true);
  });

  it("does not repeat an endpoint that already sits on a station", () => {
    const s = arcStations(0, FACET_PITCH * 4);
    expect(new Set(s.map((a) => a.toFixed(12))).size).toBe(s.length);
    expect(s).toHaveLength(5); // 0, three interior, and the end
  });

  it("a full turn yields the circle's own stations plus the closing point", () => {
    const s = arcStations(0, TWO_PI);
    expect(s).toHaveLength(CIRCLE_FACETS + 1);
    expect(s.slice(0, -1)).toEqual(circleStations());
  });
});

describe("the invariant that motivates all of this", () => {
  // A sketch arc concentric and coradial with a primitive cylinder must land on
  // that cylinder's own vertices, or the boolean between the two walls carves a
  // ribbon of hair-thin crescents up the joint.
  const key = (p: readonly number[]) => `${p[0].toFixed(9)},${p[1].toFixed(9)}`;

  it("an arc's interior points are a SUBSET of the full circle's, at any phase", () => {
    const r = 30;
    const circle = new Set(sampleCircle([0, 0], r).map(key));
    for (const phase of [0, 0.9, 1.875 * (Math.PI / 180), 7 * (Math.PI / 180), 2.3]) {
      const arc = sampleArc([0, 0], r, phase, phase + Math.PI);
      const interior = arc.slice(1, -1);
      expect(interior.length).toBeGreaterThan(10);
      for (const p of interior) expect(circle.has(key(p))).toBe(true);
    }
  });

  it("the same circle sampled twice gives identical points", () => {
    expect(sampleCircle([1, 2], 7).map(key)).toEqual(sampleCircle([1, 2], 7).map(key));
  });

  it("pitch no longer depends on the arc's span", () => {
    const step = (pts: readonly (readonly number[])[]) => Math.hypot(pts[2][0] - pts[1][0], pts[2][1] - pts[1][1]);
    const quarter = sampleArc([0, 0], 30, 0, Math.PI / 2);
    const half = sampleArc([0, 0], 30, 0, Math.PI);
    const full = sampleCircle([0, 0], 30);
    // Chord length between consecutive interior stations is the same everywhere.
    expect(step(quarter)).toBeCloseTo(step(half), 9);
    expect(step(half)).toBeCloseTo(step(full), 9);
  });

  it("still honours an explicit segment count, for callers that want one", () => {
    expect(sampleCircle([0, 0], 5, 12)).toHaveLength(13);
    expect(sampleArc([0, 0], 5, 0, 1, 8)).toHaveLength(9);
  });
});
