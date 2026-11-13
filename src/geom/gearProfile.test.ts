import { describe, expect, it } from "vitest";
import polygonClipping from "polygon-clipping";
import {
  centerDistance,
  dFlatPoints,
  gearDims,
  gearOutline,
  minTeethWithoutUndercut,
  type GearToothSpec,
  type Vec2,
} from "./gearProfile";
import { CIRCLE_FACETS, FACET_PITCH } from "./circleFacets";

const spec = (over: Partial<GearToothSpec> = {}): GearToothSpec => ({
  teeth: 20,
  module: 2,
  pressureAngle: 20,
  profileShift: 0,
  backlash: 0,
  rootFillet: 0.76,
  ...over,
});

const radius = (p: Vec2) => Math.hypot(p[0], p[1]);

/** The flanks are chords of a convex curve, so they sit a few microns inside
 *  it on each side: a measured thickness reads that much thin. */
const CHORD_TOL = 0.015;
const expectNear = (got: number, want: number) => expect(Math.abs(got - want)).toBeLessThan(CHORD_TOL);

function area(poly: Vec2[]): number {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const [x1, y1] = poly[i];
    const [x2, y2] = poly[(i + 1) % poly.length];
    a += x1 * y2 - x2 * y1;
  }
  return a / 2;
}

/** Whether any two non-adjacent edges of a closed polyline cross. */
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
      const d1 = cross(c, d, a),
        d2 = cross(c, d, b),
        d3 = cross(a, b, c),
        d4 = cross(a, b, d);
      if (d1 * d2 < 0 && d3 * d4 < 0) return true;
    }
  }
  return false;
}

/** Arc length of tooth 0 measured along the circle of radius r: where the
 *  outline crosses that circle either side of +u. */
function toothThicknessAt(outline: Vec2[], r: number, teeth: number): number {
  const angles: number[] = [];
  for (let i = 0; i < outline.length; i++) {
    const a = outline[i],
      b = outline[(i + 1) % outline.length];
    const ra = radius(a) - r,
      rb = radius(b) - r;
    if (ra * rb < 0) {
      const t = ra / (ra - rb);
      const p: Vec2 = [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])];
      const ang = Math.atan2(p[1], p[0]);
      if (Math.abs(ang) < Math.PI / teeth) angles.push(ang);
    }
  }
  expect(angles.length).toBe(2);
  return Math.abs(angles[0] - angles[1]) * r;
}

const rotate = (poly: Vec2[], a: number, dx = 0): Vec2[] =>
  poly.map(([x, y]) => [x * Math.cos(a) - y * Math.sin(a) + dx, x * Math.sin(a) + y * Math.cos(a)]);

const overlapArea = (a: Vec2[], b: Vec2[]): number =>
  polygonClipping
    .intersection([a], [b])
    .reduce(
      (s, poly) => s + poly.reduce((t, ring, k) => t + (k === 0 ? 1 : -1) * Math.abs(area(ring as Vec2[])), 0),
      0,
    );

describe("gearDims", () => {
  it("follows the standard proportions", () => {
    const d = gearDims(spec());
    expect(d.pitchDiameter).toBeCloseTo(40);
    expect(d.tipDiameter).toBeCloseTo(44);
    expect(d.rootDiameter).toBeCloseTo(35);
    expect(d.baseDiameter).toBeCloseTo(40 * Math.cos((20 * Math.PI) / 180));
  });
  it("moves both circles out with a positive shift", () => {
    const d = gearDims(spec({ profileShift: 0.5 }));
    expect(d.tipDiameter).toBeCloseTo(46);
    expect(d.rootDiameter).toBeCloseTo(37);
  });
  it("swaps addendum and dedendum for an internal gear", () => {
    const d = gearDims(spec({ teeth: 60 }), true);
    expect(d.tipDiameter).toBeCloseTo(116);
    expect(d.rootDiameter).toBeCloseTo(125);
  });
});

describe("gearOutline (external)", () => {
  it("is a simple CCW polygon between the root and tip circles", () => {
    const g = gearOutline(spec());
    expect(area(g.outline)).toBeGreaterThan(0);
    expect(selfIntersects(g.outline)).toBe(false);
    for (const p of g.outline) {
      expect(radius(p)).toBeGreaterThan(17.5 - 1e-6);
      expect(radius(p)).toBeLessThan(22 + 1e-6);
    }
    // Every tooth reaches the tip circle.
    expect(g.outline.filter((p) => Math.abs(radius(p) - 22) < 1e-6).length).toBeGreaterThanOrEqual(20);
  });

  it("has half the circular pitch as tooth thickness on the pitch circle", () => {
    const g = gearOutline(spec());
    expectNear(toothThicknessAt(g.outline, 20, 20), Math.PI); // πm/2, m = 2
  });

  it("gives up half the backlash per gear", () => {
    const g = gearOutline(spec({ backlash: 0.4 }));
    expectNear(toothThicknessAt(g.outline, 20, 20), Math.PI - 0.2);
  });

  it("thickens the tooth with a positive profile shift", () => {
    const g = gearOutline(spec({ profileShift: 0.3 }));
    expectNear(toothThicknessAt(g.outline, 20, 20), 2 * (Math.PI / 2 + 0.6 * Math.tan((20 * Math.PI) / 180)));
  });

  it("flags undercut below ~17 teeth at 20°", () => {
    expect(minTeethWithoutUndercut(20)).toBeCloseTo(17.1, 1);
    expect(gearOutline(spec({ teeth: 12 })).undercut).toBe(true);
    expect(gearOutline(spec({ teeth: 18 })).undercut).toBe(false);
    expect(gearOutline(spec({ teeth: 12, profileShift: 0.4 })).undercut).toBe(false);
  });

  it("stays simple for small and large tooth counts and pressure angles", () => {
    for (const teeth of [6, 8, 13, 17, 30, 51, 120]) {
      for (const pressureAngle of [14.5, 20, 25]) {
        const g = gearOutline(spec({ teeth, pressureAngle }));
        expect(selfIntersects(g.outline), `${teeth}T ${pressureAngle}°`).toBe(false);
      }
    }
  });

  it("clamps a fillet that can't fit, and uses none when asked for none", () => {
    const big = gearOutline(spec({ rootFillet: 50 }));
    expect(big.rootFillet).toBeLessThan(2);
    expect(selfIntersects(big.outline)).toBe(false);
    expect(gearOutline(spec({ rootFillet: 0 })).rootFillet).toBe(0);
  });

  it("refuses pointed teeth and nonsense input", () => {
    expect(() => gearOutline(spec({ teeth: 8, profileShift: 1.2 }))).toThrow(/point/);
    expect(() => gearOutline(spec({ teeth: 4 }))).toThrow(/at least 6/);
    expect(() => gearOutline(spec({ teeth: 20.5 }))).toThrow(/whole number/);
    expect(() => gearOutline(spec({ module: 0 }))).toThrow(/module/);
  });

  it("cuts a round or D-shaped bore, and refuses one that eats the teeth", () => {
    expect(gearOutline(spec(), { bore: { kind: "round", diameter: 8 } }).holes).toHaveLength(1);
    const d = gearOutline(spec(), { bore: { kind: "dflat", diameter: 5, acrossFlat: 4.5 } }).holes[0];
    expect(Math.max(...d.map((p) => p[0]))).toBeCloseTo(2, 6); // the flat sits 2 mm from centre
    expect(() => gearOutline(spec(), { bore: { kind: "round", diameter: 36 } })).toThrow(/root diameter/);
    expect(() => dFlatPoints(5, 5)).toThrow(/smaller/);
  });

  it("puts the bore and the rim on the shared circle stations, with fixed names", () => {
    const onStation = (p: Vec2) => {
      const k = Math.atan2(p[1], p[0]) / FACET_PITCH;
      return Math.abs(k - Math.round(k)) < 1e-9;
    };
    const round = gearOutline(spec(), { bore: { kind: "round", diameter: 8 } });
    expect(round.holes[0]).toHaveLength(CIRCLE_FACETS);
    expect(round.holes[0].every(onStation)).toBe(true);
    expect(round.edgeNames.holes[0]).toEqual(round.holes[0].map((_, i) => `bore${i}`));
    expect(round.edgeNames.outline).toBeNull(); // the teeth keep their numbered names

    // The bore's names don't depend on the tooth count.
    const more = gearOutline(spec({ teeth: 37 }), { bore: { kind: "round", diameter: 8 } });
    expect(more.edgeNames.holes[0]).toEqual(round.edgeNames.holes[0]);

    // A D-flat: the round part on stations except its two ends, the last edge the flat.
    const d = gearOutline(spec(), { bore: { kind: "dflat", diameter: 5, acrossFlat: 4.5 } });
    expect(d.holes[0].slice(1, -1).every(onStation)).toBe(true);
    const names = d.edgeNames.holes[0]!;
    expect(names[names.length - 1]).toBe("boreFlat");
    expect(names.slice(0, -1).every((n) => /^bore\d+$/.test(n!))).toBe(true);

    const ring = gearOutline(spec({ teeth: 60 }), { internal: true, rimWidth: 4 });
    expect(ring.outline.every(onStation)).toBe(true);
    expect(ring.edgeNames.outline![0]).toBe("rim0");
    expect(() => gearOutline(spec({ teeth: 60 }), { internal: true, rimWidth: 0.01 })).toThrow(/rim width/);
  });

  it("rotates as a whole", () => {
    const a = gearOutline(spec()).outline;
    const b = gearOutline(spec(), { rotation: Math.PI / 20 }).outline;
    expect(radius(b[0])).toBeCloseTo(radius(a[0]));
    expect(Math.atan2(b[0][1], b[0][0]) - Math.atan2(a[0][1], a[0][0])).toBeCloseTo(Math.PI / 20);
  });
});

describe("meshing", () => {
  it("a 20T and a 31T pair with backlash never overlap as they turn", () => {
    const a = gearOutline(spec({ teeth: 20, backlash: 0.1 })).outline;
    const b = gearOutline(spec({ teeth: 31, backlash: 0.1 })).outline;
    const cd = centerDistance(2, 20, 31);
    // B sits at +u; a space of B must face A, i.e. B turned by half a pitch
    // (odd count: tooth 0 at +u means a space at −u).
    for (let step = 0; step < 8; step++) {
      const da = ((2 * Math.PI) / 20) * (step / 8);
      const pa = rotate(a, da);
      const pb = rotate(b, Math.PI + Math.PI / 31 - (da * 20) / 31, cd);
      expect(overlapArea(pa, pb)).toBeLessThan(1e-3);
    }
  });

  it("the same pair without the play overlaps once pushed closer — the test can fail", () => {
    const a = gearOutline(spec({ teeth: 20 })).outline;
    const b = gearOutline(spec({ teeth: 31 })).outline;
    const pb = rotate(b, Math.PI + Math.PI / 31, centerDistance(2, 20, 31) - 0.5);
    expect(overlapArea(a, pb)).toBeGreaterThan(0.1);
  });

  it("a 20T pinion runs inside a 60T ring gear without overlapping it", () => {
    const pinion = gearOutline(spec({ teeth: 20, backlash: 0.1 })).outline;
    const ring = gearOutline(spec({ teeth: 60, backlash: 0.1 }), { internal: true, rimWidth: 4 });
    expect(selfIntersects(ring.holes[0])).toBe(false);
    const cd = centerDistance(2, 60, 20, true);
    const ringPoly = (rot: number): Vec2[][] => [ring.outline, rotate(ring.holes[0], rot)];
    for (let step = 0; step < 6; step++) {
      const da = ((2 * Math.PI) / 20) * (step / 6);
      // Pinion at +u inside the ring: its tooth 0 faces a ring SPACE, and the
      // ring's space 0 is centred on +u, so no phase offset is needed.
      const pp = rotate(pinion, da, cd);
      const inter = polygonClipping.intersection([pp], ringPoly((da * 20) / 60) as never);
      const a = inter.reduce((s, poly) => s + Math.abs(area(poly[0] as Vec2[])), 0);
      expect(a).toBeLessThan(1e-3);
    }
  });
});
