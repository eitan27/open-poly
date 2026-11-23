import { describe, expect, it } from "vitest";
import { rackDims, rackOutline, type GearToothSpec, type Vec2 } from "./gearProfile";

const spec = (over: Partial<GearToothSpec> = {}): GearToothSpec => ({
  teeth: 10,
  module: 2,
  pressureAngle: 20,
  profileShift: 0,
  backlash: 0,
  rootFillet: 0.76,
  ...over,
});

function area(poly: Vec2[]): number {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const [x1, y1] = poly[i];
    const [x2, y2] = poly[(i + 1) % poly.length];
    a += x1 * y2 - x2 * y1;
  }
  return a / 2;
}

function selfIntersects(poly: Vec2[]): boolean {
  const n = poly.length;
  const cross = (o: Vec2, a: Vec2, b: Vec2) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  for (let i = 0; i < n; i++) {
    const a = poly[i],
      b = poly[(i + 1) % n];
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue;
      const c = poly[j],
        d = poly[(j + 1) % n];
      if (cross(c, d, a) * cross(c, d, b) < 0 && cross(a, b, c) * cross(a, b, d) < 0) return true;
    }
  }
  return false;
}

/** Where the outline's top crosses the horizontal line y, sorted. */
function crossings(poly: Vec2[], y: number): number[] {
  const xs: number[] = [];
  for (let i = 0; i < poly.length; i++) {
    const [x1, y1] = poly[i];
    const [x2, y2] = poly[(i + 1) % poly.length];
    if ((y1 - y) * (y2 - y) < 0) xs.push(x1 + ((y - y1) * (x2 - x1)) / (y2 - y1));
  }
  return xs.sort((a, b) => a - b);
}

describe("rackOutline", () => {
  it("is a closed CCW outline, teeth × π × module long, without crossings", () => {
    const r = rackOutline(spec(), { height: 10 });
    expect(area(r.outline)).toBeGreaterThan(0);
    expect(selfIntersects(r.outline)).toBe(false);
    const xs = r.outline.map((p) => p[0]);
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(10 * Math.PI * 2, 9);
    expect(r.rack.length).toBeCloseTo(20 * Math.PI, 9);
    const ys = r.outline.map((p) => p[1]);
    expect(Math.max(...ys)).toBeCloseTo(2, 9); // addendum 1 × m
    expect(Math.min(...ys)).toBeCloseTo(-10, 9); // the back
    expect(r.rack.totalHeight).toBeCloseTo(12, 9);
  });

  it("has teeth half a pitch thick on the pitch line, centred half a pitch in from each end", () => {
    const r = rackOutline(spec({ rootFillet: 0 }), { height: 10 });
    const xs = crossings(r.outline, 0);
    // A pair of flanks per tooth (the ends stop at the root line).
    expect(xs.length).toBe(2 * 10);
    const p = 2 * Math.PI;
    for (let k = 0; k < 10; k++) {
      const a = xs[2 * k];
      const b = xs[1 + 2 * k];
      expect(b - a).toBeCloseTo(p / 2, 9);
      expect((a + b) / 2).toBeCloseTo(-5 * p + (k + 0.5) * p, 9);
    }
  });

  it("thins each tooth by half the backlash", () => {
    const r = rackOutline(spec({ rootFillet: 0, backlash: 0.2 }), { height: 10 });
    const xs = crossings(r.outline, 0);
    expect(xs[1] - xs[0]).toBeCloseTo(Math.PI - 0.1, 9);
  });

  it("names the back and the two ends, and leaves the teeth unnamed", () => {
    const r = rackOutline(spec(), { height: 10, endMargin: 5 });
    const names = r.edgeNames.outline;
    expect(names.length).toBe(r.outline.length);
    expect(names[0]).toBe("back");
    expect(names[1]).toBe("end1");
    expect(names[names.length - 1]).toBe("end0");
    expect(names.filter((n) => n !== null).length).toBe(3);
    // The back runs the full length, margins included.
    const [a, b] = [r.outline[0], r.outline[1]];
    expect(b[0] - a[0]).toBeCloseTo(20 * Math.PI + 10, 9);
    // The ends go from the back up to the root line.
    expect(r.outline[2][1]).toBeCloseTo(-2.5, 9);
  });

  it("turns with its rotation", () => {
    const r = rackOutline(spec(), { height: 10, rotation: Math.PI / 2 });
    const ys = r.outline.map((p) => p[1]);
    expect(Math.max(...ys) - Math.min(...ys)).toBeCloseTo(20 * Math.PI, 9);
    const xs = r.outline.map((p) => p[0]);
    expect(Math.min(...xs)).toBeCloseTo(-2, 9); // teeth point −x (90° CCW of +y)
  });

  it("keeps a root fillet inside the space and stays valid at the extremes", () => {
    for (const pa of [10, 14.5, 20, 25])
      for (const teeth of [1, 2, 7])
        for (const backlash of [0, 0.3]) {
          const r = rackOutline(spec({ pressureAngle: pa, teeth, backlash, rootFillet: 5 }), { height: 4 });
          expect(selfIntersects(r.outline)).toBe(false);
          expect(area(r.outline)).toBeGreaterThan(0);
          expect(r.rootFillet).toBeGreaterThan(0);
        }
  });

  it("refuses numbers that can't make a rack", () => {
    expect(() => rackOutline(spec({ teeth: 0 }), { height: 10 })).toThrow(/at least 1/);
    expect(() => rackOutline(spec({ teeth: 2.5 }), { height: 10 })).toThrow(/whole number/);
    expect(() => rackOutline(spec(), { height: 2 })).toThrow(/height must be more/);
    expect(() => rackOutline(spec(), { height: 10, endMargin: -1 })).toThrow(/margin/);
    expect(() => rackOutline(spec({ backlash: 3.5 }), { height: 10 })).toThrow(/point/);
    // 35° with the standard dedendum: the flanks meet below the root.
    expect(() => rackOutline(spec({ pressureAngle: 35 }), { height: 10 })).toThrow(/overlap/);
  });

  it("dims add the margins and the addendum", () => {
    const d = rackDims(spec(), { height: 10, endMargin: 3 });
    expect(d.pitch).toBeCloseTo(2 * Math.PI, 12);
    expect(d.length).toBeCloseTo(20 * Math.PI + 6, 12);
    expect(d.totalHeight).toBe(12);
  });
});
