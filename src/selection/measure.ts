// Derives readable measurements for the current selection (length / radius /
// area / coordinates), used by the bottom-right info pane.
import type { Document, SketchEntity } from "../document/types";
import { detectSketchRegions, type SketchRegion } from "../document/regions";
import { evaluateExpression, type Scope } from "../document/expression";
import type { MeshedEdges, MeshedFaces } from "../kernel/types";
import type { FeatureMesh, Selection } from "../viewport/Viewport";

export interface MeasureInfo {
  title: string;
  rows: { label: string; value: string }[];
}

const fmt = (n: number) => {
  const r = Math.round(n * 1000) / 1000;
  return Number.isInteger(r) ? String(r) : r.toFixed(3).replace(/0+$/, "").replace(/\.$/, "");
};

/** Sum of triangle areas belonging to one face group of a tessellated body. */
function faceArea(faces: MeshedFaces, faceId: number): number {
  const g = faces.faceGroups?.find((fg) => fg.faceId === faceId);
  if (!g) return 0;
  const { triangles, vertices } = faces;
  let area = 0;
  for (let k = g.start; k + 2 < g.start + g.count; k += 3) {
    const i0 = triangles[k] * 3;
    const i1 = triangles[k + 1] * 3;
    const i2 = triangles[k + 2] * 3;
    const ax = vertices[i1] - vertices[i0];
    const ay = vertices[i1 + 1] - vertices[i0 + 1];
    const az = vertices[i1 + 2] - vertices[i0 + 2];
    const bx = vertices[i2] - vertices[i0];
    const by = vertices[i2 + 1] - vertices[i0 + 1];
    const bz = vertices[i2 + 2] - vertices[i0 + 2];
    const cx = ay * bz - az * by;
    const cy = az * bx - ax * bz;
    const cz = ax * by - ay * bx;
    area += 0.5 * Math.hypot(cx, cy, cz);
  }
  return area;
}

/** Summed segment length of one edge group of a tessellated body. */
function edgeLength(edges: MeshedEdges, edgeId: number): number {
  const g = edges.edgeGroups?.find((eg) => eg.edgeId === edgeId);
  if (!g) return 0;
  const { lines } = edges;
  let len = 0;
  for (let v = g.start; v + 1 < g.start + g.count; v += 2) {
    const a = v * 3;
    const b = (v + 1) * 3;
    len += Math.hypot(lines[b] - lines[a], lines[b + 1] - lines[a + 1], lines[b + 2] - lines[a + 2]);
  }
  return len;
}

/** The face ids of the whole logical surface a picked facet belongs to (its
 *  cluster) — a faceted cylinder's N side facets, so measurements sum over the
 *  real surface, not one slice. Falls back to just the picked face. */
function faceClusterIds(faces: MeshedFaces, faceId: number): number[] {
  const g = faces.faceGroups?.find((fg) => fg.faceId === faceId);
  if (g?.clusterId === undefined || !faces.faceGroups) return [faceId];
  return faces.faceGroups.filter((fg) => fg.clusterId === g.clusterId).map((fg) => fg.faceId);
}

/** The edge ids of the whole logical curve a picked segment belongs to (its
 *  chain) — a faceted circle's N chords. Falls back to just the picked edge. */
function edgeChainIds(edges: MeshedEdges, edgeId: number): number[] {
  const g = edges.edgeGroups?.find((eg) => eg.edgeId === edgeId);
  if (g?.chainId === undefined || !edges.edgeGroups) return [edgeId];
  return edges.edgeGroups.filter((eg) => eg.chainId === g.chainId).map((eg) => eg.edgeId);
}

/** If an edge chain traces a full circle, its radius; else null. Fits a radius
 *  about the chain's centroid and accepts it only when every vertex sits within
 *  2% of that radius — true for a closed ring (centroid == centre), false for an
 *  arc (centroid off the axis → radii spread) or any non-circular chain. */
function edgeChainRadius(edges: MeshedEdges, ids: number[]): number | null {
  if (ids.length < 6) return null; // too few chords to trust as a circle
  const groups = ids.map((id) => edges.edgeGroups!.find((eg) => eg.edgeId === id)).filter(Boolean) as NonNullable<MeshedEdges["edgeGroups"]>;
  const { lines } = edges;
  const pts: Vec3[] = [];
  for (const g of groups) for (let v = g.start; v < g.start + g.count; v++) pts.push([lines[v * 3], lines[v * 3 + 1], lines[v * 3 + 2]]);
  if (pts.length < 6) return null;
  const c: Vec3 = [0, 0, 0];
  for (const p of pts) { c[0] += p[0]; c[1] += p[1]; c[2] += p[2]; }
  c[0] /= pts.length; c[1] /= pts.length; c[2] /= pts.length;
  let sum = 0;
  const radii = pts.map((p) => { const r = Math.hypot(p[0] - c[0], p[1] - c[1], p[2] - c[2]); sum += r; return r; });
  const r = sum / radii.length;
  if (r < 1e-6) return null;
  for (const ri of radii) if (Math.abs(ri - r) > 0.02 * r) return null; // not a full circle
  return r;
}

type Vec3 = [number, number, number];

/** Perpendicular distance from `q` to the infinite line through `p` along unit `d`. */
function distToLine(q: Vec3, p: Vec3, d: Vec3): number {
  const wx = q[0] - p[0];
  const wy = q[1] - p[1];
  const wz = q[2] - p[2];
  const t = wx * d[0] + wy * d[1] + wz * d[2];
  return Math.hypot(wx - t * d[0], wy - t * d[1], wz - t * d[2]);
}

/** The infinite line a STRAIGHT edge lies on — `p` a point on it, `d` a unit
 *  direction. Null for a curved edge (no single direction) or a degenerate one.
 *  The tessellated polyline is the only geometry we have here, so straightness is
 *  "every vertex lies on the chord", which a curve's sagitta fails comfortably. */
function edgeLine(edges: MeshedEdges, edgeId: number): { p: Vec3; d: Vec3 } | null {
  const g = edges.edgeGroups?.find((eg) => eg.edgeId === edgeId);
  if (!g || g.count < 2) return null;
  const { lines } = edges;
  const at = (v: number): Vec3 => [lines[v * 3], lines[v * 3 + 1], lines[v * 3 + 2]];
  const p = at(g.start);
  // The farthest vertex fixes the direction robustly — a closed or doubled-back
  // polyline can end where it started, so the last vertex won't do.
  let far = p;
  let farLen = 0;
  for (let v = g.start; v < g.start + g.count; v++) {
    const q = at(v);
    const len = Math.hypot(q[0] - p[0], q[1] - p[1], q[2] - p[2]);
    if (len > farLen) {
      farLen = len;
      far = q;
    }
  }
  if (farLen < 1e-9) return null;
  const d: Vec3 = [(far[0] - p[0]) / farLen, (far[1] - p[1]) / farLen, (far[2] - p[2]) / farLen];
  // Relative tolerance: vertices are float32, so an absolute epsilon is too tight.
  for (let v = g.start; v < g.start + g.count; v++) {
    if (distToLine(at(v), p, d) > 1e-4 * farLen) return null;
  }
  return { p, d };
}

/** Distance between two PARALLEL straight edges, or null if they aren't parallel
 *  (skew/intersecting lines have no single distance — an angle is the right
 *  measure there). Matches the sketch dimension's parallel tolerance: the sine of
 *  the angle between the directions. */
function parallelEdgeDistance(a: { p: Vec3; d: Vec3 }, b: { p: Vec3; d: Vec3 }): number | null {
  const cx = a.d[1] * b.d[2] - a.d[2] * b.d[1];
  const cy = a.d[2] * b.d[0] - a.d[0] * b.d[2];
  const cz = a.d[0] * b.d[1] - a.d[1] * b.d[0];
  if (Math.hypot(cx, cy, cz) > 1e-3) return null; // not parallel
  return distToLine(b.p, a.p, a.d);
}

/** A circle entity's radius, evaluated against the variable scope when it's
 *  expression-driven (`r: "dia/2"`) — the stored `.r` is a stale literal after a
 *  variable changes, since only the regen re-evaluates it, not this raw doc. */
function circleRadius(e: Extract<SketchEntity, { type: "circle" }>, scope: Scope): number {
  const expr = e.exprs?.r;
  if (!expr) return e.r;
  try {
    return evaluateExpression(expr, scope);
  } catch {
    return e.r;
  }
}

/** The radius of a sketch region bounded by exactly one circle (a disc), else
 *  null — the shared test behind a circular sketch face and a circular extrude. */
function circleRadiusOfRegion(region: SketchRegion, entities: SketchEntity[], scope: Scope): number | null {
  if (region.holes?.length || region.entityIds.length !== 1) return null;
  const e = entities.find((x) => x.id === region.entityIds[0]);
  return e?.type === "circle" ? circleRadius(e, scope) : null;
}

/** The true radius of a faceted circular face, traced from the extrude that made
 *  it back to its source sketch circle. An extruded circle is a POLYGONAL prism
 *  (the kernel can't boolean a real cylinder), so the radius is nowhere in the
 *  mesh — but a face named "{extrudeId}/start|end|side{n}" belongs to that
 *  extrude, and if its profile was a lone circle, every one of its faces (caps +
 *  wall facets) shares that circle's radius. Re-derived from the live document on
 *  every regen, so it tracks edits to the circle, its driving variable, or any
 *  earlier timeline feature; a downstream op that renames/splits the face drops
 *  the "{extrudeId}/…" prefix, and the diameter correctly disappears. */
function extrudedCircleRadius(doc: Document, faceName: string | undefined, scope: Scope): number | null {
  if (!faceName) return null;
  const feat = doc.features.find((f) => f.id === faceName.split("/")[0]);
  // A primitive cylinder is now a faceted prism too (so it can boolean), so its
  // faces carry no analytic radius — read it straight off the feature's param.
  if (feat?.type === "primitive" && feat.kind === "cylinder") {
    const r = evaluateExpression(feat.params.radius ?? "", scope);
    return Number.isFinite(r) && r > 0 ? r : null;
  }
  if (feat?.type !== "extrude") return null;
  const profile = feat.profile;
  if (profile.kind !== "sketchRegion") return null;
  const sk = doc.features.find((f) => f.id === profile.sketchId);
  if (sk?.type !== "sketch") return null;
  const region = detectSketchRegions(sk.entities).find((r) => r.id === profile.regionId);
  return region ? circleRadiusOfRegion(region, sk.entities, scope) : null;
}

export function measureSelection(
  selection: Selection[],
  doc: Document,
  meshes: FeatureMesh[],
  scope: Scope = {},
): MeasureInfo | null {
  if (selection.length === 0) return null;
  if (selection.length > 1) return measureMany(selection, meshes);
  return measureOne(selection[0], doc, meshes, scope);
}

/** Aggregate measurement for a multi-element selection. */
function measureMany(selection: Selection[], meshes: FeatureMesh[]): MeasureInfo {
  let area = 0;
  for (const s of selection) {
    if (s.kind === "face") {
      const m = meshes.find((x) => x.id === s.featureId);
      if (m) area += faceArea(m.mesh.faces, s.faceId);
    }
  }
  const rows = [{ label: "Selected", value: String(selection.length) }];
  if (area > 0) rows.push({ label: "Total area", value: fmt(area) });

  // Two parallel straight edges → their separation, the thing you actually want
  // when you pick two edges of a solid.
  const [s0, s1] = selection;
  if (selection.length === 2 && s0.kind === "edge" && s1.kind === "edge") {
    const m0 = meshes.find((x) => x.id === s0.featureId);
    const m1 = meshes.find((x) => x.id === s1.featureId);
    const l0 = m0 && edgeLine(m0.mesh.edges, s0.edgeId);
    const l1 = m1 && edgeLine(m1.mesh.edges, s1.edgeId);
    if (l0 && l1) {
      const dist = parallelEdgeDistance(l0, l1);
      if (dist !== null) rows.push({ label: "Parallel distance", value: fmt(dist) });
    }
  }
  return { title: "Selection", rows };
}

function measureOne(selection: Selection, doc: Document, meshes: FeatureMesh[], scope: Scope): MeasureInfo | null {
  if (selection.kind === "sketchEntity") {
    const sk = doc.features.find((f) => f.id === selection.sketchId);
    if (sk?.type !== "sketch") return null;
    const e = sk.entities.find((x) => x.id === selection.entityId);
    if (!e) return null;
    if (e.type === "line") {
      return { title: "Line", rows: [{ label: "Length", value: fmt(Math.hypot(e.b[0] - e.a[0], e.b[1] - e.a[1])) }] };
    }
    if (e.type === "circle") {
      return { title: "Circle", rows: [{ label: "Diameter", value: fmt(2 * circleRadius(e, scope)) }] };
    }
    if (e.type === "arc") {
      return {
        title: "Arc",
        rows: [
          { label: "Radius", value: fmt(e.r) },
          { label: "Arc length", value: fmt(e.r * Math.abs(e.end - e.start)) },
        ],
      };
    }
    if (e.type === "spline") {
      let len = 0;
      for (let i = 0; i + 1 < e.points.length; i++) {
        len += Math.hypot(e.points[i + 1][0] - e.points[i][0], e.points[i + 1][1] - e.points[i][1]);
      }
      return {
        title: "Spline",
        rows: [
          { label: "Points", value: String(e.points.length) },
          { label: "Chord length", value: fmt(len) },
        ],
      };
    }
    return null;
  }

  if (selection.kind === "sketchFace") {
    const sk = doc.features.find((f) => f.id === selection.sketchId);
    if (sk?.type !== "sketch") return null;
    const region = detectSketchRegions(sk.entities).find((r) => r.id === selection.regionId);
    if (!region) return null;
    const rows = [{ label: "Area", value: fmt(region.area) }];
    // A region bounded by a single circle is a disc → show its diameter too.
    const r = circleRadiusOfRegion(region, sk.entities, scope);
    if (r !== null) rows.push({ label: "Diameter", value: fmt(2 * r) });
    return { title: "Sketch face", rows };
  }

  if (selection.kind === "sketchPoint") {
    return {
      title: "Point",
      rows: [
        { label: "X", value: fmt(selection.point[0]) },
        { label: "Y", value: fmt(selection.point[1]) },
      ],
    };
  }

  if (selection.kind === "vertex") {
    return {
      title: "Vertex",
      rows: [
        { label: "X", value: fmt(selection.point[0]) },
        { label: "Y", value: fmt(selection.point[1]) },
        { label: "Z", value: fmt(selection.point[2]) },
      ],
    };
  }

  if (selection.kind === "face") {
    const m = meshes.find((x) => x.id === selection.featureId);
    if (!m) return null;
    // Sum over the whole logical face (a cylinder's facet cluster), not one slice.
    const clusterArea = faceClusterIds(m.mesh.faces, selection.faceId).reduce((sum, id) => sum + faceArea(m.mesh.faces, id), 0);
    const rows = [{ label: "Area", value: fmt(clusterArea) }];
    const group = m.mesh.faces.faceGroups?.find((g) => g.faceId === selection.faceId);
    // Diameter, for the faces the kernel could describe analytically (see FaceSurface).
    const s = group?.surface;
    if (s?.kind === "cylinder" || s?.kind === "disc") {
      rows.push({ label: "Diameter", value: fmt(2 * s.radius) });
    } else if (s?.kind === "annulus") {
      rows.push({ label: "Outer diameter", value: fmt(2 * s.radius) });
      rows.push({ label: "Inner diameter", value: fmt(2 * s.innerRadius) });
    } else {
      // No analytic surface (a faceted extruded circle) → trace back to the
      // source sketch circle for its diameter.
      const r = extrudedCircleRadius(doc, group?.name, scope);
      if (r !== null) rows.push({ label: "Diameter", value: fmt(2 * r) });
    }
    return { title: "Face", rows };
  }

  if (selection.kind === "edge") {
    const m = meshes.find((x) => x.id === selection.featureId);
    if (!m) return null;
    // Sum over the whole logical edge (a faceted circle's chords), not one chord.
    const ids = edgeChainIds(m.mesh.edges, selection.edgeId);
    const length = ids.reduce((sum, id) => sum + edgeLength(m.mesh.edges, id), 0);
    const radius = edgeChainRadius(m.mesh.edges, ids);
    const rows = radius !== null
      ? [{ label: "Diameter", value: fmt(2 * radius) }, { label: "Circumference", value: fmt(length) }]
      : [{ label: "Length", value: fmt(length) }];
    return { title: radius !== null ? "Circle" : "Edge", rows };
  }

  return null;
}
