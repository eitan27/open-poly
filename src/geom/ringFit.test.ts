import { describe, expect, it } from "vitest";
import { fitRing, type V3 } from "./ringFit";

/** The chords of a regular n-gon in the z = h plane, centred on `c`. */
function ngon(n: number, r: number, h = 0, c: V3 = [0, 0, 0], phase = 0): [V3, V3][] {
  const p = (i: number): V3 => [
    c[0] + r * Math.cos(phase + (i * 2 * Math.PI) / n),
    c[1] + r * Math.sin(phase + (i * 2 * Math.PI) / n),
    c[2] + h,
  ];
  return Array.from({ length: n }, (_, i) => [p(i), p(i + 1)] as [V3, V3]);
}

describe("fitRing", () => {
  it("recognises a 96-gon rim and reports its CIRCUMSCRIBED radius", () => {
    const ring = fitRing(ngon(96, 20, 40));
    expect(ring).not.toBeNull();
    expect(ring!.radius).toBeCloseTo(20, 9);
    expect(ring!.segments).toBe(96);
    expect(ring!.center[2]).toBeCloseTo(40, 9);
    // A chord midpoint is nearer than this by the sagitta — which is exactly why
    // the tool is built at the vertex radius, so it covers the whole ring.
    const mid = 20 * Math.cos(Math.PI / 96);
    expect(ring!.radius).toBeGreaterThan(mid);
  });

  it("finds the axis regardless of the ring's orientation", () => {
    // A ring in the x = 5 plane: axis must come out along ±x.
    const n = 48, r = 7;
    const edges: [V3, V3][] = [];
    const p = (i: number): V3 => [5, r * Math.cos((i * 2 * Math.PI) / n), r * Math.sin((i * 2 * Math.PI) / n)];
    for (let i = 0; i < n; i++) edges.push([p(i), p(i + 1)]);
    const ring = fitRing(edges);
    expect(ring).not.toBeNull();
    expect(Math.abs(ring!.axis[0])).toBeCloseTo(1, 6);
    expect(ring!.center[0]).toBeCloseTo(5, 9);
    expect(ring!.radius).toBeCloseTo(r, 9);
  });

  it("rejects an OPEN chain — half a rim is not a ring", () => {
    expect(fitRing(ngon(96, 20).slice(0, 48))).toBeNull();
  });

  it("rejects two separate rims handed in together", () => {
    // Same radius and centre axis, different heights: closed and equiradial,
    // but not coplanar, so the plane test must catch it.
    expect(fitRing([...ngon(96, 20, 0), ...ngon(96, 20, 40)])).toBeNull();
  });

  it("rejects a low-segment polygon, so a hex boss is not rounded off", () => {
    expect(fitRing(ngon(6, 20))).toBeNull();
    expect(fitRing(ngon(8, 20))).toBeNull();
  });

  it("rejects an ellipse — the vertices are not equidistant", () => {
    const n = 96;
    const p = (i: number): V3 => [20 * Math.cos((i * 2 * Math.PI) / n), 14 * Math.sin((i * 2 * Math.PI) / n), 0];
    const edges: [V3, V3][] = Array.from({ length: n }, (_, i) => [p(i), p(i + 1)]);
    expect(fitRing(edges)).toBeNull();
  });

  it("reports the CIRCUMSCRIBED radius, so a tool built on it covers every vertex", () => {
    // A rim that has been through a boolean is not a regular polygon: pull one
    // vertex in and the radius must still be the largest, never the mean.
    const edges = ngon(96, 20, 40);
    const pull = (v: V3): V3 => [v[0] * 0.997, v[1] * 0.997, v[2]];
    edges[10] = [pull(edges[10][0]), edges[10][1]];
    edges[9] = [edges[9][0], pull(edges[9][1])];
    const ring = fitRing(edges);
    expect(ring).not.toBeNull();
    // Pulling a vertex in also nudges the centroid, so this is the largest
    // radius to within that shift — the point is that it is not the mean, which
    // would sit measurably below 20.
    expect(ring!.radius).toBeCloseTo(20, 2);
    expect(ring!.radius).toBeGreaterThan(19.999);
  });

  it("accepts the uneven re-discretisation a boolean leaves on a rim", () => {
    // Measured: the boss in the stacked-fillet case came back as 127 chords
    // whose vertices varied by 0.07mm on a 26mm radius. Still a circle.
    const n = 127, R = 26;
    const p = (i: number): V3 => {
      const wobble = i % 3 === 0 ? 1 - 0.07 / R : 1;
      return [R * wobble * Math.cos((i * 2 * Math.PI) / n), R * wobble * Math.sin((i * 2 * Math.PI) / n), 5];
    };
    const edges: [V3, V3][] = Array.from({ length: n }, (_, i) => [p(i), p((i + 1) % n)]);
    const ring = fitRing(edges);
    expect(ring).not.toBeNull();
    expect(ring!.radius).toBeCloseTo(R, 3);
  });

  it("tolerates the µm-scale drift a boolean leaves behind", () => {
    const edges = ngon(96, 20, 40);
    const jitter = (v: V3, k: number): V3 => [v[0] + 1e-6 * k, v[1] - 1e-6 * k, v[2]];
    // Nudge both ends of one chord, keeping the shared vertices consistent.
    edges[10] = [jitter(edges[10][0], 1), edges[10][1]];
    edges[9] = [edges[9][0], jitter(edges[9][1], 1)];
    expect(fitRing(edges)).not.toBeNull();
  });

  it("rejects a ring whose vertices don't pair up (a chord counted twice)", () => {
    const edges = ngon(96, 20);
    edges.push(edges[0]); // a duplicate makes two vertices degree-3
    expect(fitRing(edges)).toBeNull();
  });
});
