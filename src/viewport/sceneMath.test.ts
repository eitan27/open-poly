import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { fitCircle, nearestOnSegment, transformMatrix } from "./sceneMath";

const at = (m: THREE.Matrix4, x: number, y: number, z: number) => new THREE.Vector3(x, y, z).applyMatrix4(m);
const Z = { origin: [0, 0, 0] as [number, number, number], dir: [0, 0, 1] as [number, number, number] };

describe("transformMatrix", () => {
  it("is a pure translation when there is no rotation and no scale", () => {
    const p = at(transformMatrix([0, 0, 0], 5, 6, 7, 0, Z, 1), 1, 2, 3);
    expect([p.x, p.y, p.z].map((n) => +n.toFixed(6))).toEqual([6, 8, 10]);
  });

  it("rotates about the axis LINE, not the pivot — this is what makes a body hinge", () => {
    // The case a world-axis-only signature cannot express: the pivot is the
    // body's own centre, but the axis is an edge a long way from it, so the body
    // swings around the edge instead of spinning on the spot.
    const edge = { origin: [10, 0, 0] as [number, number, number], dir: [0, 0, 1] as [number, number, number] };
    const p = at(transformMatrix([0, 0, 0], 0, 0, 0, 90, edge, 1), 11, 0, 0);
    expect(p.x).toBeCloseTo(10);
    expect(p.y).toBeCloseTo(1);
    expect(p.z).toBeCloseTo(0);
  });

  it("leaves a point on the axis fixed under rotation alone", () => {
    const axis = { origin: [3, 4, 0] as [number, number, number], dir: [0, 0, 1] as [number, number, number] };
    const p = at(transformMatrix([9, 9, 9], 0, 0, 0, 45, axis, 1), 3, 4, 5);
    expect(p.x).toBeCloseTo(3);
    expect(p.y).toBeCloseTo(4);
    expect(p.z).toBeCloseTo(5);
  });

  it("scales about the PIVOT, which need not be the axis origin", () => {
    const p = at(transformMatrix([10, 0, 0], 0, 0, 0, 0, Z, 2), 12, 0, 0);
    expect(p.x).toBeCloseTo(14); // 2 units from the pivot becomes 4
    const pivot = at(transformMatrix([10, 0, 0], 0, 0, 0, 0, Z, 2), 10, 0, 0);
    expect(pivot.x).toBeCloseTo(10);
  });

  it("composes as T·R·S — the translation is not rotated or scaled", () => {
    // If the order were wrong, a 90° turn would swing the (10,0,0) offset onto y.
    const p = at(transformMatrix([0, 0, 0], 10, 0, 0, 90, Z, 2), 1, 0, 0);
    expect(p.x).toBeCloseTo(10); // translation stays on x
    expect(p.y).toBeCloseTo(2); // the scaled-then-rotated point
  });

  it("matches the kernel for the identity case", () => {
    const m = transformMatrix([1, 2, 3], 0, 0, 0, 0, Z, 1);
    expect(m.equals(new THREE.Matrix4())).toBe(true);
  });
});

describe("nearestOnSegment", () => {
  it("projects a point onto the segment's interior", () => {
    expect(nearestOnSegment([5, 3], [0, 0], [10, 0])).toEqual([5, 0]);
  });

  it("clamps past either end rather than running off the line", () => {
    expect(nearestOnSegment([-7, 2], [0, 0], [10, 0])).toEqual([0, 0]);
    expect(nearestOnSegment([99, 2], [0, 0], [10, 0])).toEqual([10, 0]);
  });

  it("returns the endpoint for a degenerate (zero-length) segment", () => {
    expect(nearestOnSegment([4, 4], [2, 2], [2, 2])).toEqual([2, 2]);
  });
});

describe("fitCircle", () => {
  const ring = (n: number, r: number, z = 0) =>
    Array.from({ length: n }, (_, i) => {
      const a = (2 * Math.PI * i) / n;
      return new THREE.Vector3(Math.cos(a) * r, Math.sin(a) * r, z);
    });

  it("fits a ring of points", () => {
    const c = fitCircle(ring(32, 7, 2));
    expect(c?.radius).toBeCloseTo(7);
    expect(c?.center.z).toBeCloseTo(2);
    expect(Math.abs(c?.normal.z ?? 0)).toBeCloseTo(1);
  });

  it("rejects fewer than eight points, however circular", () => {
    expect(fitCircle(ring(7, 7))).toBeNull();
  });

  it("rejects a ring with one point pulled off it (not a circle)", () => {
    const pts = ring(32, 7);
    pts[5].setLength(9);
    expect(fitCircle(pts)).toBeNull();
  });

  it("accepts a point inside the 2% band", () => {
    const pts = ring(32, 7);
    pts[5].setLength(7 * 1.01);
    expect(fitCircle(pts)).not.toBeNull();
  });

  it("rejects a degenerate cluster at a single point", () => {
    expect(fitCircle(Array.from({ length: 16 }, () => new THREE.Vector3(1, 1, 1)))).toBeNull();
  });

  it("takes the normal from well-separated points, so storage order does not matter", () => {
    const a = fitCircle(ring(24, 5));
    const shuffled = ring(24, 5);
    const b = fitCircle([...shuffled.slice(12), ...shuffled.slice(0, 12)]);
    expect(Math.abs(a!.normal.dot(b!.normal))).toBeCloseTo(1);
  });
});
