// Modelled metric threads, as a faceted solid built directly — the way the
// printable-thread libraries do it (OpenSCAD's threads.scad, BOSL2's
// threading.scad), rather than a helical sweep. A sweep gives a few B-spline
// faces that this OCCT build can't reliably boolean (see the faceted-walls
// note in circleFacets.ts); a polyhedron of planar facets booleans like any
// other faceted wall here, and is already what a slicer wants.
//
// The profile is the ISO 68-1 BASIC profile, shared by the screw and the nut:
// a trapezoid with a P/8 flat at the major diameter, a P/4 flat at the minor
// (D1 = d − 1.0825·P) and 60° flanks between. Swept round the axis it is a
// helical strip of four bands (crest, flank, root, flank); each band is
// faceted at N stations per turn. Crest and root facets are parallelograms
// (two vertical edges of equal length), so planar; the flanks are helicoids,
// so each of their quads is split into two triangles.
//
// The strip is generated long enough to cover [z0, z1] at every angle, then
// clipped flat at both ends; the cut outlines become the end caps. A screw's
// tip gets a 45° lead-in chamfer (vertices pulled in onto the cone).
//
// Clearance: `offset` moves the whole profile radially — negative for a screw
// (shrinks it), positive for the cavity cut by a tapped hole (grows it). With
// both at the same phase (θ = 0 on the frame's u axis, z from the frame
// plane), a screw in a tapped hole nests with an even gap.
//
// Coordinates are local: x = r·cosθ, y = r·sinθ, z along the axis INTO the
// part (depth). θ increases from x toward y; with x × y = +z that is a
// right-hand thread, so the caller must map (x, y, z) to a right-handed
// world frame.

export type V3 = [number, number, number];

export interface ThreadSpec {
  /** Nominal (major) diameter. */
  d: number;
  pitch: number;
  /** Radial shift of the whole profile: < 0 shrinks (screw), > 0 grows (nut cavity). */
  offset: number;
  /** Axial extent, local depth. */
  z0: number;
  z1: number;
  /** 45° lead-in chamfer at z1, down to the root. */
  tipChamfer?: boolean;
  /** Facets per turn; default from a chord-error budget. */
  segments?: number;
}

export type ThreadFaceKind = "thread" | "start" | "end";

export interface ThreadMesh {
  vertices: V3[];
  /** Counter-clockwise seen from outside; each a planar polygon. */
  faces: { loop: number[]; kind: ThreadFaceKind }[];
}

/** Fundamental triangle height H = √3/2 · P. */
export const threadH = (pitch: number) => (Math.sqrt(3) / 2) * pitch;

/** Basic minor diameter D1 = d − 2·(5H/8). */
export const minorDiameter = (d: number, pitch: number) => d - (5 / 4) * threadH(pitch);

/** Facets per turn so the chord sag at the crest stays under `sag` mm. */
export function threadSegments(radius: number, sag = 0.02): number {
  const n = Math.ceil(Math.PI / Math.acos(Math.max(-1, 1 - sag / Math.max(radius, sag))));
  // A multiple of 16, for PHASE.
  return Math.min(64, Math.max(32, Math.ceil(n / 16) * 16));
}

/** Axial positions (within one pitch) where the profile changes, and the radius there. */
function bands(d: number, pitch: number, offset: number): { u: number[]; r: number[] } {
  const R = d / 2 + offset;
  const r = minorDiameter(d, pitch) / 2 + offset;
  return { u: [0, pitch / 8, (7 * pitch) / 16, (11 * pitch) / 16], r: [R, R, r, r] };
}

const EPS = 1e-9;

/** The stations start half a station past θ = 0. Unshifted, the helix puts
 *  vertices exactly on z = 0 — where a screw's head floor and a tapped hole's
 *  mouth sit — and a vertex touching the other solid's face is the degenerate
 *  contact a boolean trips on (or "solves" by growing its tolerance). With N a
 *  multiple of 16 every profile breakpoint (multiples of P/16) falls on a
 *  whole station's rise P/N, so a half-station phase puts every vertex level
 *  midway between them: P/(2N) clear of z = 0 and of any plane on that grid.
 *  Screw and hole share it, so they still nest. */
const PHASE = 0.5;

/** The nearest plane a thread end can be cut at: a whole number of station
 *  rises P/N, which with PHASE is as far from every vertex level as it gets.
 *  Moves an end by at most P/(2N) — under 0.03 mm for every size here. */
export function snapToThreadGrid(z: number, pitch: number, segments: number): number {
  const step = pitch / segments;
  return Math.round(z / step) * step;
}

export function threadMesh(spec: ThreadSpec): ThreadMesh {
  const { d, pitch: P, offset } = spec;
  if (!(P > 0) || !(d > 0)) throw new Error("thread: bad size");
  // Longer than a pitch, so no facet spans both end planes.
  if (!(spec.z1 - spec.z0 > P)) throw new Error("thread: too short to thread");
  const { u, r } = bands(d, P, offset);
  if (!(r[2] > 0)) throw new Error("thread: the clearance leaves no core");
  const N = spec.segments ?? threadSegments(r[0]);
  if (N % 16 !== 0) throw new Error("thread: facets per turn must be a multiple of 16");
  // The end planes go on the grid midway between vertex levels (see PHASE),
  // so a cut never lands a hair from a vertex and leaves a sliver edge.
  const z0 = snapToThreadGrid(spec.z0, P, N);
  const z1 = snapToThreadGrid(spec.z1, P, N);
  if (!(z1 - z0 > P)) throw new Error("thread: too short to thread");
  const jA = Math.floor(((z0 - P) * N) / P) - 1;
  const jB = Math.ceil((z1 * N) / P) + 1;
  const jMax = jB + N + 1;

  // --- the raw helical strip -------------------------------------------------
  const verts: V3[] = [];
  const raw = (j: number, b: number): number => {
    if (b === 4) return raw(j + N, 0);
    return (j - jA) * 4 + b;
  };
  for (let j = jA; j <= jMax; j++) {
    const th = (2 * Math.PI * (j + PHASE)) / N;
    const c = Math.cos(th);
    const s = Math.sin(th);
    for (let b = 0; b < 4; b++) verts.push([r[b] * c, r[b] * s, u[b] + (P * (j + PHASE)) / N]);
  }
  let polys: number[][] = [];
  for (let j = jA; j <= jB; j++) {
    for (let b = 0; b < 4; b++) {
      const a0 = raw(j, b);
      const a1 = raw(j + 1, b);
      const b1 = raw(j + 1, b + 1);
      const b0 = raw(j, b + 1);
      if (b === 0 || b === 2) polys.push([a0, a1, b1, b0]);
      else polys.push([a0, a1, b1], [a0, b1, b0]);
    }
  }

  // --- clip to z0 ≤ z ≤ z1 -----------------------------------------------------
  // Cut points are shared between the two faces either side of an edge by
  // keying them on the edge, so the result stays watertight.
  const capEdges: Record<"start" | "end", [number, number][]> = { start: [], end: [] };
  const clip = (plane: number, keepAbove: boolean, which: "start" | "end") => {
    const cut = new Map<string, number>();
    const side = (i: number) => (keepAbove ? verts[i][2] - plane : plane - verts[i][2]);
    const onPlane = (i: number) => Math.abs(side(i)) < EPS;
    const cutAt = (a: number, b: number): number => {
      const k = a < b ? `${a},${b}` : `${b},${a}`;
      const hit = cut.get(k);
      if (hit !== undefined) return hit;
      const A = verts[a];
      const B = verts[b];
      const t = (plane - A[2]) / (B[2] - A[2]);
      verts.push([A[0] + (B[0] - A[0]) * t, A[1] + (B[1] - A[1]) * t, plane]);
      cut.set(k, verts.length - 1);
      return verts.length - 1;
    };
    const out: number[][] = [];
    for (const poly of polys) {
      const res: number[] = [];
      for (let i = 0; i < poly.length; i++) {
        const a = poly[i];
        const b = poly[(i + 1) % poly.length];
        const sa = side(a);
        const sb = side(b);
        if (sa >= -EPS) res.push(a);
        if ((sa < -EPS && sb > EPS) || (sa > EPS && sb < -EPS)) res.push(cutAt(a, b));
      }
      if (res.length < 3) continue;
      // Drop slivers left by a polygon that only touches the plane.
      if (polyArea(res.map((i) => verts[i])) < 1e-12) continue;
      out.push(res);
      for (let i = 0; i < res.length; i++) {
        const a = res[i];
        const b = res[(i + 1) % res.length];
        if (onPlane(a) && onPlane(b)) capEdges[which].push([a, b]);
      }
    }
    polys = out;
  };
  clip(z0, true, "start");
  clip(z1, false, "end");
  const live = new Set(polys.flat());
  const caps: { loop: number[]; kind: ThreadFaceKind }[] = [];
  for (const which of ["start", "end"] as const) {
    const edges = capEdges[which].filter(([a, b]) => live.has(a) && live.has(b));
    caps.push({ loop: chainLoop(edges), kind: which });
  }

  // --- tip chamfer -----------------------------------------------------------
  const clamped = new Set<number>();
  if (spec.tipChamfer) {
    const root = r[2];
    for (const i of live) {
      const [x, y, z] = verts[i];
      const lim = root + (z1 - z);
      const rv = Math.hypot(x, y);
      if (rv > lim + EPS) {
        const k = lim / rv;
        verts[i] = [x * k, y * k, z];
        clamped.add(i);
      }
    }
  }

  // --- compact + emit ----------------------------------------------------------
  const faces: { loop: number[]; kind: ThreadFaceKind }[] = [];
  for (const p of polys) {
    // A quad with a vertex pulled onto the chamfer cone is no longer planar.
    if (p.length > 3 && p.some((i) => clamped.has(i))) {
      for (let k = 1; k + 1 < p.length; k++) faces.push({ loop: [p[0], p[k], p[k + 1]], kind: "thread" });
    } else faces.push({ loop: p, kind: "thread" });
  }
  faces.push(...caps);
  const remap = new Map<number, number>();
  const vertices: V3[] = [];
  for (const f of faces)
    for (const i of f.loop)
      if (!remap.has(i)) {
        remap.set(i, vertices.length);
        vertices.push(verts[i]);
      }
  return { vertices, faces: faces.map((f) => ({ loop: f.loop.map((i) => remap.get(i)!), kind: f.kind })) };
}

/** The cap: the clipped faces' on-plane edges, reversed (the cap runs each
 *  shared edge the other way) and chained into one loop. */
function chainLoop(edges: [number, number][]): number[] {
  if (edges.length < 3) throw new Error("thread: end cap didn't close");
  const next = new Map<number, number>();
  for (const [a, b] of edges) next.set(b, a);
  const start = edges[0][1];
  const loop = [start];
  let at = next.get(start);
  while (at !== undefined && at !== start) {
    loop.push(at);
    if (loop.length > edges.length) throw new Error("thread: end cap didn't close");
    at = next.get(at);
  }
  if (at !== start || loop.length !== edges.length) throw new Error("thread: end cap didn't close");
  return loop;
}

function polyArea(pts: V3[]): number {
  let x = 0;
  let y = 0;
  let z = 0;
  for (let i = 1; i + 1 < pts.length; i++) {
    const a = sub(pts[i], pts[0]);
    const b = sub(pts[i + 1], pts[0]);
    x += a[1] * b[2] - a[2] * b[1];
    y += a[2] * b[0] - a[0] * b[2];
    z += a[0] * b[1] - a[1] * b[0];
  }
  return Math.hypot(x, y, z) / 2;
}

const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];

/** Signed volume of a closed mesh (positive when the faces wind outward). */
export function meshVolume(m: ThreadMesh): number {
  let v = 0;
  for (const { loop } of m.faces) {
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
