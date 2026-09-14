// Pure 2D (uv) geometry for sketch-plane interactions: dimension anchoring, the
// live drag that feeds the solver, and "does this sketch sit on that body".
// Split out of App.tsx so the paths that use them are unit-testable without
// React; nothing here reads or mutates a document.

import type { PlaneFrameData } from "../document/planes";
import type { SketchEntity, Vec2 } from "../document/types";
import type { MeshedFaces } from "../kernel/types";

/** The parts of a `FeatureMesh` `bodyUnderRegion` needs — declared structurally,
 *  the way document/ does it (see transformAxis.ts), so this module stays clear
 *  of the viewport's types. */
export interface RegionMesh {
  id: string;
  mesh: { faces: MeshedFaces };
}

/** 2D: is point p inside triangle a-b-c (uv space)? (sign-consistency test) */
export function pointInTriangle(p: Vec2, a: Vec2, b: Vec2, c: Vec2): boolean {
  const cross = (o: Vec2, u: Vec2, w: Vec2) => (u[0] - o[0]) * (w[1] - o[1]) - (u[1] - o[1]) * (w[0] - o[0]);
  const d1 = cross(p, a, b),
    d2 = cross(p, b, c),
    d3 = cross(p, c, a);
  return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0));
}

/** Where two infinite lines (uv space) cross, or null if they're parallel
 *  (within ~0.006°) — the corner an angle dimension's arc/box is anchored on. */
export function lineLineIntersection(a1: Vec2, b1: Vec2, a2: Vec2, b2: Vec2): Vec2 | null {
  const d1x = b1[0] - a1[0],
    d1y = b1[1] - a1[1];
  const d2x = b2[0] - a2[0],
    d2y = b2[1] - a2[1];
  const len1 = Math.hypot(d1x, d1y) || 1,
    len2 = Math.hypot(d2x, d2y) || 1;
  const ux1 = d1x / len1,
    uy1 = d1y / len1,
    ux2 = d2x / len2,
    uy2 = d2y / len2;
  const denom = ux1 * uy2 - uy1 * ux2;
  if (Math.abs(denom) < 1e-4) return null;
  const t = ((a2[0] - a1[0]) * uy2 - (a2[1] - a1[1]) * ux2) / denom;
  return [a1[0] + t * ux1, a1[1] + t * uy1];
}

/** Unit direction from corner `p` toward whichever endpoint of `line` is
 *  farther from it — the ray along which the line's segment actually runs
 *  away from the corner, for sweeping an angle dimension's arc. */
export function rayFromCorner(line: Extract<SketchEntity, { type: "line" }>, p: Vec2): Vec2 {
  const da = Math.hypot(line.a[0] - p[0], line.a[1] - p[1]);
  const db = Math.hypot(line.b[0] - p[0], line.b[1] - p[1]);
  const far = da > db ? line.a : line.b;
  const dx = far[0] - p[0],
    dy = far[1] - p[1];
  const l = Math.hypot(dx, dy) || 1;
  return [dx / l, dy / l];
}

/** Rough uv-space centre of a sketch's geometry (bounding-box midpoint) — lets
 *  a length dimension pick the offset side that reads outside the profile
 *  rather than across it. */
export function sketchBoundsCenter(entities: SketchEntity[]): Vec2 {
  let minU = Infinity,
    minV = Infinity,
    maxU = -Infinity,
    maxV = -Infinity;
  const visit = (u: number, v: number) => {
    if (u < minU) minU = u;
    if (u > maxU) maxU = u;
    if (v < minV) minV = v;
    if (v > maxV) maxV = v;
  };
  for (const e of entities) {
    if (e.type === "line") {
      visit(e.a[0], e.a[1]);
      visit(e.b[0], e.b[1]);
    } else if (e.type === "circle" || e.type === "arc") {
      visit(e.c[0] - e.r, e.c[1] - e.r);
      visit(e.c[0] + e.r, e.c[1] + e.r);
    } else if (e.type === "spline") {
      for (const p of e.points) visit(p[0], p[1]);
    } else if (e.type === "point") {
      visit(e.p[0], e.p[1]);
    }
  }
  return Number.isFinite(minU) ? [(minU + maxU) / 2, (minV + maxV) / 2] : [0, 0];
}

/** Relocate sketch points for a live drag: any vertex whose current coordinate
 *  matches a `from` is moved to the matching `to` (matched by rounded key, so a
 *  vertex shared by several entities — a chained corner — moves on all of them,
 *  preserving their coincidence). The result is fed straight to the solver, which
 *  pulls the rest of the geometry back into agreement with the constraints; free
 *  degrees of freedom simply follow the cursor. Lines/circles/arcs are
 *  solver-driven; splines aren't mapped by the solver, so moving their stored
 *  points here translates them directly. */
export function moveSketchPoints(entities: SketchEntity[], points: { from: Vec2; to: Vec2 }[]): SketchEntity[] {
  const key = (p: Vec2) => `${p[0].toFixed(4)},${p[1].toFixed(4)}`;
  const moves = new Map(points.map((m) => [key(m.from), m.to]));
  const mv = (p: Vec2): Vec2 => moves.get(key(p)) ?? p;
  return entities.map((e) => {
    switch (e.type) {
      case "line":
        return { ...e, a: mv(e.a), b: mv(e.b) };
      case "circle":
        return { ...e, c: mv(e.c) };
      case "arc":
        return { ...e, c: mv(e.c) };
      case "spline":
        return { ...e, points: e.points.map(mv) };
      case "point":
        return { ...e, p: mv(e.p) };
      case "text":
        return { ...e, p: mv(e.p) };
    }
  });
}

/** The id of a rendered body that has a planar face **coplanar** with `frame`
 *  which the region (`outline`, in uv) **overlaps** — i.e. the sketch sits on
 *  that solid's face, so an extrude should default to adding onto it. null if
 *  none. Coplanarity = every face vertex on the sketch plane; overlap = a region
 *  vertex (or its centroid) inside a face triangle. */
export function bodyUnderRegion(frame: PlaneFrameData, outline: Vec2[], meshes: readonly RegionMesh[]): string | null {
  if (outline.length === 0) return null;
  const [ox, oy, oz] = frame.origin;
  const [nx, ny, nz] = frame.normal;
  const [ux, uy, uz] = frame.uAxis;
  const [vx, vy, vz] = frame.vAxis;
  const TOL = 0.05; // mm coplanarity tolerance
  let cu = 0,
    cv = 0;
  for (const p of outline) {
    cu += p[0];
    cv += p[1];
  }
  const centroid: Vec2 = [cu / outline.length, cv / outline.length];
  for (const m of meshes) {
    const { vertices, triangles, faceGroups } = m.mesh.faces;
    if (!faceGroups) continue;
    for (const g of faceGroups) {
      const uv: Vec2[] = [];
      let coplanar = true;
      for (let k = g.start; k < g.start + g.count; k++) {
        const i = triangles[k] * 3;
        const dx = vertices[i] - ox,
          dy = vertices[i + 1] - oy,
          dz = vertices[i + 2] - oz;
        if (Math.abs(dx * nx + dy * ny + dz * nz) > TOL) {
          coplanar = false;
          break;
        }
        uv.push([dx * ux + dy * uy + dz * uz, dx * vx + dy * vy + dz * vz]);
      }
      if (!coplanar) continue;
      for (let t = 0; t + 2 < uv.length; t += 3) {
        if (pointInTriangle(centroid, uv[t], uv[t + 1], uv[t + 2])) return m.id;
        for (const p of outline) if (pointInTriangle(p, uv[t], uv[t + 1], uv[t + 2])) return m.id;
      }
    }
  }
  return null;
}
