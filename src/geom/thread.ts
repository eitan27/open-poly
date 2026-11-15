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

/** The tooth shape. `iso`: ISO 68-1, 60° (screws and tapped holes). The
 *  other two are for the Thread feature: `printable`, 45° flanks with wide
 *  flats — every overhang at 45°, so it prints upright without supports and
 *  survives a printer's rounding; `trapezoid`, ≈15° flanks (ISO 2904 Tr) for
 *  lead screws and anything that has to carry load. */
export type ThreadProfile = "iso" | "printable" | "trapezoid";

interface ProfileDef {
  /** The breakpoints (crest start, flank, root start, flank) in units of P/grid,
   *  so they land on whole station rises (see PHASE). */
  grid: number;
  u: [number, number, number, number];
  /** Radial depth crest → root, per unit pitch. */
  depth: number;
}

const PROFILES: Record<ThreadProfile, ProfileDef> = {
  // P/8 crest flat, P/4 root flat, 5H/8 deep (H = √3/2·P).
  iso: { grid: 16, u: [0, 2, 7, 11], depth: (5 / 8) * (Math.sqrt(3) / 2) },
  // 0.2P flats, 0.3P flanks 0.3P deep: 45°.
  printable: { grid: 20, u: [0, 4, 10, 14], depth: 0.3 },
  // 0.375P flats, 0.125P flanks 0.5P deep: atan(0.25) ≈ 14°.
  trapezoid: { grid: 16, u: [0, 6, 8, 14], depth: 0.5 },
};

export interface ThreadSpec {
  /** Major diameter (the crest, before the offset). */
  d: number;
  pitch: number;
  /** Radial shift of the whole profile: < 0 shrinks (screw), > 0 grows (nut cavity). */
  offset: number;
  /** Axial extent, local depth. */
  z0: number;
  z1: number;
  /** 45° lead-in chamfer at z1, down to the root. */
  tipChamfer?: boolean;
  /** The same at z0. */
  startChamfer?: boolean;
  /** Default `iso`. */
  profile?: ThreadProfile;
  /** Interleaved helices; the lead is starts × pitch. Default 1. */
  starts?: number;
  leftHand?: boolean;
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

/** Crest-to-root radial depth of a profile. */
export const threadDepth = (pitch: number, profile: ThreadProfile = "iso") => PROFILES[profile].depth * pitch;

/** Where a profile's four bands start, as fractions of a pitch (crest flat,
 *  flank, root flat, flank) — for drawing it. */
export const profileBreaks = (profile: ThreadProfile = "iso") =>
  PROFILES[profile].u.map((k) => k / PROFILES[profile].grid);

/** A profile's flank angle from the radial plane, degrees (30 for ISO's 60° form). */
export function flankAngle(profile: ThreadProfile = "iso"): number {
  const { u, grid, depth } = PROFILES[profile];
  return (Math.atan((u[2] - u[1]) / grid / depth) * 180) / Math.PI;
}

/** The facet count's required divisor: the profile's grid times the starts. */
export const segmentsStep = (profile: ThreadProfile = "iso", starts = 1) => PROFILES[profile].grid * starts;

/** Facets per turn so the chord sag at the crest stays under `sag` mm: a
 *  multiple of `segmentsStep`, at least 32, at most 128 unless the step is
 *  bigger. */
export function threadSegments(radius: number, sag = 0.02, profile: ThreadProfile = "iso", starts = 1): number {
  const step = segmentsStep(profile, starts);
  const n = Math.ceil(Math.PI / Math.acos(Math.max(-1, 1 - sag / Math.max(radius, sag))));
  const want = Math.min(Math.max(n, 32), 128);
  return Math.max(step, Math.ceil(want / step) * step);
}

const EPS = 1e-9;

/** The stations start half a station past θ = 0. Unshifted, the helix puts
 *  vertices exactly on z = 0 — where a screw's head floor and a tapped hole's
 *  mouth sit — and a vertex touching the other solid's face is the degenerate
 *  contact a boolean trips on (or "solves" by growing its tolerance). With N a
 *  multiple of the profile's grid (× starts) every breakpoint falls on a whole
 *  station's rise L/N, so a half-station phase puts every vertex level midway
 *  between them: L/(2N) clear of z = 0 and of any plane on that grid. Screw
 *  and hole share it, so they still nest. */
const PHASE = 0.5;

/** The nearest plane a thread end can be cut at: a whole number of station
 *  rises L/N (L = starts × pitch), which with PHASE is as far from every vertex
 *  level as it gets. Moves an end by at most L/(2N) — under 0.03 mm for every
 *  ISO size. */
export function snapToThreadGrid(z: number, pitch: number, segments: number, starts = 1): number {
  const step = (pitch * starts) / segments;
  return Math.round(z / step) * step;
}

export function threadMesh(spec: ThreadSpec): ThreadMesh {
  const { d, pitch: P, offset } = spec;
  const profile = spec.profile ?? "iso";
  const starts = spec.starts ?? 1;
  const def = PROFILES[profile];
  if (!(P > 0) || !(d > 0)) throw new Error("thread: bad size");
  if (!Number.isInteger(starts) || starts < 1) throw new Error("thread: starts must be a whole number ≥ 1");
  // Longer than a pitch, so no facet spans both end planes.
  if (!(spec.z1 - spec.z0 > P)) throw new Error("thread: too short to thread");
  const R = d / 2 + offset;
  const root = R - def.depth * P;
  if (!(root > 0)) throw new Error("thread: the clearance leaves no core");
  const u = def.u.map((k) => (k * P) / def.grid);
  const r = [R, R, root, root];
  const N = spec.segments ?? threadSegments(R, 0.02, profile, starts);
  if (N % segmentsStep(profile, starts) !== 0)
    throw new Error(`thread: facets per turn must be a multiple of ${segmentsStep(profile, starts)}`);
  const L = P * starts;
  const rise = L / N;
  // The end planes go on the grid midway between vertex levels (see PHASE),
  // so a cut never lands a hair from a vertex and leaves a sliver edge.
  const z0 = snapToThreadGrid(spec.z0, P, N, starts);
  const z1 = snapToThreadGrid(spec.z1, P, N, starts);
  if (!(z1 - z0 > P)) throw new Error("thread: too short to thread");
  const jA = Math.floor((z0 - L) / rise) - 1;
  const jB = Math.ceil(z1 / rise) + 1;
  const jMax = jB + N + 1;

  // --- the raw helical strips ------------------------------------------------
  // One strip per start, start k a P higher than start k−1 at the same angle:
  // a start's last flank (band 4) runs into the NEXT start's crest at the
  // same station, and the last start's into the first start's a turn on.
  const verts: V3[] = [];
  const raw = (k: number, j: number, b: number): number => {
    if (b === 4) return k + 1 < starts ? raw(k + 1, j, 0) : raw(0, j + N, 0);
    return ((j - jA) * starts + k) * 4 + b;
  };
  for (let j = jA; j <= jMax; j++) {
    const th = (2 * Math.PI * (j + PHASE)) / N;
    const c = Math.cos(th);
    const sn = Math.sin(th);
    for (let k = 0; k < starts; k++)
      for (let b = 0; b < 4; b++) verts.push([r[b] * c, r[b] * sn, u[b] + k * P + rise * (j + PHASE)]);
  }
  let polys: number[][] = [];
  for (let j = jA; j <= jB; j++)
    for (let k = 0; k < starts; k++)
      for (let b = 0; b < 4; b++) {
        const a0 = raw(k, j, b);
        const a1 = raw(k, j + 1, b);
        const b1 = raw(k, j + 1, b + 1);
        const b0 = raw(k, j, b + 1);
        if (b === 0 || b === 2) polys.push([a0, a1, b1, b0]);
        else polys.push([a0, a1, b1], [a0, b1, b0]);
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

  // --- lead-in chamfers --------------------------------------------------------
  // Vertices pulled in onto a 45° cone from the root at each chamfered end.
  const clamped = new Set<number>();
  if (spec.tipChamfer || spec.startChamfer) {
    for (const i of live) {
      const [x, y, z] = verts[i];
      let lim = Infinity;
      if (spec.tipChamfer) lim = Math.min(lim, root + (z1 - z));
      if (spec.startChamfer) lim = Math.min(lim, root + (z - z0));
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
  // A left-hand thread is the right-hand one mirrored (y → −y), which turns
  // every face inside out — so the loops run backwards too.
  if (spec.leftHand) for (const v of vertices) v[1] = -v[1];
  return {
    vertices,
    faces: faces.map((f) => {
      const loop = f.loop.map((i) => remap.get(i)!);
      return { loop: spec.leftHand ? loop.reverse() : loop, kind: f.kind };
    }),
  };
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
