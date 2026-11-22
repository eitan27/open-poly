import { describe, expect, it } from "vitest";
import { fitRoundWall, roundWallOfMesh, type V3, type WallSample } from "./roundWall";

/** An n-gon prism wall about the axis through `c` along `dir`-ish Z, as the
 *  tessellation would give it: facet triangles, outward (or inward) normals. */
function prismMesh(n: number, r: number, z0: number, z1: number, inward = false, c: V3 = [0, 0, 0]) {
  const vertices: number[] = [];
  const normals: number[] = [];
  const triangles: number[] = [];
  const faceGroups: { start: number; count: number; faceId: number; clusterId: number }[] = [];
  for (let i = 0; i < n; i++) {
    const a0 = (2 * Math.PI * i) / n;
    const a1 = (2 * Math.PI * (i + 1)) / n;
    const am = (a0 + a1) / 2;
    const s = inward ? -1 : 1;
    const nrm: V3 = [Math.cos(am) * s, Math.sin(am) * s, 0];
    const base = vertices.length / 3;
    for (const [a, z] of [
      [a0, z0],
      [a1, z0],
      [a1, z1],
      [a0, z1],
    ]) {
      vertices.push(c[0] + r * Math.cos(a), c[1] + r * Math.sin(a), c[2] + z);
      normals.push(...nrm);
    }
    faceGroups.push({ start: triangles.length, count: 6, faceId: 100 + i, clusterId: 7 });
    triangles.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  return { vertices, normals, triangles, faceGroups };
}

describe("roundWallOfMesh", () => {
  it("reads a faceted rod: its axis, circumradius and extent, from one clicked strip", () => {
    const w = roundWallOfMesh(prismMesh(48, 5, 2, 14, false, [10, -3, 0]), 105)!;
    expect(w).not.toBeNull();
    expect(w.internal).toBe(false);
    expect(w.radius).toBeCloseTo(5, 6);
    expect(w.length).toBeCloseTo(12, 6);
    expect(w.dir.map((v) => v + 0)).toEqual([0, 0, 1]);
    expect(w.origin[0]).toBeCloseTo(10, 6);
    expect(w.origin[1]).toBeCloseTo(-3, 6);
    expect(w.origin[2]).toBeCloseTo(2, 6);
  });

  it("tells a hole's bore by its normals facing the axis", () => {
    const w = roundWallOfMesh(prismMesh(32, 4, 0, 10, true), 100)!;
    expect(w.internal).toBe(true);
    expect(w.radius).toBeCloseTo(4, 6);
  });

  it("refuses a flat face", () => {
    const flat = {
      vertices: [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0],
      triangles: [0, 1, 2, 0, 2, 3],
      faceGroups: [{ start: 0, count: 6, faceId: 1 }],
    };
    expect(roundWallOfMesh(flat, 1)).toBeNull();
  });
});

describe("fitRoundWall", () => {
  it("refuses a cone, whose normals aren't perpendicular to one axis", () => {
    const samples: WallSample[] = [];
    const points: V3[] = [];
    for (let i = 0; i < 12; i++) {
      const a = (2 * Math.PI * i) / 12;
      samples.push({ p: [Math.cos(a), Math.sin(a), 0], n: [Math.cos(a) * 0.8, Math.sin(a) * 0.8, 0.6], w: 1 });
      points.push([Math.cos(a), Math.sin(a), 0], [2 * Math.cos(a), 2 * Math.sin(a), -1]);
    }
    expect(fitRoundWall(samples, points)).toBeNull();
  });
});
