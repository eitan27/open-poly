import { describe, it, expect } from "vitest";
import { parseDxfToEntities, arcFromBulge } from "./dxfImport";
import type { SketchEntity, Vec2 } from "./types";

/** Build a minimal DXF ENTITIES section from raw (code,value) pair lines. */
function dxf(...pairs: Array<[number, string | number]>): string {
  const lines: string[] = ["0", "SECTION", "2", "ENTITIES"];
  for (const [code, value] of pairs) lines.push(String(code), String(value));
  lines.push("0", "ENDSEC", "0", "EOF");
  return lines.join("\n");
}

const arcAt = (c: Vec2, r: number, t: number): Vec2 => [c[0] + r * Math.cos(t), c[1] + r * Math.sin(t)];

describe("arcFromBulge", () => {
  it("makes a semicircle for bulge = 1 (CCW: apex below a left→right chord)", () => {
    const a = arcFromBulge([0, 0], [10, 0], 1)!;
    expect(a).not.toBeNull();
    expect(a.c[0]).toBeCloseTo(5);
    expect(a.c[1]).toBeCloseTo(0);
    expect(a.r).toBeCloseTo(5);
    // Endpoints land on p0 and p1.
    expect(arcAt(a.c, a.r, a.start)).toEqual([expect.closeTo(0), expect.closeTo(0)]);
    expect(arcAt(a.c, a.r, a.end)).toEqual([expect.closeTo(10), expect.closeTo(0)]);
    // A positive (CCW) bulge on a left→right chord bulges to the right = below.
    const mid = arcAt(a.c, a.r, (a.start + a.end) / 2);
    expect(mid[1]).toBeCloseTo(-5);
  });

  it("passes through both endpoints for a shallow positive bulge", () => {
    const a = arcFromBulge([0, 0], [10, 0], Math.tan(Math.PI / 8))!; // 90° arc
    expect(arcAt(a.c, a.r, a.start)).toEqual([expect.closeTo(0), expect.closeTo(0)]);
    expect(arcAt(a.c, a.r, a.end)).toEqual([expect.closeTo(10), expect.closeTo(0)]);
    const mid = arcAt(a.c, a.r, (a.start + a.end) / 2);
    expect(mid[1]).toBeLessThan(0); // CCW bulge → below the chord
  });

  it("handles a negative (clockwise) bulge as a valid CCW arc above the chord", () => {
    const a = arcFromBulge([0, 0], [10, 0], -1)!;
    expect(a.end).toBeGreaterThan(a.start); // CCW: end > start
    expect(arcAt(a.c, a.r, a.start)).toEqual([expect.closeTo(10), expect.closeTo(0)]);
    expect(arcAt(a.c, a.r, a.end)).toEqual([expect.closeTo(0), expect.closeTo(0)]);
    const mid = arcAt(a.c, a.r, (a.start + a.end) / 2);
    expect(mid[1]).toBeCloseTo(5); // clockwise bulge → above the chord
  });

  it("returns null for a straight (zero-bulge) segment", () => {
    expect(arcFromBulge([0, 0], [10, 0], 0)).toBeNull();
  });
});

describe("parseDxfToEntities", () => {
  it("converts LINE, CIRCLE, ARC with scaling", () => {
    const src = dxf(
      [0, "LINE"], [8, 0], [10, 0], [20, 0], [11, 10], [21, 5],
      [0, "CIRCLE"], [8, 0], [10, 20], [20, 20], [40, 4],
      [0, "ARC"], [8, 0], [10, 0], [20, 30], [40, 5], [50, 0], [51, 90],
    );
    const { entities, counts } = parseDxfToEntities(src, { scale: 2 });
    const line = entities.find((e) => e.type === "line") as Extract<SketchEntity, { type: "line" }>;
    expect(line.a).toEqual([0, 0]);
    expect(line.b).toEqual([20, 10]);
    const circ = entities.find((e) => e.type === "circle") as Extract<SketchEntity, { type: "circle" }>;
    expect(circ.c).toEqual([40, 40]);
    expect(circ.r).toBe(8);
    const arc = entities.find((e) => e.type === "arc") as Extract<SketchEntity, { type: "arc" }>;
    expect(arc.r).toBe(10);
    expect(arc.start).toBeCloseTo(0);
    expect(arc.end).toBeCloseTo(Math.PI / 2); // 90° → radians
    expect(counts).toEqual({ line: 1, circle: 1, arc: 1 });
  });

  it("expands a closed LWPOLYLINE (with a bulge) into lines + an arc that closes the loop", () => {
    const src = dxf(
      [0, "LWPOLYLINE"], [8, 0], [90, 3], [70, 1],
      [10, 0], [20, 0], [42, 0.5],
      [10, 10], [20, 0],
      [10, 10], [20, 10],
    );
    const { entities } = parseDxfToEntities(src);
    // 3 vertices, closed → 3 segments; first carries a bulge (arc).
    expect(entities).toHaveLength(3);
    expect(entities.filter((e) => e.type === "arc")).toHaveLength(1);
    expect(entities.filter((e) => e.type === "line")).toHaveLength(2);
  });

  it("maps TEXT and MTEXT to text entities with radians rotation", () => {
    const src = dxf(
      [0, "TEXT"], [8, 0], [10, 1], [20, 1], [40, 2.5], [1, "HELLO"], [50, 90],
      [0, "MTEXT"], [8, 0], [10, 5], [20, 6], [40, 3], [1, "{\\fArial;World}\\Pline2"], [50, 0],
    );
    const { entities } = parseDxfToEntities(src);
    const texts = entities.filter((e) => e.type === "text") as Extract<SketchEntity, { type: "text" }>[];
    expect(texts).toHaveLength(2);
    expect(texts[0].value).toBe("HELLO");
    expect(texts[0].height).toBe(2.5);
    expect(texts[0].rotation).toBeCloseTo(Math.PI / 2);
    // MTEXT formatting codes stripped, paragraph break → space.
    expect(texts[1].value).toBe("World line2");
  });

  it("samples a SPLINE onto its curve, passing through its endpoints", () => {
    const src = dxf(
      [0, "SPLINE"], [8, 0], [70, 8], [71, 3], [74, 0],
      [10, 0], [20, 0],
      [10, 1], [20, 2],
      [10, 3], [20, 2],
      [10, 4], [20, 0],
    );
    const { entities } = parseDxfToEntities(src);
    const spline = entities.find((e) => e.type === "spline") as Extract<SketchEntity, { type: "spline" }>;
    expect(spline).toBeTruthy();
    expect(spline.points.length).toBeGreaterThan(10);
    // A clamped B-spline interpolates its first and last control points.
    expect(spline.points[0]).toEqual([expect.closeTo(0), expect.closeTo(0)]);
    expect(spline.points[spline.points.length - 1]).toEqual([expect.closeTo(4), expect.closeTo(0)]);
  });

  it("welds sub-tolerance gaps so an exported outline chains into a closed loop", () => {
    // A square drawn as 4 separate LINE segments whose shared corners are off by
    // ~5e-4 (typical DXF export noise) — larger than region detection's 1e-4
    // vertex merge, so without healing the loop stays open.
    const src = dxf(
      [0, "LINE"], [8, 0], [10, 0], [20, 0], [11, 100.0005], [21, 0],
      [0, "LINE"], [8, 0], [10, 100], [20, 0.0004], [11, 100], [21, 100],
      [0, "LINE"], [8, 0], [10, 100.0003], [20, 100], [11, 0], [21, 100.0006],
      [0, "LINE"], [8, 0], [10, 0.0005], [20, 100], [11, 0.0002], [21, 0.0003],
      // A degenerate near-zero-length segment that should be dropped.
      [0, "LINE"], [8, 0], [10, 50], [20, 50], [11, 50.00001], [21, 50],
    );
    const { entities } = parseDxfToEntities(src);
    expect(entities.filter((e) => e.type === "line")).toHaveLength(4); // degenerate dropped
    // Every endpoint now coincides exactly with a neighbour — no open ends.
    const k = (p: [number, number]) => `${p[0].toFixed(4)},${p[1].toFixed(4)}`;
    const deg = new Map<string, number>();
    for (const e of entities) {
      if (e.type !== "line") continue;
      deg.set(k(e.a), (deg.get(k(e.a)) ?? 0) + 1);
      deg.set(k(e.b), (deg.get(k(e.b)) ?? 0) + 1);
    }
    expect([...deg.values()].every((d) => d === 2)).toBe(true);
  });

  it("reports unsupported entity types instead of dropping them silently", () => {
    const src = dxf([0, "ELLIPSE"], [8, 0], [10, 0], [20, 0], [11, 5], [21, 0], [40, 0.5]);
    const { entities, skipped } = parseDxfToEntities(src);
    expect(entities).toHaveLength(0);
    expect(skipped.ELLIPSE).toBe(1);
  });
});
