import { describe, it, expect } from "vitest";
import { meshVolume, minorDiameter, threadMesh, type ThreadMesh } from "./thread";

/** Every edge used exactly once in each direction: closed and consistently wound. */
function edgeProblems(m: ThreadMesh): number {
  const count = new Map<string, number>();
  for (const { loop } of m.faces)
    for (let i = 0; i < loop.length; i++) {
      const k = `${loop[i]},${loop[(i + 1) % loop.length]}`;
      count.set(k, (count.get(k) ?? 0) + 1);
    }
  let bad = 0;
  for (const [k, n] of count) {
    const [a, b] = k.split(",");
    if (n !== 1 || count.get(`${b},${a}`) !== 1) bad++;
  }
  return bad;
}

/** Max distance of a face's vertices from the plane of its first three. */
function maxNonPlanarity(m: ThreadMesh): number {
  let worst = 0;
  for (const { loop } of m.faces) {
    if (loop.length < 4) continue;
    const [p, a, b] = loop.slice(0, 3).map((i) => m.vertices[i]);
    const u = [a[0] - p[0], a[1] - p[1], a[2] - p[2]];
    const v = [b[0] - p[0], b[1] - p[1], b[2] - p[2]];
    const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    const len = Math.hypot(n[0], n[1], n[2]);
    for (const i of loop.slice(3)) {
      const q = m.vertices[i];
      worst = Math.max(worst, Math.abs(((q[0] - p[0]) * n[0] + (q[1] - p[1]) * n[1] + (q[2] - p[2]) * n[2]) / len));
    }
  }
  return worst;
}

describe("threadMesh", () => {
  for (const [d, P, chamfer] of [
    [3, 0.5, true],
    [8, 1.25, false],
    [12, 1.75, true],
  ] as const) {
    it(`M${d}×${P}${chamfer ? " with a tip chamfer" : ""}: closed, outward, planar faces, sensible volume`, () => {
      const L = 10;
      const m = threadMesh({ d, pitch: P, offset: 0, z0: 0, z1: L, tipChamfer: chamfer });
      expect(edgeProblems(m)).toBe(0);
      expect(maxNonPlanarity(m)).toBeLessThan(1e-9);
      const v = meshVolume(m);
      const core = Math.PI * (minorDiameter(d, P) / 2) ** 2 * L;
      const outer = Math.PI * (d / 2) ** 2 * L;
      expect(v).toBeGreaterThan(core);
      expect(v).toBeLessThan(outer);
      // Every vertex inside [0, L] and within the major radius.
      for (const [x, y, z] of m.vertices) {
        expect(z).toBeGreaterThanOrEqual(-1e-9);
        expect(z).toBeLessThanOrEqual(L + 1e-9);
        expect(Math.hypot(x, y)).toBeLessThanOrEqual(d / 2 + 1e-9);
      }
    });
  }

  it("clearance shrinks a screw and grows a nut cavity", () => {
    const base = { d: 6, pitch: 1, z0: 0, z1: 8 };
    const v0 = meshVolume(threadMesh({ ...base, offset: 0 }));
    expect(meshVolume(threadMesh({ ...base, offset: -0.1 }))).toBeLessThan(v0);
    expect(meshVolume(threadMesh({ ...base, offset: 0.1 }))).toBeGreaterThan(v0);
  });

  it("is a right-hand helix: the crest climbs as θ goes from x toward y", () => {
    const m = threadMesh({ d: 10, pitch: 2, offset: 0, z0: 0, z1: 10, segments: 32 });
    const crest = m.vertices.filter(([x, y, z]) => Math.abs(Math.hypot(x, y) - 5) < 1e-9 && z > 3 && z < 7);
    const a = crest[0];
    const ang = (p: number[]) => Math.atan2(p[1], p[0]);
    // A quarter turn on (counter-clockwise from x toward y) the same crest
    // edge is a quarter pitch deeper.
    const quarter = crest.find((p) => {
      const d = (((ang(p) - ang(a)) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
      return Math.abs(d - Math.PI / 2) < 1e-9 && Math.abs(p[2] - a[2] - 0.5) < 1e-9;
    });
    expect(quarter).toBeDefined();
  });

  it("puts no vertex on the plane the thread starts from (z = 0) — booleans trip on that", () => {
    const m = threadMesh({ d: 3, pitch: 0.5, offset: 0, z0: -0.3, z1: 8 });
    // Half a station's rise (P / 2N, N = 32 here) clear of it.
    const clear = Math.min(...m.vertices.filter(([, , z]) => z > -0.3 + 1e-9).map(([, , z]) => Math.abs(z)));
    expect(clear).toBeGreaterThan(0.5 / 64 - 1e-9);
  });

  it("refuses a thread shorter than a pitch, or a clearance that eats the core", () => {
    expect(() => threadMesh({ d: 3, pitch: 0.5, offset: 0, z0: 0, z1: 0.4 })).toThrow(/too short/);
    expect(() => threadMesh({ d: 3, pitch: 0.5, offset: -1.3, z0: 0, z1: 5 })).toThrow(/no core/);
  });
});
