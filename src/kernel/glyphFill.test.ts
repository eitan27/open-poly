import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import opentype from "opentype.js";
import { glyphFillPolygons, glyphRings, resolveGlyphFill, ringArea, type Ring } from "./glyphFill";

// --- helpers ---------------------------------------------------------------
function pointInRing(p: [number, number], ring: Ring): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i],
      [xj, yj] = ring[j];
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
/** Even-odd point membership across an outer ring minus its hole rings. */
function pointInPolygon(p: [number, number], poly: Ring[]): boolean {
  let c = false;
  for (const ring of poly) if (pointInRing(p, ring)) c = !c;
  return c;
}
function segCross(a1: number[], a2: number[], b1: number[], b2: number[]): boolean {
  const d = (a: number[], b: number[], c: number[]) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  const d1 = d(b1, b2, a1),
    d2 = d(b1, b2, a2),
    d3 = d(a1, a2, b1),
    d4 = d(a1, a2, b2);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}
function ringSelfIntersects(ring: Ring): boolean {
  const n = ring.length;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (Math.abs(i - j) <= 1 || (i === 0 && j === n - 1)) continue;
      if (segCross(ring[i], ring[(i + 1) % n], ring[j], ring[(j + 1) % n])) return true;
    }
  }
  return false;
}
const square = (x0: number, y0: number, x1: number, y1: number, ccw: boolean): Ring => {
  const r: Ring = [
    [x0, y0],
    [x1, y0],
    [x1, y1],
    [x0, y1],
    [x0, y0],
  ];
  return ccw ? r : (r.reverse() as Ring);
};

// --- pure geometry ---------------------------------------------------------
describe("ringArea", () => {
  it("is positive CCW, negative CW", () => {
    expect(ringArea(square(0, 0, 10, 10, true))).toBeGreaterThan(0);
    expect(ringArea(square(0, 0, 10, 10, false))).toBeLessThan(0);
  });
});

describe("resolveGlyphFill", () => {
  it("subtracts an opposite-winding counter (annulus has a hole)", () => {
    const res = resolveGlyphFill([square(0, 0, 10, 10, true), square(3, 3, 7, 7, false)]);
    expect(res).toHaveLength(1);
    expect(res[0].length).toBe(2); // outer + 1 hole
    expect(pointInPolygon([1, 1], res[0])).toBe(true); // in the ring band
    expect(pointInPolygon([5, 5], res[0])).toBe(false); // in the counter
  });

  it("unions two overlapping SAME-winding strokes (the 't' crossbar case) with no spurious hole", () => {
    // A vertical stem and a horizontal bar that overlap — must fill the overlap.
    const stem = square(4, 0, 6, 10, true);
    const bar = square(0, 4, 10, 6, true);
    const res = resolveGlyphFill([stem, bar]);
    expect(res).toHaveLength(1);
    expect(res[0].length).toBe(1); // no holes
    expect(pointInPolygon([5, 5], res[0])).toBe(true); // the overlap is filled
    expect(pointInPolygon([5, 9], res[0])).toBe(true); // stem
    expect(pointInPolygon([9, 5], res[0])).toBe(true); // bar
  });
});

describe("glyphRings", () => {
  it("flattens a square path, flipping y to u,v", () => {
    const rings = glyphRings([
      { type: "M", x: 0, y: 0 },
      { type: "L", x: 10, y: 0 },
      { type: "L", x: 10, y: 10 },
      { type: "L", x: 0, y: 10 },
      { type: "Z" },
    ] as never);
    expect(rings).toHaveLength(1);
    // y is negated: input y=10 -> u,v y=-10.
    expect(rings[0].some(([, y]) => y === -10)).toBe(true);
  });
});

// --- against the bundled font: the actual bug -------------------------------
describe("glyphFillPolygons (Inter)", () => {
  const fontPath = fileURLToPath(new URL("../../public/fonts/Inter-Regular.ttf", import.meta.url));
  const buf = readFileSync(fontPath);
  const font = opentype.parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  const fill = (ch: string) => glyphFillPolygons(font.getPath(ch, 0, 0, 100).commands as never);

  it("resolves self-overlapping glyphs to SIMPLE (faceable) wires", () => {
    // These are exactly the letters that did not fill before the fix.
    for (const ch of ["e", "h", "v", "w", "x", "y", "m", "n"]) {
      const polys = fill(ch);
      expect(polys.length, `${ch} produced no fill`).toBeGreaterThan(0);
      for (const poly of polys)
        for (const ring of poly) {
          expect(ringSelfIntersects(ring), `${ch} still has a self-intersecting ring`).toBe(false);
        }
    }
  });

  it("keeps real counters as holes (o, a, B)", () => {
    expect(fill("o").some((p) => p.length > 1)).toBe(true);
    expect(fill("a").some((p) => p.length > 1)).toBe(true);
    // 'B' has two counters.
    expect(fill("B").reduce((n, p) => n + (p.length - 1), 0)).toBeGreaterThanOrEqual(2);
  });

  it("does NOT punch a hole through the 't' crossbar", () => {
    expect(fill("t").reduce((n, p) => n + (p.length - 1), 0)).toBe(0);
  });
});
