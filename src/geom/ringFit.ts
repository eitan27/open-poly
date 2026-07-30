/**
 * Recognising a faceted circle: the closed ring of chords that approximates a
 * round rim. Pure arithmetic, no kernel types, so it is unit-testable in Node
 * (see [[occt-testing-gotcha]] — OCCT itself is not).
 *
 * Why this exists: a round wall here is a 96-gon, so a rim is 96 straight edges.
 * Dressing them one at a time is what produces a castellated crown (each wedge
 * stops at its own chord's ends), and handing all 96 to BRepFilletAPI produces a
 * top face whose boundary wire SELF-OVERLAPS — each inner edge keeps its full
 * original chord length instead of being trimmed to the mitre, so consecutive
 * edges cross by a fraction of a degree. That renders fine but poisons anything
 * built on that face. Recognising the ring lets the kernel sweep ONE tool all
 * the way round instead, which is both clean and exact.
 */

export type V3 = [number, number, number];

const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const norm = (a: V3) => Math.hypot(a[0], a[1], a[2]);
const unit = (a: V3): V3 => {
  const n = norm(a);
  return n > 1e-12 ? [a[0] / n, a[1] / n, a[2] / n] : [0, 0, 0];
};

export interface Ring {
  /** Centre of the circle the vertices lie on. */
  center: V3;
  /** Unit normal of the ring's plane — the axis to revolve about. */
  axis: V3;
  /** Distance from the axis to the polygon's VERTICES, i.e. the CIRCUMSCRIBED
   *  radius. A chord's midpoint is closer by the sagitta; a tool built at this
   *  radius therefore covers the corner along the whole ring rather than
   *  falling short at the vertices and leaving slivers. */
  radius: number;
  /** How many chords the ring is cut into. */
  segments: number;
}

/**
 * The ring these edges form, or null if they do not form one.
 *
 * Requires a CLOSED loop (every vertex shared by exactly two edges), all
 * vertices coplanar and equidistant from a common centre, and enough segments
 * that the loop genuinely approximates a circle. That last test is what keeps a
 * hexagonal boss's rim — also closed, planar and equiradial — from being rounded
 * off into a circle; `minSegments` is well above any polygon a user draws
 * deliberately, and the caller only reaches here with a tangent chain anyway.
 *
 * `tol` is relative to the radius.
 */
export function fitRing(
  edges: [V3, V3][],
  { tol = 1e-4, minSegments = 12 }: { tol?: number; minSegments?: number } = {},
): Ring | null {
  if (edges.length < minSegments) return null;

  // Vertices by rounded position (µm), each carrying how many edge-ends meet it.
  const key = (p: V3) => `${Math.round(p[0] * 1e3)},${Math.round(p[1] * 1e3)},${Math.round(p[2] * 1e3)}`;
  const seen = new Map<string, { p: V3; n: number }>();
  for (const [a, b] of edges) {
    for (const p of [a, b]) {
      const k = key(p);
      const hit = seen.get(k);
      if (hit) hit.n++;
      else seen.set(k, { p, n: 1 });
    }
  }
  const verts = [...seen.values()];
  // A closed simple loop of n chords has exactly n vertices, each used twice.
  if (verts.length !== edges.length) return null;
  if (!verts.every((v) => v.n === 2)) return null;

  const c: V3 = [0, 0, 0];
  for (const v of verts) { c[0] += v.p[0]; c[1] += v.p[1]; c[2] += v.p[2]; }
  c[0] /= verts.length; c[1] /= verts.length; c[2] /= verts.length;

  const spokes = verts.map((v) => sub(v.p, c));
  const radii = spokes.map(norm);
  const radius = radii.reduce((s, r) => s + r, 0) / radii.length;
  if (!(radius > 1e-9)) return null;
  const eps = Math.max(radius * tol, 1e-9);
  if (radii.some((r) => Math.abs(r - radius) > eps)) return null;

  // Plane normal from the two most independent spokes, then verify every vertex
  // lies in that plane (a cylinder's two rims together would fail here).
  let axis: V3 = [0, 0, 0];
  let best = 0;
  for (let i = 1; i < spokes.length; i++) {
    const x = cross(spokes[0], spokes[i]);
    const m = norm(x);
    if (m > best) { best = m; axis = x; }
  }
  axis = unit(axis);
  if (norm(axis) < 0.5) return null;
  if (spokes.some((s) => Math.abs(dot(s, axis)) > eps)) return null;

  return { center: c, axis, radius, segments: edges.length };
}
