// Fit the axis, radius and extent of a round wall — a rod's side or a hole's
// bore — from samples of it. Shared by the dialog and the agent (which see the
// tessellation) and the kernel (which sees the B-rep), so all three agree on
// what a picked face is.
//
// Round walls here are mostly polygonal prisms (extruded circles, the kernel's
// faceted cylinders), so the fit can't assume a smooth surface: the axis is the
// direction every facet normal is perpendicular to, and the radius is the
// CIRCUMRADIUS — the corners' distance from the axis — since that's the most
// material there is to cut a thread from (or, in a hole, the widest the bore
// already is).

export type V3 = [number, number, number];

export interface RoundWall {
  /** A point of the axis, at the wall's lowest end along `dir`. */
  origin: V3;
  /** Unit axis direction, its sign arbitrary but deterministic. */
  dir: V3;
  /** The corners' distance from the axis (the circumradius of a prism). */
  radius: number;
  /** A hole's bore (normals face the axis) rather than a rod's side. */
  internal: boolean;
  /** The wall's extent along `dir`, from `origin`. */
  length: number;
}

/** A sample of the wall's surface: a point on it and its outward normal, with
 *  a weight (a facet's area, say). */
export interface WallSample {
  p: V3;
  n: V3;
  w: number;
}

const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (a: V3): V3 => {
  const m = Math.hypot(a[0], a[1], a[2]);
  return [a[0] / m, a[1] / m, a[2] / m];
};

/** The round wall the samples and points lie on, or null when they don't lie
 *  on one: a flat face, a cone, a blend, or a shape too irregular to call
 *  round. `points` are the wall's vertices (corners and rim points), which set
 *  the radius and the extent. */
export function fitRoundWall(samples: WallSample[], points: V3[]): RoundWall | null {
  const ns = samples.filter((s) => s.w > 0 && Number.isFinite(s.n[0]));
  if (ns.length < 3 || points.length < 3) return null;
  // The axis: perpendicular to every normal, so the cross product of the two
  // most independent ones.
  let dir: V3 | null = null;
  let best = 0;
  for (let i = 0; i < Math.min(8, ns.length); i++) {
    for (let j = i + 1; j < ns.length; j++) {
      const x = cross(ns[i].n, ns[j].n);
      const m = Math.hypot(x[0], x[1], x[2]);
      if (m > best) {
        best = m;
        dir = x;
      }
    }
  }
  if (!dir || best < 1e-3) return null;
  dir = unit(dir);
  // A prism wall's facets are all parallel to the axis; a cone's or a dome's
  // aren't.
  if (ns.some((s) => Math.abs(dot(s.n, dir!)) > 0.02)) return null;
  const k = dir.reduce((bi, v, i, arr) => (Math.abs(v) > Math.abs(arr[bi]) ? i : bi), 0);
  if (dir[k] < 0) dir = [-dir[0], -dir[1], -dir[2]];

  // The cross-section: a circle through the points (Kåsa's algebraic fit,
  // x² + y² + Dx + Ey + F = 0, by least squares).
  const e1 = unit(Math.abs(dir[0]) < 0.9 ? cross(dir, [1, 0, 0]) : cross(dir, [0, 1, 0]));
  const e2 = cross(dir, e1);
  let sxx = 0,
    sxy = 0,
    syy = 0,
    sx = 0,
    sy = 0,
    sz = 0,
    sxz = 0,
    syz = 0;
  const n = points.length;
  const xy = points.map((p) => [dot(p, e1), dot(p, e2)] as const);
  for (const [x, y] of xy) {
    const z = x * x + y * y;
    sxx += x * x;
    sxy += x * y;
    syy += y * y;
    sx += x;
    sy += y;
    sz += z;
    sxz += x * z;
    syz += y * z;
  }
  // [sxx sxy sx; sxy syy sy; sx sy n] [D E F]ᵀ = −[sxz syz sz]ᵀ
  const det3 = (a: number[][]) =>
    a[0][0] * (a[1][1] * a[2][2] - a[1][2] * a[2][1]) -
    a[0][1] * (a[1][0] * a[2][2] - a[1][2] * a[2][0]) +
    a[0][2] * (a[1][0] * a[2][1] - a[1][1] * a[2][0]);
  const A = [
    [sxx, sxy, sx],
    [sxy, syy, sy],
    [sx, sy, n],
  ];
  const b = [-sxz, -syz, -sz];
  const det = det3(A);
  if (Math.abs(det) < 1e-12) return null;
  const col = (c: number) => det3(A.map((row, i) => row.map((v, j) => (j === c ? b[i] : v)))) / det;
  const D = col(0);
  const E = col(1);
  const cx = -D / 2;
  const cy = -E / 2;
  let radius = 0;
  let rmin = Infinity;
  for (const [x, y] of xy) {
    const r = Math.hypot(x - cx, y - cy);
    radius = Math.max(radius, r);
    rmin = Math.min(rmin, r);
  }
  if (!(radius > 1e-6)) return null;
  // Every point is on the circle (corners of a prism, rim points of a real
  // cylinder): anything well off it isn't a round wall.
  if (rmin < radius * 0.9) return null;

  // Rod or hole: do the normals point away from the axis, or at it?
  const axisAt = (p: V3): V3 => {
    const t = dot(p, dir!);
    return [
      cx * e1[0] + cy * e2[0] + t * dir![0],
      cx * e1[1] + cy * e2[1] + t * dir![1],
      cx * e1[2] + cy * e2[2] + t * dir![2],
    ];
  };
  let outward = 0;
  for (const s of ns) {
    const a = axisAt(s.p);
    outward += s.w * dot(s.n, [s.p[0] - a[0], s.p[1] - a[1], s.p[2] - a[2]]);
  }
  let t0 = Infinity;
  let t1 = -Infinity;
  for (const p of points) {
    const t = dot(p, dir);
    t0 = Math.min(t0, t);
    t1 = Math.max(t1, t);
  }
  const o = axisAt([dir[0] * t0, dir[1] * t0, dir[2] * t0]);
  return { origin: o, dir, radius, internal: outward < 0, length: t1 - t0 };
}

/** The round wall a tessellated face belongs to — the whole smooth surface it
 *  is part of (its `clusterId` group), so clicking one strip of a faceted
 *  cylinder reads the cylinder. Null when it isn't one. */
export function roundWallOfMesh(
  faces: {
    vertices: ArrayLike<number>;
    triangles: ArrayLike<number>;
    normals?: ArrayLike<number>;
    faceGroups?: { start: number; count: number; faceId: number; clusterId?: number }[];
  },
  faceId: number,
): RoundWall | null {
  const g = faces.faceGroups?.find((fg) => fg.faceId === faceId);
  if (!g) return null;
  const groups = g.clusterId === undefined ? [g] : faces.faceGroups!.filter((fg) => fg.clusterId === g.clusterId);
  const { vertices: V, triangles: T, normals: N } = faces;
  const at = (i: number): V3 => [V[i * 3], V[i * 3 + 1], V[i * 3 + 2]];
  const samples: WallSample[] = [];
  const seen = new Set<number>();
  const points: V3[] = [];
  for (const fg of groups) {
    for (let k = fg.start; k + 2 < fg.start + fg.count; k += 3) {
      const [ia, ib, ic] = [T[k], T[k + 1], T[k + 2]];
      const [a, b, c] = [at(ia), at(ib), at(ic)];
      const x = cross([b[0] - a[0], b[1] - a[1], b[2] - a[2]], [c[0] - a[0], c[1] - a[1], c[2] - a[2]]);
      const area = Math.hypot(x[0], x[1], x[2]) / 2;
      if (area < 1e-12) continue;
      let nrm = unit(x);
      if (N) {
        // The mesher's normals are outward; the winding may not be.
        const vn: V3 = [
          N[ia * 3] + N[ib * 3] + N[ic * 3],
          N[ia * 3 + 1] + N[ib * 3 + 1] + N[ic * 3 + 1],
          N[ia * 3 + 2] + N[ib * 3 + 2] + N[ic * 3 + 2],
        ];
        if (dot(vn, nrm) < 0) nrm = [-nrm[0], -nrm[1], -nrm[2]];
      }
      samples.push({
        p: [(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3, (a[2] + b[2] + c[2]) / 3],
        n: nrm,
        w: area,
      });
      for (const i of [ia, ib, ic]) {
        if (seen.has(i)) continue;
        seen.add(i);
        points.push(at(i));
      }
    }
  }
  return fitRoundWall(samples, points);
}
