// A closed polygon mesh whose faces may have holes — what the kernel turns
// straight into a solid (worker.ts meshSolid) without a single boolean. The
// screw is built this way (geom/screwMesh.ts): head, socket and thread are
// stitched into one watertight mesh in plain JS, where the boolean route
// spent seconds fusing a thread of a thousand facets onto a head.
//
// Coordinates are local (x, y, z) with z the depth along an axis; the caller
// maps them to the world.

export type V3 = [number, number, number];

export interface PolyFace {
  /** The outer boundary: counter-clockwise seen from outside once oriented. */
  loop: number[];
  /** Holes, wound the other way. */
  holes?: number[][];
  /** The face's name, relative to its feature (the kernel prefixes the id). */
  name: string;
}

export interface PolyMesh {
  vertices: V3[];
  faces: PolyFace[];
}

const loopsOf = (f: PolyFace) => [f.loop, ...(f.holes ?? [])];

/** Newell's normal of a loop (not normalised; its length is twice the area). */
export function newell(vertices: V3[], loop: number[]): V3 {
  let x = 0;
  let y = 0;
  let z = 0;
  for (let i = 0; i < loop.length; i++) {
    const a = vertices[loop[i]];
    const b = vertices[loop[(i + 1) % loop.length]];
    x += (a[1] - b[1]) * (a[2] + b[2]);
    y += (a[2] - b[2]) * (a[0] + b[0]);
    z += (a[0] - b[0]) * (a[1] + b[1]);
  }
  return [x, y, z];
}

/** Signed volume (positive when the faces wind outward). Holes count against
 *  their face, which falls out of the same sum when they wind the other way. */
export function polyMeshVolume(m: PolyMesh): number {
  let v = 0;
  for (const f of m.faces)
    for (const loop of loopsOf(f)) {
      const p0 = m.vertices[loop[0]];
      for (let k = 1; k + 1 < loop.length; k++) {
        const a = m.vertices[loop[k]];
        const b = m.vertices[loop[k + 1]];
        v +=
          (p0[0] * (a[1] * b[2] - a[2] * b[1]) +
            p0[1] * (a[2] * b[0] - a[0] * b[2]) +
            p0[2] * (a[0] * b[1] - a[1] * b[0])) /
          6;
      }
    }
  return v;
}

/** Directed edges that aren't matched by exactly one reverse edge: 0 for a
 *  closed, consistently wound mesh. */
export function polyMeshEdgeProblems(m: PolyMesh): number {
  const count = new Map<string, number>();
  for (const f of m.faces)
    for (const loop of loopsOf(f))
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

function flip(f: PolyFace): void {
  f.loop.reverse();
  for (const h of f.holes ?? []) h.reverse();
}

/** Wind every face outward, in place: holes against their outer loop, then
 *  the faces agreeing with their neighbours across every shared edge (a walk
 *  over the face graph), then all of them flipped if the volume came out
 *  negative. So a builder can emit loops in whatever order is easiest. */
export function orientPolyMesh(m: PolyMesh): void {
  for (const f of m.faces) {
    if (!f.holes?.length) continue;
    const n = newell(m.vertices, f.loop);
    for (const h of f.holes) {
      const hn = newell(m.vertices, h);
      if (n[0] * hn[0] + n[1] * hn[1] + n[2] * hn[2] > 0) h.reverse();
    }
  }
  // Undirected edge → the faces using it, and which way.
  const nv = m.vertices.length;
  const uses = new Map<number, { f: number; forward: boolean }[]>();
  m.faces.forEach((f, fi) => {
    for (const loop of loopsOf(f))
      for (let i = 0; i < loop.length; i++) {
        const a = loop[i];
        const b = loop[(i + 1) % loop.length];
        const k = a < b ? a * nv + b : b * nv + a;
        const arr = uses.get(k);
        const u = { f: fi, forward: a < b };
        if (arr) arr.push(u);
        else uses.set(k, [u]);
      }
  });
  const byFace = new Map<number, number[]>();
  for (const [k, arr] of uses)
    for (const u of arr) {
      const l = byFace.get(u.f);
      if (l) l.push(k);
      else byFace.set(u.f, [k]);
    }
  const flipped = new Array<boolean | undefined>(m.faces.length);
  for (let seed = 0; seed < m.faces.length; seed++) {
    if (flipped[seed] !== undefined) continue;
    flipped[seed] = false;
    const stack = [seed];
    while (stack.length) {
      const fi = stack.pop()!;
      for (const k of byFace.get(fi) ?? []) {
        const arr = uses.get(k)!;
        const mine = arr.find((u) => u.f === fi)!;
        const mineRuns = mine.forward !== flipped[fi];
        for (const u of arr) {
          if (u.f === fi || flipped[u.f] !== undefined) continue;
          // Neighbours must run a shared edge opposite ways: one that runs it
          // the same way as this face (once this face is settled) flips.
          flipped[u.f] = u.forward === mineRuns;
          stack.push(u.f);
        }
      }
    }
  }
  m.faces.forEach((f, i) => flipped[i] && flip(f));
  if (polyMeshVolume(m) < 0) for (const f of m.faces) flip(f);
}
