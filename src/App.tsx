import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type PointerEvent,
  type ReactNode,
} from "react";
import { KernelClient } from "./kernel/KernelClient";
import { clamp } from "./lib/clamp";
import { useUpdateAvailable } from "./useVersionCheck";
import {
  addBoolean,
  addDressUp,
  addExtrude,
  addFeature,
  addImport,
  addLoft,
  addMirror,
  addPattern,
  addPlane,
  addRevolve,
  addSweep,
  addDerivedOp,
  setDerivedOffsetDistance,
  addSketch,
  addSketchConstraints,
  addSketchEntities,
  addTransform,
  addVariable,
  createDocument,
  genId,
  migrateDocument,
  moveFeature,
  removeFeature,
  removeSketchConstraint,
  removeSketchEntity,
  removeVariable,
  renameFeature,
  resolveDocument,
  setFeatureColor,
  setFeatureHidden,
  setFeatureOpacity,
  addShell,
  setRollbackIndex,
  setSketchConstraints,
  setSketchEntities,
  setSuppressed,
  setTransform,
  updateBoolean,
  updateDressUp,
  updateShell,
  updateExtrude,
  updateMirror,
  updateParam,
  updatePattern,
  updatePlane,
  updateRevolve,
  updateVariable,
} from "./document/document";
import { expandPickToChains } from "./geom/edgeChains";
import { parseDxfToEntities, sketchEntitiesBounds } from "./document/dxfImport";
import {
  applyDerivedToSketch,
  applyEntityExprs,
  circularPatternAngles,
  projectedEntityFromPolyline,
  projectedPointEntity,
  resolvePatternCenter,
  resolvePatternCount,
  sameProjectedEntities,
} from "./document/derived";
import { DEFAULT_SOLID_COLOR, hexToColor, setNewBodyColorPreference } from "./document/colors";
import type {
  DerivedOp,
  ProjectRef,
  Document,
  EdgeRef,
  FaceRef,
  Feature,
  ExtrudeExtent,
  ExtrudeProfile,
  FeatureKind,
  UpToFaceRef,
  PatternAxisRef,
  DistanceRef,
  PatternDirRef,
  PlaneFeature,
  PlaneMethod,
  PointRef,
  RevolveAxis,
  RevolveProfile,
  SketchConstraint,
  SketchEntity,
  SketchFeature,
  TransformFeature,
  Vec2,
} from "./document/types";
import { measureBetween, resolveSide } from "./sketch/distanceDim";
import { planCoincident, coincidentEnabled as coincidentIsEnabled } from "./sketch/coincidentSelection";
import { pinConstraints } from "./sketch/snapPins";
import type { BooleanOp, MeshedEdges, MeshedFaces, ShapeMeshPayload } from "./kernel/types";
import { DRESSUP_DELTA_IDS } from "./kernel/types";
import { solveSketch } from "./sketch/solver";
import { measureSelection } from "./selection/measure";
import {
  angledFrame,
  deriveFaceFrame,
  frameOf,
  midplaneFrame,
  offsetFrame,
  planeRefLabel,
  planeResolves,
  planeThrough3Points,
  uvToWorld,
  worldToUv,
  type PlaneFrameData,
  type SketchPlaneId,
  type SketchPlaneRef,
} from "./document/planes";
import { DEFAULT_SECTION_VIEW, type SectionViewState } from "./document/sectionView";
import { evaluateExpression } from "./document/expression";
import { validateDressUpSize, validateDressUpAngle, mapDressUpKernelError } from "./document/dressUpValidation";
import { validateShellThickness, mapShellKernelError } from "./document/shellValidation";
import { shellBodyFromSelection, toggleShellFace, retargetShell, NO_SHELL_FACES } from "./document/shellTarget";
import { detectSketchRegions, regionsEnclosedBy } from "./document/regions";
import { FEATURE_DEFS, FEATURE_KINDS, featureTypeLabel } from "./document/featureDefs";
import {
  deleteDoc,
  duplicateDoc,
  getActiveDocId,
  listMeta,
  loadDoc,
  putDoc,
  renameDoc,
  setActiveDocId,
  setThumb,
  type StoredDoc,
} from "./storage/db";
import { copyName, dedupeName, nextUntitled } from "./storage/docNames";
import { parseDocFile, serializeDocFile } from "./storage/docFile";
import { CorruptDocError } from "./storage/docErrors";
import { DocumentsDialog } from "./ui/DocumentsDialog";
import { ReportDialog } from "./ui/ReportDialog";
import { SettingsDialog } from "./ui/SettingsDialog";
import { useSettings } from "./settings/useSettings";
import {
  arcFrom3,
  circleFrom3,
  connectedEntityIds,
  detectSingleChain,
  fitProjectedPolyline,
  loopSegments,
  mirrorEntity,
  offsetChain,
  rectangleCorners,
  rectangleFromCenter,
  regularPolygon,
  rotateEntity,
  translateEntity,
  type ChainEdge,
  type FittedProjection,
  type OffsetPrimitive,
} from "./document/sketchTools";
import { useHistory } from "./hooks/useHistory";
import { useAgentBridge } from "./agent/useAgentBridge";
import type { AgentMesh, RegenSettle } from "./agent/commands";
import { ConstructionIcon, HorizontalIcon, OffsetIcon, ParallelIcon, VerticalIcon } from "./ui/icons";
import { BooleanDialog } from "./ui/BooleanDialog";
import { PickButton, PickedRow, PickSlot } from "./ui/PickSlot";
import { DraggableDialog } from "./ui/DraggableDialog";
import { DimensionOverlay, type DimSpec } from "./ui/DimensionOverlay";
import { DimValueInput, type VarOption } from "./ui/DimValueInput";
import { FeatureTree } from "./ui/FeatureTree";
import { EditPanel } from "./ui/EditPanel";
import { OverflowColumn, type ColumnSlot } from "./ui/OverflowColumn";
import { OverflowToolbar } from "./ui/OverflowToolbar";
import type { ToolbarItem, ToolbarRow } from "./ui/toolbarOverflow";
import { ParamEditor } from "./ui/ParamEditor";
import { SolidsList } from "./ui/SolidsList";
import { VariablesPanel } from "./ui/VariablesPanel";
import {
  Viewport,
  sameSelection,
  type DatumId,
  type ExtrudeGizmo,
  type FeatureMesh,
  type GhostMesh,
  type RevolveAxisPick,
  type Selection,
  type SelectionFilter,
  type SketchTool,
  type TransformEdit,
  type TransformMode,
  type ViewName,
  type ViewportApi,
} from "./viewport/Viewport";
import "./App.css";

/** Log each regen's end-to-end round-trip time to the console. Off by default;
 *  enable with `?perf` in the URL to objectively compare responsiveness. */
const PERF_LOG = typeof location !== "undefined" && location.search.includes("perf");

/** Compact number formatting for the dimension input (trims trailing zeros). */
const fmt = (n: number) => {
  const r = Math.round(n * 1000) / 1000;
  return Number.isInteger(r) ? String(r) : String(r);
};

// DXF has no reliable notion of physical units — imported coordinates are bare
// numbers. We convert to Open Poly's millimetres with a scale the user picks;
// the $INSUNITS header code (when present) preselects the likely source unit.
type DxfUnitsKey = "mm" | "cm" | "m" | "in";
const DXF_UNITS: { key: DxfUnitsKey; label: string; scale: number }[] = [
  { key: "mm", label: "Millimeters (1:1)", scale: 1 },
  { key: "cm", label: "Centimeters (×10)", scale: 10 },
  { key: "m", label: "Meters (×1000)", scale: 1000 },
  { key: "in", label: "Inches (×25.4)", scale: 25.4 },
];
const dxfScaleOf = (key: DxfUnitsKey) => DXF_UNITS.find((u) => u.key === key)?.scale ?? 1;
// AutoCAD $INSUNITS values we recognise → our unit key (1=in, 4=mm, 5=cm, 6=m).
const INSUNITS_TO_KEY: Record<number, DxfUnitsKey> = { 1: "in", 4: "mm", 5: "cm", 6: "m" };
/** Read the DXF header's `$INSUNITS` (a code-9 name followed by a code-70 int)
 *  and map it to a unit key, so the dialog can preselect. Returns null if absent
 *  or unrecognised (caller defaults to mm). */
function guessDxfUnits(text: string): DxfUnitsKey | null {
  const m = /\$INSUNITS\s*\r?\n\s*70\s*\r?\n\s*(\d+)/.exec(text);
  return m ? (INSUNITS_TO_KEY[Number(m[1])] ?? null) : null;
}

// The geometric constraints grouped behind the one toolbar button, in flyout
// order. (Dimensional constraints and the construction toggle stay separate.)
type ConstraintKind = "horizontal" | "vertical" | "parallel" | "perpendicular" | "equal" | "coincident" | "tangent";
const CONSTRAINT_ORDER: readonly ConstraintKind[] = [
  "horizontal",
  "vertical",
  "parallel",
  "perpendicular",
  "equal",
  "coincident",
  "tangent",
];
const CONSTRAINT_NAME: Record<ConstraintKind, string> = {
  horizontal: "Horizontal",
  vertical: "Vertical",
  parallel: "Parallel",
  perpendicular: "Perpendicular",
  equal: "Equal",
  coincident: "Coincident",
  tangent: "Tangent",
};

/** Human-readable label for a sketch constraint (for the constraints list). */
const constraintLabel = (c: SketchConstraint): string => {
  switch (c.type) {
    case "horizontal":
      return "Horizontal";
    case "vertical":
      return "Vertical";
    case "parallel":
      return "Parallel";
    case "perpendicular":
      return "Perpendicular";
    case "equal":
      return "Equal";
    case "distance":
      return `Length ${fmt(c.value)}`;
    case "distanceBetween":
      return `Distance ${fmt(c.value)}`;
    case "radius":
      return `Radius ${fmt(c.value)}`;
    case "angle":
      return `Angle ${fmt(c.value)}°`;
    case "tangent":
      return "Tangent";
    case "coincident":
      return "origin" in c.a || "origin" in c.b ? "Coincident (origin)" : "Coincident";
    case "pointOnLine":
      return "origin" in c.point ? "On line (origin)" : "Point on line";
    case "pointOnCircle":
      return "Point on circle";
    case "midpoint":
      return "Midpoint";
  }
};

/** The uv position a PointRef resolves to in its sketch, or null if it can't be
 *  resolved (a `{fixed}` external point resolves to its stored uv). Used to drop
 *  a point marker where a constraint acts. */
const pointRefUv = (entities: SketchEntity[], ref: PointRef): Vec2 | null => {
  if ("origin" in ref) return [0, 0];
  if ("fixed" in ref) return ref.fixed;
  const e = entities.find((x) => x.id === ref.entity);
  if (!e) return null;
  if (e.type === "line") return ref.at === "b" ? e.b : e.a;
  if (e.type === "point") return e.p;
  if (e.type === "circle") return e.c;
  if (e.type === "arc") {
    if (ref.at === "c") return e.c;
    const ang = ref.at === "b" ? e.end : e.start;
    return [e.c[0] + e.r * Math.cos(ang), e.c[1] + e.r * Math.sin(ang)];
  }
  return null;
};

/** The sketch entities + points a constraint references, as viewport Selections,
 *  so hovering the constraint in the list lights them up. Entity refs become
 *  `sketchEntity`; point refs become a precise `sketchPoint` marker (plus the
 *  owning line/target entity for context). */
const constraintSelections = (sketchId: string, entities: SketchEntity[], c: SketchConstraint): Selection[] => {
  const ent = (entityId: string): Selection => ({ kind: "sketchEntity", sketchId, entityId });
  const pt = (ref: PointRef): Selection[] => {
    const uv = pointRefUv(entities, ref);
    const out: Selection[] = uv ? [{ kind: "sketchPoint", sketchId, point: uv }] : [];
    if ("entity" in ref) out.push(ent(ref.entity));
    return out;
  };
  const dist = (ref: DistanceRef): Selection[] => (ref.on === "point" ? pt(ref.ref) : [ent(ref.entity)]);
  switch (c.type) {
    case "horizontal":
    case "vertical":
    case "distance":
    case "radius":
      return [ent(c.entity)];
    case "parallel":
    case "perpendicular":
    case "equal":
    case "tangent":
    case "angle":
      return [ent(c.a), ent(c.b)];
    case "distanceBetween":
      return [...dist(c.a), ...dist(c.b)];
    case "coincident":
      return [...pt(c.a), ...pt(c.b)];
    case "pointOnLine":
      return [...pt(c.point), ent(c.line)];
    case "pointOnCircle":
      return [...pt(c.point), ent(c.circle)];
    case "midpoint":
      return [...pt(c.point), ent(c.target)];
  }
};

/** Average position of a tessellated body face — the centroid fallback used to
 *  re-find a face that has no persistent name yet. */
function faceCentroid(faces: MeshedFaces, faceId: number): [number, number, number] | null {
  const g = faces.faceGroups?.find((fg) => fg.faceId === faceId);
  if (!g) return null;
  const { triangles, vertices } = faces;
  let sx = 0,
    sy = 0,
    sz = 0,
    n = 0;
  for (let k = g.start; k < g.start + g.count; k++) {
    const vi = triangles[k] * 3;
    sx += vertices[vi];
    sy += vertices[vi + 1];
    sz += vertices[vi + 2];
    n++;
  }
  return n ? [sx / n, sy / n, sz / n] : null;
}

/** Unit normal of a tessellated body face, or null if the face is non-planar
 *  (vertices not coplanar within tolerance — e.g. a cylinder side). Prefers the
 *  meshed per-vertex normals, falling back to the first non-degenerate triangle's
 *  geometric normal. Used to derive a mirror plane from a picked planar face. */
function faceNormal(faces: MeshedFaces, faceId: number): [number, number, number] | null {
  const g = faces.faceGroups?.find((fg) => fg.faceId === faceId);
  if (!g) return null;
  const { triangles, vertices, normals } = faces;
  let n: [number, number, number] | null = null;
  if (normals && normals.length) {
    let nx = 0,
      ny = 0,
      nz = 0;
    for (let k = g.start; k < g.start + g.count; k++) {
      const vi = triangles[k] * 3;
      nx += normals[vi];
      ny += normals[vi + 1];
      nz += normals[vi + 2];
    }
    const l = Math.hypot(nx, ny, nz);
    if (l > 1e-9) n = [nx / l, ny / l, nz / l];
  }
  if (!n) {
    for (let k = g.start; k + 2 < g.start + g.count; k += 3) {
      const a = triangles[k] * 3,
        b = triangles[k + 1] * 3,
        c = triangles[k + 2] * 3;
      const ux = vertices[b] - vertices[a],
        uy = vertices[b + 1] - vertices[a + 1],
        uz = vertices[b + 2] - vertices[a + 2];
      const vx = vertices[c] - vertices[a],
        vy = vertices[c + 1] - vertices[a + 1],
        vz = vertices[c + 2] - vertices[a + 2];
      const nx = uy * vz - uz * vy,
        ny = uz * vx - ux * vz,
        nz = ux * vy - uy * vx;
      const l = Math.hypot(nx, ny, nz);
      if (l > 1e-9) {
        n = [nx / l, ny / l, nz / l];
        break;
      }
    }
  }
  if (!n) return null;
  // Reject a non-planar face: every vertex must lie on the plane (point + n).
  const a0 = triangles[g.start] * 3;
  const px = vertices[a0],
    py = vertices[a0 + 1],
    pz = vertices[a0 + 2];
  for (let k = g.start; k < g.start + g.count; k++) {
    const vi = triangles[k] * 3;
    const d = (vertices[vi] - px) * n[0] + (vertices[vi + 1] - py) * n[1] + (vertices[vi + 2] - pz) * n[2];
    if (Math.abs(d) > 0.05) return null; // mm tolerance
  }
  return n;
}

/** Bounding-box centre of a tessellated body — the default rotation pivot for a
 *  Transform (intuitive: the body spins about its own middle). */
function bodyCenter(faces: MeshedFaces): [number, number, number] {
  const { vertices } = faces;
  if (vertices.length === 0) return [0, 0, 0];
  let minX = Infinity,
    minY = Infinity,
    minZ = Infinity;
  let maxX = -Infinity,
    maxY = -Infinity,
    maxZ = -Infinity;
  for (let i = 0; i < vertices.length; i += 3) {
    const x = vertices[i],
      y = vertices[i + 1],
      z = vertices[i + 2];
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
  }
  return [(minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2];
}

/** 2D: is point p inside triangle a-b-c (uv space)? (sign-consistency test) */
function pointInTriangle(p: Vec2, a: Vec2, b: Vec2, c: Vec2): boolean {
  const cross = (o: Vec2, u: Vec2, w: Vec2) => (u[0] - o[0]) * (w[1] - o[1]) - (u[1] - o[1]) * (w[0] - o[0]);
  const d1 = cross(p, a, b),
    d2 = cross(p, b, c),
    d3 = cross(p, c, a);
  return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0));
}

/** Where two infinite lines (uv space) cross, or null if they're parallel
 *  (within ~0.006°) — the corner an angle dimension's arc/box is anchored on. */
function lineLineIntersection(a1: Vec2, b1: Vec2, a2: Vec2, b2: Vec2): Vec2 | null {
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
function rayFromCorner(line: Extract<SketchEntity, { type: "line" }>, p: Vec2): Vec2 {
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
function sketchBoundsCenter(entities: SketchEntity[]): Vec2 {
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
function moveSketchPoints(entities: SketchEntity[], points: { from: Vec2; to: Vec2 }[]): SketchEntity[] {
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
function bodyUnderRegion(frame: PlaneFrameData, outline: Vec2[], meshes: FeatureMesh[]): string | null {
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

/** The persistent topological name of a tessellated face (if it has one). */
function faceNameOf(faces: MeshedFaces, faceId: number): string | undefined {
  return faces.faceGroups?.find((fg) => fg.faceId === faceId)?.name;
}

/** The persistent topological name of a tessellated edge (if it has one). */
function edgeNameOf(edges: MeshedEdges, edgeId: number): string | undefined {
  return edges.edgeGroups?.find((eg) => eg.edgeId === edgeId)?.name;
}

/** Midpoint of a tessellated edge (world space) — anchors the dress-up dialog. */
function edgeMidpoint(edges: MeshedEdges, edgeId: number): [number, number, number] | null {
  const g = edges.edgeGroups?.find((eg) => eg.edgeId === edgeId);
  if (!g) return null;
  const { lines } = edges;
  let sx = 0,
    sy = 0,
    sz = 0,
    n = 0;
  for (let v = g.start; v < g.start + g.count; v++) {
    sx += lines[v * 3];
    sy += lines[v * 3 + 1];
    sz += lines[v * 3 + 2];
    n++;
  }
  return n ? [sx / n, sy / n, sz / n] : null;
}

/** Geometric fingerprint of a tessellated edge, stored with a dress-up so the
 *  kernel can re-match the edge if an upstream edit renames it. `mid` is the
 *  polyline's bounding-box centre (matches the kernel's edge-bbox centre — and
 *  is robust for closed edges, where an endpoint average lands on the seam);
 *  `length` is the polyline arc length. */
function edgeFingerprint(edges: MeshedEdges, edgeId: number): { mid: [number, number, number]; length: number } | null {
  const g = edges.edgeGroups?.find((eg) => eg.edgeId === edgeId);
  if (!g || g.count === 0) return null;
  const { lines } = edges;
  let minX = Infinity,
    minY = Infinity,
    minZ = Infinity;
  let maxX = -Infinity,
    maxY = -Infinity,
    maxZ = -Infinity;
  let length = 0;
  for (let v = g.start; v < g.start + g.count; v++) {
    const x = lines[v * 3],
      y = lines[v * 3 + 1],
      z = lines[v * 3 + 2];
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    minZ = Math.min(minZ, z);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
    maxZ = Math.max(maxZ, z);
    if (v > g.start) {
      length += Math.hypot(x - lines[(v - 1) * 3], y - lines[(v - 1) * 3 + 1], z - lines[(v - 1) * 3 + 2]);
    }
  }
  return { mid: [(minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2], length };
}

/** Apply a rigid motion to a tessellated mesh payload for the Pattern dialog's
 *  ghost preview — no kernel round trip: positions map through `mapPt`, normals
 *  through `mapVec` (identity for a pure translation). Face/edge groups are
 *  dropped (ghosts are never picked). */
function transformMeshPayload(
  mesh: ShapeMeshPayload,
  mapPt: (p: [number, number, number]) => [number, number, number],
  mapVec: (v: [number, number, number]) => [number, number, number],
): ShapeMeshPayload {
  const mapFlat = (src: ArrayLike<number>, fn: (p: [number, number, number]) => [number, number, number]) => {
    const out = new Array<number>(src.length);
    for (let i = 0; i < src.length; i += 3) {
      const [x, y, z] = fn([src[i], src[i + 1], src[i + 2]]);
      out[i] = x;
      out[i + 1] = y;
      out[i + 2] = z;
    }
    return out;
  };
  return {
    name: mesh.name,
    faces: {
      vertices: mapFlat(mesh.faces.vertices, mapPt),
      triangles: mesh.faces.triangles,
      ...(mesh.faces.normals ? { normals: mapFlat(mesh.faces.normals, mapVec) } : {}),
    },
    edges: { lines: mapFlat(mesh.edges.lines, mapPt) },
  };
}

/** Point/vector mappers for a rotation of `angle` radians about the axis line
 *  through `origin` along (unit) `dir` — Rodrigues' formula. */
function rotationMappers(origin: [number, number, number], dir: [number, number, number], angle: number) {
  const [ux, uy, uz] = dir;
  const cos = Math.cos(angle),
    sin = Math.sin(angle);
  const mapVec = (v: [number, number, number]): [number, number, number] => {
    const [x, y, z] = v;
    const dot = ux * x + uy * y + uz * z;
    const cx = uy * z - uz * y,
      cy = uz * x - ux * z,
      cz = ux * y - uy * x;
    return [
      x * cos + cx * sin + ux * dot * (1 - cos),
      y * cos + cy * sin + uy * dot * (1 - cos),
      z * cos + cz * sin + uz * dot * (1 - cos),
    ];
  };
  const mapPt = (p: [number, number, number]): [number, number, number] => {
    const r = mapVec([p[0] - origin[0], p[1] - origin[1], p[2] - origin[2]]);
    return [r[0] + origin[0], r[1] + origin[1], r[2] + origin[2]];
  };
  return { mapPt, mapVec };
}

/** Saves a Blob to the user's machine via a throwaway anchor element. */
function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/** Strips characters that are awkward in filenames across platforms. */
const safeFilename = (name: string) => name.replace(/[^a-z0-9_-]+/gi, "_");

const DATUM_ROWS: { id: DatumId; kind: string; label: string }[] = [
  { id: "origin", kind: "Point", label: "Origin" },
  { id: "plane-top", kind: "Plane", label: "Top" },
  { id: "plane-front", kind: "Plane", label: "Front" },
  { id: "plane-right", kind: "Plane", label: "Right" },
];

// `name` is the plain-text name the More flyout lists and searches on (the
// label is an icon, the title a full sentence).
const SKETCH_TOOLS: { tool: SketchTool; label: ReactNode; name: string; title: string; sc: string }[] = [
  { tool: "select", label: "↖", name: "Select", title: "Select (S)", sc: "S" },
  { tool: "line", label: "╱", name: "Line", title: "Line (L)", sc: "L" },
  { tool: "rect-corner", label: "▭", name: "Rectangle: 2 corners", title: "Rectangle: 2 corners (R)", sc: "R" },
  {
    tool: "rect-center",
    label: "⊞",
    name: "Rectangle: center",
    title: "Rectangle: center + corner (Shift+R)",
    sc: "⇧R",
  },
  { tool: "circle-center", label: "○", name: "Circle: center + radius", title: "Circle: center + radius (C)", sc: "C" },
  { tool: "circle-3p", label: "◔", name: "Circle: 3 points", title: "Circle: 3 points (Shift+C)", sc: "⇧C" },
  { tool: "polygon", label: "⬢", name: "Polygon", title: "Regular polygon (P)", sc: "P" },
  { tool: "arc-3p", label: "⌒", name: "Arc", title: "Arc: 3 points (A)", sc: "A" },
  { tool: "spline", label: "∿", name: "Spline", title: "Spline (Shift+S): click points, Esc to finish", sc: "⇧S" },
  {
    tool: "offset",
    label: <OffsetIcon />,
    name: "Offset",
    title: "Offset (O): select a single chain of edges, then drag / type the distance",
    sc: "O",
  },
  {
    tool: "mirror",
    label: "◫",
    name: "Mirror",
    title:
      "Mirror (M): select a line to arm the mirror axis, then select entities to mirror; Enter commits, Esc cancels",
    sc: "M",
  },
  {
    tool: "pattern-linear",
    // The same glyph the solids toolbar's Pattern button wears: patterning is
    // one idea, and it should look like one whether the thing being repeated is
    // a body or a sketch entity.
    label: "⁙",
    name: "Linear pattern",
    title: "Linear pattern (X): select entities to repeat, set count + step; Enter commits, Esc cancels",
    sc: "X",
  },
  {
    tool: "pattern-circular",
    label: "⊛",
    name: "Circular pattern",
    title: "Circular pattern (Shift+X): select the center point, then entities to repeat; Enter commits, Esc cancels",
    sc: "⇧X",
  },
  {
    tool: "project",
    label: "⧉",
    name: "Project / Convert",
    title:
      "Project / Convert (U): click body edges & vertices to project them onto the sketch; Enter commits, Esc cancels",
    sc: "U",
  },
  {
    tool: "text",
    label: "T",
    name: "Text",
    title: "Text (T): click to place, then type the text & height; Enter commits, Esc cancels",
    sc: "T",
  },
];
const sketchToolMeta = (t: SketchTool) => SKETCH_TOOLS.find((x) => x.tool === t)!;

// The two circle tools and the two rectangle tools each collapse into a single
// primary button (the last-used variant, clickable to select it) plus a ▸ arrow
// that opens a vertical flyout of the variants — same UX as the grouped
// constraint button. Shortcuts are unchanged: the bare key picks variant[0],
// Shift the second (see SKETCH_KEYS / SKETCH_SHIFT_KEYS).
const SKETCH_GROUPS = {
  rect: {
    name: "Rectangle",
    title: "Rectangle (R = 2 corners, Shift+R = center)",
    variants: ["rect-corner", "rect-center"] as const,
  },
  circle: {
    name: "Circle",
    title: "Circle (C = center + radius, Shift+C = 3 points)",
    variants: ["circle-center", "circle-3p"] as const,
  },
  pattern: {
    name: "Pattern",
    title: "Pattern (X = linear, Shift+X = circular)",
    variants: ["pattern-linear", "pattern-circular"] as const,
  },
};
type SketchGroupId = keyof typeof SKETCH_GROUPS;

/** Shell dialog state. `targetId` is the body being hollowed — armed when the
 *  tool opens and re-pickable from the dialog; `faces` (with their parallel
 *  `faceRefs` fingerprints) are the optional openings. `arming` says which role
 *  the next viewport click fills.
 *
 *  No x/y: like Boolean and Pattern — the other dialogs you pick INTO — this one
 *  sits at a fixed spot out of the way, because anchoring it to the clicked face
 *  parked it right on top of the geometry whose faces you then have to click. */
interface ShellDialogState {
  thickness: string;
  editId?: string;
  /** Set once this dialog has put a feature in the timeline that the user has
   *  not confirmed yet — see `createShell`. Cancelling removes it; pressing
   *  Create again updates it rather than adding a second one. */
  createdId?: string;
  targetId: string | null;
  faces: string[];
  faceRefs: FaceRef[];
  arming: "body" | "faces" | null;
}
/** A Shell dialog with its body armed — the state a feature can be built from. */
type ArmedShellDialog = ShellDialogState & { targetId: string };

// Short display names for the variants shown in each group's vertical flyout.
/** Below this (mm) a drawn segment/radius is nothing: a zero-size entity is
 *  invisible AND unpickable, so it can never be selected or deleted again — and
 *  it drags the sketch's degrees of freedom around invisibly. Drawing one is an
 *  easy slip (a double-click, or a second click the snap pulls back onto the
 *  first), so the draw tools refuse instead of committing it. */
const MIN_SEGMENT = 1e-3;

const SKETCH_VARIANT_NAME: Partial<Record<SketchTool, string>> = {
  "rect-corner": "2 corners",
  "rect-center": "Center",
  "circle-center": "Center + radius",
  "circle-3p": "3 points",
  "pattern-linear": "Linear",
  "pattern-circular": "Circular",
};
// Left-to-right (top-to-bottom in the vertical bar) order, with the two tool
// pairs replaced by their group flyouts.
const SKETCH_LAYOUT: ({ kind: "tool"; tool: SketchTool } | { kind: "group"; group: SketchGroupId })[] = [
  { kind: "tool", tool: "select" },
  { kind: "tool", tool: "line" },
  { kind: "group", group: "rect" },
  { kind: "group", group: "circle" },
  { kind: "tool", tool: "polygon" },
  { kind: "tool", tool: "arc-3p" },
  { kind: "tool", tool: "spline" },
  { kind: "tool", tool: "offset" },
  { kind: "tool", tool: "mirror" },
  { kind: "group", group: "pattern" },
  { kind: "tool", tool: "project" },
  { kind: "tool", tool: "text" },
];

/** Turn a raw offset primitive into a committable SketchEntity (fresh id). */
function offsetPrimToEntity(p: OffsetPrimitive, construction: boolean, id = genId()): SketchEntity {
  const base = construction ? { construction: true as const } : {};
  if (p.type === "line") return { type: "line", id, a: p.a, b: p.b, ...base };
  if (p.type === "circle") return { type: "circle", id, c: p.c, r: p.r, ...base };
  return { type: "arc", id, c: p.c, r: p.r, start: p.start, end: p.end, ...base };
}

/** Turn a fitted projected edge (Project/Convert tool) into a SketchEntity. */
function fittedToEntity(f: FittedProjection, id = genId()): SketchEntity {
  switch (f.type) {
    case "line":
      return { type: "line", id, a: f.a, b: f.b };
    case "circle":
      return { type: "circle", id, c: f.c, r: f.r };
    case "arc":
      return { type: "arc", id, c: f.c, r: f.r, start: f.start, end: f.end };
    case "spline":
      return { type: "spline", id, points: f.points };
  }
}

// Order backs the 1-7 keyboard shortcuts for named views (the on-canvas
// gizmo handles mouse clicks — see Viewport.tsx).
const VIEW_KEYS: ViewName[] = ["top", "front", "right", "back", "left", "bottom", "iso"];

function initialDocument(): Document {
  // Seed with one box so there is something on screen on first load.
  return addFeature(createDocument(), "box").doc;
}

export default function App() {
  const kernelRef = useRef<KernelClient | null>(null);
  const [ready, setReady] = useState(false);

  const {
    state: doc,
    set: setDoc,
    reset: resetDoc,
    undo,
    redo,
    canUndo,
    canRedo,
  } = useHistory<Document>(initialDocument);
  // Persistence: the IndexedDB record id for the working document, and whether
  // the initial load has completed (autosave waits for it so the placeholder
  // doesn't clobber a saved doc).
  const docIdRef = useRef<string | null>(null);
  if (docIdRef.current === null) docIdRef.current = genId();
  const [persistLoaded, setPersistLoaded] = useState(false);
  // Document identity (Phase 8.7). The name lives OUTSIDE the parametric
  // `Document` (rename is a storage-level operation, not an undoable model
  // edit); `createdAt` rides along so autosaves preserve it.
  const [docName, setDocName] = useState("Untitled");
  const docCreatedAtRef = useRef<number>(Date.now());
  // Inline title editing in the topbar: null when idle, else the draft text.
  const [titleDraft, setTitleDraft] = useState<string | null>(null);
  // State mirror of docIdRef for things that must re-render/re-run when the
  // active document changes (dialog highlight, the multi-tab guard effect).
  const [activeId, setActiveId] = useState<string | null>(null);
  const [docsDialogOpen, setDocsDialogOpen] = useState(false);
  const [reportOpen, setReportOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  // User preferences (color theme, new-body color, mouse bindings). Owned here
  // and read by the topbar and the Viewport; persisted to localStorage, NOT to
  // the document — they follow the person, not the model.
  const { settings, update: updateSettings, resolvedTheme } = useSettings();
  // The document builders pick a new body's colour deep in pure code that has no
  // route to React state, so the preference is pushed down to them as module
  // state. Layout effect, not a plain one: a feature can be created in the same
  // commit that applies a settings change (the agent bridge, or an undo landing
  // alongside), and this has to be in place first.
  useLayoutEffect(() => {
    setNewBodyColorPreference(settings.newBodyColor === "random" ? null : hexToColor(settings.newBodyColor));
  }, [settings.newBodyColor]);
  // Left panel visibility. Togglable at any width; on a phone it's an
  // off-canvas drawer over the viewport, so it starts hidden there to keep the
  // 3D view (the point of the app) front and centre.
  const [sidebarOpen, setSidebarOpen] = useState(() => typeof window === "undefined" || window.innerWidth > 820);
  // True while the SAME document is open in another tab (BroadcastChannel).
  const [docInOtherTab, setDocInOtherTab] = useState(false);
  const tabIdRef = useRef(genId());
  // Set once, at most, by the boot-restore effect when the saved active/most-
  // recent document couldn't be opened — a dismissible banner pointing at the
  // Documents dialog's existing Export/Delete actions, rather than the app
  // silently falling back to a blank doc. "corrupted" means the record loaded
  // but its content didn't migrate (Export as JSON still works on it);
  // "unreadable" means the record itself couldn't be read from IndexedDB (rarer
  // — Export as JSON may not help either, so that promise isn't made).
  const [docRecoveryBanner, setDocRecoveryBanner] = useState<
    { kind: "corrupted"; name: string } | { kind: "unreadable" } | null
  >(null);
  // True once a newer build has been deployed — surfaces a "refresh" banner.
  const updateAvailable = useUpdateAvailable();
  const [selection, setSelection] = useState<Selection[]>([]);
  const featureIdOf = (s: Selection): string =>
    s.kind === "feature" ? s.id : "featureId" in s ? s.featureId : s.sketchId;
  const selectedFeatureIds = useMemo(() => new Set(selection.map(featureIdOf)), [selection]);
  // Which rendered bodies a whole-feature selection should highlight. A body
  // keeps the id of the feature that *created* it; in-place modifiers (Add/Remove
  // extrude, chamfer/fillet) preserve the target's id, so selecting the modifier
  // feature should highlight that target body (not look for a body with the
  // modifier's own id, which doesn't exist).
  const highlightBodyIds = useMemo(() => {
    const ids = new Set<string>();
    for (const s of selection) {
      if (s.kind !== "feature") continue;
      const f = doc.features.find((x) => x.id === s.id);
      if (f?.type === "extrude" && (f.mode === "add" || f.mode === "remove") && f.targetId) ids.add(f.targetId);
      else if (f?.type === "dressup") ids.add(f.targetId);
      else if (f?.type === "shell") ids.add(f.targetId);
      else if (f?.type === "transform") ids.add(f.copy ? f.id : f.targetId);
      else ids.add(s.id);
    }
    return ids;
  }, [selection, doc]);
  const primaryFeatureId = selection.length ? featureIdOf(selection[selection.length - 1]) : null;
  const selectFeature = (id: string | null) => setSelection(id === null ? [] : [{ kind: "feature", id }]);
  // Regular clicks accumulate into the set; clicking a selected element removes
  // it; clicking empty space clears.
  const handlePick = (picked: Selection | null, sketchUv?: Vec2) => {
    // Up-to-face pick armed (from the extrude dialog): the next clicked body
    // face becomes the extrude's target face. Anything else is ignored and the
    // arming stays live for another try — a miss is a misclick, not a decision
    // to stop picking (same as the mirror face and the shell faces below).
    if (pickingUpFace) {
      if (picked?.kind === "face") {
        const m = meshes.find((x) => x.id === picked.featureId);
        const center = m ? faceCentroid(m.mesh.faces, picked.faceId) : null;
        if (center) {
          const faceName = m ? faceNameOf(m.mesh.faces, picked.faceId) : undefined;
          // normal completes the geometric fingerprint (null for non-planar).
          const normal = (m && faceNormal(m.mesh.faces, picked.faceId)) || undefined;
          setExtrudeDialog((d) => (d ? { ...d, upTo: { featureId: picked.featureId, faceName, center, normal } } : d));
          setPickingUpFace(false);
        }
      }
      return;
    }
    // Mirror-face pick armed (from the Mirror dialog): the next clicked planar
    // body face becomes the mirror plane. A non-planar face (faceNormal → null)
    // is ignored so the arming stays active for another try.
    if (pickingMirrorFace) {
      if (picked?.kind === "face") {
        const m = meshes.find((x) => x.id === picked.featureId);
        const center = m ? faceCentroid(m.mesh.faces, picked.faceId) : null;
        const normal = m ? faceNormal(m.mesh.faces, picked.faceId) : null;
        if (center && normal) {
          const frame = deriveFaceFrame(center, normal);
          setMirrorDialog((d) => (d ? { ...d, plane: "face", faceRef: { featureId: picked.featureId, frame } } : d));
          setPickingMirrorFace(false);
        }
      }
      return;
    }
    // Through-3-points plane pick armed: read a world point from the clicked
    // vertex or sketch point and append it (up to 3); ignore anything else.
    if (planePick === "point") {
      let wp: [number, number, number] | null = null;
      if (picked?.kind === "vertex") wp = picked.point;
      else if (picked?.kind === "sketchPoint") {
        const sk = doc.features.find((f) => f.id === picked.sketchId);
        if (sk?.type === "sketch") {
          wp = uvToWorld(frameOf(sk.plane, resolved.planeFrames), picked.point[0], picked.point[1]);
        }
      }
      if (wp) {
        setPlaneDialog((d) => (d && d.points.length < 3 ? { ...d, points: [...d.points, wp!] } : d));
      }
      return;
    }
    // Boolean dialog open: a clicked body fills the dialog instead of changing
    // the normal selection. union/intersect toggle a single operand list;
    // subtract routes to the armed slot (base = one part; tools accumulate).
    if (booleanDialog) {
      const id = picked ? featureIdOf(picked) : null;
      if (!id || !booleanCandidates.some((c) => c.id === id)) return;
      setBooleanDialog((d) => {
        if (!d) return d;
        if (d.op === "subtract") {
          const slot = d.armed ?? (d.base ? "tools" : "base");
          if (slot === "base") {
            // Set the base; it can't also be a tool; advance to picking tools.
            return { ...d, base: id, tools: d.tools.filter((t) => t !== id), armed: "tools" };
          }
          if (id === d.base) return d; // the base can't be a tool
          const has = d.tools.includes(id);
          return { ...d, tools: has ? d.tools.filter((t) => t !== id) : [...d.tools, id], armed: "tools" };
        }
        const has = d.operandIds.includes(id);
        return { ...d, operandIds: has ? d.operandIds.filter((x) => x !== id) : [...d.operandIds, id] };
      });
      return;
    }
    // Shell dialog open with a slot armed. Re-picking the BODY takes any click
    // that resolves to a body; arming FACES accumulates clicked faces of the
    // armed body (clicking one again removes it). Neither changes the normal
    // selection — the dialog is the source of truth for what gets shelled.
    if (shellDialog?.arming === "body") {
      const id = picked ? featureIdOf(picked) : null;
      if (id && bodyIds.has(id)) {
        setShellDialog((d) => (d ? { ...d, ...retargetShell(d, id), arming: null } : d));
        selectFeature(id);
      }
      return;
    }
    if (shellDialog?.arming === "faces") {
      // Only faces of the armed body: a face elsewhere would be a name the
      // shell can't resolve. Ignored rather than treated as a re-target, so the
      // arming stays live for another try.
      if (picked?.kind === "face" && picked.featureId === shellDialog.targetId) {
        const ref = shellFaceRefAt(picked.featureId, picked.faceId);
        if (ref) setShellDialog((d) => (d ? { ...d, ...toggleShellFace(d, ref.name, ref) } : d));
      }
      return;
    }
    // Pattern dialog open, TARGET body not yet picked: like Revolve's profile,
    // arming it happens via the normal selection raycaster (any click that
    // resolves to a body).
    if (patternDialog && patternDialog.arming === "target") {
      const id = picked ? featureIdOf(picked) : null;
      if (id && bodyIds.has(id)) {
        setPatternDialog((d) => (d ? { ...d, targetId: id, arming: null } : d));
      }
      return;
    }
    // Transform armed with no target yet: the next body click picks it and
    // creates+opens the Transform feature directly on the requested mode.
    if (transformArming) {
      const id = picked ? featureIdOf(picked) : null;
      if (id && bodyIds.has(id)) openTransformOn(id, transformArming.mode);
      return;
    }
    // Revolve dialog open: arming the PROFILE (a sketch region) happens here via
    // the normal selection raycaster. Arming the AXIS uses picking mode instead
    // (→ handleAxisPick), so one click stream can take a sketch line, a body
    // face, or a datum/reference plane.
    if (revolveDialog && revolveDialog.armed === "profile") {
      if (picked?.kind === "sketchFace") {
        const profile: RevolveProfile = { kind: "sketchRegion", sketchId: picked.sketchId, regionId: picked.regionId };
        setRevolveDialog((d) => (d ? { ...d, profile, armed: null } : d));
      } else if (picked?.kind === "face") {
        // A body face is a profile too (same reference as an extrude pulled off
        // a face). Only a PLANAR one: faceNormal is null for anything curved,
        // which has no plane to spin — the arming stays live for another try.
        const m = meshes.find((x) => x.id === picked.featureId);
        const center = m ? faceCentroid(m.mesh.faces, picked.faceId) : null;
        const normal = m ? faceNormal(m.mesh.faces, picked.faceId) : null;
        if (!center || !normal) {
          flashMsg("That face isn't planar — a revolve profile needs a flat face (or a sketch region).");
          return;
        }
        const profile: RevolveProfile = {
          kind: "bodyFace",
          featureId: picked.featureId,
          faceId: picked.faceId,
          faceName: m ? faceNameOf(m.mesh.faces, picked.faceId) : undefined,
          center,
          normal,
        };
        setRevolveDialog((d) => (d ? { ...d, profile, armed: null } : d));
      } else if (picked) {
        // Anything else keeps the arming live — but say why nothing happened,
        // instead of leaving the button looking stuck on "Selecting a profile…".
        flashMsg("Select a closed sketch region or a planar body face to revolve.");
      }
      return;
    }
    // Dimension mode armed: the next picked line/circle/arc is the target.
    if (dimPending) {
      const sk = doc.features.find((f) => f.id === editingSketchId);
      const e =
        picked?.kind === "sketchEntity" && picked.sketchId === editingSketchId && sk?.type === "sketch"
          ? sk.entities.find((x) => x.id === picked.entityId)
          : undefined;
      if (e?.type === "line" || e?.type === "circle" || e?.type === "arc") {
        setSelection([picked!]);
        openDimensionFor(e);
      } else {
        setDimPending(false); // clicked empty / non-dimensionable → cancel
      }
      return;
    }
    // Sketch Mirror tool active: the first line clicked arms the mirror axis;
    // each entity clicked afterwards is mirrored across it (re-clicking a
    // mirrored source toggles it off). Clicks here never change the normal
    // selection. Enter commits the previews; Esc cancels (see the key handler).
    if (mirrorSessionRef.current && sketchTool === "mirror") {
      const s = mirrorSessionRef.current;
      const sk = doc.features.find((f) => f.id === editingSketchId);
      const ent =
        picked?.kind === "sketchEntity" && picked.sketchId === editingSketchId && sk?.type === "sketch"
          ? sk.entities.find((x) => x.id === picked.entityId)
          : undefined;
      if (!ent) return; // empty / non-sketch click: keep the session armed
      // Not yet armed: only a line can be the mirror axis. Highlight it (via the
      // normal selection) so the armed axis reads clearly.
      if (!s.axisEntityId) {
        if (ent.type !== "line") {
          flashMsg("Select a line to set the mirror axis.");
          return;
        }
        setMirrorSession({ ...s, axisEntityId: ent.id });
        setSelection([{ kind: "sketchEntity", sketchId: editingSketchId!, entityId: ent.id }]);
        return;
      }
      if (ent.id === s.axisEntityId) return; // the axis can't mirror itself
      const axis = sk?.type === "sketch" ? sk.entities.find((x) => x.id === s.axisEntityId) : undefined;
      if (!axis || axis.type !== "line") return;
      const idx = s.sourceIds.indexOf(ent.id);
      if (idx >= 0) {
        // Toggle this source off: drop its id and its paired preview.
        setMirrorSession({
          ...s,
          sourceIds: s.sourceIds.filter((_, i) => i !== idx),
          previews: s.previews.filter((_, i) => i !== idx),
        });
        return;
      }
      const mirrored = mirrorEntity(ent, axis.a, axis.b, genId());
      setMirrorSession({ ...s, sourceIds: [...s.sourceIds, ent.id], previews: [...s.previews, mirrored] });
      return;
    }
    // Sketch Pattern tool active: clicks accumulate source entities (re-click
    // toggles off). Circular first arms the CENTER: the click's snapped uv
    // resolves to an entity point / the origin when it lands on one (associative
    // PointRef), else a raw uv committed later as a construction point. Clicks
    // never change the normal selection. Enter commits; Esc cancels.
    if (patternSessionRef.current && (sketchTool === "pattern-linear" || sketchTool === "pattern-circular")) {
      const s = patternSessionRef.current;
      const sk = doc.features.find((f) => f.id === editingSketchId);
      if (sk?.type !== "sketch") return;
      if (s.kind === "circular" && !s.center) {
        if (!sketchUv) return;
        // A vertex of DERIVED geometry can't anchor the center (applyDerived
        // only sources hand-authored entities) — fall back to the raw uv.
        const ref = pointRefAt(sketchUv);
        const refDerived = ref && "entity" in ref && sk.entities.find((x) => x.id === ref.entity)?.derivedFrom;
        setPatternSession({ ...s, center: ref && !refDerived ? ref : { at: sketchUv } });
        return;
      }
      const ent =
        picked?.kind === "sketchEntity" && picked.sketchId === editingSketchId
          ? sk.entities.find((x) => x.id === picked.entityId)
          : undefined;
      if (!ent) return; // empty / non-sketch click: keep the session armed
      if (ent.derivedFrom) {
        flashMsg("Derived geometry can't be patterned — pick its source instead.");
        return;
      }
      setPatternSession({
        ...s,
        sourceIds: s.sourceIds.includes(ent.id) ? s.sourceIds.filter((id) => id !== ent.id) : [...s.sourceIds, ent.id],
      });
      return;
    }
    // Project/Convert tool active: clicking an existing body edge or vertex
    // projects it orthographically onto the active sketch plane as a new entity.
    // Each pick is previewed; Enter commits, Esc cancels. Re-clicking a source
    // toggles its projection off. Clicks never change the normal selection.
    if (projectSessionRef.current && sketchTool === "project") {
      const s = projectSessionRef.current;
      const sk = doc.features.find((f) => f.id === editingSketchId);
      if (sk?.type !== "sketch") return;
      const frame = frameOf(sk.plane, resolved.planeFrames);
      let key: string | null = null;
      let entity: SketchEntity | null = null;
      let ref: ProjectRef | null = null;
      if (picked?.kind === "vertex") {
        key = `v:${picked.point.join(",")}`;
        entity = { type: "point", id: genId(), p: worldToUv(frame, picked.point) };
        ref = { kind: "vertex", featureId: picked.featureId, point: picked.point };
      } else if (picked?.kind === "edge") {
        key = `e:${picked.featureId}:${picked.edgeId}`;
        const poly = viewApiRef.current?.getEdgeWorldPolyline(picked.featureId, picked.edgeId);
        if (poly && poly.length >= 2) {
          const fit = fitProjectedPolyline(poly.map((p) => worldToUv(frame, p)));
          if (fit) entity = fittedToEntity(fit, genId());
        }
        // Capture the persistent edge name so the projection re-resolves to the
        // SAME edge after a rebuild (build-local edgeId can renumber).
        const edgeName = viewApiRef.current?.getEdgeName(picked.featureId, picked.edgeId);
        ref = { kind: "edge", featureId: picked.featureId, edgeName, edgeId: picked.edgeId };
      }
      if (!key || !ref) return; // empty space / a face: keep the session armed
      const idx = s.keys.indexOf(key);
      if (idx >= 0) {
        setProjectSession({
          refs: s.refs.filter((_, i) => i !== idx),
          keys: s.keys.filter((_, i) => i !== idx),
          previews: s.previews.filter((_, i) => i !== idx),
        });
        return;
      }
      if (!entity) {
        flashMsg("Couldn't project that edge.");
        return;
      }
      setProjectSession({ refs: [...s.refs, ref], keys: [...s.keys, key], previews: [...s.previews, entity] });
      return;
    }
    if (!picked) {
      setSelection([]);
      return;
    }
    setSelection((prev) => {
      const i = prev.findIndex((s) => sameSelection(s, picked));
      if (i >= 0) return prev.filter((_, j) => j !== i);
      return [...prev, picked];
    });
  };
  // Double-click a sketch entity → select its whole connected chain (every entity
  // transitively sharing an endpoint). Makes offsetting an imported outline of
  // many small edges a single gesture instead of a rubber-band drag.
  const handleSketchEntityDouble = (sketchId: string, entityId: string) => {
    const sk = doc.features.find((f) => f.id === sketchId);
    if (sk?.type !== "sketch") return;
    const ids = connectedEntityIds(entityId, sk.entities);
    setSelection(ids.map((id) => ({ kind: "sketchEntity", sketchId, entityId: id })));
  };
  const [picking, setPicking] = useState(false);
  // What the plane/face pick flow is for: starting a sketch, or the base of a
  // new reference plane.
  const [pickPurpose, setPickPurpose] = useState<
    "sketch" | "plane" | "revolveAxis" | "patternAxis" | "patternDir" | "sectionPlane"
  >("sketch");
  // The reference-plane dialog. `method` chooses the placement; the relevant
  // fields are filled by picks (base/refB planes-or-faces; points) or text inputs.
  const [planeDialog, setPlaneDialog] = useState<{
    method: PlaneMethod;
    base: SketchPlaneRef | null;
    offset: string;
    refB: SketchPlaneRef | null;
    angleAxis: "u" | "v";
    angle: string;
    points: [number, number, number][];
    editId?: string;
  } | null>(null);
  // What the next viewport pick fills in the plane dialog (null = not arming a
  // plane pick). "base"/"refB" use plane/face pick mode; "point" reads a vertex /
  // sketch point from a normal click.
  const [planePick, setPlanePick] = useState<"base" | "refB" | "point" | null>(null);
  // The Mirror dialog: the body to mirror + the chosen plane key (see plane keys).
  // `plane === "face"` mirrors across a picked planar body face, stored in
  // `faceRef` (a frozen frame snapshot, like a sketch-on-face placement).
  const [mirrorDialog, setMirrorDialog] = useState<{
    targetId: string;
    plane: string;
    faceRef: { featureId: string; frame: PlaneFrameData } | null;
    editId?: string;
  } | null>(null);
  // Armed by the Mirror dialog: the next clicked planar body face is the plane.
  const [pickingMirrorFace, setPickingMirrorFace] = useState(false);
  // The body Pattern dialog: repeat `targetId` as a linear run/grid or a
  // circular ring (the copies land in ONE compound body; the seed is kept).
  // Direction/axis references arm the shared axis-pick stream (pickPurpose
  // "patternDir"/"patternAxis"); `arming` says which slot the next pick fills.
  // `dir2on` reveals the optional second direction (a count1×count2 grid).
  // All numeric fields are expression text.
  const [patternDialog, setPatternDialog] = useState<{
    kind: "linear" | "circular";
    /** Null until a body is armed + clicked (see `arming: "target"`) — the
     *  dialog opens immediately like Revolve, no pre-selection required. */
    targetId: string | null;
    dir1: PatternDirRef;
    count1: string;
    spacing1: string;
    flip1: boolean;
    dir2on: boolean;
    dir2: PatternDirRef | null;
    count2: string;
    spacing2: string;
    flip2: boolean;
    axis: PatternAxisRef | null;
    count: string;
    mode: "full" | "angle";
    angle: string;
    symmetric: boolean;
    arming: "target" | "dir1" | "dir2" | "axis" | null;
    editId?: string;
  } | null>(null);
  const [editingSketchId, setEditingSketchId] = useState<string | null>(null);
  const [sketchTool, setSketchToolState] = useState<SketchTool>("line");
  const [draft, setDraft] = useState<Vec2[]>([]);
  // Line tool: the active-sketch entity (if any) that the *current* draft start
  // point landed on, and whether it was that entity's midpoint — so the first
  // segment's start gets a point-on-line / midpoint constraint (the end of each
  // segment is constrained from its own snap).
  const lineStartOnRef = useRef<{ id: string; mid: boolean } | undefined>(undefined);
  // A drawn point that snapped to BODY geometry (a hole rim/centre) pins to that
  // world spot via a coincident-to-`{fixed}` constraint, so the snap LASTS across
  // drags/solves instead of holding only by coincident-coordinate merge. These
  // remember the fixed uv for the line start / circle centre (committed later).
  const lineStartFixedRef = useRef<Vec2 | undefined>(undefined);
  const circleCenterFixedRef = useRef<Vec2 | undefined>(undefined);
  // The body-pin (onFixed) of each accumulated draft click, parallel to `draft` —
  // so a rect/polygon corner snapped to a hole pins at commit time.
  const draftFixedRef = useRef<(Vec2 | undefined)[]>([]);
  // The document the NEXT sketch edit builds on, and a counter identifying the
  // most recent commit. Solving is async (planegcs runs off the main thread), so
  // between a click and its solved result landing, the `doc` a handler closed
  // over is stale: a second click would build on a document that never saw the
  // first one and silently drop it — drawing a polyline faster than the solve
  // round-trip (~150ms) used to lose whole segments. Every sketch commit writes
  // this ref synchronously so back-to-back edits stack, and stamps the counter
  // so a superseded solve can't overwrite the newer geometry. See
  // commitSketchEdit.
  // Bumped by "/" to toggle the active toolbar's More flyout (the modeling bar
  // while modelling, the sketch column while editing a sketch — they're never
  // both usable at once).
  const [modelMoreRequest, setModelMoreRequest] = useState(0);
  const [sketchMoreRequest, setSketchMoreRequest] = useState(0);
  const sketchBaseDocRef = useRef(doc);
  const sketchCommitSeqRef = useRef(0);
  // Any other source of document change (undo, the agent, loading a document)
  // becomes the new base.
  useEffect(() => {
    sketchBaseDocRef.current = doc;
  }, [doc]);
  // The committed polygon side count (used when drawing). The dialog edits a
  // free-text draft and commits it via Set, so typing isn't fought by live clamping.
  const [polygonSides, setPolygonSides] = useState(6);
  const [polySidesText, setPolySidesText] = useState("6");
  // The polygon "Sides" dialog is a one-shot prompt: it opens when the polygon
  // tool is selected and closes on Set/Cancel, so the next viewport click draws.
  const [polySidesOpen, setPolySidesOpen] = useState(false);
  // When on, newly drawn entities are marked as construction (reference) geometry.
  const [constructionMode, setConstructionMode] = useState(false);
  // The active Offset session: the validated single chain to offset, the live
  // signed distance (expression text), and a uv anchor + unit normal for placing
  // the on-canvas input box and its draggable arrow handle. Null = no offset in
  // progress. See beginOffset / commitOffset.
  const [offsetSession, setOffsetSession] = useState<{
    chain: ChainEdge[];
    value: string;
    anchor: Vec2;
    normal: Vec2;
  } | null>(null);
  const offsetSessionRef = useRef(offsetSession);
  offsetSessionRef.current = offsetSession;
  // The active sketch Mirror session (the 2D sketch tool — distinct from the
  // modeling-mode body MirrorFeature). `axisEntityId` is the armed mirror line
  // (null until the user clicks one); `previews` are the live mirrored copies,
  // committed on Enter and discarded on Esc. Null = no mirror in progress.
  const [mirrorSession, setMirrorSession] = useState<{
    axisEntityId: string | null;
    /** Source entity ids already mirrored (so re-clicking toggles them off). */
    sourceIds: string[];
    previews: SketchEntity[];
  } | null>(null);
  const mirrorSessionRef = useRef(mirrorSession);
  mirrorSessionRef.current = mirrorSession;
  // Set below once commitMirror is defined; the key handler calls it via this
  // ref so Enter always commits using the latest doc/session (no stale closure).
  const commitMirrorRef = useRef<() => void>(() => {});
  // The active Project/Convert session: live previews of existing 3D body
  // edges/vertices projected onto the active sketch plane. `keys` tracks the
  // source pick of each preview (featureId/edgeId or vertex) so re-clicking a
  // source toggles it off. Committed on Enter, discarded on Esc. Null = none.
  const [projectSession, setProjectSession] = useState<{
    refs: ProjectRef[];
    keys: string[];
    previews: SketchEntity[];
  } | null>(null);
  const projectSessionRef = useRef(projectSession);
  projectSessionRef.current = projectSession;
  const commitProjectRef = useRef<() => void>(() => {});
  // The active sketch Pattern session (linear or circular — the 2D sketch tools,
  // distinct from the modeling-mode body PatternFeature). Sources accumulate by
  // clicking entities (re-click toggles off); the session seeds from the current
  // selection when the tool is activated. Circular arms a `center` on its first
  // click (an entity-point PointRef when the snapped uv lands on one, else a raw
  // uv committed as a construction point). All numeric fields are expression
  // text. Committed on Enter as a DerivedOp, discarded on Esc. Null = none.
  const [patternSession, setPatternSession] = useState<{
    kind: "linear" | "circular";
    sourceIds: string[];
    /** TOTAL instances including the seed (expression). */
    count: string;
    /** Linear: per-step uv translation (expressions, mm). */
    dx: string;
    dy: string;
    /** Circular: the rotation center; null until the first click arms it. */
    center: PointRef | { at: Vec2 } | null;
    /** Circular: full circle (equal steps) or a total sweep angle. */
    mode: "full" | "angle";
    angle: string;
    symmetric: boolean;
  } | null>(null);
  const patternSessionRef = useRef(patternSession);
  patternSessionRef.current = patternSession;
  const commitPatternRef = useRef<() => void>(() => {});
  // Text tool: after clicking the plane to set the anchor, the user types the
  // string + height in a floating box. Live-previewed; committed on Enter,
  // discarded on Esc. Null = no placement in progress.
  // `editId` set ⇒ editing an existing text entity in place (re-edit), else a
  // fresh placement.
  const [textDraft, setTextDraft] = useState<{ anchor: Vec2; value: string; height: string; editId?: string } | null>(
    null,
  );
  const textDraftRef = useRef(textDraft);
  textDraftRef.current = textDraft;
  // In-progress edit of a committed offset op's distance (keyed by op id). Shown
  // when a single derived offset entity is selected; null = not editing.
  const [offsetEdit, setOffsetEdit] = useState<{ opId: string; value: string } | null>(null);
  const [fullyConstrained, setFullyConstrained] = useState(false);
  // The last solve reported conflicting/redundant (over-)constraints.
  const [solveConflict, setSolveConflict] = useState(false);
  // The constraints-list row the pointer is over, so the viewport lights up the
  // entities/points that constraint acts on.
  const [hoveredConstraintId, setHoveredConstraintId] = useState<string | null>(null);
  // A transient banner over the viewport (a rejected conflicting dimension, an
  // arming click that resolved to the wrong kind of geometry…), auto-dismissed
  // after a few seconds. Not sketch-only — several of the messages below are
  // raised by dialogs armed outside sketch mode.
  const [hudMsg, setHudMsg] = useState<string | null>(null);
  const hudMsgTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flashMsg = (text: string) => {
    setHudMsg(text);
    if (hudMsgTimer.current) clearTimeout(hudMsgTimer.current);
    hudMsgTimer.current = setTimeout(() => setHudMsg(null), 4000);
  };
  // Dimension entry: the entity being dimensioned, whether it's a line length or
  // a circle radius, the in-progress text, and the on-screen position (px,
  // canvas-relative) to anchor the input box.
  const [dimInput, setDimInput] = useState<{
    entityId: string;
    /** Second line, for an angle dimension between two lines. */
    entityId2?: string;
    kind: "length" | "radius" | "angle" | "distance";
    /** The two sides of a `distance` dimension (point/line/rim each). */
    refs?: [DistanceRef, DistanceRef];
    /** The constraint being edited (if reopening an existing one), so its
     *  on-canvas label is hidden while the input is open. */
    editId?: string;
    value: string;
    x: number;
    y: number;
  } | null>(null);
  // Armed dimension mode: D was pressed with nothing selected; the next picked
  // line/circle becomes the dimension target.
  const [dimPending, setDimPending] = useState(false);
  // Double-click on a feature WITHOUT a creation dialog (primitive / import /
  // sweep / loft) opens its parameters in the floating EditPanel. null = closed.
  // Features that DO have a creation dialog re-open that dialog in edit mode
  // instead (see the edit* openers).
  const [editParamsId, setEditParamsId] = useState<string | null>(null);
  // Editing an existing feature through its creation dialog applies changes LIVE
  // (so every change is previewed by the real regen), reverting on Cancel. The
  // snapshot is the feature as it was when the dialog opened; `editSeedRef` skips
  // the first (seed) live-sync so opening doesn't write an identical no-op step.
  const editSnapshotRef = useRef<Feature | null>(null);
  const editSeedRef = useRef(false);
  // A signature of the last params a live-sync effect applied. The effects list
  // doc-derived values (e.g. re-picked profiles) in their deps, so a doc change
  // re-runs them; without this guard the restore in cancelEdit would immediately
  // re-apply the stale dialog values (a feedback loop). Skipping re-runs whose
  // params are unchanged breaks that loop and also skips the open-time seed.
  const editSigRef = useRef<string | null>(null);
  // Returns true if this live-sync run should proceed to apply. Seeds/loops skip.
  const shouldLiveApply = (sig: string): boolean => {
    if (editSeedRef.current) {
      editSeedRef.current = false;
      editSigRef.current = sig;
      return false;
    }
    if (sig === editSigRef.current) return false;
    editSigRef.current = sig;
    return true;
  };
  // Begin/commit/cancel an in-place dialog edit. Every edit* opener calls
  // beginEdit; each dialog's Confirm calls commitEdit (keep the live changes);
  // each close path calls cancelEdit (a no-op after commit, else revert to the
  // snapshot taken when the dialog opened).
  const beginEdit = (feature: Feature) => {
    editSnapshotRef.current = feature;
    editSeedRef.current = true;
    editSigRef.current = null;
  };
  const commitEdit = () => {
    editSnapshotRef.current = null;
  };
  const cancelEdit = () => {
    const snap = editSnapshotRef.current;
    editSnapshotRef.current = null;
    if (snap) setDoc((prev) => ({ ...prev, features: prev.features.map((f) => (f.id === snap.id ? snap : f)) }));
  };
  // The extrude dialog (anchored at the profile) while choosing parameters.
  // `editId` set ⇒ editing an existing extrude in place (Confirm updates it);
  // else creating from the current profile selection.
  const [extrudeDialog, setExtrudeDialog] = useState<{
    mode: "new" | "add" | "remove";
    distance: string;
    flip: boolean;
    extent: ExtrudeExtent;
    targetId: string | null;
    upTo: UpToFaceRef | null;
    x: number;
    y: number;
    editId?: string;
  } | null>(null);
  // True while the extrude dialog's "Select a face" pick is armed: the next
  // body face clicked in the viewport fills the up-to-face target.
  const [pickingUpFace, setPickingUpFace] = useState(false);
  // Live ghost preview of the extrude dialog's current params: one entry per
  // body the regen result represents (every new extrude for "new", or the
  // single chosen target for "add"/"remove") — used to swap those bodies' real
  // meshes out for the translucent previews while the dialog is open.
  const [extrudePreview, setExtrudePreview] = useState<{ bodyId: string; mesh: FeatureMesh["mesh"] }[] | null>(null);
  const [extrudePreviewError, setExtrudePreviewError] = useState<string | null>(null);
  // Live ghost of the revolve dialog's currently-armed inputs (translucent solid
  // of the would-be result), and its build/resolve error if any.
  const [revolvePreview, setRevolvePreview] = useState<FeatureMesh["mesh"] | null>(null);
  const [revolvePreviewError, setRevolvePreviewError] = useState<string | null>(null);
  const [dressUpDialog, setDressUpDialog] = useState<
    // `angle`/`flip` are chamfer-only (degrees from the reference face, and
    // which adjacent face that is); they're ignored when the op is a fillet.
    {
      op: "chamfer" | "fillet";
      size: string;
      angle: string;
      flip: boolean;
      x: number;
      y: number;
      editId?: string;
    } | null
  >(null);
  // Validation for the chamfer/fillet dialog: a human-readable message when the
  // current size is unsatisfiable (e.g. a fillet radius larger than the
  // geometry), or null when it builds cleanly. Set live as the user types and
  // re-checked authoritatively before commit, so an invalid size can't close it.
  const [dressUpError, setDressUpError] = useState<string | null>(null);
  // Live ghost of what the chamfer/fillet dialog's current size/angle will
  // change: `removed` is the solid it carves off (a bevel, a rounded-off
  // corner), `added` the solid it fills in (a fillet on a concave edge). Either
  // may be absent — a feature whose edges are all convex only removes. Produced
  // by the same debounced regen that validates the dialog, so previewing costs
  // no extra kernel round trip.
  const [dressUpPreview, setDressUpPreview] = useState<{
    removed?: FeatureMesh["mesh"];
    added?: FeatureMesh["mesh"];
  } | null>(null);
  // Shell dialog. The body is armed when the tool opens (from whatever was
  // selected — a face pick resolves to its owning body) and shown in the
  // dialog; the faces to open are optional and armed separately from there, so
  // the common "just hollow this" case can't accidentally open the face the
  // user happened to have clicked. `arming` says which role the next viewport
  // click fills.
  const [shellDialog, setShellDialog] = useState<ShellDialogState | null>(null);
  // Validation for the Shell dialog: a human-readable message when the current
  // thickness is unsatisfiable (e.g. too thick for the body), or null when it
  // builds cleanly. Set live as the user types and re-checked authoritatively
  // before commit, so an invalid thickness can't close it.
  const [shellError, setShellError] = useState<string | null>(null);
  // True while Create is waiting on the kernel to finish the regeneration it
  // just triggered. Shelling a loft is seconds of OCCT work, and with no
  // pending state the dialog just sat there looking inert — so the click got
  // repeated, and every repeat queued more work behind the first on the
  // worker's single thread.
  const [shellBusy, setShellBusy] = useState(false);
  // Revolve dialog. The user arms a profile (a sketch region or a planar body
  // face) and an axis (a sketch line, a plane, or a body face) by clicking in the
  // viewport — like the Boolean dialog — then sets the angle (Full 360° vs. a
  // specified angle + optional symmetric sweep). `armed` says which role the next
  // viewport click fills.
  const [revolveDialog, setRevolveDialog] = useState<{
    profile: RevolveProfile | null;
    axis: RevolveAxis | null;
    armed: "profile" | "axis" | null;
    mode: "full" | "angle";
    degrees: string;
    symmetric: boolean;
    x: number;
    y: number;
    editId?: string;
  } | null>(null);
  // True while the Revolve dialog is waiting for a profile to be clicked (a
  // sketch region or a planar body face). It unlocks two things the plain
  // selection path can't offer: hidden sketches are drawn (a sketch consumed by
  // an earlier feature is hidden, and was therefore unpickable — the arming could
  // never be satisfied), and a region outranks the body geometry in front of it
  // in the picker, so a profile behind a solid stays reachable.
  const armingRevolveProfile = revolveDialog?.armed === "profile";
  // Arming that rides the NORMAL selection raycaster rather than `picking` mode
  // (which has a banner of its own further down). Each of these still needs the
  // banner — without it the only sign the app is waiting on a click is a small
  // highlighted button inside a dialog — so they share one, keyed by whichever
  // is live. Only one can be, since each belongs to a different dialog.
  const selectionArming = armingRevolveProfile
    ? {
        message:
          "Select a closed sketch region or a planar body face to revolve — hidden sketches are shown while you pick",
        cancel: () => setRevolveDialog((d) => (d ? { ...d, armed: null } : d)),
      }
    : pickingUpFace
      ? { message: "Select the body face to extrude up to", cancel: () => setPickingUpFace(false) }
      : pickingMirrorFace
        ? { message: "Select the planar body face to mirror across", cancel: () => setPickingMirrorFace(false) }
        : null;
  // The Transform feature currently being edited with the gizmo (a floating
  // panel + viewport gizmo are shown while this is set), and which gizmo to show.
  const [transformEditId, setTransformEditId] = useState<string | null>(null);
  const [transformMode, setTransformMode] = useState<TransformMode>("translate");
  // Where the panel opens: beside the gizmo, never on top of it (see
  // transformPanelPos). Null until the first placement; draggable after that.
  const [transformPanelXY, setTransformPanelXY] = useState<{ x: number; y: number } | null>(null);
  // Live numeric readout during a gizmo drag (display only; cleared on commit).
  // Kept out of the document so dragging never regenerates the kernel.
  const [liveTransform, setLiveTransform] = useState<{
    tx: number;
    ty: number;
    tz: number;
    angle: number;
    scale: number;
  } | null>(null);
  // How the current transform edit began, so Cancel knows what to undo: a
  // just-created transform is dropped entirely; an existing one being re-edited
  // is reverted to the snapshot it had when this edit started.
  const [transformOrigin, setTransformOrigin] = useState<
    | { created: true }
    | { created: false; snapshot: Pick<TransformFeature, "tx" | "ty" | "tz" | "angle" | "axis" | "scale" | "copy"> }
    | null
  >(null);
  // Transform requested with no unambiguous single-body target (nothing
  // selected, or a selection spanning more than one body): a small panel
  // shows the requested mode and waits for the next viewport body click to
  // arm it — see the click-router branch below and openTransform/openTransformOn.
  const [transformArming, setTransformArming] = useState<{ mode: TransformMode } | null>(null);
  // The "New Body" dropdown (box/cylinder/sphere) in the viewport toolbar.
  const [newSolidOpen, setNewSolidOpen] = useState(false);
  // Toggle (via the "?" button in the topbar, or the "?" key) that appends each
  // toolbar button's keyboard shortcut to its label, e.g. "⬆ Extrude (E)".
  // Persisted with the other prefs, so it survives a reload.
  const showShortcuts = settings.showShortcuts;
  const toggleShortcuts = useCallback(
    () => updateSettings((s) => ({ showShortcuts: !s.showShortcuts })),
    [updateSettings],
  );
  const kbd = (sc: string): ReactNode => (showShortcuts ? <span className="kbd-hint">{sc}</span> : null);
  // Collapsed circle/rectangle flyouts: which group (if any) is expanded, and the
  // last-used variant each collapses to. Selecting any tool (button OR shortcut)
  // updates the remembered variant and closes any open flyout.
  const [expandedSketchGroup, setExpandedSketchGroup] = useState<SketchGroupId | null>(null);
  const [circleVariant, setCircleVariant] = useState<SketchTool>("circle-center");
  const [rectVariant, setRectVariant] = useState<SketchTool>("rect-corner");
  const [patternVariant, setPatternVariant] = useState<SketchTool>("pattern-linear");
  // The grouped geometric-constraint button: which constraint the always-visible
  // primary button represents (last one used, like the drawing-tool variants),
  // and whether the ▸ flyout of the others is open.
  const [constraintChoice, setConstraintChoice] = useState<ConstraintKind>("parallel");
  const [constraintFlyoutOpen, setConstraintFlyoutOpen] = useState(false);
  useEffect(() => {
    if (sketchTool === "circle-center" || sketchTool === "circle-3p") setCircleVariant(sketchTool);
    else if (sketchTool === "rect-corner" || sketchTool === "rect-center") setRectVariant(sketchTool);
    else if (sketchTool === "pattern-linear" || sketchTool === "pattern-circular") setPatternVariant(sketchTool);
    setExpandedSketchGroup(null);
  }, [sketchTool]);
  // Dismiss an open flyout when clicking anything outside a sketch group (the
  // opening click already completed before this listener attaches).
  useEffect(() => {
    if (!expandedSketchGroup) return;
    const onDown = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest?.(".sketch-group")) setExpandedSketchGroup(null);
    };
    window.addEventListener("pointerdown", onDown);
    return () => window.removeEventListener("pointerdown", onDown);
  }, [expandedSketchGroup]);
  // Same dismiss-on-outside-click for the constraint flyout.
  useEffect(() => {
    if (!constraintFlyoutOpen) return;
    const onDown = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest?.(".constraint-group")) setConstraintFlyoutOpen(false);
    };
    window.addEventListener("pointerdown", onDown);
    return () => window.removeEventListener("pointerdown", onDown);
  }, [constraintFlyoutOpen]);
  // The camera projection toggle (orthographic ⇄ perspective) is TODO: it moves
  // into a future settings menu. The viewport API (viewApiRef.setProjection) is
  // still wired, so the menu can drive it; the default stays orthographic.
  // The Variables section is collapsible (to reclaim panel space). Default:
  // open for a short list (< 5 variables), collapsed for a long one so it
  // doesn't dominate the panel. Set from the loaded doc (see the restore effect)
  // and then left wherever the user puts it.
  const VARS_OPEN_THRESHOLD = 5;
  // Trailing debounce (ms) before a resolved-doc change triggers a kernel regen,
  // so bursts of edits collapse into one rebuild (see the regen effect).
  const REGEN_DEBOUNCE_MS = 60;
  const [variablesOpen, setVariablesOpen] = useState(() => doc.variables.length < VARS_OPEN_THRESHOLD);
  // Height of the timeline's own scroll box, dragged via the splitter below it.
  const [timelineHeight, setTimelineHeight] = useState(260);
  const startTimelineResize = (e: PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const startY = e.clientY;
    const startHeight = timelineHeight;
    const move = (ev: globalThis.PointerEvent) => setTimelineHeight(clamp(startHeight + ev.clientY - startY, 80, 600));
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  // The viewport <main> — the containing block every floating dialog is
  // positioned in, so its size is what a placement has to fit inside.
  const viewportElRef = useRef<HTMLElement>(null);
  const importInputRef = useRef<HTMLInputElement>(null);
  const dxfInputRef = useRef<HTMLInputElement>(null);
  // The "Import ▾" flyout (STEP part / DXF sketch) in the Parts panel.
  const [importMenuOpen, setImportMenuOpen] = useState(false);
  const importMenuRef = useRef<HTMLDivElement>(null);
  // The DXF placement dialog: raw file text + a live parse preview (counts), plus
  // the chosen destination plane and unit scale. Held open until the user
  // confirms; the sketch is built from `text` re-parsed at the chosen scale.
  const [dxfDialog, setDxfDialog] = useState<{
    fileName: string;
    text: string;
    planeKey: string;
    unitsKey: DxfUnitsKey;
    preview: { total: number; skipped: number };
  } | null>(null);
  const startDimensionRef = useRef<() => void>(() => {});
  const dimPendingRef = useRef(dimPending);
  dimPendingRef.current = dimPending;
  const dimInputRef = useRef(dimInput);
  dimInputRef.current = dimInput;
  const [datumVisibility, setDatumVisibility] = useState<Record<DatumId, boolean>>({
    origin: true,
    "plane-top": true,
    "plane-front": true,
    "plane-right": true,
  });
  const viewApiRef = useRef<ViewportApi | null>(null);
  // Section view: pure viewport state — no undo, no timeline (see BACKLOG.md).
  // Same bucket as datumVisibility/selFilter above: it changes nothing about the
  // geometry, so it never goes through setDoc. `offset` is measured along the
  // ref's own (unflipped) normal; `flip` picks which half is kept. Persisted to
  // IndexedDB alongside the doc (see storage/db.ts) but outside `doc` itself.
  const [sectionView, setSectionView] = useState<SectionViewState>(DEFAULT_SECTION_VIEW);
  // Camera projection. The viewport boots orthographic (see Viewport.tsx), so this
  // mirrors that default; the toolbar toggle flips it via the viewport API. View-
  // only, like sectionView — not part of the document.
  const [perspective, setPerspective] = useState(false);

  const setSketchTool = (t: SketchTool) => {
    // Activating Text with a single text entity selected re-opens it for editing
    // (pre-filled), instead of starting a fresh placement.
    if (t === "text") {
      const sel = selectedSketchEntities;
      const existing = sel.length === 1 && sel[0].type === "text" ? sel[0] : null;
      setProjectSession(null);
      setOffsetSession(null);
      setMirrorSession(null);
      setPatternSession(null);
      setSketchToolState("text");
      setDraft([]);
      setPolySidesOpen(false);
      setTextDraft(
        existing
          ? { anchor: existing.p, value: existing.value, height: String(existing.height), editId: existing.id }
          : null,
      );
      return;
    }
    setTextDraft(null); // switching tools abandons any in-progress text placement
    // Offset isn't a free-draw tool: it acts on the current selection. Validate
    // it forms a single chain and open the offset session (or flash the error
    // and stay in Select). beginOffset is defined below — a closure, so it's
    // initialised by the time any click/keypress calls this.
    if (t === "offset") {
      setProjectSession(null);
      setPatternSession(null);
      beginOffsetRef.current();
      return;
    }
    setOffsetSession(null);
    // Mirror opens a session that arms an axis on the next line click, then
    // mirrors each subsequently clicked entity. Starting any other tool ends it.
    if (t === "mirror") {
      setProjectSession(null);
      setPatternSession(null);
      setMirrorSession({ axisEntityId: null, sourceIds: [], previews: [] });
      setSketchToolState("mirror");
      setDraft([]);
      setPolySidesOpen(false);
      return;
    }
    setMirrorSession(null);
    // Project/Convert: clicking body edges/vertices projects them onto the plane.
    if (t === "project") {
      setProjectSession({ refs: [], keys: [], previews: [] });
      setPatternSession(null);
      setSketchToolState("project");
      setDraft([]);
      setPolySidesOpen(false);
      return;
    }
    setProjectSession(null);
    // Pattern (linear/circular): a session that accumulates source entities by
    // click, seeded from whatever is already selected (the Select tool toggle-
    // accumulates, so a multi-entity selection is often already there). Only
    // hand-authored entities are eligible — derived ops can't chain. Switching
    // between the two pattern variants keeps the accumulated sources.
    if (t === "pattern-linear" || t === "pattern-circular") {
      const prev = patternSessionRef.current;
      const seed = prev ? prev.sourceIds : selectedSketchEntities.filter((e) => !e.derivedFrom).map((e) => e.id);
      setPatternSession({
        kind: t === "pattern-linear" ? "linear" : "circular",
        sourceIds: seed,
        count: prev?.count ?? (t === "pattern-linear" ? "3" : "6"),
        dx: prev?.dx ?? "10",
        dy: prev?.dy ?? "0",
        center: prev?.center ?? null,
        mode: prev?.mode ?? "full",
        angle: prev?.angle ?? "90",
        symmetric: prev?.symmetric ?? false,
      });
      setSelection([]);
      setSketchToolState(t);
      setDraft([]);
      setPolySidesOpen(false);
      return;
    }
    setPatternSession(null);
    setSketchToolState(t);
    setDraft([]); // starting a new tool abandons any in-progress points
    // Selecting the polygon tool (re)opens its Sides prompt, seeded with the
    // committed count; any other tool dismisses it.
    if (t === "polygon") {
      setPolySidesText(String(polygonSides));
      setPolySidesOpen(true);
    } else setPolySidesOpen(false);
  };
  const beginOffsetRef = useRef<() => void>(() => {});
  // Geometry from the last kernel regen, keyed by feature id. Color/opacity
  // live on the feature and are overlaid in `meshes` below so tweaking them
  // doesn't require re-running the (expensive) kernel regen.
  const [rawMeshes, setRawMeshes] = useState<{ id: string; mesh: FeatureMesh["mesh"] }[]>([]);
  // Bumped once per regen when the FINAL (complete) result lands — not on the
  // progressive per-body updates. Effects that must see the whole rebuilt scene
  // (the associative Project reproject) key off this instead of `rawMeshes`, so
  // they don't fire against a half-streamed model.
  const [regenSettledSeq, setRegenSettledSeq] = useState(0);
  // When set, only this body is rendered (isolate); others are hidden until exit.
  const [isolatedBodyId, setIsolatedBodyId] = useState<string | null>(null);
  // Which geometry kinds clicking can pick (selection filters).
  const [selFilter, setSelFilter] = useState<SelectionFilter>({ body: true, face: true, edge: true, vertex: true });
  const [errors, setErrors] = useState<Record<string, string>>({});
  // Non-fatal kernel notices per feature id: a topological reference that had
  // to be re-matched geometrically (name churn after an upstream edit) or was
  // partially lost. Shown as an amber badge in the timeline.
  const [warnings, setWarnings] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  // Coarse progress while the kernel meshes a huge imported body face-by-face
  // (a long-running import); null when no such mesh is in flight.
  const [meshProgress, setMeshProgress] = useState<{ done: number; total: number } | null>(null);
  const [fatal, setFatal] = useState<string | null>(null);

  // Agent regen coordinator (Phase 9 L3). The regen effect feeds these refs the
  // instant a regen settles — synchronously, ahead of React's re-render — so an
  // agent op can await regen and a follow-up read/screenshot sees fresh geometry
  // without polling. `agentMeshesRef` mirrors `rawMeshes`; `agentErrorsRef`
  // mirrors the merged error map; `regenWaitersRef` holds one-shot resolvers.
  const agentMeshesRef = useRef<AgentMesh[]>([]);
  const agentErrorsRef = useRef<Record<string, string>>({});
  // Mirrors the kernel's non-fatal per-feature warnings (re-matched/lost
  // topological references) so agent op results can report them.
  const agentWarningsRef = useRef<Record<string, string>>({});
  // Monotonic count of regens that have *started*. A waiter must only resolve on
  // a regen that began after it started waiting — otherwise a regen already in
  // flight (e.g. the slow initial load) would resolve it before the agent's edit
  // is even regenerated.
  const regenStartSeqRef = useRef(0);
  const regenWaitersRef = useRef<{ threshold: number; settle: (s: RegenSettle) => void }[]>([]);
  const waitForRegen = useCallback(
    (timeoutMs = 8000): Promise<RegenSettle> =>
      new Promise((resolve) => {
        let done = false;
        const settle = (s: RegenSettle) => {
          if (!done) {
            done = true;
            resolve(s);
          }
        };
        regenWaitersRef.current.push({ threshold: regenStartSeqRef.current, settle });
        // Never hang: if regen doesn't settle (kernel not ready, a competing
        // edit cancelled it), resolve with whatever errors we last knew.
        setTimeout(
          () => settle({ errors: agentErrorsRef.current, warnings: agentWarningsRef.current, timedOut: true }),
          timeoutMs,
        );
      }),
    [],
  );
  // Boolean dialog. `operandIds` is the operand list for union/intersect; for
  // subtract the operands split into a single `base` + accumulating `tools`, with
  // `armed` saying which subtract slot the next viewport click fills.
  const [booleanDialog, setBooleanDialog] = useState<{
    op: BooleanOp;
    operandIds: string[];
    base: string | null;
    tools: string[];
    armed: "base" | "tools" | null;
    editId?: string;
  } | null>(null);

  // Own the worker's lifecycle here so each mount cycle (incl. StrictMode's
  // mount/unmount/remount) gets a fresh, live kernel rather than a disposed one.
  useEffect(() => {
    const kernel = new KernelClient();
    kernelRef.current = kernel;
    setReady(true);
    return () => {
      kernel.dispose();
      kernelRef.current = null;
      setReady(false);
    };
  }, []);

  // Restore the working document from IndexedDB on first load: the tab's
  // active-document pointer (localStorage) first — NOT "most recent", which
  // another tab may have touched — falling back to the most recent meta row,
  // else keeping the fresh seed under its own id. Autosave only starts once
  // this completes so the placeholder can't overwrite a saved document.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const activeId = getActiveDocId();
        let record: StoredDoc | undefined;
        // Which document (if any) failed to open — surfaced as a dismissible
        // banner rather than silently discarded, since the failure mode used to
        // be "the app quietly falls back to a blank doc and the next autosave
        // overwrites the broken record" (see docIdRef note below).
        let recovery: { kind: "corrupted"; name: string } | { kind: "unreadable" } | null = null;
        try {
          record = activeId ? await loadDoc(activeId) : undefined;
          if (!record) {
            const metas = await listMeta();
            if (metas.length > 0) record = await loadDoc(metas[0].id);
          }
        } catch (err) {
          console.warn("could not read saved document:", err);
          recovery = { kind: "unreadable" };
        }
        if (cancelled) return;
        if (record) {
          try {
            // Validate BEFORE touching docIdRef/state: migrateDocument throws on
            // malformed persisted data (e.g. `features` isn't an array). If it
            // threw AFTER docIdRef already pointed at this record, the fresh
            // seed doc would render under the BROKEN record's id, and the next
            // autosave would silently overwrite the corrupt data with an empty
            // box — the exact "quiet data loss" this fix exists to prevent.
            const migrated = migrateDocument(record.doc);
            docIdRef.current = record.id;
            docCreatedAtRef.current = record.createdAt ?? record.updatedAt;
            setDocName(record.name || "Untitled");
            // Paint the last-saved meshes immediately so a heavy document shows
            // its geometry at once — the regen `resetDoc` kicks off (which
            // rebuilds every feature through OCCT and can take many seconds)
            // then swaps in fresh meshes when it settles. Without this the
            // viewport stays blank until that full rebuild finishes.
            if (record.meshes?.length) setRawMeshes(record.meshes);
            resetDoc(migrated);
            setSectionView(record.sectionView ?? DEFAULT_SECTION_VIEW);
            // Default the Variables section open/collapsed by the restored count.
            setVariablesOpen(migrated.variables.length < VARS_OPEN_THRESHOLD);
          } catch (err) {
            console.warn("saved document is corrupt:", err);
            recovery = { kind: "corrupted", name: record.name || "Untitled" };
          }
        }
        if (recovery) setDocRecoveryBanner(recovery);
        // Adopt whichever doc we ended up with (restored, or the fresh seed —
        // docIdRef never adopted a record that failed to open) as the tab's
        // active document.
        setActiveDocId(docIdRef.current!);
        setActiveId(docIdRef.current!);
      } finally {
        if (!cancelled) setPersistLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [resetDoc]);

  // Autosave the working document to IndexedDB (debounced) after each change.
  // Meshes ride along so the next load can paint instantly (see the restore
  // effect); `rawMeshes` is a dependency so a completed regen re-saves the fresh
  // geometry — a doc-only edit persists with the meshes that are current when the
  // debounce fires (regen typically settles first, so they match the doc).
  // `putDoc` writes the full record AND its meta row atomically (Phase 8.7);
  // `docName` is a dependency so a rename persists through the same path.
  useEffect(() => {
    if (!persistLoaded) return;
    const t = setTimeout(() => {
      putDoc({
        id: docIdRef.current!,
        name: docName,
        doc,
        updatedAt: Date.now(),
        createdAt: docCreatedAtRef.current,
        meshes: rawMeshes,
        sectionView,
      }).catch((err) => console.warn("autosave failed:", err));
    }, 600);
    return () => clearTimeout(t);
  }, [doc, rawMeshes, docName, persistLoaded, sectionView]);

  // Mirror the document name to the browser tab.
  useEffect(() => {
    document.title = `${docName} — Open Poly`;
  }, [docName]);

  // --- Multi-document actions (Phase 8.7 M2) -------------------------------

  /** Persist the working document NOW (same payload as the debounced autosave).
   *  Called before switching away so the last ≤600 ms of edits can't be lost;
   *  the pending debounce timer is cleared by its own effect when state changes,
   *  and a double-write is harmless. */
  const flushSave = useCallback(() => {
    if (!persistLoaded) return Promise.resolve();
    return putDoc({
      id: docIdRef.current!,
      name: docName,
      doc,
      updatedAt: Date.now(),
      createdAt: docCreatedAtRef.current,
      meshes: rawMeshes,
      sectionView,
    }).catch((err) => console.warn("flush save failed:", err));
  }, [doc, docName, rawMeshes, persistLoaded, sectionView]);

  /** Snapshot the CURRENT viewport into `meta.thumb` for `docId`, downscaled
   *  to ~256 px (offscreen canvas — capturePNG is Retina-sized, and a 2×/4×
   *  thumbnail would quadruple the stored bytes for no visible gain in a 56 px
   *  slot). Fire-and-forget: a failed capture just keeps the old thumb. */
  const captureThumb = useCallback((docId: string) => {
    // `plain` suppresses selection/hover highlights for the capture frame — a
    // thumbnail with an orange "selected" part would be misleading in the list.
    const dataUrl = viewApiRef.current?.capturePNG({ plain: true });
    if (!dataUrl) return;
    const img = new Image();
    img.onload = () => {
      const w = 256;
      const h = Math.max(1, Math.round((img.height / img.width) * w));
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      canvas.getContext("2d")?.drawImage(img, 0, 0, w, h);
      canvas.toBlob(
        (blob) => {
          if (blob) setThumb(docId, blob).catch(() => {});
        },
        "image/jpeg",
        0.75,
      );
    };
    img.src = dataUrl;
  }, []);

  // Refresh the thumbnail when a regen settles, throttled to once per 30 s per
  // document (never per keystroke — regens can settle several times a second
  // while dragging a dimension). Switch-away also captures (see openDocument).
  const thumbAtRef = useRef<{ id: string; at: number } | null>(null);
  useEffect(() => {
    if (!persistLoaded || regenSettledSeq === 0) return;
    const id = docIdRef.current!;
    const last = thumbAtRef.current;
    if (last && last.id === id && Date.now() - last.at < 30_000) return;
    thumbAtRef.current = { id, at: Date.now() };
    // Give the freshly settled meshes one frame to actually paint.
    const t = setTimeout(() => captureThumb(id), 300);
    return () => clearTimeout(t);
  }, [regenSettledSeq, persistLoaded, captureThumb]);

  /** Make `record` the working document. Ordering is load-bearing in TWO ways:
   *  1. `migrateDocument` runs FIRST, before anything is mutated — it throws on
   *     malformed persisted data, and if that happened after `docIdRef` already
   *     pointed at `record.id`, the app would be left in an inconsistent state
   *     (docIdRef says we're on the new doc; `doc` state is still the old one),
   *     and the next autosave would silently overwrite `record`'s real content.
   *  2. Once validated, `docIdRef` updates BEFORE `resetDoc`, so the first
   *     autosave after a switch can never write the incoming document's content
   *     under the outgoing id (the clobber bug — covered by verify-multidoc-
   *     m2.mjs). The saved meshes paint instantly while the kernel regen
   *     rebuilds behind.
   *  Throws (uncaught) if `record.doc` doesn't migrate — callers decide how to
   *  surface that (the Documents dialog shows it; the boot-restore effect
   *  falls back to a fresh doc + a recovery banner). */
  const adoptRecord = useCallback(
    (record: StoredDoc) => {
      const migrated = migrateDocument(record.doc);
      docIdRef.current = record.id;
      docCreatedAtRef.current = record.createdAt ?? record.updatedAt;
      setDocName(record.name || "Untitled");
      setActiveId(record.id);
      setActiveDocId(record.id);
      setSelection([]);
      setRawMeshes(record.meshes ?? []);
      resetDoc(migrated); // clears undo history — a document boundary
      setSectionView(record.sectionView ?? DEFAULT_SECTION_VIEW);
      setVariablesOpen(migrated.variables.length < VARS_OPEN_THRESHOLD);
    },
    [resetDoc],
  );

  const openDocument = useCallback(
    async (id: string) => {
      if (id === docIdRef.current) return;
      captureThumb(docIdRef.current!); // the canvas still shows the outgoing doc
      await flushSave();
      let record: StoredDoc | undefined;
      try {
        record = await loadDoc(id);
      } catch (err) {
        throw new Error(`Could not read this document from storage: ${String((err as Error)?.message ?? err)}`);
      }
      if (!record) throw new Error("This document no longer exists — it may have been deleted.");
      try {
        adoptRecord(record);
      } catch {
        // Swallow the raw parse error (e.g. a TypeError from migrateDocument) —
        // not actionable for the user. It's still in Documents either way: they
        // can Export as JSON (works regardless of doc validity) then Delete it.
        throw new CorruptDocError(record.name);
      }
    },
    [flushSave, adoptRecord, captureThumb],
  );

  const newDocument = useCallback(async () => {
    captureThumb(docIdRef.current!);
    await flushSave();
    const metas = await listMeta();
    const now = Date.now();
    const record: StoredDoc = {
      id: genId(),
      name: nextUntitled(metas.map((m) => m.name)),
      doc: createDocument(),
      createdAt: now,
      updatedAt: now,
    };
    await putDoc(record); // exists in the list before it's ever edited
    adoptRecord(record);
  }, [flushSave, adoptRecord, captureThumb]);

  const duplicateDocument = useCallback(
    async (id: string) => {
      captureThumb(docIdRef.current!);
      // Flush first so duplicating the ACTIVE doc copies its latest edits.
      if (id === docIdRef.current) await flushSave();
      const metas = await listMeta();
      const source = metas.find((m) => m.id === id);
      const copy = await duplicateDoc(
        id,
        genId(),
        copyName(
          source?.name ?? "Untitled",
          metas.map((m) => m.name),
        ),
      );
      if (!copy) throw new Error("This document no longer exists — it may have been deleted.");
      try {
        adoptRecord(copy); // throws if the SOURCE was itself corrupt (copied verbatim)
      } catch {
        throw new CorruptDocError(copy.name);
      }
    },
    [flushSave, adoptRecord, captureThumb],
  );

  const deleteDocument = useCallback(
    async (id: string) => {
      // No flush — deleting the active doc means discarding it.
      await deleteDoc(id);
      if (id !== docIdRef.current) return;
      // The active doc is gone: fall back to the next most recent, else seed.
      const metas = await listMeta();
      const next = metas.length ? await loadDoc(metas[0].id) : undefined;
      if (next) {
        adoptRecord(next);
      } else {
        const now = Date.now();
        const record: StoredDoc = {
          id: genId(),
          name: "Untitled",
          doc: createDocument(),
          createdAt: now,
          updatedAt: now,
        };
        await putDoc(record);
        adoptRecord(record);
      }
    },
    [adoptRecord],
  );

  const renameDocument = useCallback(async (id: string, name: string) => {
    // State first: for the active doc this alone persists (docName is an
    // autosave dependency), even if the record hasn't been written yet —
    // renameDoc is then a no-op-if-absent stores update.
    if (id === docIdRef.current) setDocName(name);
    await renameDoc(id, name);
  }, []);

  /** Save a document as `.openpoly.json` (envelope + parametric doc; cached
   *  meshes deliberately excluded — see storage/docFile.ts). */
  const exportDocument = useCallback(
    async (id: string) => {
      if (id === docIdRef.current) await flushSave(); // export the latest edits
      const record = await loadDoc(id);
      if (!record) return;
      const blob = new Blob([serializeDocFile(record.name, record.doc)], { type: "application/json" });
      downloadBlob(blob, `${safeFilename(record.name)}.openpoly.json`);
    },
    [flushSave],
  );

  /** Import a `.openpoly.json` file as a NEW document (fresh id — an import
   *  must never overwrite an existing doc) and open it. Resolves an error
   *  message for the dialog to show, or null on success. */
  const importDocumentFile = useCallback(
    async (file: File): Promise<string | null> => {
      let parsed: ReturnType<typeof parseDocFile>;
      try {
        parsed = parseDocFile(await file.text());
      } catch (err) {
        return String((err as Error).message ?? err);
      }
      captureThumb(docIdRef.current!);
      await flushSave();
      const metas = await listMeta();
      const now = Date.now();
      const record: StoredDoc = {
        id: genId(),
        name: dedupeName(
          parsed.name,
          metas.map((m) => m.name),
        ),
        doc: migrateDocument(parsed.doc),
        createdAt: now,
        updatedAt: now,
      };
      await putDoc(record);
      adoptRecord(record);
      return null;
    },
    [flushSave, adoptRecord, captureThumb],
  );

  // Same-document multi-tab guard: announce which doc this tab holds; if
  // another tab announces (or answers for) the same doc, both show a warning.
  // Last-writer-wins autosaves make concurrent edits genuinely dangerous, so
  // surface it rather than silently clobbering.
  useEffect(() => {
    if (!activeId || typeof BroadcastChannel === "undefined") return;
    setDocInOtherTab(false);
    const tab = tabIdRef.current;
    const ch = new BroadcastChannel("openpoly-docs");
    ch.onmessage = (e: MessageEvent<{ t: string; docId: string; tab: string }>) => {
      const m = e.data;
      if (!m || m.tab === tab || m.docId !== activeId) return;
      if (m.t === "open") {
        setDocInOtherTab(true);
        ch.postMessage({ t: "present", docId: activeId, tab });
      } else if (m.t === "present") {
        setDocInOtherTab(true);
      } else if (m.t === "leave") {
        // The other holder left; re-announce to detect any remaining ones.
        setDocInOtherTab(false);
        ch.postMessage({ t: "open", docId: activeId, tab });
      }
    };
    ch.postMessage({ t: "open", docId: activeId, tab });
    return () => {
      ch.postMessage({ t: "leave", docId: activeId, tab });
      ch.close();
    };
  }, [activeId]);

  // ("New Body" closes on an outside click too, but that dropdown now lives
  // inside <OverflowToolbar>, which owns the listener.)

  // Close the Parts "Import ▾" flyout when clicking outside it.
  useEffect(() => {
    if (!importMenuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (!importMenuRef.current?.contains(e.target as Node)) setImportMenuOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [importMenuOpen]);

  // Resolution (variables + params -> numbers) is synchronous and pure; memoize
  // it so the UI can read evaluated values without re-running the kernel.
  const resolved = useMemo(() => resolveDocument(doc), [doc]);
  // Latest doc/resolved for effects that fire off async kernel builds (the
  // reproject effect runs after a regen and must read the current state, not a
  // closure captured when the effect was registered).
  const docRef = useRef(doc);
  docRef.current = doc;
  const resolvedRef = useRef(resolved);
  resolvedRef.current = resolved;

  // The section-view ref resolved to a concrete frame. Falls back to the
  // default (Front datum) if the ref pointed at a since-deleted reference
  // plane — a datum or a frozen face frame (the common cases) always resolve.
  const sectionFrame = useMemo(() => {
    try {
      return frameOf(sectionView.ref, resolved.planeFrames);
    } catch {
      return frameOf(DEFAULT_SECTION_VIEW.ref);
    }
  }, [sectionView.ref, resolved.planeFrames]);

  // User-created reference planes that resolved to a frame — rendered in the
  // viewport and selectable for sketching / as a base for further planes.
  const userPlanes = useMemo(
    () =>
      doc.features
        .filter((f): f is PlaneFeature => f.type === "plane" && resolved.planeFrames.has(f.id))
        .map((f) => ({
          id: f.id,
          name: f.name,
          frame: resolved.planeFrames.get(f.id)!,
          color: f.color,
          hidden: !!f.hidden,
        })),
    [doc, resolved.planeFrames],
  );
  // Hiding a plane is a view toggle: it drops out of the viewport (so it's no
  // longer drawn or pickable) but stays in every plane list, and anything built
  // on it keeps resolving.
  const visibleUserPlanes = useMemo(() => userPlanes.filter((p) => !p.hidden), [userPlanes]);

  // Live ghost of the reference-plane dialog: as soon as the picked inputs
  // define a frame, preview where the new plane will land (pure geometry — the
  // same resolvers `resolvePlanes` uses, no kernel round trip). Create only: an
  // edit live-applies to the real plane, which would double up with a ghost.
  const ghostPlaneFrame = useMemo<PlaneFrameData | null>(() => {
    const d = planeDialog;
    if (!d || d.editId) return null;
    try {
      if (d.method === "through") {
        const [p0, p1, p2] = d.points;
        return d.points.length === 3 ? planeThrough3Points(p0, p1, p2) : null;
      }
      if (!d.base) return null;
      const base = frameOf(d.base, resolved.planeFrames);
      if (d.method === "midplane") return d.refB ? midplaneFrame(base, frameOf(d.refB, resolved.planeFrames)) : null;
      if (d.method === "angle") return angledFrame(base, d.angleAxis, evaluateExpression(d.angle, resolved.scope));
      return offsetFrame(base, evaluateExpression(d.offset, resolved.scope));
    } catch {
      return null; // an unresolved reference or a bad expression — no ghost
    }
  }, [planeDialog, resolved.planeFrames, resolved.scope]);

  // Regenerate whenever the resolved document changes — the kernel runs off-thread.
  // A short trailing debounce coalesces bursts (slider drags, multi-step edits)
  // into ONE regen: without it each intermediate `resolved` kicks off a full
  // worker rebuild that the next supersedes — the client drops the stale result,
  // but the worker already spent the time. The delay is negligible next to a
  // heavy regen, and geometry the model already shows stays on screen meanwhile.
  useEffect(() => {
    const kernel = kernelRef.current;
    if (!ready || !kernel) return;
    let cancelled = false;

    const timer = setTimeout(() => {
      setBusy(true);
      // This regen's start ordinal — waiters that began before it resolve on it.
      const myStart = (regenStartSeqRef.current += 1);
      // Captured outcome handed to anyone awaiting this regen (the agent layer).
      let settle: RegenSettle = { errors: { ...resolved.errors } };
      // Optional end-to-end latency measurement (submit → results). Enable with
      // `?perf` in the URL to objectively compare regen responsiveness.
      const perfT0 = PERF_LOG ? performance.now() : 0;

      kernel
        .regenerate(
          resolved.features,
          (r) => {
            // Progressive paint: fold each body into the shown set the moment it's
            // meshed (replace by id, else append) so a heavy rebuild reveals the
            // model piece by piece instead of all at once. The final result below
            // is authoritative and reconciles (drops bodies that no longer exist).
            if (cancelled || !r.ok) return;
            setRawMeshes((prev) => {
              const next = prev.slice();
              const i = next.findIndex((m) => m.id === r.id);
              if (i >= 0) next[i] = { id: r.id, mesh: r.mesh };
              else next.push({ id: r.id, mesh: r.mesh });
              return next;
            });
          },
          (_featureId, done, total) => {
            if (!cancelled) setMeshProgress(done < total ? { done, total } : null);
          },
        )
        .then(({ results, warnings: regenWarnings }) => {
          if (cancelled) return;
          const nextMeshes: { id: string; mesh: FeatureMesh["mesh"] }[] = [];
          const regenErrors: Record<string, string> = { ...resolved.errors };
          for (const r of results) {
            if (r.ok) nextMeshes.push({ id: r.id, mesh: r.mesh });
            else {
              regenErrors[r.id] = r.error;
              const name = doc.features.find((f) => f.id === r.id)?.name ?? r.id;
              console.error(`[open-poly] feature "${name}" (${r.id}) failed:`, r.error);
            }
          }
          setRawMeshes(nextMeshes);
          setRegenSettledSeq((s) => s + 1);
          setErrors(regenErrors);
          setWarnings(regenWarnings);
          setFatal(null);
          // Feed the agent refs synchronously (ahead of React's commit).
          agentMeshesRef.current = nextMeshes;
          agentErrorsRef.current = regenErrors;
          agentWarningsRef.current = regenWarnings;
          settle = { errors: regenErrors, warnings: regenWarnings, bodyIds: nextMeshes.map((m) => m.id) };
        })
        .catch((err) => {
          if (cancelled) return;
          console.error("regeneration failed:", err);
          setFatal(String(err?.message ?? err));
          settle = { errors: agentErrorsRef.current, warnings: agentWarningsRef.current };
        })
        .finally(() => {
          if (cancelled) return;
          setBusy(false);
          setMeshProgress(null);
          if (PERF_LOG)
            console.log(
              `[perf] regen round-trip ${(performance.now() - perfT0).toFixed(0)} ms (${resolved.features.length} features)`,
            );
          // Resolve only waiters that began before this regen started; keep the
          // rest pending for a later regen.
          const stillWaiting: typeof regenWaitersRef.current = [];
          for (const w of regenWaitersRef.current) {
            if (myStart > w.threshold) w.settle(settle);
            else stillWaiting.push(w);
          }
          regenWaitersRef.current = stillWaiting;
        });
    }, REGEN_DEBOUNCE_MS);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [resolved, ready]);

  // Associative Project/Convert ("Use"): after every kernel build, re-project each
  // `project` DerivedOp's source body edges/vertices onto its sketch plane and
  // refresh the generated entities, so projected geometry tracks the source body
  // (Onshape/Fusion behaviour). This is IMPURE — it reads the live world-space
  // edge polylines off the rendered bodies, by persistent edge name — so it can't
  // live in pure `applyDerived`. It runs after a regen settles (rawMeshes), once
  // the viewport (a child) has rebuilt its scene, so the edges are current.
  //
  // No infinite loop: we only `setDoc` when the freshly-projected entities DIFFER
  // from the stored ones. A source-body change → the first post-build reproject
  // writes new geometry (changed) → that triggers a regen, but those bodies
  // rebuild identically (a sketch's projected geometry is not an input to them) →
  // the next reproject yields identical geometry (unchanged) → no write → settles.
  // So it converges in at most one extra regen.
  useEffect(() => {
    const view = viewApiRef.current;
    if (!view) return;
    const cur = docRef.current;
    const planeFrames = resolvedRef.current.planeFrames;
    let dangling = false;
    let changed = false;
    const features = cur.features.map((f) => {
      if (f.type !== "sketch") return f;
      const projOps = (f.derived ?? []).filter((o) => o.kind === "project");
      if (projOps.length === 0) return f;
      let frame: PlaneFrameData;
      try {
        frame = frameOf(f.plane, planeFrames);
      } catch {
        return f; // sketch plane not resolvable yet — leave its projections alone
      }
      const projOpIds = new Set(projOps.map((o) => o.id));
      const fresh: SketchEntity[] = [];
      for (const op of projOps) {
        if (op.kind !== "project") continue;
        op.refs.forEach((ref, i) => {
          const id = `${op.id}:${i}`;
          if (ref.kind === "vertex") {
            // Vertices have no stable identity across rebuilds; re-project the
            // stored world point (best-effort — tracks the plane, not the body).
            fresh.push(projectedPointEntity(frame, ref.point, id, op.id));
            return;
          }
          // Resolve the edge by its persistent name (stable across rebuilds);
          // fall back to the build-local id for legacy/unnamed edges.
          const poly =
            (ref.edgeName ? view.getEdgeWorldPolylineByName(ref.featureId, ref.edgeName) : null) ??
            view.getEdgeWorldPolyline(ref.featureId, ref.edgeId);
          if (!poly || poly.length < 2) {
            dangling = true; // source edge gone / topology changed (a dangling projection)
            return;
          }
          const e = projectedEntityFromPolyline(frame, poly, id, op.id);
          if (e) fresh.push(e);
        });
      }
      const old = f.entities.filter((e) => e.derivedFrom && projOpIds.has(e.derivedFrom));
      if (sameProjectedEntities(old, fresh)) return f; // converged — no rewrite
      changed = true;
      const rest = f.entities.filter((e) => !(e.derivedFrom && projOpIds.has(e.derivedFrom)));
      return { ...f, entities: [...rest, ...fresh] };
    });
    // Only warn when a dangling source actually changed the result (avoids
    // re-flashing the same banner on every settled rebuild).
    if (changed && dangling) flashMsg("A projected edge's source is missing.");
    if (changed) setDoc({ ...cur, features });
    // Keyed on the SETTLED regen (not progressive partials) so it reprojects
    // against the complete rebuilt scene, never a half-streamed one.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [regenSettledSeq]);

  // Overlay each body's current color/opacity from the document onto its
  // cached geometry — so changing appearance is instant, not a regen round-trip.
  const meshes = useMemo<FeatureMesh[]>(
    () =>
      rawMeshes.flatMap((m) => {
        if (isolatedBodyId && m.id !== isolatedBodyId) return []; // isolate mode
        const feature = doc.features.find((f) => f.id === m.id);
        // Primitives, "new" extrusions, booleans, and copy-transforms own a
        // color/opacity/hidden; a body modified in place (add/remove/dressup, or
        // a non-copy transform) keeps the id — and appearance — of its source.
        const owns =
          feature?.type === "primitive" ||
          feature?.type === "extrude" ||
          feature?.type === "boolean" ||
          feature?.type === "transform" ||
          feature?.type === "mirror" ||
          feature?.type === "pattern" ||
          feature?.type === "revolve" ||
          feature?.type === "sweep" ||
          feature?.type === "loft" ||
          feature?.type === "import";
        if (owns && feature.hidden) return []; // hidden part — don't render or pick
        const color = owns ? feature.color : DEFAULT_SOLID_COLOR;
        const opacity = owns ? feature.opacity : 1;
        return [{ id: m.id, mesh: m.mesh, color, opacity }];
      }),
    [rawMeshes, doc, isolatedBodyId],
  );

  // The extrude live preview ghosts only the swept *tool* (the changing
  // portion), keyed by fresh ids that aren't among the real bodies — so every
  // existing body stays rendered in its own colour and only the new material
  // reads as cyan. Hence the viewport just shows all real meshes as usual.
  const viewportMeshes = meshes;

  // The Pattern dialog's live validation: null = fields are commit-ready. Used
  // both to gate Create and as the dialog's warning line.
  const patternDialogWarning = useMemo<string | null>(() => {
    const d = patternDialog;
    if (!d) return null;
    if (!d.targetId) return "Pick a body to pattern.";
    const num = (expr: string): number => {
      try {
        return evaluateExpression(expr, resolved.scope);
      } catch {
        return NaN;
      }
    };
    const badCount = (expr: string) => resolvePatternCount(expr, resolved.scope) === null;
    if (d.kind === "linear") {
      if (badCount(d.count1)) return "Count must be 2 or more.";
      const s1 = num(d.spacing1);
      if (!Number.isFinite(s1) || Math.abs(s1) < 1e-9) return "Spacing must be a non-zero number.";
      if (d.dir2on) {
        if (!d.dir2) return "Pick the second direction (or collapse it).";
        if (badCount(d.count2)) return "The second count must be 2 or more.";
        const s2 = num(d.spacing2);
        if (!Number.isFinite(s2) || Math.abs(s2) < 1e-9) return "The second spacing must be a non-zero number.";
      }
      return null;
    }
    if (badCount(d.count)) return "Count must be 2 or more.";
    if (d.mode === "angle") {
      const a = num(d.angle);
      if (!Number.isFinite(a) || Math.abs(a) < 1e-9) return "Angle must be a non-zero number.";
    }
    return null;
  }, [patternDialog, resolved.scope]);

  // Ghost preview of the Pattern dialog: the seed's ALREADY-TESSELLATED mesh
  // cloned once per would-be copy with the instance's rigid motion applied in
  // place — no kernel round trip, exact for rigid motions, updates per
  // keystroke. Mirrors resolveDocument's baking but tolerates half-typed fields
  // (⇒ no ghosts). A face axis only resolves in the worker (a cylinder's axis
  // needs the B-rep), so it previews nothing until Create.
  const patternGhosts = useMemo<GhostMesh[]>(() => {
    const d = patternDialog;
    if (!d || patternDialogWarning) return [];
    const m = meshes.find((x) => x.id === d.targetId);
    if (!m) return [];
    const worldDir = (ref: PatternDirRef): [number, number, number] | null => {
      if ("world" in ref) return ref.world === "x" ? [1, 0, 0] : ref.world === "y" ? [0, 1, 0] : [0, 0, 1];
      const sk = doc.features.find((f) => f.id === ref.sketchId);
      if (sk?.type !== "sketch") return null;
      const e = sk.entities.find((x) => x.id === ref.entityId);
      if (e?.type !== "line") return null;
      const fr = frameOf(sk.plane, resolved.planeFrames);
      const a = uvToWorld(fr, e.a[0], e.a[1]);
      const b = uvToWorld(fr, e.b[0], e.b[1]);
      const v: [number, number, number] = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
      const len = Math.hypot(v[0], v[1], v[2]);
      return len < 1e-9 ? null : [v[0] / len, v[1] / len, v[2] / len];
    };
    const num = (expr: string): number => {
      try {
        return evaluateExpression(expr, resolved.scope);
      } catch {
        return NaN;
      }
    };
    if (d.kind === "linear") {
      const count1 = resolvePatternCount(d.count1, resolved.scope);
      const d1 = worldDir(d.dir1);
      if (count1 === null || !d1) return [];
      const s1 = num(d.spacing1) * (d.flip1 ? -1 : 1);
      let count2 = 1,
        s2 = 0;
      let d2: [number, number, number] = [0, 0, 0];
      if (d.dir2on && d.dir2) {
        const c2 = resolvePatternCount(d.count2, resolved.scope);
        const dir2 = worldDir(d.dir2);
        if (c2 === null || !dir2) return [];
        count2 = c2;
        s2 = num(d.spacing2) * (d.flip2 ? -1 : 1);
        d2 = dir2;
      }
      const out: GhostMesh[] = [];
      for (let j = 0; j < count2; j++) {
        for (let i = 0; i < count1; i++) {
          if (i === 0 && j === 0) continue;
          const off: [number, number, number] = [
            i * s1 * d1[0] + j * s2 * d2[0],
            i * s1 * d1[1] + j * s2 * d2[1],
            i * s1 * d1[2] + j * s2 * d2[2],
          ];
          out.push({
            mesh: transformMeshPayload(
              m.mesh,
              (p) => [p[0] + off[0], p[1] + off[1], p[2] + off[2]],
              (v) => v,
            ),
          });
        }
      }
      return out;
    }
    const axis = d.axis;
    const count = resolvePatternCount(d.count, resolved.scope);
    if (count === null || !axis || "face" in axis) return [];
    const totalDeg = d.mode === "full" ? 360 : num(d.angle);
    if (!Number.isFinite(totalDeg) || Math.abs(totalDeg) < 1e-9) return [];
    let origin: [number, number, number];
    let dir: [number, number, number] | null;
    if ("world" in axis) {
      origin = [0, 0, 0];
      dir = worldDir({ world: axis.world });
    } else {
      const sk = doc.features.find((f) => f.id === axis.sketchId);
      if (sk?.type !== "sketch") return [];
      const e = sk.entities.find((x) => x.id === axis.entityId);
      if (e?.type !== "line") return [];
      const fr = frameOf(sk.plane, resolved.planeFrames);
      origin = uvToWorld(fr, e.a[0], e.a[1]);
      dir = worldDir(axis);
    }
    if (!dir) return [];
    return circularPatternAngles(count, totalDeg, d.mode === "angle" && d.symmetric).map((a) => {
      const { mapPt, mapVec } = rotationMappers(origin, dir!, a);
      return { mesh: transformMeshPayload(m.mesh, mapPt, mapVec) };
    });
  }, [patternDialog, patternDialogWarning, meshes, doc, resolved.planeFrames, resolved.scope]);

  const ghostMeshes = useMemo<GhostMesh[]>(
    () => [
      ...(extrudePreview ? extrudePreview.map((p) => ({ mesh: p.mesh })) : []),
      ...(revolvePreview ? [{ mesh: revolvePreview }] : []),
      ...patternGhosts,
      // The chamfer/fillet delta: what the operation fills in and what it carves
      // off, ghosted over the model (see GhostMesh.variant).
      ...(dressUpPreview?.added ? [{ mesh: dressUpPreview.added, variant: "fill" as const }] : []),
      ...(dressUpPreview?.removed ? [{ mesh: dressUpPreview.removed, variant: "cut" as const }] : []),
    ],
    [extrudePreview, revolvePreview, patternGhosts, dressUpPreview],
  );

  // Feature ids that produced an actual rendered body — what the Solids list
  // shows and what a Boolean can combine (primitives, "new" extrusions,
  // booleans, and add/dressup-targets that kept their id).
  const bodyIds = useMemo(() => new Set(rawMeshes.map((m) => m.id)), [rawMeshes]);

  // Agent command layer (Phase 9): exposes window.__openpoly for console testing
  // and runs the WebSocket bridge to the local MCP hub. `agentStatus` drives the
  // "Agent connected" badge.
  // Multi-document API for the agent (Phase 8.7 M4). A ref refreshed each
  // render, so the stable AgentContext always calls the latest switch-flow
  // closures (openDocument etc. close over doc/docName/rawMeshes).
  const agentDocApiRef = useRef({
    info: () => ({ id: docIdRef.current!, name: docName }),
    open: openDocument,
    create: newDocument,
    duplicate: duplicateDocument,
    rename: renameDocument,
  });
  agentDocApiRef.current = {
    info: () => ({ id: docIdRef.current!, name: docName }),
    open: openDocument,
    create: newDocument,
    duplicate: duplicateDocument,
    rename: renameDocument,
  };

  const { status: agentStatus } = useAgentBridge({
    doc,
    setDoc,
    selection,
    setSelection,
    sectionView,
    setSectionView,
    meshesRef: agentMeshesRef,
    errorsRef: agentErrorsRef,
    waitForRegen,
    viewApiRef,
    docApiRef: agentDocApiRef,
  });

  // Exit isolate if the isolated body disappears (deleted / consumed / regen).
  useEffect(() => {
    if (isolatedBodyId && !bodyIds.has(isolatedBodyId)) setIsolatedBodyId(null);
  }, [bodyIds, isolatedBodyId]);
  const handleIsolate = (id: string) => setIsolatedBodyId((cur) => (cur === id ? null : id));

  // Bodies available as Boolean operands: features with a rendered body.
  const booleanCandidates = useMemo(
    () => doc.features.filter((f) => bodyIds.has(f.id)).map((f) => ({ id: f.id, name: f.name })),
    [doc, bodyIds],
  );

  const editingSketch = useMemo(() => {
    const f = doc.features.find((x) => x.id === editingSketchId);
    return f && f.type === "sketch" ? f : null;
  }, [doc, editingSketchId]);

  // The no-dialog feature whose params panel is open (double-click), if it still
  // exists. The panel closes automatically once the selection moves elsewhere.
  const editParamsFeature = useMemo(
    () => (editParamsId ? (doc.features.find((f) => f.id === editParamsId) ?? null) : null),
    [editParamsId, doc],
  );
  useEffect(() => {
    if (editParamsId && editParamsId !== primaryFeatureId) setEditParamsId(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [primaryFeatureId]);

  // Viewport emphasis driven by the constraints-list hover (independent of the
  // pointer): the entities/points the hovered constraint acts on.
  const constraintEmphasis = useMemo<Selection[]>(() => {
    if (!editingSketch || !hoveredConstraintId) return [];
    const c = editingSketch.constraints.find((x) => x.id === hoveredConstraintId);
    return c ? constraintSelections(editingSketch.id, editingSketch.entities, c) : [];
  }, [editingSketch, hoveredConstraintId]);

  // The single dimensionable entity selected inside the active sketch (a line →
  // length, or a circle → radius). Null unless exactly one such entity is held.
  // The sketch entities currently selected in the active sketch, in pick order.
  const selectedSketchEntities = useMemo(() => {
    if (!editingSketch) return [];
    return selection.flatMap((s) =>
      s.kind === "sketchEntity" && s.sketchId === editingSketch.id
        ? (editingSketch.entities.find((x) => x.id === s.entityId) ?? [])
        : [],
    );
  }, [editingSketch, selection]);

  // When exactly one selected sketch entity is a generated offset output, expose
  // its op so the user can re-edit the offset distance after the fact.
  const selectedOffsetOp = useMemo(() => {
    if (!editingSketch || selectedSketchEntities.length !== 1) return null;
    const e = selectedSketchEntities[0];
    if (!e.derivedFrom) return null;
    const op = (editingSketch.derived ?? []).find((o) => o.id === e.derivedFrom);
    return op && op.kind === "offset" ? { op, entity: e } : null;
  }, [editingSketch, selectedSketchEntities]);

  // A single line (length), circle or arc (radius) selected → dimensionable.
  const dimEntity = useMemo(() => {
    if (selectedSketchEntities.length !== 1) return null;
    const e = selectedSketchEntities[0];
    // Derived (offset/mirror) outputs aren't free geometry — the solver ignores
    // them, so they can't carry dimensions/constraints.
    if (e.derivedFrom) return null;
    return e.type === "line" || e.type === "circle" || e.type === "arc" ? e : null;
  }, [selectedSketchEntities]);

  // A single line selected → eligible for the Horizontal/Vertical constraints.
  const oneSelectedLine = dimEntity?.type === "line" ? dimEntity : null;

  // Exactly two lines / two circles selected → eligible for the line-pair
  // constraints (angle/parallel/perpendicular/equal-length) and equal-radius.
  const twoSelectedLines = useMemo(() => {
    const es = selectedSketchEntities;
    return es.length === 2 && es[0].type === "line" && es[1].type === "line"
      ? ([es[0], es[1]] as Extract<SketchEntity, { type: "line" }>[])
      : null;
  }, [selectedSketchEntities]);
  // Exactly two circles/arcs (any mix) selected → eligible for equal-radius.
  const twoRadiusEntities = useMemo(() => {
    const es = selectedSketchEntities;
    const isR = (e: SketchEntity) => e.type === "circle" || e.type === "arc";
    return es.length === 2 && isR(es[0]) && isR(es[1]) ? [es[0], es[1]] : null;
  }, [selectedSketchEntities]);

  // Two entities selected with at least one curve (circle/arc) — eligible for a
  // tangent constraint (any pair except line+line). The solver normalizes order.
  const tangentPair = useMemo(() => {
    const es = selectedSketchEntities;
    if (es.length !== 2) return null;
    const [a, b] = es;
    const ok = (e: SketchEntity) => e.type === "line" || e.type === "circle" || e.type === "arc";
    const curve = (e: SketchEntity) => e.type === "circle" || e.type === "arc";
    if (ok(a) && ok(b) && (curve(a) || curve(b)) && !(a.type === "line" && b.type === "line")) return [a, b];
    return null;
  }, [selectedSketchEntities]);

  // Sketch points (endpoints/centres/origin) currently selected in this sketch.
  const selectedSketchPoints = useMemo<Vec2[]>(() => {
    if (!editingSketch) return [];
    return selection.flatMap((s) => (s.kind === "sketchPoint" && s.sketchId === editingSketch.id ? [s.point] : []));
  }, [editingSketch, selection]);

  // Selected line entities in this sketch (for the point-on-line coincidence).
  const selectedSketchLines = useMemo(
    () => selectedSketchEntities.filter((e): e is Extract<SketchEntity, { type: "line" }> => e.type === "line"),
    [selectedSketchEntities],
  );

  // The active sketch's plane frame (uv → world), for placing on-canvas overlays.
  const dimFrame = useMemo(
    () => (editingSketch ? frameOf(editingSketch.plane, resolved.planeFrames) : null),
    [editingSketch, resolved.planeFrames],
  );

  // On-canvas dimensions for the active sketch: one per length (line), radius
  // (circle), or angle (line–line) constraint, drawn as technical-drawing-style
  // annotations. The dimension currently being edited (its dim-input is open)
  // is dropped so the two don't overlap.
  const ent = (id: string) => editingSketch?.entities.find((x) => x.id === id);
  const dimCentroid = useMemo<Vec2>(() => sketchBoundsCenter(editingSketch?.entities ?? []), [editingSketch]);
  // Variables (well-named, evaluated) offered as autocomplete in the dimension
  // value field — a dimension may be a number, an expression, or a variable.
  const dimVarOptions = useMemo<VarOption[]>(
    () =>
      doc.variables
        .filter((v) => resolved.scope[v.name] !== undefined)
        .map((v) => ({ name: v.name, value: resolved.scope[v.name] })),
    [doc.variables, resolved.scope],
  );
  const dimSpecs = useMemo<DimSpec[]>(() => {
    if (!editingSketch) return [];
    return editingSketch.constraints.flatMap((c): DimSpec[] => {
      if (c.id === dimInput?.editId) return [];
      if (c.type === "distance") {
        const e = ent(c.entity);
        if (e?.type === "line") return [{ id: c.id, kind: "length", text: fmt(c.value), a: e.a, b: e.b }];
      } else if (c.type === "distanceBetween") {
        const ra = resolveSide(c.a, editingSketch.entities);
        const rb = resolveSide(c.b, editingSketch.entities);
        if (ra && rb) {
          const m = measureBetween(ra, rb);
          if (m) return [{ id: c.id, kind: "distance", text: fmt(c.value), a: m.wa, b: m.wb }];
        }
      } else if (c.type === "radius") {
        const e = ent(c.entity);
        if (e?.type === "circle" || e?.type === "arc")
          return [{ id: c.id, kind: "radius", text: `R${fmt(c.value)}`, c: e.c, r: e.r }];
      } else if (c.type === "angle") {
        const la = ent(c.a);
        const lb = ent(c.b);
        if (la?.type === "line" && lb?.type === "line") {
          const p = lineLineIntersection(la.a, la.b, lb.a, lb.b);
          if (p) {
            return [
              {
                id: c.id,
                kind: "angle",
                text: `${fmt(c.value)}°`,
                p,
                dir1: rayFromCorner(la, p),
                dir2: rayFromCorner(lb, p),
                isRight: Math.abs(c.value - 90) < 1e-6,
              },
            ];
          }
          const mid = (l: Extract<SketchEntity, { type: "line" }>): Vec2 => [
            (l.a[0] + l.b[0]) / 2,
            (l.a[1] + l.b[1]) / 2,
          ];
          return [{ id: c.id, kind: "free", text: `${fmt(c.value)}°`, a: mid(la), b: mid(lb) }];
        }
      }
      return [];
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editingSketch, dimInput]);

  const measure = useMemo(
    () => measureSelection(selection, doc, meshes, resolved.scope),
    [selection, doc, meshes, resolved.scope],
  );

  // Every selected profile an Extrude could consume: sketch regions, planar
  // faces of existing bodies, or sketch edges that fully enclose a region (so
  // a tiny/fiddly-to-click face can be picked by its boundary instead) —
  // picked one at a time and accumulated by the normal multi-select (see
  // handlePick) — one dialog fill-in extrudes or cuts all of them at once.
  const extrudeProfiles = useMemo((): ExtrudeProfile[] => {
    const profiles: ExtrudeProfile[] = [];
    const regionKeys = new Set<string>(); // dedupe sketchId/regionId across selection kinds
    const addRegion = (sketchId: string, regionId: string) => {
      const key = `${sketchId}/${regionId}`;
      if (regionKeys.has(key)) return;
      regionKeys.add(key);
      profiles.push({ kind: "sketchRegion", sketchId, regionId });
    };
    const selectedEntitiesBySketch = new Map<string, Set<string>>();
    for (const s of selection) {
      if (s.kind !== "sketchEntity") continue;
      let ids = selectedEntitiesBySketch.get(s.sketchId);
      if (!ids) selectedEntitiesBySketch.set(s.sketchId, (ids = new Set()));
      ids.add(s.entityId);
    }
    for (const [sketchId, ids] of selectedEntitiesBySketch) {
      const sk = doc.features.find((f) => f.id === sketchId);
      if (sk?.type !== "sketch") continue;
      for (const region of regionsEnclosedBy(sk.entities, ids)) addRegion(sketchId, region.id);
      // A selected text entity extrudes on its own (the kernel bakes its glyph
      // wires with counters/holes) — no enclosing region needed.
      for (const id of ids) {
        const ent = sk.entities.find((e) => e.id === id);
        if (ent?.type === "text" && ent.value.trim()) profiles.push({ kind: "sketchText", sketchId, textId: id });
      }
    }
    for (const s of selection) {
      if (s.kind === "sketchFace") {
        addRegion(s.sketchId, s.regionId);
      } else if (s.kind === "face") {
        const m = meshes.find((x) => x.id === s.featureId);
        const center = m ? faceCentroid(m.mesh.faces, s.faceId) : null;
        if (!center) continue;
        const faceName = m ? faceNameOf(m.mesh.faces, s.faceId) : undefined;
        const normal = (m && faceNormal(m.mesh.faces, s.faceId)) || undefined;
        profiles.push({ kind: "bodyFace", featureId: s.featureId, faceId: s.faceId, faceName, center, normal });
      }
    }
    return profiles;
  }, [selection, meshes, doc]);

  // What the extrude dialog operates on. Creating: the selected profiles above.
  // Editing (editId set): a re-picked profile from the selection if there is one,
  // else the feature's own current profile — so the dialog is never empty and
  // re-picking a region/face just works through the normal selection.
  const extrudeDialogProfiles = useMemo((): ExtrudeProfile[] => {
    if (!extrudeDialog?.editId) return extrudeProfiles;
    if (extrudeProfiles.length > 0) return extrudeProfiles;
    const f = doc.features.find((x) => x.id === extrudeDialog.editId);
    return f?.type === "extrude" ? [f.profile] : [];
  }, [extrudeDialog, extrudeProfiles, doc]);

  // World-space anchor for the extrude dialog + gizmo: a body face's centroid,
  // or a sketch region's centroid mapped to 3D. Defaults to the first selected
  // profile; the gizmo passes the dialog's own profile (which falls back to the
  // edited feature's when nothing is selected).
  const profileAnchorWorld = (p: ExtrudeProfile | undefined = extrudeProfiles[0]): [number, number, number] | null => {
    if (!p) return null;
    if (p.kind === "bodyFace") return p.center;
    const sk = doc.features.find((f) => f.id === p.sketchId);
    if (sk?.type !== "sketch") return null;
    if (p.kind === "sketchText") {
      const ent = sk.entities.find((e) => e.id === p.textId);
      if (ent?.type !== "text") return null;
      return uvToWorld(frameOf(sk.plane, resolved.planeFrames), ent.p[0], ent.p[1]);
    }
    const region = detectSketchRegions(sk.entities).find((r) => r.id === p.regionId);
    if (!region || region.outline.length === 0) return null;
    let u = 0,
      v = 0;
    for (const pt of region.outline) {
      u += pt[0];
      v += pt[1];
    }
    const n = region.outline.length;
    return uvToWorld(frameOf(sk.plane, resolved.planeFrames), u / n, v / n);
  };

  // World unit normal of an extrude profile's plane — the direction a positive,
  // unflipped extrude travels: the profile sketch's plane normal, or the picked
  // body face's own (meshed) normal.
  const profileNormalWorld = (p: ExtrudeProfile | undefined): [number, number, number] | null => {
    if (!p) return null;
    if (p.kind === "bodyFace") return p.normal ?? null;
    const sk = doc.features.find((f) => f.id === p.sketchId);
    if (sk?.type !== "sketch") return null;
    return frameOf(sk.plane, resolved.planeFrames).normal;
  };

  // The extrude dialog's distance gizmo: an arrow at the extrusion's tip, along
  // the direction the extrude currently travels — the profile normal signed the
  // way the kernel signs it (a Remove cuts INTO the plane by default). Hidden
  // for extents where the distance is ignored (through-all / up-to-face /
  // up-to-next).
  const extrudeGizmo = useMemo((): ExtrudeGizmo | null => {
    const d = extrudeDialog;
    if (!d || (d.extent !== "blind" && d.extent !== "symmetric")) return null;
    const p = extrudeDialogProfiles[0];
    const origin = profileAnchorWorld(p);
    const n = profileNormalWorld(p);
    if (!origin || !n) return null;
    const sign = (d.mode === "remove" ? !d.flip : d.flip) ? -1 : 1;
    let dist = 0;
    try {
      const v = evaluateExpression(d.distance, resolved.scope);
      if (Number.isFinite(v)) dist = v;
    } catch {
      // Unparseable while typing — the arrow just sits at the profile.
    }
    return {
      origin,
      dir: [n[0] * sign, n[1] * sign, n[2] * sign],
      distance: dist,
      symmetric: d.extent === "symmetric",
    };
    // profileAnchorWorld/profileNormalWorld are plain closures over doc/resolved,
    // both listed below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [extrudeDialog, extrudeDialogProfiles, doc, resolved.planeFrames, resolved.scope]);

  // The gizmo's drag stream: a 1 mm-snapped distance, signed along the arrow's
  // current direction. Negative = the drag crossed the profile plane, so flip
  // the feature's direction and keep the magnitude (symmetric spans both sides
  // — there is nothing to flip, only a total). Writing into the dialog state is
  // all it takes: the ghost-preview / live-edit effects react to it exactly as
  // they do to typing in the Distance field.
  const handleExtrudeGizmoDistance = (v: number) => {
    setExtrudeDialog((d) => {
      if (!d) return d;
      if (d.extent === "symmetric") return { ...d, distance: fmt(Math.abs(v)) };
      if (v < 0) return { ...d, flip: !d.flip, distance: fmt(-v) };
      return { ...d, distance: fmt(v) };
    });
  };

  // The solid a sketch-region profile sits on (drawn on its face, or coplanar +
  // overlapping it), if any — so the extrude can default to adding onto it.
  const extrudeHostBody = (): string | null => {
    const p = extrudeProfiles[0];
    if (!p || p.kind !== "sketchRegion") return null;
    const sk = doc.features.find((f) => f.id === p.sketchId);
    if (sk?.type !== "sketch") return null;
    // Fast, exact: the sketch was drawn directly on a body face.
    if (sk.plane.kind === "face" && bodyIds.has(sk.plane.featureId)) return sk.plane.featureId;
    // Otherwise: a body whose coplanar face the region overlaps geometrically.
    const region = detectSketchRegions(sk.entities).find((r) => r.id === p.regionId);
    if (!region) return null;
    return bodyUnderRegion(frameOf(sk.plane, resolved.planeFrames), region.outline, meshes);
  };

  const openExtrudeDialog = () => {
    if (extrudeProfiles.length === 0) return;
    const first = extrudeProfiles[0];
    const world = profileAnchorWorld();
    const s = (world && viewApiRef.current?.worldToScreen(world)) || { x: 240, y: 140 };
    // Default to adding onto the host solid when the profile sits on one:
    //  - a body face -> that face's own body,
    //  - a sketch region drawn on / coplanar+overlapping a solid's face -> that solid.
    // Otherwise a new body (target = first available, for if the user switches mode).
    const addTarget =
      first.kind === "bodyFace" ? (bodyIds.has(first.featureId) ? first.featureId : null) : extrudeHostBody();
    const defaultTarget = addTarget ?? booleanCandidates[0]?.id ?? null;
    setExtrudeDialog({
      mode: addTarget ? "add" : "new",
      distance: "10",
      flip: false,
      extent: "blind",
      targetId: defaultTarget,
      upTo: null,
      x: s.x,
      y: s.y,
    });
  };

  const createExtrude = () => {
    if (extrudeDialogProfiles.length === 0 || !extrudeDialog) return;
    // Add/Remove require a target body to affect.
    if (extrudeDialog.mode !== "new" && !extrudeDialog.targetId) return;
    // Up to face requires a chosen target face.
    if (extrudeDialog.extent === "upToFace" && !extrudeDialog.upTo) return;
    const opts = {
      distance: extrudeDialog.distance,
      flip: extrudeDialog.flip,
      extent: extrudeDialog.extent,
      mode: extrudeDialog.mode,
      targetId: extrudeDialog.mode === "new" ? undefined : (extrudeDialog.targetId ?? undefined),
      upTo: extrudeDialog.extent === "upToFace" ? (extrudeDialog.upTo ?? undefined) : undefined,
    };
    // Editing: update the one feature in place with the (possibly re-picked)
    // first profile — an edit doesn't split into several features.
    if (extrudeDialog.editId) {
      const profile = extrudeDialogProfiles[0];
      let next = updateExtrude(doc, extrudeDialog.editId, profile, opts);
      if (profile.kind === "sketchRegion" || profile.kind === "sketchText") {
        next = setSuppressed(next, profile.sketchId, true);
      }
      setDoc(next);
      selectFeature(extrudeDialog.editId);
      commitEdit();
      closeExtrudeDialog();
      return;
    }
    // One Extrude feature per selected profile, sharing the dialog's settings —
    // folded into a single undo step by threading `next` through every
    // addExtrude/setSuppressed call before the one setDoc at the end.
    let next = doc;
    for (const profile of extrudeDialogProfiles) {
      const res = addExtrude(next, profile, opts);
      // Hide the source sketch once it's been consumed by an extrude. It stays
      // in place and editable — toggle the timeline eye (or edit it) to bring
      // it back.
      next =
        profile.kind === "sketchRegion" || profile.kind === "sketchText"
          ? setSuppressed(res.doc, profile.sketchId, true)
          : res.doc;
    }
    setDoc(next);
    selectFeature(null);
    closeExtrudeDialog();
  };

  // Dismiss the extrude dialog, also disarming any pending up-to-face pick.
  // cancelEdit reverts a live in-place edit (no-op after Confirm/commitEdit).
  const closeExtrudeDialog = () => {
    setExtrudeDialog(null);
    setPickingUpFace(false);
    cancelEdit();
  };

  // Live-preview an extrude edit: apply the dialog's current settings to the
  // feature as they change, so the real body updates under the dialog.
  useEffect(() => {
    const d = extrudeDialog;
    if (!d?.editId) return;
    const profile = extrudeDialogProfiles[0];
    if (!profile) return;
    const opts = {
      distance: d.distance,
      flip: d.flip,
      extent: d.extent,
      mode: d.mode,
      targetId: d.mode === "new" ? undefined : (d.targetId ?? undefined),
      upTo: d.extent === "upToFace" ? (d.upTo ?? undefined) : undefined,
    };
    if (!shouldLiveApply(JSON.stringify({ e: d.editId, profile, opts }))) return;
    setDoc((prev) => updateExtrude(prev, d.editId!, profile, opts), `edit:${d.editId}`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    extrudeDialog?.editId,
    extrudeDialog?.distance,
    extrudeDialog?.flip,
    extrudeDialog?.extent,
    extrudeDialog?.mode,
    extrudeDialog?.targetId,
    extrudeDialog?.upTo,
    extrudeDialogProfiles,
  ]);

  // Re-open the extrude dialog to edit an existing extrude in place. Seeds the
  // dialog from the feature's own profile (so it's never empty even though the
  // source sketch is suppressed); re-picking to any visible region/face/text
  // works through the normal selection.
  const editExtrude = (id: string) => {
    const f = doc.features.find((x) => x.id === id);
    if (f?.type !== "extrude") return;
    beginEdit(f);
    selectFeature(id);
    const world = profileAnchorWorld();
    const s = (world && viewApiRef.current?.worldToScreen(world)) || { x: 240, y: 140 };
    setExtrudeDialog({
      mode: f.mode,
      distance: f.distance,
      flip: f.flip,
      extent: f.extent,
      targetId: f.targetId ?? null,
      upTo: f.upTo ?? null,
      x: s.x,
      y: s.y,
      editId: id,
    });
  };

  // Live ghost preview of the extrude dialog: mirrors the main regen effect
  // above, but against a throwaway document (current doc + this draft extrude)
  // that's never assigned via `setDoc` — no undo entry, no effect on the real
  // model. Re-runs on every dialog/profile change, same as editing a committed
  // feature's params already does.
  useEffect(() => {
    if (
      !extrudeDialog ||
      // Editing shows the committed feature live (no throwaway ghost — that
      // would double the body); the create-only ghost is for new extrudes.
      extrudeDialog.editId ||
      extrudeProfiles.length === 0 ||
      (extrudeDialog.mode !== "new" && !extrudeDialog.targetId) ||
      (extrudeDialog.extent === "upToFace" && !extrudeDialog.upTo)
    ) {
      setExtrudePreview(null);
      setExtrudePreviewError(null);
      return;
    }
    const kernel = kernelRef.current;
    if (!ready || !kernel) return;
    let cancelled = false;

    // Build a throwaway doc with every selected profile extruded (mirrors
    // createExtrude), honoring the dialog's extent. Each extrude is regenerated
    // in `previewTool` mode so the kernel emits only the swept tool (the
    // changing portion) — the existing bodies are left untouched and keep their
    // own colour, so only the new material reads as cyan.
    let previewDoc = doc;
    const createdIds: string[] = [];
    for (const profile of extrudeProfiles) {
      const res = addExtrude(previewDoc, profile, {
        distance: extrudeDialog.distance,
        flip: extrudeDialog.flip,
        extent: extrudeDialog.extent,
        mode: extrudeDialog.mode,
        targetId: extrudeDialog.mode === "new" ? undefined : (extrudeDialog.targetId ?? undefined),
        upTo: extrudeDialog.extent === "upToFace" ? (extrudeDialog.upTo ?? undefined) : undefined,
      });
      previewDoc = res.doc;
      createdIds.push(res.id);
    }
    const created = new Set(createdIds);
    const previewResolved = resolveDocument(previewDoc);
    const resolveErr = createdIds.map((id) => previewResolved.errors[id]).find(Boolean);
    if (resolveErr) {
      setExtrudePreview(null);
      setExtrudePreviewError(resolveErr);
      return;
    }
    const features = previewResolved.features.map((rf) =>
      rf.type === "extrude" && created.has(rf.id) ? { ...rf, previewTool: true } : rf,
    );

    kernel
      .regenerate(features)
      .then(({ results }) => {
        if (cancelled) return;
        const previews: { bodyId: string; mesh: FeatureMesh["mesh"] }[] = [];
        let failure: string | null = null;
        for (const id of createdIds) {
          const hit = results.find((r) => r.id === id);
          if (hit?.ok) previews.push({ bodyId: id, mesh: hit.mesh });
          else if (hit && !hit.ok) failure = hit.error;
        }
        if (previews.length > 0) {
          setExtrudePreview(previews);
          setExtrudePreviewError(failure); // partial failure still surfaces
        } else {
          setExtrudePreview(null);
          setExtrudePreviewError(failure ?? "Preview failed.");
        }
      })
      .catch((err) => {
        if (cancelled) return;
        setExtrudePreview(null);
        setExtrudePreviewError(String(err?.message ?? err));
      });

    return () => {
      cancelled = true;
    };
  }, [extrudeDialog, extrudeProfiles, doc, ready]);

  // Live ghost preview of the revolve dialog: once a profile + axis are armed,
  // build a throwaway doc with that revolve (mirrors createRevolve, minus the
  // setDoc / hide-sketch), regenerate just the new body, and show it translucent.
  // Re-runs as the angle / symmetric / arming change. Debounced so dragging the
  // angle field stays responsive.
  useEffect(() => {
    if (!revolveDialog || revolveDialog.editId || !revolveDialog.profile || !revolveDialog.axis) {
      // Editing shows the committed revolve live; the create-only ghost would
      // double the body.
      setRevolvePreview(null);
      setRevolvePreviewError(null);
      return;
    }
    const kernel = kernelRef.current;
    if (!ready || !kernel) return;
    const angle = revolveDialog.mode === "full" ? "360" : revolveDialog.degrees;
    const symmetric = revolveDialog.mode === "angle" && revolveDialog.symmetric;
    let cancelled = false;
    const timer = setTimeout(() => {
      const { doc: previewDoc, id } = addRevolve(doc, revolveDialog.profile!, revolveDialog.axis!, angle, symmetric);
      const previewResolved = resolveDocument(previewDoc);
      const resolveErr = previewResolved.errors[id];
      if (resolveErr) {
        setRevolvePreview(null);
        setRevolvePreviewError(resolveErr);
        return;
      }
      kernel
        .regenerate(previewResolved.features)
        .then(({ results }) => {
          if (cancelled) return;
          const hit = results.find((r) => r.id === id);
          if (hit?.ok) {
            setRevolvePreview(hit.mesh);
            setRevolvePreviewError(null);
          } else {
            setRevolvePreview(null);
            setRevolvePreviewError(hit && !hit.ok ? hit.error : "Preview failed.");
          }
        })
        .catch((err) => {
          if (cancelled) return;
          setRevolvePreview(null);
          setRevolvePreviewError(String(err?.message ?? err));
        });
    }, 120);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [revolveDialog, doc, ready]);

  // One or more selected body edges and/or FACES, all on the same body — what a
  // chamfer or fillet would dress. Resolves each to its persistent name. A face
  // stands for all its boundary edges (the kernel expands it, where the topology
  // is); that is the practical way to round a circular rim, which is otherwise a
  // 96-chord chain you have to hit exactly with the cursor.
  const dressUpTarget = useMemo(() => {
    const edges = selection.filter((s): s is Extract<Selection, { kind: "edge" }> => s.kind === "edge");
    const faces = selection.filter((s): s is Extract<Selection, { kind: "face" }> => s.kind === "face");
    if (edges.length + faces.length === 0 || edges.length + faces.length !== selection.length) return null;
    const targetId = (edges[0] ?? faces[0]).featureId;
    if (!edges.every((e) => e.featureId === targetId) || !faces.every((f) => f.featureId === targetId)) return null;
    const m = meshes.find((x) => x.id === targetId);
    if (!m) return null;
    // Clicking a rim selects ONE of its 96 chords, but dressing it means the
    // whole curve — so store the picked edge's entire tangent chain. The kernel
    // expands a partial chain anyway and warns that it did ("re-pick the edge to
    // store it afresh"), which fired on every freshly-picked rim; that notice is
    // meant for a STORED selection gone stale after an upstream edit, not for a
    // pick made a moment ago. Storing the chain up front is exactly what it asks
    // for. `chainId` comes from the same mesh data the viewport highlights with,
    // so what gets dressed is what was lit up under the cursor.
    const wanted = expandPickToChains(
      m.mesh.edges.edgeGroups ?? [],
      edges.map((e) => e.edgeId),
    );
    const names: string[] = [];
    const edgeRefs: EdgeRef[] = [];
    for (const edgeId of wanted) {
      const nm = edgeNameOf(m.mesh.edges, edgeId);
      if (!nm) return null; // unnamed edge — can't reference it stably
      names.push(nm);
      // Geometric fingerprint stored alongside the name, so the kernel can
      // re-match the edge if an upstream edit renames it.
      const fp = edgeFingerprint(m.mesh.edges, edgeId);
      edgeRefs.push(fp ? { name: nm, mid: fp.mid, length: fp.length } : { name: nm });
    }
    const faceNames: string[] = [];
    const faceRefs: FaceRef[] = [];
    for (const f of faces) {
      const nm = faceNameOf(m.mesh.faces, f.faceId);
      if (!nm) return null; // unnamed face — same rule as edges
      faceNames.push(nm);
      faceRefs.push({
        name: nm,
        center: faceCentroid(m.mesh.faces, f.faceId) ?? undefined,
        normal: faceNormal(m.mesh.faces, f.faceId) ?? undefined,
      });
    }
    // Where the dialog pops up: by the edge actually clicked (not the chain's
    // first chord, which can be on the far side of the body), else the face.
    const anchor = edges.length
      ? edgeMidpoint(m.mesh.edges, edges[0].edgeId)
      : faceCentroid(m.mesh.faces, faces[0].faceId);
    return { targetId, edges: names, edgeRefs, faces: faceNames, faceRefs, anchor };
  }, [selection, meshes]);

  const openDressUp = (op: "chamfer" | "fillet") => {
    if (!dressUpTarget) return;
    const s = (dressUpTarget.anchor && viewApiRef.current?.worldToScreen(dressUpTarget.anchor)) || { x: 240, y: 160 };
    setDressUpError(null);
    setDressUpDialog({ op, size: "2", angle: "45", flip: false, x: s.x, y: s.y });
  };

  // Re-open the chamfer/fillet dialog to edit in place. Seeds op + size + angle
  // from the feature; its edges stay referenced (re-pick by clicking edges on
  // the body). A feature with no stored angle is a symmetric 45° chamfer.
  const editDressUp = (id: string) => {
    const f = doc.features.find((x) => x.id === id);
    if (f?.type !== "dressup") return;
    beginEdit(f);
    selectFeature(id);
    setDressUpError(null);
    setDressUpDialog({
      op: f.op,
      size: f.size,
      angle: f.angle ?? "45",
      flip: f.flip ?? false,
      x: 240,
      y: 160,
      editId: id,
    });
  };
  const closeDressUpDialog = () => {
    setDressUpDialog(null);
    setDressUpError(null);
    cancelEdit();
  };

  // Which edges/body the dialog dresses: a re-picked edge selection if present,
  // else (editing) the feature's own referenced edges.
  const dressUpDialogTarget = useMemo(() => {
    if (!dressUpDialog?.editId) return dressUpTarget;
    if (dressUpTarget) return dressUpTarget;
    const f = doc.features.find((x) => x.id === dressUpDialog.editId);
    return f?.type === "dressup"
      ? {
          targetId: f.targetId,
          edges: f.edges,
          edgeRefs: f.edgeRefs ?? [],
          faces: f.faces ?? [],
          faceRefs: f.faceRefs ?? [],
          anchor: null as [number, number, number] | null,
        }
      : null;
  }, [dressUpDialog, dressUpTarget, doc]);

  // The document-level spec the dialog's current inputs describe. Angle/flip
  // ride along for chamfers only — a fillet has no bevel to tilt.
  const dressUpSpec = (t: NonNullable<typeof dressUpDialogTarget>, d: NonNullable<typeof dressUpDialog>) => ({
    op: d.op,
    targetId: t.targetId,
    edges: t.edges,
    size: d.size,
    edgeRefs: t.edgeRefs,
    faces: t.faces,
    faceRefs: t.faceRefs,
    ...(d.op === "chamfer" ? { angle: d.angle, flip: d.flip } : {}),
  });

  // Both size and (for a chamfer) angle must resolve before anything is built.
  const validateDressUpDialog = (d: NonNullable<typeof dressUpDialog>) => {
    const sv = validateDressUpSize(d.size, resolved.scope, d.op);
    if (sv.value === null) return sv;
    if (d.op !== "chamfer") return sv;
    const av = validateDressUpAngle(d.angle, resolved.scope);
    return av.value === null ? av : sv;
  };

  // Add a new dress-up, or (editing) update the existing one in place — shared by
  // the commit and the live-validation effect so both build the same doc.
  const applyDressUp = (
    base: Document,
    t: NonNullable<typeof dressUpDialogTarget>,
    d: NonNullable<typeof dressUpDialog>,
  ) =>
    d.editId
      ? { doc: updateDressUp(base, d.editId, dressUpSpec(t, d)), id: d.editId }
      : addDressUp(
          base,
          d.op,
          t.targetId,
          t.edges,
          d.size,
          t.edgeRefs,
          d.op === "chamfer" ? d.angle : undefined,
          d.op === "chamfer" && d.flip,
          t.faces,
          t.faceRefs,
        );

  // Live-preview a chamfer/fillet edit: apply the new size/angle/edges to the
  // real feature as they change (skipping empty/invalid inputs). The existing
  // async validation effect still surfaces an unsatisfiable radius as
  // `dressUpError`.
  useEffect(() => {
    const d = dressUpDialog;
    const t = dressUpDialogTarget;
    if (!d?.editId || !t) return;
    if (validateDressUpDialog(d).value === null) return;
    const spec = dressUpSpec(t, d);
    if (!shouldLiveApply(JSON.stringify({ e: d.editId, spec }))) return;
    setDoc((prev) => updateDressUp(prev, d.editId!, spec), `edit:${d.editId}`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    dressUpDialog?.editId,
    dressUpDialog?.size,
    dressUpDialog?.angle,
    dressUpDialog?.flip,
    dressUpDialog?.op,
    dressUpDialogTarget,
  ]);

  const createDressUp = async () => {
    if (!dressUpDialogTarget || !dressUpDialog) return;
    // Synchronous gate first: an empty/garbage/≤0 size (or an out-of-range
    // chamfer angle) never reaches the kernel. Empty is silently ignored (no
    // error, just a no-op); anything invalid keeps the dialog open with its
    // message.
    const sv = validateDressUpDialog(dressUpDialog);
    if (sv.value === null) {
      setDressUpError(null);
      return;
    }
    const { doc: next, id } = applyDressUp(doc, dressUpDialogTarget, dressUpDialog);
    // Authoritative pre-commit check against the kernel: an unsatisfiable size
    // (radius too big, degenerate edge) keeps the dialog open with the error
    // rather than committing a broken feature. Runs even if the live-validation
    // effect hasn't caught up (e.g. Enter pressed immediately after typing).
    const kernel = kernelRef.current;
    if (ready && kernel) {
      const resolvedNext = resolveDocument(next);
      let err: string | null = resolvedNext.errors[id] ?? null;
      if (!err) {
        try {
          const { results } = await kernel.regenerate(resolvedNext.features);
          const hit = results.find((r) => r.id === id);
          if (hit && !hit.ok) err = hit.error;
        } catch (e) {
          err = String((e as Error)?.message ?? e);
        }
      }
      if (err) {
        setDressUpError(mapDressUpKernelError(err, dressUpDialog.op));
        return;
      }
    }
    setDoc(next);
    selectFeature(null);
    commitEdit();
    setDressUpDialog(null);
    setDressUpError(null);
  };

  // Live geometry validation AND ghost preview of the chamfer/fillet dialog. The
  // sync part of validation (empty / unparseable / ≤ 0) is done in render off the
  // raw size — instant, and never touches the kernel. This effect covers only the
  // case that NEEDS the kernel: a valid positive size that OCCT still can't build
  // (e.g. a fillet radius too large for the edges). It regenerates a throwaway doc
  // (mirrors createDressUp, minus setDoc), debounced so each keystroke on a heavy
  // body stays responsive. `dressUpError` holds only this async error.
  //
  // The same regen carries `previewDelta`, so the kernel hands back the material
  // the dress-up removes and the material it adds as extra bodies — the ghosts
  // below. Validation and preview therefore always agree, and a preview never
  // costs a second round trip.
  useEffect(() => {
    if (!dressUpDialog || !dressUpDialogTarget) {
      setDressUpError(null);
      setDressUpPreview(null);
      return;
    }
    const sv = validateDressUpDialog(dressUpDialog);
    if (sv.value === null) {
      // Empty/invalid/≤0 — surfaced synchronously in the dialog; clear any stale
      // geometry error and don't build. The stale ghost goes too: showing the
      // last good size's wedge while the field reads something else is a lie.
      setDressUpError(null);
      setDressUpPreview(null);
      return;
    }
    const kernel = kernelRef.current;
    if (!ready || !kernel) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      const { doc: next, id } = applyDressUp(doc, dressUpDialogTarget, dressUpDialog);
      const resolvedNext = resolveDocument(next);
      const resolveErr = resolvedNext.errors[id];
      if (resolveErr) {
        if (!cancelled) {
          setDressUpError(mapDressUpKernelError(resolveErr, dressUpDialog.op));
          setDressUpPreview(null);
        }
        return;
      }
      const features = resolvedNext.features.map((rf) =>
        rf.type === "dressup" && rf.id === id ? { ...rf, previewDelta: true } : rf,
      );
      kernel
        .regenerate(features)
        .then(({ results }) => {
          if (cancelled) return;
          const hit = results.find((r) => r.id === id);
          const err = hit && !hit.ok ? mapDressUpKernelError(hit.error, dressUpDialog.op) : null;
          setDressUpError(err);
          if (err) {
            setDressUpPreview(null);
            return;
          }
          const delta = (deltaId: string) => {
            const r = results.find((x) => x.id === deltaId);
            return r?.ok ? r.mesh : undefined;
          };
          const removed = delta(DRESSUP_DELTA_IDS.removed(id));
          const added = delta(DRESSUP_DELTA_IDS.added(id));
          setDressUpPreview(removed || added ? { removed, added } : null);
        })
        .catch((err) => {
          if (!cancelled) {
            setDressUpError(mapDressUpKernelError(String(err?.message ?? err), dressUpDialog.op));
            setDressUpPreview(null);
          }
        });
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dressUpDialog, dressUpDialogTarget, doc, ready, resolved.scope]);

  // The single body a Shell would hollow, resolved from the selection. Any pick
  // on a rendered body — the body, or one of its faces/edges/vertices — arms
  // that body, so the tool behaves the same however the user clicked; see
  // shellTarget.ts for why a face pick deliberately does NOT preselect that
  // face as an opening.
  const shellBody = useMemo(() => shellBodyFromSelection(selection, bodyIds), [selection, bodyIds]);

  /** A clicked body face resolved to the persistent name + geometric
   *  fingerprint a ShellFeature stores. Null for an unnamed face (nothing
   *  stable to reference). */
  const shellFaceRefAt = (featureId: string, faceId: number): FaceRef | null => {
    const m = meshes.find((x) => x.id === featureId);
    if (!m) return null;
    const name = faceNameOf(m.mesh.faces, faceId);
    if (!name) return null;
    return {
      name,
      center: faceCentroid(m.mesh.faces, faceId) ?? undefined,
      normal: faceNormal(m.mesh.faces, faceId) ?? undefined,
    };
  };

  // Open the Shell dialog. Always available: the body is armed inside the
  // dialog by clicking the viewport, exactly as Revolve arms its profile. A
  // pre-selected body still prefills the role — reaching for Shell with the
  // thing already picked is the common case and shouldn't cost a second click —
  // but nothing is required to get the dialog open.
  const openShell = () => {
    setShellError(null);
    setShellBusy(false);
    // Promote the pick to the whole body so what's highlighted matches what the
    // dialog says is armed.
    if (shellBody) selectFeature(shellBody);
    setShellDialog({
      thickness: "2",
      targetId: shellBody,
      ...NO_SHELL_FACES,
      arming: shellBody ? null : "body",
    });
  };

  // Re-open the Shell dialog to edit in place. Seeds the body, the opened
  // faces and the thickness from the feature, so the dialog shows what the
  // feature actually references rather than making the user re-pick.
  const editShell = (id: string) => {
    const f = doc.features.find((x) => x.id === id);
    if (f?.type !== "shell") return;
    beginEdit(f);
    selectFeature(id);
    setShellError(null);
    setShellDialog({
      thickness: f.thickness,
      editId: id,
      targetId: f.targetId,
      faces: f.faces,
      faceRefs: f.faceRefs ?? f.faces.map((name) => ({ name })),
      arming: null,
    });
  };
  const closeShellDialog = () => {
    const pending = shellDialog?.createdId;
    shellRunRef.current++; // a regen still in flight is no longer wanted
    setShellDialog(null);
    setShellError(null);
    setShellBusy(false);
    cancelEdit();
    // A feature this dialog added but never got to a working state goes with
    // it — cancelling a Shell should not leave a broken one behind.
    if (pending) setDoc((prev) => removeFeature(prev, pending));
  };

  // The dialog is armed once it has a body. It owns that state outright rather
  // than deriving it from the live selection, so clicking around the viewport
  // can't silently re-point a half-filled Shell at something else.
  const shellArmed = shellDialog?.targetId ? (shellDialog as ArmedShellDialog) : null;

  // Add a new shell, or (editing) update the existing one in place — shared by
  // the commit and the live-validation effect so both build the same doc.
  const applyShell = (base: Document, d: ArmedShellDialog) =>
    d.editId
      ? {
          doc: updateShell(base, d.editId, {
            targetId: d.targetId,
            faces: d.faces,
            thickness: d.thickness,
            faceRefs: d.faceRefs,
          }),
          id: d.editId,
        }
      : addShell(base, d.targetId, d.faces, d.thickness, d.faceRefs);

  // Live-preview a Shell edit: apply the new thickness/faces to the real
  // feature as they change (skipping empty/invalid thicknesses). The existing
  // async validation effect still surfaces an unsatisfiable thickness.
  useEffect(() => {
    const d = shellArmed;
    if (!d?.editId) return;
    if (validateShellThickness(d.thickness, resolved.scope).value === null) return;
    const spec = { targetId: d.targetId, faces: d.faces, thickness: d.thickness, faceRefs: d.faceRefs };
    if (!shouldLiveApply(JSON.stringify({ e: d.editId, spec }))) return;
    setDoc((prev) => updateShell(prev, d.editId!, spec), `edit:${d.editId}`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shellDialog?.editId, shellDialog?.thickness, shellDialog?.targetId, shellDialog?.faces]);

  /** How long the Shell dialog will wait for the kernel before falling back on
   *  whatever it last knew. Well past the seconds a loft's cavity takes — the
   *  agent's default of 8s would give up on exactly the geometry this is for. */
  const SHELL_REGEN_TIMEOUT_MS = 120000;
  /** Bumped whenever a Shell run is superseded (a second press, or the dialog
   *  closing), so a regen that lands late can tell it is no longer wanted. */
  const shellRunRef = useRef(0);

  /** Build the shell by COMMITTING it and reading the result off the real
   *  regeneration — no speculative rebuild, no cache.
   *
   *  This used to build the whole document a second time, in a throwaway copy,
   *  purely to ask whether the feature would survive; on a lofted body that is
   *  seconds of OCCT work paid twice, and the dialog sat there looking inert
   *  for the first half of it. The regeneration that follows `setDoc` answers
   *  the same question, so wait for THAT.
   *
   *  A feature that fails is LEFT IN THE TIMELINE, flagged with its error, and
   *  the dialog stays open on top of it. That mirrors how editing an existing
   *  shell already behaves (its live preview commits as you type), it needs no
   *  reverting — so no stray undo entries — and the failure is visible where
   *  every other feature's failure is. Cancelling removes it; pressing Create
   *  again updates it in place, which is what `createdId` is for. */
  const createShell = async () => {
    if (!shellArmed || shellBusy) return;
    // Synchronous gate first: an empty/garbage/≤0 thickness never reaches the
    // kernel. Empty is silently ignored (no error, just a no-op); anything
    // invalid keeps the dialog open with its message.
    const sv = validateShellThickness(shellArmed.thickness, resolved.scope);
    if (sv.value === null) {
      setShellError(null);
      return;
    }
    const { doc: next, id } = applyShell(doc, shellArmed);
    const run = ++shellRunRef.current;
    setShellError(null);
    setShellBusy(true);
    setDoc(next);
    // Remember what we just put in the timeline, so a retry edits it and a
    // cancel takes it away again.
    setShellDialog((p) => (p ? { ...p, editId: id, createdId: p.createdId ?? id } : p));
    const settle = await waitForRegen(SHELL_REGEN_TIMEOUT_MS);
    if (shellRunRef.current !== run) return; // superseded, or the dialog closed
    setShellBusy(false);
    const err = settle.errors[id];
    if (err) {
      setShellError(mapShellKernelError(err));
      return;
    }
    selectFeature(id);
    commitEdit();
    shellRunRef.current++;
    setShellDialog(null);
    setShellError(null);
  };

  // Drop a stale build error as soon as the dialog's spec changes: whatever the
  // kernel said applies to what was asked for then, not to what is being asked
  // for now. There is no speculative rebuild behind this any more — the error
  // comes from the real regeneration in `createShell`, which is the only place
  // the geometry is built at all.
  useEffect(() => {
    setShellError(null);
  }, [shellDialog?.targetId, shellDialog?.thickness, shellDialog?.faces]);

  // The single body a Transform would move, resolved from the selection: any
  // pick (feature / face / edge / vertex) on exactly one rendered body. In-place
  // modifiers map to the body they affect (like highlightBodyIds).
  const transformTarget = useMemo(() => {
    const ids = new Set<string>();
    for (const s of selection) {
      let id = featureIdOf(s);
      const f = doc.features.find((x) => x.id === id);
      if (f?.type === "extrude" && (f.mode === "add" || f.mode === "remove") && f.targetId) id = f.targetId;
      else if (f?.type === "dressup") id = f.targetId;
      else if (f?.type === "shell") id = f.targetId;
      else if (f?.type === "transform" && !f.copy) id = f.targetId;
      ids.add(id);
    }
    const bodies = [...ids].filter((id) => bodyIds.has(id));
    return bodies.length === 1 ? bodies[0] : null;
  }, [selection, doc, bodyIds]);

  // Mirror plane options for the dialog: the three datums + any reference planes.
  // Keys are "datum:<id>" or "plane:<id>"; parsed back to a SketchPlaneRef.
  const mirrorPlaneOptions = useMemo(
    () => [
      { key: "datum:plane-top", label: "Top" },
      { key: "datum:plane-front", label: "Front" },
      { key: "datum:plane-right", label: "Right" },
      ...userPlanes.map((p) => ({ key: `plane:${p.id}`, label: p.name })),
      { key: "face", label: "Body face…" },
    ],
    [userPlanes],
  );
  const planeKeyToRef = (key: string): SketchPlaneRef =>
    key.startsWith("plane:")
      ? { kind: "plane", planeId: key.slice(6) }
      : { kind: "datum", id: key.slice(6) as SketchPlaneId };

  // Revolve prefills from a selection of a profile + an axis line: a sketch
  // region (which must share its sketch with the axis line — the same-sketch rule
  // that made the old pair unambiguous), or a planar body face, whose axis line
  // may live in any sketch since there's no sketch of its own to match.
  const revolveInputs = useMemo(() => {
    let profile: RevolveProfile | null = null;
    let axis: { sketchId: string; entityId: string } | null = null;
    for (const s of selection) {
      if (s.kind === "sketchFace") profile = { kind: "sketchRegion", sketchId: s.sketchId, regionId: s.regionId };
      else if (s.kind === "face") {
        const m = meshes.find((x) => x.id === s.featureId);
        const center = m ? faceCentroid(m.mesh.faces, s.faceId) : null;
        const normal = m ? faceNormal(m.mesh.faces, s.faceId) : null;
        if (center && normal) {
          profile = {
            kind: "bodyFace",
            featureId: s.featureId,
            faceId: s.faceId,
            faceName: m ? faceNameOf(m.mesh.faces, s.faceId) : undefined,
            center,
            normal,
          };
        }
      } else if (s.kind === "sketchEntity") {
        const sk = doc.features.find((f) => f.id === s.sketchId);
        const e = sk?.type === "sketch" ? sk.entities.find((x) => x.id === s.entityId) : undefined;
        if (e?.type === "line") axis = { sketchId: s.sketchId, entityId: s.entityId };
      }
    }
    if (!profile || !axis) return null;
    if (profile.kind === "sketchRegion" && profile.sketchId !== axis.sketchId) return null;
    return { profile, axis };
  }, [selection, doc, meshes]);

  // Open the Revolve dialog. Always available: profile + axis are armed inside
  // the dialog by clicking the viewport. If a profile region + axis line happen
  // to be pre-selected, they prefill the roles; otherwise the profile role is
  // armed and waiting for the first click.
  const openRevolve = () => {
    const pre = revolveInputs;
    const world = profileAnchorWorld();
    const s = (world && viewApiRef.current?.worldToScreen(world)) || { x: 240, y: 140 };
    setRevolveDialog({
      profile: pre?.profile ?? null,
      axis: pre?.axis ?? null,
      armed: pre ? null : "profile",
      mode: "full",
      degrees: "90",
      symmetric: false,
      x: s.x,
      y: s.y,
    });
  };

  const closeRevolveDialog = () => {
    setRevolveDialog(null);
    // Drop any in-flight "pick a plane for the axis" mode the dialog armed.
    if (pickPurpose === "revolveAxis") {
      setPicking(false);
      setPickPurpose("sketch");
    }
    cancelEdit();
  };

  // Live-preview a revolve edit.
  useEffect(() => {
    const d = revolveDialog;
    if (!d?.editId || !d.profile || !d.axis) return;
    const angle = d.mode === "full" ? "360" : d.degrees;
    const symmetric = d.mode === "angle" && d.symmetric;
    if (!shouldLiveApply(JSON.stringify({ e: d.editId, p: d.profile, a: d.axis, angle, symmetric }))) return;
    setDoc((prev) => updateRevolve(prev, d.editId!, d.profile!, d.axis!, angle, symmetric), `edit:${d.editId}`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    revolveDialog?.editId,
    revolveDialog?.profile,
    revolveDialog?.axis,
    revolveDialog?.mode,
    revolveDialog?.degrees,
    revolveDialog?.symmetric,
  ]);

  const createRevolve = () => {
    if (!revolveDialog || !revolveDialog.profile || !revolveDialog.axis) return;
    // Full revolve = 360°; symmetric is meaningless there, so force it off.
    const angle = revolveDialog.mode === "full" ? "360" : revolveDialog.degrees;
    const symmetric = revolveDialog.mode === "angle" && revolveDialog.symmetric;
    // Hide the originating sketch once it's been consumed (like extrude does).
    // A body-face profile has no sketch to hide — the face stays part of its body.
    const prof = revolveDialog.profile;
    const hideSource = (d: Document) => (prof.kind === "sketchRegion" ? setSuppressed(d, prof.sketchId, true) : d);
    if (revolveDialog.editId) {
      const next = hideSource(updateRevolve(doc, revolveDialog.editId, prof, revolveDialog.axis, angle, symmetric));
      setDoc(next);
      selectFeature(revolveDialog.editId);
      commitEdit();
      closeRevolveDialog();
      return;
    }
    const { doc: created } = addRevolve(doc, prof, revolveDialog.axis, angle, symmetric);
    const next = hideSource(created);
    setDoc(next);
    selectFeature(null);
    closeRevolveDialog();
  };

  // Re-open the revolve dialog to edit in place, seeded from the feature.
  const editRevolve = (id: string) => {
    const f = doc.features.find((x) => x.id === id);
    if (f?.type !== "revolve") return;
    beginEdit(f);
    selectFeature(id);
    const full = f.angle === "360";
    const world = profileAnchorWorld();
    const s = (world && viewApiRef.current?.worldToScreen(world)) || { x: 240, y: 140 };
    setRevolveDialog({
      profile: f.profile,
      axis: f.axis,
      armed: null,
      mode: full ? "full" : "angle",
      degrees: full ? "90" : f.angle,
      symmetric: f.symmetric,
      x: s.x,
      y: s.y,
      editId: id,
    });
  };

  // Sweep needs a profile region + a path entity (line / arc / spline). They may
  // be in different sketches (e.g. a circle on Top swept along a spline on Front).
  const sweepInputs = useMemo(() => {
    let profile: { sketchId: string; regionId: string } | null = null;
    let path: { sketchId: string; entityId: string } | null = null;
    for (const s of selection) {
      if (s.kind === "sketchFace") profile = { sketchId: s.sketchId, regionId: s.regionId };
      else if (s.kind === "sketchEntity") {
        const sk = doc.features.find((f) => f.id === s.sketchId);
        const e = sk?.type === "sketch" ? sk.entities.find((x) => x.id === s.entityId) : undefined;
        if (e && (e.type === "line" || e.type === "arc" || e.type === "spline")) {
          path = { sketchId: s.sketchId, entityId: s.entityId };
        }
      }
    }
    return profile && path ? { profile, path } : null;
  }, [selection, doc]);

  const openSweep = () => {
    if (!sweepInputs) return;
    const { doc: next } = addSweep(doc, sweepInputs.profile, sweepInputs.path);
    setDoc(next);
    selectFeature(null);
  };

  // Loft needs ≥2 selected regions (sketch faces). Ordered by their sketch's
  // timeline position so the loft direction is predictable (not selection order).
  const loftInputs = useMemo(() => {
    const faces = selection.filter((s): s is Extract<Selection, { kind: "sketchFace" }> => s.kind === "sketchFace");
    if (faces.length < 2 || faces.length !== selection.length) return null;
    const idx = (sketchId: string) => doc.features.findIndex((f) => f.id === sketchId);
    return [...faces]
      .sort((a, b) => idx(a.sketchId) - idx(b.sketchId))
      .map((s) => ({ sketchId: s.sketchId, regionId: s.regionId }));
  }, [selection, doc]);

  // Global keyboard shortcuts. The modeling toolbar and the sketch toolbar are
  // mutually exclusive (one is only usable while NOT editing a sketch, the
  // other only while editing one), so some letters are intentionally reused
  // across the two branches below — see KEYBOARD_SHORTCUTS.md.
  useEffect(() => {
    const SKETCH_KEYS: Record<string, SketchTool> = {
      s: "select", // S = Select (the sketch-mode pointer; modeling-mode S = Sketch)
      l: "line",
      r: "rect-corner",
      c: "circle-center",
      p: "polygon",
      a: "arc-3p",
      o: "offset",
      m: "mirror", // M = sketch Mirror (modeling-mode M = body Mirror feature)
      u: "project", // U = "Use" (Project/Convert existing geometry into the sketch)
      t: "text", // T = Text (sketch-mode only; modeling-mode T = Transform)
      x: "pattern-linear", // X = linear pattern (Shift+X = circular)
    };
    // Shift-modified variants of an existing tool key (Shift+R/Shift+C/Shift+S).
    const SKETCH_SHIFT_KEYS: Record<string, SketchTool> = {
      r: "rect-center",
      c: "circle-3p",
      s: "spline", // Shift+S = Spline (bare S now selects the Select tool)
      x: "pattern-circular",
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (offsetSessionRef.current) {
          setOffsetSession(null);
          setSketchToolState("select");
        } else if (mirrorSessionRef.current) {
          setMirrorSession(null);
          setSelection([]);
          setSketchToolState("select");
        } else if (patternSessionRef.current) {
          setPatternSession(null);
          setSelection([]);
          setSketchToolState("select");
        } else if (projectSessionRef.current) {
          setProjectSession(null);
          setSketchToolState("select");
        } else if (textDraftRef.current) setTextDraft(null);
        else if (dimInputRef.current) setDimInput(null);
        else if (dimPendingRef.current) setDimPending(false);
        else if (polySidesOpen) setPolySidesOpen(false);
        else if (planeDialog) closePlaneDialog();
        // While the revolve dialog is arming a plane axis, Esc cancels just that
        // pick (keeping the dialog); a second Esc then closes the dialog.
        else if (revolveDialog && picking) {
          setPicking(false);
          setPickPurpose("sketch");
        } else if (revolveDialog) closeRevolveDialog();
        // Mirror dialog: like Revolve, Esc first cancels an in-progress face
        // pick (keeping the dialog), then a second Esc closes the dialog.
        else if (mirrorDialog && pickingMirrorFace) setPickingMirrorFace(false);
        else if (mirrorDialog) closeMirror();
        // Pattern dialog: Esc first cancels an in-progress direction/axis pick
        // (keeping the dialog), then a second Esc closes the dialog.
        else if (patternDialog && picking) {
          setPicking(false);
          setPickPurpose("sketch");
        } else if (patternDialog) closePattern();
        // Shell dialog: Esc first disarms an in-progress body/face pick (keeping
        // the dialog and everything picked so far), then a second Esc closes it.
        else if (shellDialog?.arming) setShellDialog((d) => (d ? { ...d, arming: null } : d));
        else if (shellDialog) closeShellDialog();
        else if (transformEditId) cancelTransform();
        else if (transformArming) cancelTransformArming();
        else if (editParamsId) setEditParamsId(null);
        else if (picking) setPicking(false);
        // Esc finishes an in-progress draft: the spline commits its accumulated
        // points (like ending a polyline); every other tool just abandons the
        // draft. finishSpline() returns false unless the spline tool has ≥2
        // points, so non-spline drafts fall through to setDraft([]).
        else if (draft.length > 0) {
          if (!finishSpline()) setDraft([]);
        } else if (editingSketchId) finishSketch();
        return;
      }
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      // "?" toggles the keyboard-shortcut hints appended to toolbar labels.
      if (e.key === "?") {
        e.preventDefault();
        toggleShortcuts();
        return;
      }
      // "/" opens (or closes) the More flyout of whichever toolbar is live, so
      // every tool — including the ones that didn't fit — is a search away.
      if (e.key === "/") {
        e.preventDefault();
        if (editingSketchId) setSketchMoreRequest((n) => n + 1);
        else setModelMoreRequest((n) => n + 1);
        return;
      }
      // Enter commits the in-progress sketch Mirror (its previews → real entities).
      if (e.key === "Enter" && mirrorSessionRef.current) {
        e.preventDefault();
        commitMirrorRef.current();
        return;
      }
      // Enter commits the in-progress Project/Convert previews.
      if (e.key === "Enter" && projectSessionRef.current) {
        e.preventDefault();
        commitProjectRef.current();
        return;
      }
      // Enter commits the in-progress sketch Pattern as a DerivedOp.
      if (e.key === "Enter" && patternSessionRef.current) {
        e.preventDefault();
        commitPatternRef.current();
        return;
      }
      if ((e.key === "Delete" || e.key === "Backspace") && selection.length > 0) {
        e.preventDefault();
        handleDeleteSelection();
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "i") {
        e.preventDefault();
        importInputRef.current?.click();
        return;
      }
      if (e.metaKey || e.ctrlKey) return; // leave other OS/browser chords alone

      // Standard views: the on-canvas gizmo covers these by click, but digits
      // 1-7 remain a keyboard shortcut in both modeling and sketch mode —
      // letters were deliberately avoided here (they'd collide with
      // modeling-toolbar actions live in the same context: T-op/T-ransform,
      // F-ront/F-illet...).
      if (/^[1-7]$/.test(e.key)) {
        const v = VIEW_KEYS[Number(e.key) - 1];
        if (v) viewApiRef.current?.setView(v);
        return;
      }

      const key = e.key.toLowerCase();

      if (editingSketchId) {
        // ---- Sketch toolbar ----
        // D dimensions the selected line (the standard dimension shortcut).
        // preventDefault so the keystroke can't leak into the input that
        // opening the dialog autofocuses synchronously.
        if (key === "d") {
          e.preventDefault();
          startDimensionRef.current();
          return;
        }
        // preventDefault on the tool keys too: tools like Offset/Text open an
        // input that autofocuses synchronously, and without this the same
        // keystroke leaks into that input (e.g. "o" → offset distance "o",
        // which used to throw in the expression parser and crash the app).
        if (e.shiftKey && SKETCH_SHIFT_KEYS[key]) {
          e.preventDefault();
          setSketchTool(SKETCH_SHIFT_KEYS[key]);
          return;
        }
        if (!e.shiftKey && SKETCH_KEYS[key]) {
          e.preventDefault();
          setSketchTool(SKETCH_KEYS[key]);
          return;
        }
        if (!e.shiftKey && key === "q") {
          toggleConstruction();
          return;
        }
        if (!e.shiftKey && key === "n" && twoSelectedLines) {
          addGeoConstraint("perpendicular", twoSelectedLines[0].id, twoSelectedLines[1].id);
          return;
        }
        if (!e.shiftKey && key === "h" && oneSelectedLine) {
          addHVConstraint("horizontal", oneSelectedLine.id);
          return;
        }
        if (!e.shiftKey && key === "v" && oneSelectedLine) {
          addHVConstraint("vertical", oneSelectedLine.id);
          return;
        }
        if (e.shiftKey && key === "p" && twoSelectedLines) {
          addGeoConstraint("parallel", twoSelectedLines[0].id, twoSelectedLines[1].id);
          return;
        }
        if (e.key === "=") {
          const pair = twoSelectedLines ?? twoRadiusEntities;
          if (pair) addGeoConstraint("equal", pair[0].id, pair[1].id);
        }
        return;
      }

      // ---- Modeling toolbar ----
      // Home: iso view zoomed to fit all bodies + visible sketches. (This key
      // used to Hide/suppress the selected feature — that now lives only on the
      // timeline's per-feature eye toggle.)
      if (key === "h") {
        viewApiRef.current?.homeView();
        return;
      }
      if (e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown") && primaryFeatureId) {
        e.preventDefault();
        setDoc(moveFeature(doc, primaryFeatureId, e.key === "ArrowUp" ? -1 : 1));
        return;
      }
      if (key === "n") {
        // New Body ignores `picking`, matching the toolbar button itself.
        setNewSolidOpen((o) => !o);
        return;
      }
      if (picking) return;
      // preventDefault before acting: several cases below (e/c/f) synchronously
      // mount a dialog with an autoFocus text input, and without this the same
      // keystroke leaks into that input right after it mounts (e.g. "e" turning
      // the Extrude distance default "10" into "10e").
      e.preventDefault();
      switch (key) {
        case "s":
          setPickPurpose("sketch");
          setPicking(true);
          break;
        case "p":
          openPlaneDialog();
          break;
        case "e":
          if (extrudeProfiles.length > 0 && !extrudeDialog) openExtrudeDialog();
          break;
        case "r":
          if (!revolveDialog) openRevolve();
          break;
        case "w":
          if (sweepInputs) openSweep();
          break;
        case "l":
          if (loftInputs) openLoft();
          break;
        case "c":
          if (dressUpTarget) openDressUp("chamfer");
          break;
        case "f":
          if (dressUpTarget) openDressUp("fillet");
          break;
        case "g":
          if (!shellDialog) openShell();
          break;
        case "b":
          if (bodyIds.size >= 2) openBooleanDialog();
          break;
        case "t":
          if (!transformEditId && !transformArming) openTransform();
          break;
        case "m":
          if (transformTarget) openMirror();
          break;
        case "x":
          if (!patternDialog) openPattern();
          break;
        default:
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    undo,
    redo,
    picking,
    planeDialog,
    transformEditId,
    draft,
    editingSketchId,
    selection,
    doc,
    sketchTool,
    constructionMode,
    extrudeProfiles,
    extrudeDialog,
    revolveInputs,
    revolveDialog,
    mirrorDialog,
    pickingMirrorFace,
    patternDialog,
    sweepInputs,
    loftInputs,
    dressUpTarget,
    shellBody,
    // The dialog itself, not just `shellBody`: arming a face pick returns early
    // from handlePick without touching the selection, so nothing else in this
    // list changes and Esc would run against a closure that still thought
    // nothing was armed — closing the whole dialog instead of disarming.
    shellDialog,
    bodyIds,
    transformTarget,
    twoSelectedLines,
    twoRadiusEntities,
    oneSelectedLine,
    primaryFeatureId,
    polySidesOpen,
    editParamsId,
  ]);

  const openLoft = () => {
    if (!loftInputs) return;
    const { doc: next } = addLoft(doc, loftInputs);
    setDoc(next);
    selectFeature(null);
  };

  const openMirror = () => {
    if (!transformTarget) return;
    setMirrorDialog({ targetId: transformTarget, plane: "datum:plane-front", faceRef: null });
  };
  const closeMirror = () => {
    setMirrorDialog(null);
    setPickingMirrorFace(false);
    cancelEdit();
  };
  // Live-preview a mirror edit as the plane choice changes.
  useEffect(() => {
    const d = mirrorDialog;
    if (!d?.editId) return;
    const ref: SketchPlaneRef | null =
      d.plane === "face"
        ? d.faceRef
          ? { kind: "face", featureId: d.faceRef.featureId, frame: d.faceRef.frame }
          : null
        : planeKeyToRef(d.plane);
    if (!ref) return;
    if (!shouldLiveApply(JSON.stringify({ e: d.editId, t: d.targetId, ref }))) return;
    setDoc((prev) => updateMirror(prev, d.editId!, d.targetId, ref), `edit:${d.editId}`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mirrorDialog?.editId, mirrorDialog?.plane, mirrorDialog?.faceRef, mirrorDialog?.targetId]);
  const createMirror = () => {
    if (!mirrorDialog) return;
    const ref: SketchPlaneRef | null =
      mirrorDialog.plane === "face"
        ? mirrorDialog.faceRef
          ? { kind: "face", featureId: mirrorDialog.faceRef.featureId, frame: mirrorDialog.faceRef.frame }
          : null
        : planeKeyToRef(mirrorDialog.plane);
    if (!ref) return; // a face plane was chosen but none picked yet
    if (mirrorDialog.editId) {
      setDoc(updateMirror(doc, mirrorDialog.editId, mirrorDialog.targetId, ref));
      selectFeature(mirrorDialog.editId);
      commitEdit();
      closeMirror();
      return;
    }
    const { doc: next } = addMirror(doc, mirrorDialog.targetId, ref);
    setDoc(next);
    closeMirror();
    selectFeature(null);
  };

  // Re-open the Mirror dialog to edit an existing mirror in place. The mirror
  // plane seeds back to its dialog key (datum / reference plane / picked face).
  const editMirror = (id: string) => {
    const f = doc.features.find((x) => x.id === id);
    if (f?.type !== "mirror") return;
    beginEdit(f);
    selectFeature(id);
    const planeKey =
      f.plane.kind === "datum" ? `datum:${f.plane.id}` : f.plane.kind === "plane" ? `plane:${f.plane.planeId}` : "face";
    const faceRef = f.plane.kind === "face" ? { featureId: f.plane.featureId, frame: f.plane.frame } : null;
    setMirrorDialog({ targetId: f.targetId, plane: planeKey, faceRef, editId: id });
  };

  // Open the Pattern dialog. Always available: like Revolve, a body is armed
  // inside the dialog by clicking one in the viewport. If a single body
  // happens to be pre-selected it prefills the target; otherwise the target
  // role is armed and waiting for the first click.
  const openPattern = () => {
    setPatternDialog({
      kind: "linear",
      targetId: transformTarget,
      dir1: { world: "x" },
      count1: "3",
      spacing1: "25",
      flip1: false,
      dir2on: false,
      dir2: null,
      count2: "2",
      spacing2: "25",
      flip2: false,
      axis: null,
      count: "6",
      mode: "full",
      angle: "90",
      symmetric: false,
      arming: transformTarget ? null : "target",
    });
  };
  const closePattern = () => {
    setPatternDialog(null);
    if (pickPurpose === "patternAxis" || pickPurpose === "patternDir") {
      setPicking(false);
      setPickPurpose("sketch");
    }
    cancelEdit();
  };
  // The PatternFeature fields the dialog currently describes (shared by commit
  // and live-preview so they can't drift).
  const patternFieldsOf = (d: NonNullable<typeof patternDialog>) =>
    d.kind === "linear"
      ? {
          kind: "linear" as const,
          dir1: d.dir1,
          count1: d.count1,
          spacing1: d.spacing1,
          flip1: d.flip1,
          ...(d.dir2on && d.dir2 ? { dir2: d.dir2, count2: d.count2, spacing2: d.spacing2, flip2: d.flip2 } : {}),
        }
      : {
          kind: "circular" as const,
          axis: d.axis!,
          count: d.count,
          angle: d.mode === "full" ? "360" : d.angle,
          symmetric: d.mode === "angle" && d.symmetric,
        };
  // Live-preview a pattern edit (skips while the dialog is in an invalid state).
  useEffect(() => {
    const d = patternDialog;
    if (!d?.editId || !d.targetId || patternDialogWarning) return;
    if (d.kind === "circular" && !d.axis) return;
    const fields = patternFieldsOf(d);
    if (!shouldLiveApply(JSON.stringify({ e: d.editId, t: d.targetId, fields }))) return;
    setDoc((prev) => updatePattern(prev, d.editId!, d.targetId!, fields), `edit:${d.editId}`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [patternDialog, patternDialogWarning]);
  // Arm the shared axis-pick stream to fill one of the dialog's reference slots.
  const armPatternPick = (slot: "dir1" | "dir2" | "axis") => {
    setPatternDialog((d) => (d ? { ...d, arming: slot } : d));
    setPickPurpose(slot === "axis" ? "patternAxis" : "patternDir");
    setPicking(true);
  };
  const createPattern = () => {
    const d = patternDialog;
    if (!d || !d.targetId || patternDialogWarning) return;
    if (d.kind === "circular" && !d.axis) return;
    const fields = patternFieldsOf(d);
    if (d.editId) {
      setDoc(updatePattern(doc, d.editId, d.targetId, fields));
      selectFeature(d.editId);
      commitEdit();
      closePattern();
      return;
    }
    const { doc: next } = addPattern(doc, d.targetId, fields);
    setDoc(next);
    closePattern();
    selectFeature(null);
  };

  // Re-open the Pattern dialog to edit an existing pattern in place. Seeds every
  // field from the feature; refs (dir/axis) re-pick through the same axis stream.
  const editPattern = (id: string) => {
    const f = doc.features.find((x) => x.id === id);
    if (f?.type !== "pattern") return;
    beginEdit(f);
    selectFeature(id);
    const full = (f.angle ?? "360") === "360";
    setPatternDialog({
      kind: f.kind,
      targetId: f.targetId,
      dir1: f.dir1 ?? { world: "x" },
      count1: f.count1 ?? "3",
      spacing1: f.spacing1 ?? "25",
      flip1: f.flip1 ?? false,
      dir2on: !!f.dir2,
      dir2: f.dir2 ?? null,
      count2: f.count2 ?? "2",
      spacing2: f.spacing2 ?? "25",
      flip2: f.flip2 ?? false,
      axis: f.axis ?? null,
      count: f.count ?? "6",
      mode: full ? "full" : "angle",
      angle: full ? "90" : (f.angle ?? "90"),
      symmetric: f.symmetric ?? false,
      arming: null,
      editId: id,
    });
  };

  // An expression resolved to a number for geometry maths; unparseable (or
  // mid-typing) reads as 0, the same way the gizmo's own resolver treats it.
  const numOrZero = (expr: string) => {
    try {
      const v = evaluateExpression(expr, resolved.scope);
      return Number.isFinite(v) ? v : 0;
    } catch {
      return 0;
    }
  };

  // Where the Transform panel opens: beside the gizmo rather than over it. The
  // gizmo is drawn at the body's pivot and TransformControls sizes its arrows as
  // a constant fraction of the viewport height, so it claims a wide disc around
  // that point — parked at top-centre (where the panel used to live) it sat on
  // the handles of anything near the middle of the view. Pick whichever side of
  // the gizmo has room for the panel, preferring the left; the drag handle still
  // lets the user move it anywhere afterwards.
  const transformPanelPos = (pivot: [number, number, number]) => {
    // .extrude-dialog: 190px of content + 10px padding + 1px border a side.
    const PANEL_W = 212;
    const el = viewportElRef.current;
    const g = viewApiRef.current?.worldToScreen(pivot);
    const vw = el?.clientWidth ?? 0;
    const vh = el?.clientHeight ?? 0;
    // Fallback: the old top-centre anchor, minus the panel's half width.
    if (!g || vw === 0) return { x: Math.max(12, vw / 2 - PANEL_W / 2), y: 64 };
    const radius = Math.min(0.3 * vh, 260); // the gizmo's on-screen reach, generously
    const left = g.x - radius - 12 - PANEL_W;
    const right = g.x + radius + 12;
    const x = left >= 12 ? left : right + PANEL_W <= vw - 12 ? right : left >= vw - right ? 12 : vw - PANEL_W - 12;
    return { x: Math.max(12, Math.min(x, Math.max(12, vw - PANEL_W - 12))), y: 64 };
  };

  // Create a Transform on `targetId` and open the gizmo directly on `mode`.
  const openTransformOn = (targetId: string, mode: TransformMode) => {
    const m = rawMeshes.find((x) => x.id === targetId);
    const pivot = m ? bodyCenter(m.mesh.faces) : ([0, 0, 0] as [number, number, number]);
    const { doc: next, id } = addTransform(doc, targetId, pivot);
    setDoc(next);
    selectFeature(null);
    setTransformMode(mode);
    setTransformEditId(id);
    setTransformPanelXY(transformPanelPos(pivot));
    setTransformOrigin({ created: true });
    setTransformArming(null);
  };

  // Entry point for the toolbar button, the "T" shortcut, and the Move /
  // Rotate / Scale search rows: with an unambiguous single-body target it
  // creates+opens the Transform immediately on `mode`; otherwise (nothing
  // selected, or a selection spanning more than one body) it clears the
  // selection and arms a body pick for that mode instead — like Pattern's
  // target arming, this doesn't touch `picking`/`pickPurpose` (those drive
  // the separate axis/direction pick stream); the click-router branch above
  // matches on `transformArming` directly.
  const openTransform = (mode: TransformMode = "translate") => {
    if (transformTarget) {
      openTransformOn(transformTarget, mode);
      return;
    }
    setSelection([]);
    setTransformArming({ mode });
  };

  // Cancel an in-progress Transform arming (Esc, or the arming panel's own
  // Cancel button) without creating a feature.
  const cancelTransformArming = () => setTransformArming(null);

  // Re-open the gizmo for an existing Transform (from the parameter editor).
  // Snapshot its current values so Cancel can revert this edit (vs. delete).
  const editTransform = (id: string) => {
    const f = doc.features.find((x) => x.id === id);
    if (f?.type !== "transform") return;
    selectFeature(id);
    setTransformMode("translate");
    setTransformEditId(id);
    // Re-opening: the gizmo sits at the pivot PLUS the translation already
    // applied, which is where it will be drawn.
    setTransformPanelXY(
      transformPanelPos([f.pivot[0] + numOrZero(f.tx), f.pivot[1] + numOrZero(f.ty), f.pivot[2] + numOrZero(f.tz)]),
    );
    setTransformOrigin({
      created: false,
      snapshot: { tx: f.tx, ty: f.ty, tz: f.tz, angle: f.angle, axis: f.axis, scale: f.scale, copy: f.copy },
    });
  };

  // The live gizmo state: resolve the editing transform's expressions to numbers
  // (the gizmo is numeric) while leaving the document's expression strings intact.
  const transformEdit = useMemo<TransformEdit | null>(() => {
    if (!transformEditId) return null;
    const f = doc.features.find((x) => x.id === transformEditId);
    if (f?.type !== "transform") return null;
    const num = (s: string) => {
      try {
        const v = evaluateExpression(s, resolved.scope);
        return Number.isFinite(v) ? v : 0;
      } catch {
        return 0;
      }
    };
    return {
      featureId: f.id,
      // The body the gizmo visibly moves: a copy is its own body (keyed by the
      // feature); a move-in-place keeps the source body's id.
      bodyId: f.copy ? f.id : f.targetId,
      pivot: f.pivot,
      tx: num(f.tx),
      ty: num(f.ty),
      tz: num(f.tz),
      angle: num(f.angle),
      axis: f.axis,
      // A half-typed / non-positive factor would collapse the gizmo's proxy;
      // fall back to 1 until the field resolves to something buildable.
      scale: num(f.scale) > 0 ? num(f.scale) : 1,
    };
  }, [transformEditId, doc, resolved.scope]);

  // The transform feature being edited (drives the floating panel's fields).
  const editingTransform = useMemo(
    () => doc.features.find((f) => f.id === transformEditId && f.type === "transform") as TransformFeature | undefined,
    [doc, transformEditId],
  );

  // A gizmo drag commits ONCE, on release: write the final numeric values back as
  // the feature's expressions (one regenerate for the whole drag). During the drag
  // the body is moved locally in the viewport, so the kernel never sees the
  // intermediate frames — the fix for "stuck regenerating" in a many-solid doc.
  const handleTransformInput = (d: { tx: number; ty: number; tz: number; angle: number; scale: number }) => {
    if (!transformEditId) return;
    if (![d.tx, d.ty, d.tz, d.angle, d.scale].every(Number.isFinite)) return; // see handleTransformPreview
    setLiveTransform(null); // commit supersedes the live readout
    setDoc(
      setTransform(doc, transformEditId, {
        tx: fmt(d.tx),
        ty: fmt(d.ty),
        tz: fmt(d.tz),
        angle: fmt(d.angle),
        scale: fmt(d.scale),
      }),
      `transform:${transformEditId}`,
    );
  };

  // Per-frame readout while dragging — drives the floating panel's numbers only,
  // never the document, so it can't trigger a regenerate. A frame carrying a
  // non-finite number is dropped rather than shown: `fmt` would render it into
  // the field as the text "NaN"/"Infinity", and the same value on release would
  // be committed as an expression that can't be evaluated. Holding the last good
  // readout instead makes a degenerate frame invisible. (The gizmo guards this at
  // source too — see proxyDelta — this is the backstop for every field.)
  const handleTransformPreview = (d: { tx: number; ty: number; tz: number; angle: number; scale: number }) => {
    if (![d.tx, d.ty, d.tz, d.angle, d.scale].every(Number.isFinite)) return;
    setLiveTransform(d);
  };

  // Close the gizmo, keeping the Transform feature as-is.
  const finishTransform = () => {
    setTransformEditId(null);
    setTransformOrigin(null);
    setTransformPanelXY(null);
    setLiveTransform(null);
  };

  // Cancel (panel Cancel / Esc): a just-created transform is dropped entirely;
  // an existing one being re-edited reverts to its pre-edit snapshot.
  const cancelTransform = () => {
    if (transformEditId) {
      if (transformOrigin && !transformOrigin.created) {
        setDoc(setTransform(doc, transformEditId, transformOrigin.snapshot));
      } else {
        setDoc(removeFeature(doc, transformEditId));
        setSelection((prev) => prev.filter((s) => featureIdOf(s) !== transformEditId));
      }
    }
    setTransformEditId(null);
    setTransformOrigin(null);
    setTransformPanelXY(null);
    setLiveTransform(null);
  };

  // All visible sketches (so finished sketches stay rendered), each with its frame.
  const renderSketches = useMemo(
    () =>
      doc.features
        .slice(0, doc.rollbackIndex)
        // Hidden (suppressed) sketches aren't drawn — except the one being
        // actively edited, so editing a post-extrude hidden sketch still shows it,
        // and every sketch while Revolve waits for a profile: consuming a sketch
        // hides it, so otherwise the regions you're being asked to click aren't
        // on screen at all.
        .filter(
          (f): f is SketchFeature =>
            f.type === "sketch" && (!f.suppressed || f.id === editingSketchId || armingRevolveProfile),
        )
        // Reflow expression-driven coordinates so the on-canvas sketch tracks its
        // variables, matching the solids built from it.
        .map((f) => applyEntityExprs(f, resolved.scope))
        // A sketch whose plane no longer resolves (its reference plane was
        // suppressed or deleted) simply isn't drawn — frameOf would throw, and a
        // throw here takes the whole app down.
        .filter((f) => planeResolves(f.plane, resolved.planeFrames))
        .map((f) => ({
          id: f.id,
          frame: frameOf(f.plane, resolved.planeFrames),
          entities: f.entities,
          regions: detectSketchRegions(f.entities),
        })),
    [doc, editingSketchId, armingRevolveProfile, resolved.planeFrames, resolved.scope],
  );

  // Live dashed preview of the in-progress offset, rebuilt as the distance
  // changes. Marked construction so it routes to the dashed overlay for free.
  const offsetPreview = useMemo<SketchEntity[]>(() => {
    if (!offsetSession) return [];
    try {
      // The eval is INSIDE the try: a partially-typed / non-numeric distance
      // (e.g. "1+" or "o") throws in the parser — that must yield no preview,
      // never crash the render.
      const d = evaluateExpression(offsetSession.value, resolved.scope);
      if (!Number.isFinite(d) || Math.abs(d) < 1e-9) return [];
      return offsetChain(offsetSession.chain, d).map((p, i) => offsetPrimToEntity(p, true, `__offsetpv${i}`));
    } catch {
      return [];
    }
  }, [offsetSession, resolved.scope]);

  // Live dashed preview of the in-progress sketch Pattern: every copy the
  // committed op would generate, recomputed as sources/count/step/center change.
  // Uses the same helpers as applyDerived so preview and commit can't disagree.
  const patternPreview = useMemo<SketchEntity[]>(() => {
    if (!patternSession || !editingSketch) return [];
    const s = patternSession;
    try {
      const byId = new Map(editingSketch.entities.filter((e) => !e.derivedFrom).map((e) => [e.id, e] as const));
      const out: SketchEntity[] = [];
      const count = resolvePatternCount(s.count, resolved.scope);
      if (s.kind === "linear") {
        if (count === null) return [];
        const dx = evaluateExpression(s.dx, resolved.scope);
        const dy = evaluateExpression(s.dy, resolved.scope);
        if (!Number.isFinite(dx) || !Number.isFinite(dy) || Math.hypot(dx, dy) < 1e-9) return [];
        s.sourceIds.forEach((sid, j) => {
          const src = byId.get(sid);
          if (!src) return;
          for (let i = 1; i < count; i++) out.push(translateEntity(src, dx * i, dy * i, `__patpv${j}:${i}`));
        });
        return out;
      }
      const center = s.center ? resolvePatternCenter(s.center, byId) : null;
      if (!center) return [];
      // Mark the armed center so it reads before any sources are clicked.
      out.push({ type: "point", id: "__patpv_center", p: center });
      if (count !== null) {
        const totalDeg = s.mode === "full" ? 360 : evaluateExpression(s.angle, resolved.scope);
        if (Number.isFinite(totalDeg) && Math.abs(totalDeg) > 1e-9) {
          const angles = circularPatternAngles(count, totalDeg, s.mode === "angle" && s.symmetric);
          s.sourceIds.forEach((sid, j) => {
            const src = byId.get(sid);
            if (!src) return;
            angles.forEach((a, i) => out.push(rotateEntity(src, center, a, `__patpv${j}:${i}`)));
          });
        }
      }
      return out;
    } catch {
      // A half-typed expression must yield no preview, never crash the render.
      return [];
    }
  }, [patternSession, editingSketch, resolved.scope]);

  // The sketches handed to the Viewport, plus a transient synthetic sketch
  // carrying the offset preview (on the active sketch's frame) when one is live.
  const renderSketchesWithPreview = useMemo(() => {
    const mirrorPreview = mirrorSession?.previews ?? [];
    const projectPreview = projectSession?.previews ?? [];
    // In-progress text: a live (solid) preview entity so the user sees the glyphs
    // as they type, before committing.
    let textPreview: SketchEntity[] = [];
    if (textDraft && textDraft.value.trim()) {
      // Guard the eval: a half-typed / non-numeric height must not throw and
      // crash this render memo — just skip the preview until it's valid.
      let h = NaN;
      try {
        h = evaluateExpression(textDraft.height, resolved.scope);
      } catch {
        h = NaN;
      }
      if (Number.isFinite(h) && h > 0)
        textPreview = [{ type: "text", id: "__textpv", p: textDraft.anchor, value: textDraft.value, height: h }];
    }
    if (
      (offsetPreview.length === 0 &&
        mirrorPreview.length === 0 &&
        projectPreview.length === 0 &&
        patternPreview.length === 0 &&
        textPreview.length === 0) ||
      !dimFrame
    )
      return renderSketches;
    const extra: typeof renderSketches = [];
    if (textPreview.length > 0)
      extra.push({ id: "__text_preview__", frame: dimFrame, entities: textPreview, regions: [] });
    if (offsetPreview.length > 0)
      extra.push({ id: "__offset_preview__", frame: dimFrame, entities: offsetPreview, regions: [] });
    if (mirrorPreview.length > 0)
      extra.push({
        id: "__mirror_preview__",
        frame: dimFrame,
        // Force construction so the preview routes to the dashed overlay; the
        // committed entities (commitMirror) keep their real construction flag.
        entities: mirrorPreview.map((e) => ({ ...e, construction: true })),
        regions: [],
      });
    if (projectPreview.length > 0)
      extra.push({
        id: "__project_preview__",
        frame: dimFrame,
        entities: projectPreview.map((e) => ({ ...e, construction: true })),
        regions: [],
      });
    if (patternPreview.length > 0)
      extra.push({
        id: "__pattern_preview__",
        frame: dimFrame,
        // Force construction so the preview routes to the dashed overlay; the
        // committed copies keep their sources' real construction flags.
        entities: patternPreview.map((e) => ({ ...e, construction: true })),
        regions: [],
      });
    return [...renderSketches, ...extra];
  }, [
    renderSketches,
    offsetPreview,
    mirrorSession,
    projectSession,
    patternPreview,
    textDraft,
    resolved.scope,
    dimFrame,
  ]);

  const startSketchOn = (ref: SketchPlaneRef, aim?: [number, number, number]) => {
    const { doc: next, id } = addSketch(doc, ref);
    setDoc(next);
    selectFeature(id);
    setPicking(false);
    setEditingSketchId(id);
    setSketchTool("select");
    setFullyConstrained(false);
    // Orient onto the face at the point the user clicked (aim), keeping their
    // current zoom — so the sketch view stays on the geometry they just picked
    // instead of jumping to the plane origin at a fixed far distance.
    viewApiRef.current?.lookAtFrame(frameOf(ref, resolved.planeFrames), aim);
  };

  // Open the reference-plane dialog and arm the base pick (offset is the default
  // method; the dropdown switches to midplane / at-angle / through 3 points).
  const openPlaneDialog = () => {
    setPlaneDialog({ method: "offset", base: null, offset: "20", refB: null, angleAxis: "u", angle: "30", points: [] });
    armPlanePick("base");
  };
  /** Arm one of the plane dialog's pick slots. "base"/"refB" ride the shared
   *  plane/face pick stream; "point" reads a vertex or sketch point off an
   *  ordinary click, so it leaves the normal selection flow running. */
  const armPlanePick = (slot: "base" | "refB" | "point") => {
    setPlanePick(slot);
    if (slot === "point") {
      setPicking(false);
    } else {
      setPickPurpose("plane");
      setPicking(true);
    }
  };
  const closePlaneDialog = () => {
    setPlaneDialog(null);
    setPlanePick(null);
    setPicking(false);
    cancelEdit();
  };

  // Live-preview a plane edit (pure geometry — no kernel; the plane frame just
  // re-resolves). Skips incomplete specs so a half-armed re-pick doesn't error.
  useEffect(() => {
    const d = planeDialog;
    if (!d?.editId) return;
    if (d.method === "through" ? d.points.length !== 3 : !d.base) return;
    if (d.method === "midplane" && !d.refB) return;
    const spec = {
      method: d.method,
      base: d.base ?? { kind: "datum" as const, id: "plane-top" },
      offset: d.offset,
      refB: d.refB ?? undefined,
      angleAxis: d.angleAxis,
      angle: d.angle,
      points: d.method === "through" ? d.points : undefined,
    };
    if (!shouldLiveApply(JSON.stringify({ e: d.editId, spec }))) return;
    setDoc((prev) => updatePlane(prev, d.editId!, spec), `edit:${d.editId}`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    planeDialog?.editId,
    planeDialog?.method,
    planeDialog?.base,
    planeDialog?.offset,
    planeDialog?.refB,
    planeDialog?.angleAxis,
    planeDialog?.angle,
    planeDialog?.points,
  ]);

  // The plane/face pick resolved: start a sketch on it, or fill the plane
  // dialog's base / second reference (whichever slot is armed).
  const handlePickRef = (ref: SketchPlaneRef, aim?: [number, number, number]) => {
    if (pickPurpose === "plane") {
      setPicking(false);
      if (planePick === "refB") setPlaneDialog((d) => (d ? { ...d, refB: ref } : d));
      else setPlaneDialog((d) => (d ? { ...d, base: ref } : d));
      setPlanePick(null);
    } else if (pickPurpose === "sectionPlane") {
      setPicking(false);
      setPickPurpose("sketch");
      setSectionView((s) => ({ ...s, ref, offset: 0, flip: false, enabled: true }));
    } else {
      startSketchOn(ref, aim);
    }
  };

  // The revolve "Select axis" arming resolved: fill the dialog's axis role from a
  // sketch line, a body face, or a datum/reference plane (one unified pick path).
  // The Pattern dialog rides the same stream: "patternDir" takes a sketch line
  // only; "patternAxis" a sketch line or a body face (planes are rejected — a
  // pattern has no profile plane to intersect one with).
  const handleAxisPick = (pick: RevolveAxisPick) => {
    if (pickPurpose === "patternDir" || pickPurpose === "patternAxis") {
      if (pick.kind === "line") {
        const sk = doc.features.find((f) => f.id === pick.sketchId);
        const e = sk?.type === "sketch" ? sk.entities.find((x) => x.id === pick.entityId) : undefined;
        if (e?.type !== "line") {
          flashMsg("Pick a straight sketch line.");
          return;
        }
        const ref = { sketchId: pick.sketchId, entityId: pick.entityId };
        setPatternDialog((d) =>
          d && d.arming
            ? d.arming === "axis"
              ? { ...d, axis: ref, arming: null }
              : d.arming === "dir2"
                ? { ...d, dir2: ref, arming: null }
                : { ...d, dir1: ref, arming: null }
            : d,
        );
      } else if (pick.kind === "bodyFace" && pickPurpose === "patternAxis") {
        const m = meshes.find((x) => x.id === pick.featureId);
        const center = m ? faceCentroid(m.mesh.faces, pick.faceId) : null;
        if (!center) return;
        const faceName = m ? faceNameOf(m.mesh.faces, pick.faceId) : undefined;
        const normal = (m && faceNormal(m.mesh.faces, pick.faceId)) || undefined;
        setPatternDialog((d) =>
          d && d.arming === "axis"
            ? {
                ...d,
                axis: { face: { featureId: pick.featureId, faceId: pick.faceId, faceName, center, normal } },
                arming: null,
              }
            : d,
        );
      } else {
        flashMsg(
          pickPurpose === "patternDir"
            ? "The direction must be a sketch line (or use World X/Y/Z)."
            : "The axis must be a sketch line or a cylindrical face (a body edge only works for a revolve).",
        );
        return; // keep the pick armed for another try
      }
      setPicking(false);
      setPickPurpose("sketch");
      return;
    }
    if (pick.kind === "line") {
      const sk = doc.features.find((f) => f.id === pick.sketchId);
      const e = sk?.type === "sketch" ? sk.entities.find((x) => x.id === pick.entityId) : undefined;
      if (e?.type !== "line") {
        flashMsg("The axis must be a straight sketch line, a body edge, a plane, or a face.");
        return;
      }
      setRevolveDialog((d) => (d ? { ...d, axis: { sketchId: pick.sketchId, entityId: pick.entityId } } : d));
    } else if (pick.kind === "bodyEdge") {
      // A straight body edge is the axis line itself. Stored by persistent name
      // + the mid/length fingerprint, like a dress-up's edges, so it survives an
      // upstream edit that renames it.
      const m = meshes.find((x) => x.id === pick.featureId);
      const edgeName = m ? edgeNameOf(m.mesh.edges, pick.edgeId) : undefined;
      if (!edgeName) {
        flashMsg("That edge can't be referenced — pick another edge, a sketch line, a plane, or a face.");
        return; // keep the pick armed
      }
      const fp = m ? edgeFingerprint(m.mesh.edges, pick.edgeId) : null;
      setRevolveDialog((d) =>
        d
          ? {
              ...d,
              axis: {
                edge: { featureId: pick.featureId, edgeId: pick.edgeId, edgeName, mid: fp?.mid, length: fp?.length },
              },
            }
          : d,
      );
    } else if (pick.kind === "bodyFace") {
      const m = meshes.find((x) => x.id === pick.featureId);
      const center = m ? faceCentroid(m.mesh.faces, pick.faceId) : null;
      if (!center) return;
      const faceName = m ? faceNameOf(m.mesh.faces, pick.faceId) : undefined;
      const normal = (m && faceNormal(m.mesh.faces, pick.faceId)) || undefined;
      setRevolveDialog((d) =>
        d ? { ...d, axis: { face: { featureId: pick.featureId, faceId: pick.faceId, faceName, center, normal } } } : d,
      );
    } else {
      setRevolveDialog((d) => (d ? { ...d, axis: { plane: pick.ref } } : d));
    }
    setPicking(false);
    setPickPurpose("sketch");
  };

  const createPlane = () => {
    if (!planeDialog) return;
    const { method, base, offset, refB, angleAxis, angle, points } = planeDialog;
    // Each method needs its own inputs filled before it can build a frame.
    if (method === "through") {
      if (points.length !== 3) return;
    } else if (!base) {
      return;
    } else if (method === "midplane" && !refB) {
      return;
    }
    const spec = {
      method,
      base: base ?? { kind: "datum" as const, id: "plane-top" }, // unused for "through"
      offset,
      refB: refB ?? undefined,
      angleAxis,
      angle,
      points: method === "through" ? points : undefined,
    };
    if (planeDialog.editId) {
      setDoc(updatePlane(doc, planeDialog.editId, spec));
      selectFeature(planeDialog.editId);
      commitEdit();
      closePlaneDialog();
      return;
    }
    const { doc: next } = addPlane(doc, spec);
    setDoc(next);
    selectFeature(null);
    closePlaneDialog();
  };

  // Re-open the reference-plane dialog to edit an existing plane. Seeds the
  // method + refs + params; re-picking base/refB works through the same
  // plane-pick stream as creation (Confirm → updatePlane).
  const editPlane = (id: string) => {
    const f = doc.features.find((x) => x.id === id);
    if (f?.type !== "plane") return;
    beginEdit(f);
    selectFeature(id);
    setPlaneDialog({
      method: f.method ?? "offset",
      base: f.base ?? null,
      offset: f.offset,
      refB: f.refB ?? null,
      angleAxis: f.angleAxis ?? "u",
      angle: f.angle ?? "30",
      points: f.points ?? [],
      editId: id,
    });
    setPickPurpose("plane");
    setPlanePick(null); // don't auto-arm a re-pick; the user clicks a slot to re-pick
  };

  const editSketch = (id: string) => {
    const f = doc.features.find((x) => x.id === id);
    if (f?.type !== "sketch") return;
    setEditingSketchId(id);
    selectFeature(id);
    setSketchTool("select");
    setFullyConstrained(false);
    viewApiRef.current?.lookAtFrame(frameOf(f.plane, resolved.planeFrames));
  };

  const finishSketch = () => {
    // An empty sketch (no entities drawn) is treated as a cancel — drop it.
    const sk = doc.features.find((f) => f.id === editingSketchId);
    if (sk?.type === "sketch" && sk.entities.length === 0) {
      setDoc(removeFeature(doc, sk.id));
    }
    setEditingSketchId(null);
    setDraft([]);
    setOffsetSession(null);
    setProjectSession(null);
    setTextDraft(null);
    setSelection([]); // so the next click (e.g. a face to extrude) starts fresh
  };

  // Double-clicking a timeline row (or a body) opens that feature's ONE editor:
  // sketch → sketch canvas; transform → gizmo; every operation with a creation
  // dialog re-opens it populated in edit mode (Confirm updates in place, inputs
  // re-pickable); everything else (primitive / import / sweep / loft) opens its
  // parameters in the floating panel. There's no separate "params-on-select"
  // surface any more — selection just highlights.
  const openFeatureEditor = (id: string) => {
    const f = doc.features.find((x) => x.id === id);
    if (!f) return;
    switch (f.type) {
      case "sketch":
        editSketch(id);
        break;
      case "transform":
        editTransform(id);
        break;
      case "extrude":
        editExtrude(id);
        break;
      case "plane":
        editPlane(id);
        break;
      case "revolve":
        editRevolve(id);
        break;
      case "boolean":
        editBoolean(id);
        break;
      case "mirror":
        editMirror(id);
        break;
      case "pattern":
        editPattern(id);
        break;
      case "dressup":
        editDressUp(id);
        break;
      case "shell":
        editShell(id);
        break;
      default: // primitive / import / sweep / loft — no creation dialog
        selectFeature(id);
        setEditParamsId(id);
    }
  };
  const handleTreeDoubleClick = openFeatureEditor;

  // A snapped click on the sketch plane (already in uv coords). Drives the
  // multi-click construction tools. `hv` records a horizontal/vertical inference
  // (line tool) so it can be captured as a constraint.
  const handleSketchClick = (
    uv: Vec2,
    hv?: "horizontal" | "vertical",
    on?: { id: string; mid: boolean },
    atVertex?: boolean,
    meanings?: { meaning: "horizontal" | "vertical" | "parallel" | "perpendicular"; refId?: string }[],
    onFixed?: Vec2,
  ) => {
    if (!editingSketchId || sketchTool === "select" || sketchTool === "offset") return;
    const sketchId = editingSketchId;
    // Build on the last committed sketch rather than this render's `doc`, which
    // is stale while the previous click's solve is still running (see
    // sketchBaseDocRef — clicking faster than the solver used to drop segments).
    const base = sketchBaseDocRef.current;
    // Drawing solves immediately: the constraints captured while drawing (auto
    // H/V, rectangle edges, shared corners) are enforced on the spot, the geometry
    // snaps clean, and the fully-constrained / conflict status stays live — so
    // there's no separate "Solve" step. For the chained line tool, the next
    // segment continues from the *solved* endpoint so the chain stays coincident.
    const applyAndSolve = async (mutated: Document, chainLineId?: string) => {
      const solved = await commitSketchEdit(mutated, sketchId);
      // Superseded by a later click — that one owns the draft/chain now.
      if (chainLineId && solved) {
        const sk = solved.features.find((f) => f.id === sketchId);
        const e = sk?.type === "sketch" ? sk.entities.find((x) => x.id === chainLineId) : undefined;
        if (e?.type === "line") setDraft([e.b]);
      }
    };
    const commit = (entities: SketchEntity[]) => void applyAndSolve(addSketchEntities(base, sketchId, entities));
    // Stamp construction (reference) geometry when that draw-mode is on.
    const mark = <T extends SketchEntity>(e: T): T => (constructionMode ? { ...e, construction: true } : e);
    const lineEntity = (a: Vec2, b: Vec2): SketchEntity => mark({ type: "line", id: genId(), a, b });
    const loopLines = (pts: Vec2[]) => loopSegments(pts).map(([a, b]) => lineEntity(a, b));

    // Body-geometry snaps → lasting coincident-to-{fixed} pins (see snapPins).
    const makePins = (entities: SketchEntity[], p: (Vec2 | undefined)[]) => pinConstraints(entities, p, genId);

    // Commit a rectangle as 4 looped lines plus the implicit horizontal/vertical
    // constraints (each edge is axis-aligned, so it's exactly H or V). Without
    // these a "rectangle" is just four coincident lines, free to shear the
    // moment any later constraint is added. `pins` pins any corner snapped to a body point.
    const commitRect = (pts: Vec2[], pins: (Vec2 | undefined)[] = []) => {
      const segs = loopSegments(pts);
      const lines = segs.map(([a, b]) => lineEntity(a, b));
      let next = addSketchEntities(base, sketchId, lines);
      const cons: SketchConstraint[] = segs.map(([a, b], i) => ({
        id: genId(),
        type: Math.abs(b[0] - a[0]) >= Math.abs(b[1] - a[1]) ? "horizontal" : "vertical",
        entity: lines[i].id,
      }));
      cons.push(...makePins(lines, pins));
      next = addSketchConstraints(next, sketchId, cons);
      void applyAndSolve(next);
    };

    switch (sketchTool) {
      case "line":
        if (draft.length === 0) {
          setDraft([uv]);
          lineStartOnRef.current = on; // remember an entity the start landed on
          lineStartFixedRef.current = onFixed; // …or a body point it pinned to
        } else {
          // Clicking the same point twice would commit a zero-length line —
          // ignore it and keep the chain going (see MIN_SEGMENT).
          if (Math.hypot(uv[0] - draft[0][0], uv[1] - draft[0][1]) < MIN_SEGMENT) break;
          const line = lineEntity(draft[0], uv);
          let next = addSketchEntities(base, sketchId, [line]);
          const cons: SketchConstraint[] = [];
          if (hv) cons.push({ id: genId(), type: hv, entity: line.id });
          else {
            // A parallel/perpendicular inference guide → constrain the drawn
            // segment to its reference line. One direction constraint only (H/V
            // already covered above), and only against a real (non-derived) line
            // still in the sketch, so a stale ref can't over-constrain.
            const dir = meanings?.find((m) => (m.meaning === "parallel" || m.meaning === "perpendicular") && m.refId);
            const sk = base.features.find((f) => f.id === sketchId);
            const ref = sk?.type === "sketch" ? sk.entities.find((x) => x.id === dir?.refId) : undefined;
            if (dir?.refId && ref?.type === "line" && !ref.derivedFrom) {
              cons.push({ id: genId(), type: dir.meaning as "parallel" | "perpendicular", a: line.id, b: dir.refId });
            }
          }
          // Keep an endpoint attached to whatever it was snapped onto: a line's
          // body → point-on-line; a circle's/arc's rim → point-on-circle (so the
          // end rides the rim when the circle is re-dimensioned); a line/arc
          // midpoint → midpoint — so a later dimension can't slide it off.
          const baseSk = base.features.find((f) => f.id === sketchId);
          const targetType = (id: string) =>
            baseSk?.type === "sketch" ? baseSk.entities.find((x) => x.id === id)?.type : undefined;
          const attach = (at: "a" | "b", t: { id: string; mid: boolean }): SketchConstraint => {
            const point = { entity: line.id, at } as const;
            if (t.mid) return { id: genId(), type: "midpoint", point, target: t.id };
            const kind = targetType(t.id);
            return kind === "circle" || kind === "arc"
              ? { id: genId(), type: "pointOnCircle", point, circle: t.id }
              : { id: genId(), type: "pointOnLine", point, line: t.id };
          };
          if (lineStartOnRef.current) cons.push(attach("a", lineStartOnRef.current));
          if (on) cons.push(attach("b", on));
          // A body-geometry snap (hole rim/centre) → pin that endpoint to the spot
          // with a coincident-to-`{fixed}`, so it can't drift on a later drag.
          const pin = (at: "a" | "b", p: Vec2): SketchConstraint => ({
            id: genId(),
            type: "coincident",
            a: { entity: line.id, at },
            b: { fixed: p },
          });
          if (lineStartFixedRef.current) cons.push(pin("a", lineStartFixedRef.current));
          if (onFixed) cons.push(pin("b", onFixed));
          if (cons.length) next = addSketchConstraints(next, sketchId, cons);
          // The chain continues from this end; it's now constrained, so the next
          // segment's start needs no further attachment.
          lineStartOnRef.current = undefined;
          lineStartFixedRef.current = undefined;
          // Landing this endpoint on an existing corner (another entity's endpoint
          // or the origin) closes the polyline — end the chain instead of drawing
          // on from there. Snapping back onto the chain's own point doesn't count.
          if (atVertex) {
            setDraft([]);
            setSketchTool("select"); // chain closed on a corner → back to Select
            void applyAndSolve(next);
          } else {
            setDraft([uv]); // chain optimistically; applyAndSolve resets to the solved endpoint
            void applyAndSolve(next, line.id);
          }
        }
        break;
      case "rect-corner":
        if (draft.length === 0) {
          setDraft([uv]);
          draftFixedRef.current = [onFixed];
        } else {
          if (Math.abs(uv[0] - draft[0][0]) < MIN_SEGMENT || Math.abs(uv[1] - draft[0][1]) < MIN_SEGMENT) break;
          // Both opposite corners (draft[0], uv) are rectangle corners → pin either
          // that snapped to a hole. The other two corners aren't snap targets.
          commitRect(rectangleCorners(draft[0], uv), [draftFixedRef.current[0], onFixed]);
          setDraft([]);
          draftFixedRef.current = [];
        }
        break;
      case "rect-center":
        if (draft.length === 0) {
          setDraft([uv]);
          draftFixedRef.current = [onFixed];
        } else {
          if (Math.abs(uv[0] - draft[0][0]) < MIN_SEGMENT || Math.abs(uv[1] - draft[0][1]) < MIN_SEGMENT) break;
          // Only the corner (uv) is a rectangle vertex; the centre (draft[0]) isn't.
          commitRect(rectangleFromCenter(draft[0], uv), [onFixed]);
          setDraft([]);
          draftFixedRef.current = [];
        }
        break;
      case "circle-center":
        if (draft.length === 0) {
          setDraft([uv]);
          circleCenterFixedRef.current = onFixed; // centre may pin to a hole centre
        } else {
          const r = Math.hypot(uv[0] - draft[0][0], uv[1] - draft[0][1]);
          if (r < MIN_SEGMENT) break; // a second click on the centre → no circle
          const circle = mark({ type: "circle" as const, id: genId(), c: draft[0], r });
          let next = addSketchEntities(base, sketchId, [circle]);
          // Pin the centre to the body circle it snapped to (concentric that LASTS).
          if (circleCenterFixedRef.current) {
            next = addSketchConstraints(next, sketchId, [
              {
                id: genId(),
                type: "coincident",
                a: { entity: circle.id, at: "c" },
                b: { fixed: circleCenterFixedRef.current },
              },
            ]);
          }
          void applyAndSolve(next);
          circleCenterFixedRef.current = undefined;
          setDraft([]);
        }
        break;
      case "circle-3p":
        if (draft.length < 2) setDraft([...draft, uv]);
        else {
          const c = circleFrom3(draft[0], draft[1], uv);
          if (c) commit([mark({ type: "circle", id: genId(), c: c.center, r: c.r })]);
          setDraft([]);
        }
        break;
      case "polygon":
        if (draft.length === 0) setDraft([uv]);
        else {
          if (Math.hypot(uv[0] - draft[0][0], uv[1] - draft[0][1]) < MIN_SEGMENT) break;
          // The clicked vertex (uv) is a polygon corner → pins if snapped to a
          // hole. The centre (draft[0]) isn't a referenceable vertex, so it can't.
          const polyLines = loopLines(regularPolygon(draft[0], uv, polygonSides));
          let next = addSketchEntities(base, sketchId, polyLines);
          const cons = makePins(polyLines, [onFixed]);
          if (cons.length) next = addSketchConstraints(next, sketchId, cons);
          void applyAndSolve(next);
          setDraft([]);
        }
        break;
      case "arc-3p":
        if (draft.length < 2) setDraft([...draft, uv]);
        else {
          const a = arcFrom3(draft[0], uv, draft[1]); // start, mid(uv), end
          if (a) commit([mark({ type: "arc", id: genId(), c: a.center, r: a.r, start: a.start, end: a.end })]);
          setDraft([]);
        }
        break;
      case "spline":
        // Accumulate control points; the spline is committed on Esc / Finish
        // (see finishSpline) so it can take any number of points.
        setDraft([...draft, uv]);
        break;
      case "text":
        // Click sets/repositions the baseline anchor and opens the floating
        // editor; the string + height are typed there and committed on Enter.
        // Re-positioning keeps any in-progress value/height and edit target.
        setTextDraft({
          anchor: uv,
          value: textDraft?.value ?? "",
          height: textDraft?.height ?? "10",
          editId: textDraft?.editId,
        });
        break;
    }
  };

  // Commit the in-progress text placement as a `text` entity (no solve needed —
  // text isn't a constraint participant). Empty string → cancel.
  const commitText = () => {
    const td = textDraftRef.current;
    if (!editingSketchId || !td) return;
    let h = NaN;
    try {
      h = evaluateExpression(td.height, resolved.scope);
    } catch {
      h = NaN;
    }
    if (!td.value.trim() || !Number.isFinite(h) || h <= 0) {
      setTextDraft(null);
      return;
    }
    if (td.editId) {
      // Re-edit: update the existing text entity in place (preserving its
      // construction flag), so its glyphs / any extrude of it follow.
      const sk = doc.features.find((f) => f.id === editingSketchId);
      if (sk?.type === "sketch") {
        const entities = sk.entities.map((en) =>
          en.id === td.editId && en.type === "text" ? { ...en, p: td.anchor, value: td.value, height: h } : en,
        );
        setDoc(setSketchEntities(doc, editingSketchId, entities));
      }
      setTextDraft(null);
      return;
    }
    const e: SketchEntity = constructionMode
      ? { type: "text", id: genId(), p: td.anchor, value: td.value, height: h, construction: true }
      : { type: "text", id: genId(), p: td.anchor, value: td.value, height: h };
    setDoc(addSketchEntities(doc, editingSketchId, [e]));
    setTextDraft(null);
  };
  const commitTextRef = useRef<() => void>(() => {});
  commitTextRef.current = commitText;

  // Commit the in-progress spline (≥2 points) as a spline entity, then clear the
  // draft. Called from Esc while the spline tool is active (Finish path).
  const finishSpline = () => {
    if (!editingSketchId || sketchTool !== "spline" || draft.length < 2) return false;
    const e: SketchEntity = { type: "spline", id: genId(), points: draft };
    const sketchId = editingSketchId;
    // Same base-not-`doc` rule as the click path: Esc can land while the solve
    // of the last point's click is still in flight.
    const mutated = addSketchEntities(sketchBaseDocRef.current, sketchId, [
      constructionMode ? { ...e, construction: true } : e,
    ]);
    void commitSketchEdit(mutated, sketchId);
    setDraft([]);
    return true;
  };

  // Solve a sketch and fold the new coordinates back in, returning both the
  // updated document and the raw solve result (null if the solve threw or the
  // sketch is gone) so callers can react to conflicts before committing.
  const runSolve = async (
    docArg: Document,
    sketchId: string,
  ): Promise<{ doc: Document; res: Awaited<ReturnType<typeof solveSketch>> | null }> => {
    const sk = docArg.features.find((f) => f.id === sketchId);
    if (sk?.type !== "sketch") return { doc: docArg, res: null };
    try {
      const res = await solveSketch(sk.entities, sk.constraints);
      // Fold the solved (free) geometry back in, then regenerate this sketch's
      // derived entities (offset/mirror) from those solved sources so the editor
      // shows associative geometry updating live.
      const solved = setSketchEntities(docArg, sketchId, res.entities);
      return { doc: applyDerivedToSketch(solved, sketchId, resolved.scope), res };
    } catch (err) {
      console.error("constraint solve failed:", err);
      return { doc: docArg, res: null };
    }
  };

  // Did adding constraint `addedId` introduce a redundancy? Precise when
  // planegcs names the new constraint directly; otherwise compare against a
  // baseline solve without it — a sketch can carry harmless pre-existing
  // redundants (e.g. a trivially-satisfied draw-time attach), and those must
  // not veto every future constraint.
  const introducedRedundancy = async (
    entities: SketchEntity[],
    constraints: SketchConstraint[],
    addedId: string,
    res: NonNullable<Awaited<ReturnType<typeof runSolve>>["res"]>,
  ): Promise<boolean> => {
    if (!res.hasRedundant && res.redundantIds.length === 0) return false;
    if (res.redundantIds.includes(addedId)) return true;
    try {
      const baseline = await solveSketch(
        entities,
        constraints.filter((c) => c.id !== addedId),
      );
      return res.redundantIds.length > baseline.redundantIds.length || (res.hasRedundant && !baseline.hasRedundant);
    } catch {
      return true; // baseline itself unsolvable — blame the addition
    }
  };

  // The labels of the constraints planegcs blames for a conflict (minus the one
  // just added), for a rejection message that names the actual culprits.
  const conflictNames = (
    constraints: SketchConstraint[],
    res: { conflictingIds: string[] },
    addedId: string,
  ): string[] => [
    ...new Set(
      res.conflictingIds
        .filter((id) => id !== addedId)
        .map((id) => constraints.find((c) => c.id === id))
        .filter((c): c is SketchConstraint => !!c)
        .map(constraintLabel),
    ),
  ];

  const solveSketchIn = async (docArg: Document, sketchId: string): Promise<Document> => {
    const { doc: solved, res } = await runSolve(docArg, sketchId);
    if (res) {
      setFullyConstrained(res.dof === 0 && !res.hasConflicts);
      setSolveConflict(res.hasConflicts);
    }
    return solved;
  };

  /**
   * Claim the next sketch commit: `mutated` becomes, synchronously, the document
   * every later edit builds on — solving is async, so by the time it returns the
   * caller's `doc` is long stale. Returns the stamp to hand to finish/abandon.
   */
  const beginSketchEdit = (mutated: Document): number => {
    sketchBaseDocRef.current = mutated;
    return ++sketchCommitSeqRef.current;
  };

  /**
   * Publish a solved commit, unless a newer one has claimed the sketch since.
   * A superseded result is dropped rather than merged: the newer edit was built
   * on top of this mutation and its own solve covers the whole sketch, so the
   * document converges either way.
   */
  const finishSketchEdit = (seq: number, solved: Document): boolean => {
    if (seq !== sketchCommitSeqRef.current) return false;
    sketchBaseDocRef.current = solved;
    setDoc(solved);
    return true;
  };

  /** Give up a claimed commit (a dimension the solver rejected), restoring the
   *  base it was built on — unless a later edit has already claimed the sketch,
   *  in which case that edit's document (which contains this abandoned mutation)
   *  is the one in play and rolling back would drop its work instead. */
  const abandonSketchEdit = (seq: number, previous: Document): void => {
    if (seq === sketchCommitSeqRef.current) sketchBaseDocRef.current = previous;
  };

  /** Ids of the sketch's lines that have collapsed to (near) nothing. A drawn
   *  constraint that COLLAPSES a line is rejected — but one that merely leaves an
   *  already-collapsed line alone must not be, or a single stray zero-length
   *  segment (an easy accidental double-click: invisible, and unselectable
   *  afterwards) would make every dimension in the sketch look unsolvable. */
  const degenerateLineIds = (d: Document, sketchId: string): Set<string> => {
    const sk = d.features.find((f) => f.id === sketchId);
    const out = new Set<string>();
    if (sk?.type === "sketch") {
      for (const e of sk.entities) {
        if (e.type === "line" && Math.hypot(e.b[0] - e.a[0], e.b[1] - e.a[1]) < MIN_SEGMENT) out.add(e.id);
      }
    }
    return out;
  };

  /** claim → solve → publish, for edits that are always accepted. Returns the
   *  solved document, or null if superseded. */
  const commitSketchEdit = async (mutated: Document, sketchId: string): Promise<Document | null> => {
    const seq = beginSketchEdit(mutated);
    const solved = await solveSketchIn(mutated, sketchId);
    return finishSketchEdit(seq, solved) ? solved : null;
  };

  // --- Live sketch dragging -------------------------------------------------
  // Every frame solves from a snapshot of the geometry taken when the drag began
  // (so repeated frames don't accumulate) with the grabbed points relocated to
  // their cursor targets. Only one solve runs at a time; the latest request waits
  // and supersedes any earlier pending one (coalescing fast pointer moves).
  const dragBaseRef = useRef<{
    sketchId: string;
    key: string;
    entities: SketchEntity[];
    constraints: SketchConstraint[];
  } | null>(null);
  const dragActiveRef = useRef(false);
  const dragBusyRef = useRef(false);
  const dragPendingRef = useRef<{ from: Vec2; to: Vec2 }[] | null>(null);
  const dragSeqRef = useRef(0);

  const pumpSketchDrag = async () => {
    dragBusyRef.current = true;
    try {
      // Drain to the latest pending frame — including the final one after the
      // pointer is released — so the committed geometry matches where the drag
      // actually ended, not one frame behind.
      while (dragPendingRef.current) {
        const points = dragPendingRef.current;
        dragPendingRef.current = null;
        const base = dragBaseRef.current;
        if (!base) break;
        const moved = moveSketchPoints(base.entities, points);
        // Pin the grabbed point(s) at the cursor so free neighbours follow them,
        // instead of the solver correcting the grabbed point back along a
        // constrained axis (which made e.g. a vertical line's free end only drag
        // vertically). If pinning over-constrains — a genuinely constrained vertex
        // dragged off its locus, which planegcs may reject by THROWING or by
        // flagging a conflict — fall back to an unpinned solve so the point still
        // slides as far as the constraints allow (never worse than no pin).
        const solveDrag = async (pin: boolean) =>
          solveSketch(moved, base.constraints, pin ? { lockedPoints: points.map((p) => p.to) } : {});
        let res: Awaited<ReturnType<typeof solveSketch>> | null = null;
        try {
          res = await solveDrag(true);
          if (res.hasConflicts) res = null; // pinning was infeasible → fall back
        } catch {
          /* pinning threw → fall back */
        }
        if (!res) {
          try {
            res = await solveDrag(false);
          } catch (err) {
            console.error("drag solve failed:", err);
            continue;
          }
        }
        // Coalesce every frame of one drag into a single undo step (the key is
        // unique per drag, so separate drags stay separate undo steps).
        setDoc((prev) => setSketchEntities(prev, base.sketchId, res.entities), base.key);
        setFullyConstrained(res.dof === 0 && !res.hasConflicts);
        setSolveConflict(res.hasConflicts);
      }
    } finally {
      dragBusyRef.current = false;
    }
  };

  const handleSketchDragMove = (points: { from: Vec2; to: Vec2 }[]) => {
    const sketchId = editingSketchId;
    if (!sketchId) return;
    // Snapshot the pre-drag geometry once, at the start of each drag; every frame
    // re-solves from this base so repeated frames don't accumulate.
    if (!dragActiveRef.current) {
      const sk = doc.features.find((f) => f.id === sketchId);
      if (sk?.type !== "sketch") return;
      dragBaseRef.current = {
        sketchId,
        key: `sketch-drag:${sketchId}:${++dragSeqRef.current}`,
        entities: sk.entities,
        constraints: sk.constraints,
      };
      dragActiveRef.current = true;
    }
    dragPendingRef.current = points;
    if (!dragBusyRef.current) void pumpSketchDrag();
  };

  // Mark the drag finished; the pump keeps the base alive until it has applied
  // the last queued frame, so the released position is the one that's committed.
  const handleSketchDragEnd = () => {
    dragActiveRef.current = false;
  };

  const screenOf = (uv: Vec2) => {
    const frame = frameOf(editingSketch!.plane, resolved.planeFrames);
    return viewApiRef.current?.worldToScreen(uvToWorld(frame, uv[0], uv[1])) ?? { x: 240, y: 120 };
  };

  // Offset: validate the current selection is a single chain and open the
  // session (anchored at the first edge's midpoint, with the right-of-travel
  // normal as the drag axis); otherwise flash the one-chain error.
  const beginOffset = () => {
    if (!editingSketch) return;
    const chain = detectSingleChain(selectedSketchEntities);
    if (!chain) {
      flashMsg("Can only offset a single chain at once.");
      setSketchToolState("select");
      return;
    }
    const e0 = chain[0];
    let anchor: Vec2;
    let normal: Vec2;
    if (e0.type === "line") {
      anchor = [(e0.a[0] + e0.b[0]) / 2, (e0.a[1] + e0.b[1]) / 2];
      const dx = e0.b[0] - e0.a[0],
        dy = e0.b[1] - e0.a[1],
        len = Math.hypot(dx, dy) || 1;
      normal = [dy / len, -dx / len]; // right of travel (positive offset side)
    } else if (e0.type === "arc") {
      const mid = (e0.start + e0.end) / 2;
      anchor = [e0.c[0] + e0.r * Math.cos(mid), e0.c[1] + e0.r * Math.sin(mid)];
      normal = [Math.cos(mid), Math.sin(mid)];
    } else {
      anchor = [e0.c[0] + e0.r, e0.c[1]];
      normal = [1, 0];
    }
    setOffsetSession({ chain, value: "5", anchor, normal });
    setSketchToolState("offset");
  };
  beginOffsetRef.current = beginOffset;

  const cancelOffset = () => {
    setOffsetSession(null);
    setSketchToolState("select");
  };

  const commitOffset = async () => {
    const sess = offsetSession;
    if (!sess || !editingSketch) return;
    let d = NaN;
    try {
      d = evaluateExpression(sess.value, resolved.scope);
    } catch {
      d = NaN;
    }
    // A non-numeric / unparseable distance: flag it and keep the box open so the
    // user can correct it (don't throw, don't silently discard the chain).
    if (!Number.isFinite(d)) {
      flashMsg("Enter a numeric offset distance.");
      return;
    }
    if (Math.abs(d) < 1e-9) {
      cancelOffset();
      return;
    }
    const allConstruction = sess.chain.every((e) => !!e.construction);
    // Commit as an associative DerivedOp (not a static snapshot): the offset
    // re-computes from its source chain whenever they move. solveSketchIn →
    // applyDerived seeds the output entities. `value` is kept as an expression.
    const op: DerivedOp = {
      id: genId(),
      kind: "offset",
      sourceIds: sess.chain.map((e) => e.id),
      distance: sess.value,
      ...(allConstruction ? { construction: true } : {}),
    };
    const sketchId = editingSketch.id;
    // Build on the last committed sketch, not this render's `doc` — see
    // sketchBaseDocRef: a drawn segment may still be solving.
    const next = addDerivedOp(sketchBaseDocRef.current, sketchId, op);
    setOffsetSession(null);
    setSketchToolState("select");
    void commitSketchEdit(next, sketchId);
  };

  // Re-edit a committed offset op's distance: write the new expression and
  // re-solve (which re-runs applyDerived, shifting the offset edges).
  const commitOffsetEdit = async () => {
    if (!offsetEdit || !editingSketch) return;
    const sketchId = editingSketch.id;
    const next = setDerivedOffsetDistance(sketchBaseDocRef.current, sketchId, offsetEdit.opId, offsetEdit.value);
    setOffsetEdit(null);
    void commitSketchEdit(next, sketchId);
  };

  const cancelMirror = () => {
    setMirrorSession(null);
    setSelection([]);
    setSketchToolState("select");
  };

  // Commit the sketch Mirror previews as real entities (mirroring the offset
  // commit path: add the new entities, then re-solve). The previews already
  // carry fresh ids from handlePick, so they commit as-is.
  const commitMirror = async () => {
    const sess = mirrorSession;
    if (!sess || !editingSketch) return;
    if (sess.previews.length === 0 || !sess.axisEntityId || sess.sourceIds.length === 0) {
      cancelMirror();
      return;
    }
    // Commit as an associative DerivedOp: the mirrored copies re-compute from
    // their sources + axis whenever they move (applyDerived runs on solve/regen).
    const op: DerivedOp = {
      id: genId(),
      kind: "mirror",
      axisId: sess.axisEntityId,
      sourceIds: sess.sourceIds,
    };
    const sketchId = editingSketch.id;
    const next = addDerivedOp(sketchBaseDocRef.current, sketchId, op);
    setMirrorSession(null);
    setSelection([]);
    setSketchToolState("select");
    void commitSketchEdit(next, sketchId);
  };
  commitMirrorRef.current = commitMirror;

  const cancelPattern = () => {
    setPatternSession(null);
    setSelection([]);
    setSketchToolState("select");
  };

  // Commit the sketch Pattern as an associative DerivedOp (the copies re-compute
  // from their sources whenever they move — applyDerived runs on solve/regen).
  // A raw-uv circular center first drops a construction point at that spot and
  // references it, so the center stays visible / draggable / dimensionable.
  const commitPattern = async () => {
    const sess = patternSession;
    if (!sess || !editingSketch) return;
    if (sess.sourceIds.length === 0 || (sess.kind === "circular" && !sess.center)) {
      cancelPattern();
      return;
    }
    // Validate the numeric fields like commitOffset: flag and keep the session
    // open so the user can correct them (don't throw, don't silently discard).
    if (resolvePatternCount(sess.count, resolved.scope) === null) {
      flashMsg("Enter an instance count of 2 or more.");
      return;
    }
    if (sess.kind === "linear") {
      let dx = NaN,
        dy = NaN;
      try {
        dx = evaluateExpression(sess.dx, resolved.scope);
        dy = evaluateExpression(sess.dy, resolved.scope);
      } catch {
        /* fall through to the finite check */
      }
      if (!Number.isFinite(dx) || !Number.isFinite(dy) || Math.hypot(dx, dy) < 1e-9) {
        flashMsg("Enter a non-zero numeric step.");
        return;
      }
    } else if (sess.mode === "angle") {
      let a = NaN;
      try {
        a = evaluateExpression(sess.angle, resolved.scope);
      } catch {
        /* as above */
      }
      if (!Number.isFinite(a) || Math.abs(a) < 1e-9) {
        flashMsg("Enter a non-zero numeric angle.");
        return;
      }
    }
    const sketchId = editingSketch.id;
    let next = sketchBaseDocRef.current;
    const opId = genId();
    let op: DerivedOp;
    if (sess.kind === "linear") {
      op = { id: opId, kind: "linearPattern", sourceIds: sess.sourceIds, count: sess.count, dx: sess.dx, dy: sess.dy };
    } else {
      let center = sess.center!;
      if (!("entity" in center) && !("origin" in center) && "at" in center) {
        const pid = genId();
        next = addSketchEntities(next, sketchId, [{ type: "point", id: pid, p: center.at, construction: true }]);
        center = { entity: pid, at: "c" };
      }
      op = {
        id: opId,
        kind: "circularPattern",
        sourceIds: sess.sourceIds,
        center,
        count: sess.count,
        angle: sess.mode === "full" ? "360" : sess.angle,
        symmetric: sess.mode === "angle" && sess.symmetric,
      };
    }
    next = addDerivedOp(next, sketchId, op);
    setPatternSession(null);
    setSelection([]);
    setSketchToolState("select");
    void commitSketchEdit(next, sketchId);
  };
  commitPatternRef.current = commitPattern;

  const cancelProject = () => {
    setProjectSession(null);
    setSketchToolState("select");
  };

  // Commit the Project/Convert previews as an associative `project` DerivedOp:
  // it stores the source edges/vertices (by persistent name) and re-projects them
  // after every kernel build (see the reproject effect), so projected geometry
  // tracks the source body. We seed the op's initial output entities from the
  // live previews (identical geometry, stable `${op.id}:${i}` ids) so there's no
  // flash and the first reproject finds them unchanged.
  const commitProject = async () => {
    const sess = projectSession;
    if (!sess || !editingSketch) return;
    if (sess.refs.length === 0) {
      cancelProject();
      return;
    }
    const sketchId = editingSketch.id;
    const op: DerivedOp = { id: genId(), kind: "project", refs: sess.refs };
    const seeded: SketchEntity[] = sess.previews.map((e, i) => ({
      ...e,
      id: `${op.id}:${i}`,
      derivedFrom: op.id,
    }));
    let next = addDerivedOp(sketchBaseDocRef.current, sketchId, op);
    next = addSketchEntities(next, sketchId, seeded);
    setProjectSession(null);
    setSketchToolState("select");
    void commitSketchEdit(next, sketchId);
  };
  commitProjectRef.current = commitProject;

  // Open the dimension input anchored next to the given entity: a line → length
  // (input next to its midpoint); a circle or arc → radius (input next to its
  // centre). `editId`/`prefill` are supplied when reopening an existing
  // constraint (its label hides while the input is open, and the input shows the
  // stored value); for a fresh dimension the value is computed from the geometry.
  const openDimensionFor = (
    entity: Extract<SketchEntity, { type: "line" | "circle" | "arc" }>,
    editId?: string,
    prefill?: number,
  ) => {
    if (!editingSketch) return;
    const [uv, kind, measured]: [Vec2, "length" | "radius", number] =
      entity.type === "line"
        ? [
            [(entity.a[0] + entity.b[0]) / 2, (entity.a[1] + entity.b[1]) / 2],
            "length",
            Math.hypot(entity.b[0] - entity.a[0], entity.b[1] - entity.a[1]),
          ]
        : [entity.c, "radius", entity.r];
    const s = screenOf(uv);
    setDimPending(false);
    setSelection([{ kind: "sketchEntity", sketchId: editingSketch.id, entityId: entity.id }]);
    setDimInput({ entityId: entity.id, kind, editId, value: fmt(prefill ?? measured), x: s.x, y: s.y });
  };

  // Open the angle input between two lines, anchored between their midpoints.
  // Reopening shows the stored value (`prefill`); a fresh angle is computed from
  // the lines' current included angle (which may be the supplement of what a
  // later constraint settles on, so we never recompute over a stored value).
  const openAngleFor = (
    la: Extract<SketchEntity, { type: "line" }>,
    lb: Extract<SketchEntity, { type: "line" }>,
    editId?: string,
    prefill?: number,
  ) => {
    if (!editingSketch) return;
    const mid = (l: typeof la): Vec2 => [(l.a[0] + l.b[0]) / 2, (l.a[1] + l.b[1]) / 2];
    const angOf = (l: typeof la) => Math.atan2(l.b[1] - l.a[1], l.b[0] - l.a[0]);
    // The interior angle at the lines' shared vertex (vectors pointing away from
    // it) — the angle the user actually sees, not the supplement. Falls back to the
    // folded direction angle when the lines don't touch.
    const interiorDeg = (): number => {
      const k = (p: Vec2) => `${p[0].toFixed(4)},${p[1].toFixed(4)}`;
      let shared: Vec2 | null = null;
      for (const p of [la.a, la.b]) for (const q of [lb.a, lb.b]) if (k(p) === k(q)) shared = p;
      if (!shared) {
        const phi = ((Math.abs(angOf(lb) - angOf(la)) * 180) / Math.PI) % 360;
        return phi > 180 ? 360 - phi : phi;
      }
      const away = (l: typeof la): Vec2 => (k(l.a) === k(shared!) ? l.b : l.a);
      const va = [away(la)[0] - shared[0], away(la)[1] - shared[1]];
      const vb = [away(lb)[0] - shared[0], away(lb)[1] - shared[1]];
      const dot = va[0] * vb[0] + va[1] * vb[1];
      const m = Math.hypot(va[0], va[1]) * Math.hypot(vb[0], vb[1]) || 1;
      return (Math.acos(clamp(dot / m, -1, 1)) * 180) / Math.PI;
    };
    const deg = prefill ?? interiorDeg();
    const ma = mid(la);
    const mb = mid(lb);
    const s = screenOf([(ma[0] + mb[0]) / 2, (ma[1] + mb[1]) / 2]);
    setDimPending(false);
    setDimInput({ entityId: la.id, entityId2: lb.id, kind: "angle", editId, value: fmt(deg), x: s.x, y: s.y });
  };

  // Open the linear-distance input for a pair of sides (point/line/rim each),
  // anchored at the midpoint of the dimension it would draw. `prefill` supplies
  // the stored value when reopening an existing dimension.
  const openDistanceFor = (a: DistanceRef, b: DistanceRef, editId?: string, prefill?: number) => {
    if (!editingSketch) return;
    const ra = resolveSide(a, editingSketch.entities);
    const rb = resolveSide(b, editingSketch.entities);
    if (!ra || !rb) return;
    const m = measureBetween(ra, rb);
    if (!m) return;
    const s = screenOf([(m.wa[0] + m.wb[0]) / 2, (m.wa[1] + m.wb[1]) / 2]);
    setDimPending(false);
    setDimInput({
      entityId: "",
      kind: "distance",
      refs: [a, b],
      editId,
      value: fmt(prefill ?? Math.abs(m.value)),
      x: s.x,
      y: s.y,
    });
  };

  // D (or the ↔ button): dimension the current selection — a single line/circle
  // (length/radius), a distance between two elements (point/line/rim, incl. two
  // PARALLEL lines), or two non-parallel lines (angle) — else arm "pick one to
  // dimension" mode (forcing the Select tool so clicks pick).
  const startDimension = () => {
    if (!editingSketch) return;
    if (dimEntity) return openDimensionFor(dimEntity);
    const pair = computeDistancePair();
    if (pair) return openDistanceFor(pair[0], pair[1]);
    if (twoSelectedLines) return openAngleFor(twoSelectedLines[0], twoSelectedLines[1]);
    setSketchTool("select");
    setDimPending(true);
  };
  startDimensionRef.current = startDimension;

  // Add one geometric (non-dimensional) constraint and re-solve. Like a
  // dimension, one the solver can't satisfy is rejected (not saved as a dead
  // constraint) and reported by `name` instead of silently freezing the
  // geometry; a redundant (already-implied) one is dropped.
  const commitConstraint = async (constraint: SketchConstraint, name: string) => {
    if (!editingSketch) return;
    const sketchId = editingSketch.id;
    // Build on the last committed sketch (a drawn segment may still be solving)
    // and claim the commit up front, so an edit made while the solve below runs
    // stacks on this constraint instead of overwriting it. A rejection hands the
    // claim back — see abandonSketchEdit.
    const previous = sketchBaseDocRef.current;
    const candidate = addSketchConstraints(previous, sketchId, [constraint]);
    const candidateSk = candidate.features.find((f) => f.id === sketchId);
    if (candidateSk?.type !== "sketch") return;
    const seq = beginSketchEdit(candidate);
    const wasDegenerate = degenerateLineIds(previous, sketchId);
    const reject = (msg: string) => {
      abandonSketchEdit(seq, previous);
      flashMsg(msg);
      setSelection([]);
    };
    const { doc: solved, res } = await runSolve(candidate, sketchId);
    // The solver threw: storing the constraint anyway would silently freeze the
    // sketch (saved but never enforced), so reject it like a failed solve.
    if (!res) {
      reject(`${name} couldn't be solved — not applied.`);
      return;
    }
    // A contradictory geometric constraint (e.g. forcing a horizontal and a
    // vertical line parallel) often isn't flagged as a formal conflict —
    // planegcs "satisfies" it by collapsing a line to zero length. So reject on
    // a conflict, a failed/invalid solve, OR a degenerate (near-zero) entity.
    // Only a line THIS constraint collapsed counts against it.
    const collapsed = [...degenerateLineIds(solved, sketchId)].some((id) => !wasDegenerate.has(id));
    if (res.hasConflicts || res.status >= 2 || collapsed) {
      const culprits = conflictNames(candidateSk.constraints, res, constraint.id);
      reject(
        culprits.length
          ? `${name} conflicts with ${culprits.join(" + ")} — not applied. Edit or remove that constraint (Constraints list) instead.`
          : `${name} conflicts with existing constraints — not applied. Edit or remove the conflicting one instead.`,
      );
      return;
    }
    if (await introducedRedundancy(candidateSk.entities, candidateSk.constraints, constraint.id, res)) {
      reject(`${name} is already implied by existing constraints — not added.`);
      return;
    }
    setFullyConstrained(res.dof === 0 && !res.hasConflicts);
    setSolveConflict(res.hasConflicts);
    finishSketchEdit(seq, solved);
    setSelection([]);
  };

  // Add a geometric constraint between two entities (no-op if an equivalent one
  // already exists, to avoid redundant piles).
  const addGeoConstraint = async (type: "parallel" | "perpendicular" | "equal" | "tangent", a: string, b: string) => {
    if (!editingSketch) return;
    const exists = editingSketch.constraints.some(
      (c) =>
        (c.type === "parallel" || c.type === "perpendicular" || c.type === "equal" || c.type === "tangent") &&
        c.type === type &&
        ((c.a === a && c.b === b) || (c.a === b && c.b === a)),
    );
    if (exists) return;
    const name = { parallel: "Parallel", perpendicular: "Perpendicular", equal: "Equal", tangent: "Tangent" }[type];
    await commitConstraint({ id: genId(), type, a, b }, name);
  };

  // Add a Horizontal/Vertical constraint to a single line (no-op if it already
  // has that exact constraint; the opposite one is caught by commitConstraint's
  // own conflict detection, same as any other contradictory pair).
  const addHVConstraint = async (type: "horizontal" | "vertical", entity: string) => {
    if (!editingSketch) return;
    const exists = editingSketch.constraints.some((c) => c.type === type && c.entity === entity);
    if (exists) return;
    const name = type === "horizontal" ? "Horizontal" : "Vertical";
    await commitConstraint({ id: genId(), type, entity }, name);
  };

  // Resolve a selected sketch point (uv) to a PointRef: an entity's named vertex
  // if one sits there, else the sketch origin.
  const pointRefAt = (uv: Vec2): PointRef | null => {
    if (!editingSketch) return null;
    const near = (p: Vec2) => Math.hypot(p[0] - uv[0], p[1] - uv[1]) < 1e-4;
    for (const e of editingSketch.entities) {
      if (e.type === "line") {
        if (near(e.a)) return { entity: e.id, at: "a" };
        if (near(e.b)) return { entity: e.id, at: "b" };
      } else if (e.type === "circle") {
        if (near(e.c)) return { entity: e.id, at: "c" };
      } else if (e.type === "arc") {
        if (near(e.c)) return { entity: e.id, at: "c" };
        // Arc endpoints ("a" = start angle, "b" = end angle).
        if (near([e.c[0] + e.r * Math.cos(e.start), e.c[1] + e.r * Math.sin(e.start)]))
          return { entity: e.id, at: "a" };
        if (near([e.c[0] + e.r * Math.cos(e.end), e.c[1] + e.r * Math.sin(e.end)])) return { entity: e.id, at: "b" };
      }
    }
    if (Math.hypot(uv[0], uv[1]) < 1e-4) return { origin: true };
    return null;
  };

  const samePointRef = (x: PointRef, y: PointRef): boolean => {
    if ("origin" in x || "origin" in y) return "origin" in x && "origin" in y;
    if ("fixed" in x || "fixed" in y)
      return "fixed" in x && "fixed" in y && x.fixed[0] === y.fixed[0] && x.fixed[1] === y.fixed[1];
    return x.entity === y.entity && x.at === y.at;
  };

  // Selected "points" available to a coincident / point-on-line constraint:
  //  • a sketch vertex (entity endpoint / centre, or the origin) → EDITABLE, the
  //    solver may move it.
  //  • a body/solid vertex → an EXTERNAL fixed reference, projected orthographically
  //    onto the active sketch plane. Immovable, so a coincidence pulls the sketch
  //    geometry onto it. This is what makes "sketch vertex ↔ solid face vertex"
  //    coincidence work (previously a solid vertex was ignored, so the button was
  //    either disabled or a lone sketch point silently anchored to the origin).
  const selectedPointRefs: { ref: PointRef; editable: boolean }[] = editingSketch
    ? selection.flatMap((s): { ref: PointRef; editable: boolean }[] => {
        if (s.kind === "sketchPoint" && s.sketchId === editingSketch.id) {
          const ref = pointRefAt(s.point);
          return ref ? [{ ref, editable: true }] : [];
        }
        if (s.kind === "vertex" && dimFrame) {
          return [{ ref: { fixed: worldToUv(dimFrame, s.point) }, editable: false }];
        }
        return [];
      })
    : [];

  // Resolve the current selection to a pair of distance sides for a linear
  // dimension: a selected point/centre/origin → a `point` side; a selected line →
  // a `line` side (perpendicular distance); a selected circle/arc → a `rim` side
  // (nearest boundary). Returns null unless exactly two sides resolve to a
  // non-degenerate measure — and, for two lines, only when they're PARALLEL (an
  // angle is the right dimension otherwise).
  const computeDistancePair = (): [DistanceRef, DistanceRef] | null => {
    if (!editingSketch) return null;
    const refs: DistanceRef[] = [];
    for (const p of selectedSketchPoints) {
      const pr = pointRefAt(p);
      if (!pr) return null; // a free point that isn't a vertex/centre/origin
      refs.push({ on: "point", ref: pr });
    }
    for (const e of selectedSketchEntities) {
      if (e.derivedFrom) return null; // derived geometry isn't constrainable
      if (e.type === "line") refs.push({ on: "line", entity: e.id });
      else if (e.type === "circle" || e.type === "arc") refs.push({ on: "rim", entity: e.id });
      else return null; // spline/point/text aren't dimensioned this way
    }
    if (refs.length !== 2) return null;
    const [a, b] = refs;
    if (a.on === "line" && b.on === "line") {
      const la = ent(a.entity);
      const lb = ent(b.entity);
      if (la?.type !== "line" || lb?.type !== "line") return null;
      const na = Math.hypot(la.b[0] - la.a[0], la.b[1] - la.a[1]);
      const nb = Math.hypot(lb.b[0] - lb.a[0], lb.b[1] - lb.a[1]);
      const cross = (la.b[0] - la.a[0]) * (lb.b[1] - lb.a[1]) - (la.b[1] - la.a[1]) * (lb.b[0] - lb.a[0]);
      if (na < 1e-9 || nb < 1e-9 || Math.abs(cross) / (na * nb) > 1e-3) return null; // not parallel → angle
    }
    const ra = resolveSide(a, editingSketch.entities);
    const rb = resolveSide(b, editingSketch.entities);
    if (!ra || !rb || !measureBetween(ra, rb)) return null; // degenerate (e.g. point on its own centre)
    return [a, b];
  };

  // Coincident, dispatched on the selection (see planCoincident):
  //  • one point + one line → the point lies ON the line (point-on-line). Covers
  //    "square's edge + origin" (origin pulled onto it), "point + edge" (point
  //    attached), and "solid vertex + edge" (the edge moves onto the vertex).
  //  • two points → make them coincident — INCLUDING a sketch vertex + a solid
  //    face vertex (the sketch vertex snaps onto the solid's projected vertex).
  //  • one movable sketch vertex → anchor it to the origin.
  const addCoincident = async () => {
    const plan = planCoincident(
      selectedPointRefs,
      selectedSketchLines.map((l) => l.id),
    );
    if (!plan) return;
    if (plan.kind === "pointOnLine") {
      const exists = editingSketch?.constraints.some(
        (c) => c.type === "pointOnLine" && c.line === plan.lineId && samePointRef(c.point, plan.point),
      );
      if (exists) return;
      await commitConstraint(
        { id: genId(), type: "pointOnLine", point: plan.point, line: plan.lineId },
        "Point on line",
      );
      return;
    }
    const a = plan.kind === "originAnchor" ? plan.point : plan.a;
    const b: PointRef = plan.kind === "originAnchor" ? { origin: true } : plan.b;
    if (samePointRef(a, b)) return;
    const exists = editingSketch?.constraints.some(
      (c) =>
        c.type === "coincident" &&
        ((samePointRef(c.a, a) && samePointRef(c.b, b)) || (samePointRef(c.a, b) && samePointRef(c.b, a))),
    );
    if (exists) return;
    await commitConstraint({ id: genId(), type: "coincident", a, b }, "Coincident");
  };

  // Construction (reference) geometry: with a sketch-entity selection, flip those
  // entities' construction flag; otherwise toggle the draw-mode for new entities.
  const toggleConstruction = () => {
    if (!editingSketch) return;
    if (selectedSketchEntities.length === 0) {
      setConstructionMode((m) => !m);
      return;
    }
    const ids = new Set(selectedSketchEntities.map((e) => e.id));
    const makeConstruction = selectedSketchEntities.some((e) => !e.construction);
    const entities = editingSketch.entities.map((e) => (ids.has(e.id) ? { ...e, construction: makeConstruction } : e));
    setDoc(setSketchEntities(doc, editingSketch.id, entities));
    // Keep the draw-mode button in sync with what the selection just became, so
    // the toolbar reflects the current construction state.
    setConstructionMode(makeConstruction);
  };

  // The seven geometric constraints, keyed for the grouped toolbar button: the
  // icon/kbd node, tooltip, whether the current selection makes it applicable,
  // and the action. `enabled` mirrors each constraint's own selection rule.
  const coincidentEnabled = coincidentIsEnabled(
    selectedPointRefs,
    selectedSketchLines.map((l) => l.id),
  );
  // `icon` is the bare glyph (what the More flyout's icon column shows); `node`
  // is the toolbar button's content — the same glyph plus the "?" shortcut hint.
  const constraintDefs: Record<
    ConstraintKind,
    { icon: ReactNode; node: ReactNode; sc?: string; title: string; enabled: boolean; apply: () => void }
  > = {
    horizontal: {
      icon: <HorizontalIcon />,
      node: (
        <>
          <HorizontalIcon />
          {kbd("H")}
        </>
      ),
      sc: "H",
      title: "Horizontal (H) — select a line",
      enabled: !!oneSelectedLine,
      apply: () => oneSelectedLine && addHVConstraint("horizontal", oneSelectedLine.id),
    },
    vertical: {
      icon: <VerticalIcon />,
      node: (
        <>
          <VerticalIcon />
          {kbd("V")}
        </>
      ),
      sc: "V",
      title: "Vertical (V) — select a line",
      enabled: !!oneSelectedLine,
      apply: () => oneSelectedLine && addHVConstraint("vertical", oneSelectedLine.id),
    },
    parallel: {
      icon: <ParallelIcon />,
      node: (
        <>
          <ParallelIcon />
          {kbd("⇧P")}
        </>
      ),
      sc: "⇧P",
      title: "Parallel (Shift+P) — select two lines",
      enabled: !!twoSelectedLines,
      apply: () => twoSelectedLines && addGeoConstraint("parallel", twoSelectedLines[0].id, twoSelectedLines[1].id),
    },
    perpendicular: {
      icon: <>⊥</>,
      node: <>⊥{kbd("N")}</>,
      sc: "N",
      title: "Perpendicular (N) — select two lines",
      enabled: !!twoSelectedLines,
      apply: () =>
        twoSelectedLines && addGeoConstraint("perpendicular", twoSelectedLines[0].id, twoSelectedLines[1].id),
    },
    equal: {
      icon: <>＝</>,
      node: <>＝{kbd("=")}</>,
      sc: "=",
      title: "Equal (=) — select two lines (equal length) or two circles/arcs (equal radius)",
      enabled: !!(twoSelectedLines || twoRadiusEntities),
      apply: () => {
        const pair = twoSelectedLines ?? twoRadiusEntities;
        if (pair) addGeoConstraint("equal", pair[0].id, pair[1].id);
      },
    },
    coincident: {
      icon: <>⌖</>,
      node: <>⌖</>,
      title:
        "Coincident — two points make them coincident (a sketch vertex snaps onto a solid/body vertex too); a point + a line puts the point on the line; one point anchors it to the origin",
      enabled: coincidentEnabled,
      apply: addCoincident,
    },
    tangent: {
      icon: <>◯⌐</>,
      node: <>◯⌐</>,
      title: "Tangent — select two curves (circle/arc) or a line and a curve",
      enabled: !!tangentPair,
      apply: () => tangentPair && addGeoConstraint("tangent", tangentPair[0].id, tangentPair[1].id),
    },
  };

  // Remove a single constraint (from the constraints list) and re-solve.
  const deleteConstraint = async (id: string) => {
    if (!editingSketch) return;
    const next = removeSketchConstraint(sketchBaseDocRef.current, editingSketch.id, id);
    await commitSketchEdit(next, editingSketch.id);
  };

  // Reopen the editor for an existing constraint (double-clicking its label).
  const editConstraint = (constraintId: string) => {
    if (!editingSketch) return;
    const c = editingSketch.constraints.find((x) => x.id === constraintId);
    if (!c) return;
    if (c.type === "distance" || c.type === "radius") {
      const e = ent(c.entity);
      if (e?.type === "line" || e?.type === "circle" || e?.type === "arc") openDimensionFor(e, c.id, c.value);
    } else if (c.type === "distanceBetween") {
      openDistanceFor(c.a, c.b, c.id, c.value);
    } else if (c.type === "angle") {
      const la = ent(c.a);
      const lb = ent(c.b);
      if (la?.type === "line" && lb?.type === "line") openAngleFor(la, lb, c.id, c.value);
    }
  };

  // Apply the entered value as a `distance` (line), `radius` (circle), or `angle`
  // (line–line) constraint and immediately re-solve. Replaces any prior dimension
  // of the same kind on the same entity/pair.
  const applyDimension = async () => {
    if (!dimInput || !editingSketch) return;
    const sketchId = editingSketch.id;
    const { kind, entityId, entityId2 } = dimInput;
    // Evaluate against the variable scope so a number, expression, or variable
    // name all work. (Note: this resolves to a number now; a live expression
    // link that re-evaluates on variable change is a deferred Phase-2 gap.)
    let value = NaN;
    try {
      value = evaluateExpression(dimInput.value, resolved.scope);
    } catch {
      value = NaN;
    }
    setDimInput(null);
    // Angles accept 0–180; lengths/radii must be positive.
    if (!Number.isFinite(value) || (kind === "angle" ? value < 0 || value >= 180 : value <= 0)) return;

    const samePair = (a: string, b: string) =>
      (a === entityId && b === entityId2) || (a === entityId2 && b === entityId);
    // Order-independent equality of two distance sides / pairs, so re-dimensioning
    // the same two elements replaces the prior dimension instead of stacking.
    const sameSide = (x: DistanceRef, y: DistanceRef): boolean =>
      x.on !== y.on
        ? false
        : x.on === "point" && y.on === "point"
          ? samePointRef(x.ref, y.ref)
          : (x as { entity: string }).entity === (y as { entity: string }).entity;
    const samePairRefs = (p: [DistanceRef, DistanceRef], q: [DistanceRef, DistanceRef]) =>
      (sameSide(p[0], q[0]) && sameSide(p[1], q[1])) || (sameSide(p[0], q[1]) && sameSide(p[1], q[0]));
    // Filter the constraints of the LAST COMMITTED sketch, not this render's —
    // rebuilding the list from a stale copy would drop anything a still-solving
    // edit added (see sketchBaseDocRef).
    const previous = sketchBaseDocRef.current;
    const baseSk = previous.features.find((f) => f.id === sketchId);
    if (baseSk?.type !== "sketch") return;
    const kept = baseSk.constraints.filter((c) => {
      if (c.id === dimInput.editId) return false; // the one being edited is replaced
      if (kind === "distance")
        return !(c.type === "distanceBetween" && dimInput.refs != null && samePairRefs([c.a, c.b], dimInput.refs));
      if (kind === "angle") return !(c.type === "angle" && samePair(c.a, c.b));
      const ctype = kind === "radius" ? "radius" : "distance";
      return !(c.type === ctype && c.entity === entityId);
    });
    const added: SketchConstraint =
      kind === "distance"
        ? { id: genId(), type: "distanceBetween", a: dimInput.refs![0], b: dimInput.refs![1], value }
        : kind === "angle"
          ? { id: genId(), type: "angle", a: entityId, b: entityId2!, value }
          : { id: genId(), type: kind === "radius" ? "radius" : "distance", entity: entityId, value };
    const candidate = setSketchConstraints(previous, sketchId, [...kept, added]);
    const candidateSk = candidate.features.find((f) => f.id === sketchId);
    if (candidateSk?.type !== "sketch") return;
    // Claim the commit before solving so a concurrent edit stacks on this
    // dimension; a rejection below hands the claim back.
    const seq = beginSketchEdit(candidate);
    const wasDegenerate = degenerateLineIds(previous, sketchId);
    const reject = (msg: string) => {
      abandonSketchEdit(seq, previous);
      flashMsg(msg);
      setSelection([]);
    };
    const { doc: solved, res } = await runSolve(candidate, sketchId);
    // A dimension the solver can't satisfy would otherwise be saved as a dead
    // constraint that silently freezes (or wrecks) the geometry. Reject it and tell
    // the user — the sketch is left exactly as it was. As with geometric
    // constraints, an over-constraint shows as `hasConflicts`, but an impossible
    // one (e.g. a second right angle in a triangle) instead fails the solve or
    // collapses a line to zero length, so check those too. A solver THROW must
    // also reject: storing the dimension unsolved would show the new value on the
    // label while the geometry silently stays put.
    if (!res) {
      reject(`That ${kind} couldn't be solved — not applied.`);
      return;
    }
    // Only a line THIS constraint collapsed counts against it.
    const collapsed = [...degenerateLineIds(solved, sketchId)].some((id) => !wasDegenerate.has(id));
    if (res.hasConflicts || res.status >= 2 || collapsed) {
      const culprits = conflictNames(candidateSk.constraints, res, added.id);
      reject(
        culprits.length
          ? `That ${kind} conflicts with ${culprits.join(" + ")} — not applied. Edit or remove that constraint (Constraints list) instead.`
          : `That ${kind} can't be satisfied with the existing constraints — not applied. Edit or remove a conflicting one instead.`,
      );
      return;
    }
    // A dimension on an already-driven length (e.g. the opposite side of a
    // rectangle) solves "fine" but is dead weight: it changes nothing now and
    // makes every later edit of the coupled dimension conflict. Reject it.
    if (await introducedRedundancy(candidateSk.entities, candidateSk.constraints, added.id, res)) {
      reject(
        `That ${kind} is already driven by the existing constraints — not added. Edit the existing dimension instead.`,
      );
      return;
    }
    setFullyConstrained(res.dof === 0 && !res.hasConflicts);
    setSolveConflict(res.hasConflicts);
    finishSketchEdit(seq, solved);
    setSelection([]);
  };

  const errorCount =
    Object.keys(errors).length +
    Object.keys(resolved.variableErrors).length +
    Object.keys(resolved.variableNameErrors).length;
  // Human-readable breakdown of every current error, shown when hovering the
  // status badge (the count alone is a dead end otherwise). Feature errors are
  // labelled by feature name; variable errors by their key.
  const errorDetail = [
    ...Object.entries(errors).map(([id, msg]) => `${doc.features.find((f) => f.id === id)?.name ?? id}: ${msg}`),
    ...Object.entries(resolved.variableErrors).map(([k, msg]) => `Variable ${k}: ${msg}`),
    ...Object.entries(resolved.variableNameErrors).map(([k, msg]) => `Variable name ${k}: ${msg}`),
  ].join("\n");
  // How far a long rebuild has got, when the worker reports it. Kept beside the
  // spinner: the glyph says "working", this says "and how far".
  const meshPercent =
    busy && meshProgress ? Math.round((100 * meshProgress.done) / Math.max(1, meshProgress.total)) : null;
  // The sentence. Only the error states still SHOW it (see the chip below), but
  // it stays in the DOM either way — screen readers need it, and the E2E
  // harnesses poll this chip's text to know the app has settled.
  const status = fatal
    ? "kernel error"
    : busy
      ? meshPercent !== null
        ? `processing ${meshPercent}%…`
        : "processing…"
      : errorCount > 0
        ? `${errorCount} error${errorCount > 1 ? "s" : ""}`
        : "up to date";
  const statusClass = fatal || errorCount > 0 ? "err" : busy ? "busy" : "idle";

  const handleAdd = (kind: FeatureKind) => {
    const { doc: next, id } = addFeature(doc, kind);
    setDoc(next);
    selectFeature(id);
  };

  // Opens the Boolean dialog, auto-populating operands from whatever solids
  // are already selected (deduped, in selection order). Defaults to union; the
  // base/tools split (for subtract) is seeded from the same list.
  const openBooleanDialog = () => {
    const candidateIds = new Set(booleanCandidates.map((c) => c.id));
    const operandIds = [...new Set(selection.map(featureIdOf))].filter((id) => candidateIds.has(id));
    setBooleanDialog({
      op: "union",
      operandIds,
      base: operandIds[0] ?? null,
      tools: operandIds.slice(1),
      armed: null,
    });
  };

  // Switch op, converting the operand representation between the flat list
  // (union/intersect) and the base+tools split (subtract) so picks aren't lost.
  const setBooleanOp = (op: BooleanOp) => {
    setBooleanDialog((d) => {
      if (!d) return d;
      const flat = d.op === "subtract" ? [d.base, ...d.tools].filter((x): x is string => !!x) : d.operandIds;
      if (op === "subtract") {
        const base = flat[0] ?? null;
        return { ...d, op, base, tools: flat.slice(1), armed: base ? "tools" : "base" };
      }
      return { ...d, op, operandIds: flat, armed: null };
    });
  };

  // Valid operand list for the current boolean dialog, or null while incomplete.
  const booleanOperands = (d: NonNullable<typeof booleanDialog>): string[] | null =>
    d.op === "subtract"
      ? d.base && d.tools.length >= 1
        ? [d.base, ...d.tools]
        : null
      : d.operandIds.length >= 2
        ? d.operandIds
        : null;
  const closeBooleanDialog = () => {
    setBooleanDialog(null);
    cancelEdit();
  };
  // Live-preview a boolean edit as operands/op change.
  useEffect(() => {
    const d = booleanDialog;
    if (!d?.editId) return;
    const operands = booleanOperands(d);
    if (!operands) return;
    if (!shouldLiveApply(JSON.stringify({ e: d.editId, op: d.op, operands }))) return;
    setDoc((prev) => updateBoolean(prev, d.editId!, d.op, operands), `edit:${d.editId}`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [booleanDialog]);
  const confirmBoolean = () => {
    if (!booleanDialog) return;
    const d = booleanDialog;
    const operands = booleanOperands(d);
    if (!operands) return;
    if (d.editId) {
      setDoc(updateBoolean(doc, d.editId, d.op, operands));
      selectFeature(d.editId);
      commitEdit();
      closeBooleanDialog();
      return;
    }
    const { doc: next } = addBoolean(doc, d.op, operands);
    setDoc(next);
    selectFeature(null);
    closeBooleanDialog();
  };

  // Re-open the Boolean dialog to edit an existing boolean in place. Seeds the op
  // + operands; clicking bodies re-picks operands exactly as at creation.
  const editBoolean = (id: string) => {
    const f = doc.features.find((x) => x.id === id);
    if (f?.type !== "boolean") return;
    beginEdit(f);
    selectFeature(id);
    setBooleanDialog({
      op: f.op,
      operandIds: f.operands,
      base: f.operands[0] ?? null,
      tools: f.operands.slice(1),
      armed: null,
      editId: id,
    });
  };

  // Per-operand viewport highlight while the dialog is open: union → all orange;
  // subtract → base orange, tools cyan; intersect → all cyan (overlap reads
  // through). Colors are the shared SELECT_COLOR / GHOST_COLOR refs in Viewport.
  const booleanHighlight = useMemo(() => {
    const d = booleanDialog;
    if (!d) return null;
    if (d.op === "subtract") return { orange: new Set(d.base ? [d.base] : []), cyan: new Set(d.tools) };
    if (d.op === "intersect") return { orange: new Set<string>(), cyan: new Set(d.operandIds) };
    return { orange: new Set(d.operandIds), cyan: new Set<string>() };
  }, [booleanDialog]);

  const handleDelete = (id: string) => {
    setDoc(removeFeature(doc, id));
    setSelection((prev) => prev.filter((s) => featureIdOf(s) !== id));
    if (editingSketchId === id) setEditingSketchId(null);
  };

  const handleSolidColor = (id: string, color: number) => {
    setDoc(setFeatureColor(doc, id, color), `color:${id}`);
    setSelection([]); // deselect so the new color isn't masked by the highlight
  };

  const handleSolidOpacity = (id: string, opacity: number) =>
    setDoc(setFeatureOpacity(doc, id, opacity), `opacity:${id}`);

  const handleSolidHidden = (id: string, hidden: boolean) => setDoc(setFeatureHidden(doc, id, hidden));

  const exportSolid = (id: string, format: "step" | "stl") => {
    const kernel = kernelRef.current;
    // `id` is a result-body id (a rendered mesh). The worker replays the feature
    // list and exports that body from the running model.
    if (!kernel || !rawMeshes.some((m) => m.id === id)) {
      setFatal("Can't export: this solid has no resolved geometry right now.");
      return;
    }
    const name = doc.features.find((f) => f.id === id)?.name ?? id;
    kernel
      .exportBody(resolved.features, id, format)
      .then((blob) => downloadBlob(blob, `${safeFilename(name)}.${format}`))
      .catch((err) => setFatal(String(err?.message ?? err)));
  };

  const handleExportStep = (id: string) => exportSolid(id, "step");
  const handleExportStl = (id: string) => exportSolid(id, "stl");

  // Import a local STEP file as a new part (the kernel parses it on regen).
  const handleImportFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ""; // reset so the same file can be re-imported
    if (!file) return;
    const text = await file.text();
    const base = file.name.replace(/\.(step|stp)$/i, "");
    const { doc: next } = addImport(doc, text, base);
    setDoc(next);
    selectFeature(null); // leave the import deselected — it's usually reference context
  };

  // DXF import: parse into native sketch geometry (unlike STEP, which stays an
  // opaque body). Picking the file opens a placement dialog to choose the plane
  // and unit scale; the sketch is created on confirm.
  const handleDxfFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    const text = await file.text();
    let preview = { total: 0, skipped: 0 };
    try {
      const res = parseDxfToEntities(text); // scale-independent counts for preview
      preview = {
        total: res.entities.length,
        skipped: Object.values(res.skipped).reduce((a, b) => a + b, 0),
      };
    } catch {
      flashMsg("Couldn't read that DXF file.");
      return;
    }
    setDxfDialog({
      fileName: file.name,
      text,
      planeKey: "datum:plane-top",
      unitsKey: guessDxfUnits(text) ?? "mm", // preselect from the $INSUNITS header
      preview,
    });
  };

  const confirmDxfImport = () => {
    if (!dxfDialog) return;
    const { entities, skipped } = parseDxfToEntities(dxfDialog.text, { scale: dxfScaleOf(dxfDialog.unitsKey) });
    if (entities.length === 0) {
      flashMsg("No importable geometry found in that DXF.");
      setDxfDialog(null);
      return;
    }
    const ref = planeKeyToRef(dxfDialog.planeKey);
    const { doc: withSketch, id } = addSketch(doc, ref);
    const next = addSketchEntities(withSketch, id, entities);
    setDoc(next);
    selectFeature(id);
    setEditingSketchId(id);
    setSketchTool("select");
    setFullyConstrained(false);
    // Frame the imported geometry, not the plane origin — a DXF's own coordinates
    // often sit far from (0,0), so aiming at the origin leaves the sketch
    // off-screen (the "imported but nothing visible" report).
    const frame = frameOf(ref, resolved.planeFrames);
    const bounds = sketchEntitiesBounds(entities);
    if (bounds) viewApiRef.current?.frameSketchBounds(frame, bounds.min, bounds.max);
    else viewApiRef.current?.lookAtFrame(frame);
    const skippedCount = Object.values(skipped).reduce((a, b) => a + b, 0);
    const skipMsg = skippedCount ? ` (skipped ${skippedCount} unsupported: ${Object.keys(skipped).join(", ")})` : "";
    flashMsg(`Imported ${entities.length} entities from ${dxfDialog.fileName}${skipMsg}.`);
    setDxfDialog(null);
  };

  // Delete key from the viewport: whole bodies/sketches (feature, face, edge,
  // vertex picks) are removed entirely; sketchEntity picks remove just that
  // line/curve. Bare sketchPoint/sketchFace picks have no deletion target.
  const handleDeleteSelection = () => {
    const featureIds = new Set<string>();
    const entityRefs: { sketchId: string; entityId: string }[] = [];
    for (const s of selection) {
      if (s.kind === "feature" || s.kind === "face" || s.kind === "edge" || s.kind === "vertex") {
        featureIds.add(featureIdOf(s));
      } else if (s.kind === "sketchEntity") {
        entityRefs.push({ sketchId: s.sketchId, entityId: s.entityId });
      }
    }
    // Entering sketch edit selects the sketch feature (for the timeline/param
    // highlight), and edge/vertex picks then accumulate on top. While editing,
    // Delete must act on the picked geometry — never wipe the whole sketch out
    // from under the editor. To delete the sketch itself, finish editing first
    // (or use the timeline ✕).
    if (editingSketchId) featureIds.delete(editingSketchId);
    let next = doc;
    for (const { sketchId, entityId } of entityRefs) {
      if (featureIds.has(sketchId)) continue; // whole sketch is already going away
      next = removeSketchEntity(next, sketchId, entityId);
    }
    for (const id of featureIds) {
      next = removeFeature(next, id);
    }
    if (next === doc) return;
    setDoc(next);
    setSelection([]);
    if (editingSketchId && featureIds.has(editingSketchId)) setEditingSketchId(null);
    if (entityRefs.length > 0) setFullyConstrained(false);
  };

  // The sketch toolbar as slots: <OverflowColumn> shows as many as fit down the
  // window and moves the rest into its "⋯" flyout. Each slot carries the rows
  // the flyout lists for it — a separator or the constraint-count badge carries
  // none, so it simply drops out when there's no room.
  const sketchToolRow = (tool: SketchTool, extra?: Partial<ToolbarRow>): ToolbarRow => {
    const t = sketchToolMeta(tool);
    return {
      id: `tool:${tool}`,
      itemId: `tool:${tool}`,
      icon: t.label,
      label: t.name,
      shortcut: t.sc,
      title: t.title,
      disabled: false,
      keywords: [],
      onSelect: () => setSketchTool(tool),
      ...extra,
    };
  };
  const sketchSlots: ColumnSlot[] = !editingSketch
    ? []
    : [
        ...SKETCH_LAYOUT.map((slot): ColumnSlot => {
          if (slot.kind === "tool") {
            const t = sketchToolMeta(slot.tool);
            // Offset needs a selected chain of edges — grey it out when
            // nothing is selected.
            const disabled = slot.tool === "offset" && selectedSketchEntities.length === 0;
            return {
              id: `tool:${t.tool}`,
              rows: [sketchToolRow(slot.tool, { disabled })],
              node: (
                <button
                  className={sketchTool === t.tool ? "active" : ""}
                  title={t.title}
                  disabled={disabled}
                  onClick={() => setSketchTool(t.tool)}
                >
                  {t.label}
                  {kbd(t.sc)}
                </button>
              ),
            };
          }
          const g = SKETCH_GROUPS[slot.group];
          const variant =
            slot.group === "circle" ? circleVariant : slot.group === "rect" ? rectVariant : patternVariant;
          const groupActive = (g.variants as readonly SketchTool[]).includes(sketchTool);
          const expanded = expandedSketchGroup === slot.group;
          const vm = sketchToolMeta(variant);
          return {
            id: `group:${slot.group}`,
            // Both variants are searchable in their own right ("3 points", "center").
            rows: g.variants.map((tv) =>
              sketchToolRow(tv, {
                id: `group:${slot.group}/${tv}`,
                label: `${g.name} ▸ ${SKETCH_VARIANT_NAME[tv] ?? sketchToolMeta(tv).name}`,
              }),
            ),
            node: (
              <div className="sketch-group">
                {/* Primary applies the last-used variant; ▸ opens the vertical
                flyout of variants (to the right of the toolbar). */}
                <button
                  className={"sketch-group-primary" + (groupActive ? " active" : "")}
                  title={vm.title}
                  onClick={() => setSketchTool(variant)}
                >
                  {vm.label}
                  {kbd(vm.sc)}
                </button>
                <button
                  className={"sketch-group-arrow" + (expanded ? " expanded" : "")}
                  title={g.title}
                  aria-expanded={expanded}
                  onClick={() => setExpandedSketchGroup(expanded ? null : slot.group)}
                >
                  ▸
                </button>
                {expanded && (
                  <div className="sketch-flyout">
                    {g.variants.map((tv) => {
                      const t = sketchToolMeta(tv);
                      return (
                        <button
                          key={tv}
                          className={sketchTool === tv ? "active" : ""}
                          title={t.title}
                          onClick={() => setSketchTool(tv)}
                        >
                          <span className="cf-icon">{t.label}</span>
                          <span className="cf-name">
                            {SKETCH_VARIANT_NAME[tv] ?? t.title}
                            {kbd(t.sc)}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            ),
          };
        }),
        {
          id: "dimension",
          rows: [
            {
              id: "dimension",
              itemId: "dimension",
              icon: "↔",
              label: "Dimension",
              shortcut: "D",
              title:
                "Dimension (D): a line (length), circle (radius), or two lines (angle) — pick one if none selected",
              disabled: false,
              keywords: ["length", "radius", "angle", "distance"],
              onSelect: () => startDimension(),
            },
          ],
          node: (
            <button
              title="Dimension (D): a line (length), circle (radius), or two lines (angle) — pick one if none selected"
              className={dimPending ? "active" : ""}
              onClick={startDimension}
            >
              ↔{kbd("D")}
            </button>
          ),
        },
        { id: "sep1", rows: [], node: <div className="sketch-toolbar-sep" /> },
        {
          id: "constraints",
          rows: CONSTRAINT_ORDER.map((k) => ({
            id: `constraint:${k}`,
            itemId: "constraints",
            icon: constraintDefs[k].icon,
            label: CONSTRAINT_NAME[k],
            shortcut: constraintDefs[k].sc,
            title: constraintDefs[k].title,
            disabled: !constraintDefs[k].enabled,
            keywords: ["constraint"],
            onSelect: () => {
              setConstraintChoice(k);
              constraintDefs[k].apply();
            },
          })),
          node: (
            /* All seven geometric constraints behind one button: the primary
           applies the last-used one; ▸ opens a vertical flyout (to the
           right of the toolbar) of every choice. Disabled choices show
           what selection they need via their tooltip. */
            <div className="constraint-group">
              <button
                className="constraint-primary"
                title={constraintDefs[constraintChoice].title}
                disabled={!constraintDefs[constraintChoice].enabled}
                onClick={() => constraintDefs[constraintChoice].apply()}
              >
                {constraintDefs[constraintChoice].node}
              </button>
              <button
                className={"constraint-arrow" + (constraintFlyoutOpen ? " expanded" : "")}
                title="More constraints"
                aria-expanded={constraintFlyoutOpen}
                onClick={() => setConstraintFlyoutOpen((v) => !v)}
              >
                ▸
              </button>
              {constraintFlyoutOpen && (
                <div className="constraint-flyout">
                  {CONSTRAINT_ORDER.map((k) => {
                    const d = constraintDefs[k];
                    return (
                      <button
                        key={k}
                        className={k === constraintChoice ? "active" : ""}
                        title={d.title}
                        disabled={!d.enabled}
                        onClick={() => {
                          setConstraintChoice(k);
                          setConstraintFlyoutOpen(false);
                          d.apply();
                        }}
                      >
                        <span className="cf-icon">{d.node}</span>
                        <span className="cf-name">{CONSTRAINT_NAME[k]}</span>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          ),
        },
        { id: "sep2", rows: [], node: <div className="sketch-toolbar-sep" /> },
        {
          id: "construction",
          rows: [
            {
              id: "construction",
              itemId: "construction",
              icon: <ConstructionIcon />,
              label: "Construction",
              shortcut: "Q",
              title: "Construction (Q): reference geometry — toggle the draw mode, or convert the selection",
              disabled: false,
              keywords: ["reference", "guide"],
              onSelect: () => toggleConstruction(),
            },
          ],
          node: (
            <button
              title={
                selectedSketchEntities.length > 0
                  ? "Construction (Q): toggle construction (reference) geometry on the selection"
                  : "Construction (Q): draw reference geometry (toggle)"
              }
              className={constructionMode ? "active" : ""}
              onClick={toggleConstruction}
            >
              <ConstructionIcon />
              {kbd("Q")}
            </button>
          ),
        },
        ...(editingSketch.constraints.length > 0
          ? [
              {
                id: "constraint-count",
                rows: [],
                node: (
                  <span
                    className={`constraint-count${solveConflict ? " conflict" : ""}`}
                    title={
                      solveConflict
                        ? "Over-constrained / conflicting constraints"
                        : `${editingSketch.constraints.length} constraints${fullyConstrained ? " · fully constrained" : ""}`
                    }
                  >
                    {solveConflict ? "⚠" : fullyConstrained ? "✓" : editingSketch.constraints.length}
                  </span>
                ),
              } satisfies ColumnSlot,
            ]
          : []),
      ];

  // The modeling toolbar as data: <OverflowToolbar> renders as many of these as
  // fit and collapses the rest into its searchable "More ▾" flyout. `keywords`
  // are the search-only synonyms (they never show in the UI).
  const modelTools: ToolbarItem[] = [
    {
      id: "sketch",
      icon: "✎",
      label: "Sketch",
      shortcut: "S",
      title: "Sketch (S): start a sketch — pick a plane or face",
      keywords: ["draw", "2d", "profile"],
      disabled: !!editingSketch || picking,
      onSelect: () => {
        setPickPurpose("sketch");
        setPicking(true);
      },
    },
    {
      id: "body",
      icon: "◧",
      label: "Body",
      shortcut: "N",
      title: "New Body (N): create a new solid body",
      keywords: ["new", "primitive", "solid"],
      disabled: !!editingSketch,
      onSelect: () => setNewSolidOpen((o) => !o),
      choices: FEATURE_KINDS.map((kind) => ({
        id: kind,
        label: FEATURE_DEFS[kind].label,
        onSelect: () => handleAdd(kind),
      })),
      choicesOpen: newSolidOpen,
      onChoicesOpenChange: setNewSolidOpen,
    },
    {
      id: "plane",
      icon: "⧉",
      label: "Plane",
      shortcut: "P",
      title: "Plane (P): create a reference plane (offset, midplane, at-angle, or through 3 points)",
      keywords: ["datum", "reference", "offset", "midplane"],
      disabled: !!editingSketch || picking || !!planeDialog,
      onSelect: openPlaneDialog,
    },
    {
      id: "extrude",
      icon: "⬆",
      label: "Extrude",
      shortcut: "E",
      title: "Extrude (E): extrude the selected sketch region(s) and/or face(s)",
      keywords: ["pad", "boss", "pocket", "cut", "hole"],
      disabled: extrudeProfiles.length === 0 || !!editingSketch || picking || !!extrudeDialog,
      onSelect: openExtrudeDialog,
    },
    {
      id: "revolve",
      icon: "⟳",
      label: "Revolve",
      shortcut: "R",
      title: "Revolve (R): select a profile (sketch region or planar face) + an axis (edge or plane) in the dialog",
      keywords: ["lathe", "turn", "axis"],
      disabled: !!editingSketch || picking || !!revolveDialog,
      onSelect: openRevolve,
    },
    {
      id: "sweep",
      icon: "⊃",
      label: "Sweep",
      shortcut: "W",
      title: "Sweep (W): sweep a sketch region along a path — line / arc / spline (select both)",
      keywords: ["path", "rail"],
      disabled: !sweepInputs || !!editingSketch || picking,
      onSelect: openSweep,
    },
    {
      id: "loft",
      icon: "⌧",
      label: "Loft",
      shortcut: "L",
      title: "Loft (L): loft through 2+ sketch regions (select the sections)",
      keywords: ["blend", "sections"],
      disabled: !loftInputs || !!editingSketch || picking,
      onSelect: openLoft,
    },
    {
      id: "chamfer",
      icon: "◣",
      label: "Chamfer",
      shortcut: "C",
      title: "Chamfer (C): chamfer the selected edge(s) or face(s)",
      keywords: ["bevel", "edge", "face"],
      disabled: !dressUpTarget || !!editingSketch || picking,
      onSelect: () => openDressUp("chamfer"),
    },
    {
      id: "fillet",
      icon: "◖",
      label: "Fillet",
      shortcut: "F",
      title: "Fillet (F): round the selected edge(s) or face(s)",
      keywords: ["round", "radius", "edge", "face"],
      disabled: !dressUpTarget || !!editingSketch || picking,
      onSelect: () => openDressUp("fillet"),
    },
    {
      id: "shell",
      icon: "▢",
      label: "Shell",
      shortcut: "G",
      title: "Shell (G): hollow a body — select it in the dialog; sealed by default, open faces from there too",
      keywords: ["hollow", "thickness", "wall", "enclosure", "thicken"],
      disabled: !!editingSketch || picking || !!shellDialog,
      onSelect: openShell,
    },
    {
      id: "boolean",
      icon: "⊕",
      label: "Boolean",
      shortcut: "B",
      title: "Boolean (B): union / subtract / intersect",
      keywords: ["union", "subtract", "intersect", "combine", "cut"],
      disabled: bodyIds.size < 2 || !!editingSketch || picking,
      onSelect: openBooleanDialog,
    },
    {
      id: "transform",
      icon: "✥",
      label: "Transform",
      shortcut: "T",
      title: "Transform (T): move / rotate / scale a body — pick one first, or arm and click it in the viewport",
      disabled: !!editingSketch || picking || !!transformEditId || !!transformArming,
      // The button itself opens the gizmo on Move — its natural default — so it
      // stays a plain one-click action (choicesSearchOnly). The modes exist as
      // their own rows in the "/" flyout, where "rotate" or "resize" should land
      // you straight in the right tab rather than on a generic "Transform".
      onSelect: () => openTransform(),
      choicesSearchOnly: true,
      choices: [
        {
          id: "move",
          label: "Move",
          keywords: ["translate", "position"],
          title: "Move (Transform): move a body",
          onSelect: () => openTransform("translate"),
        },
        {
          id: "rotate",
          label: "Rotate",
          keywords: ["spin", "orient"],
          title: "Rotate (Transform): rotate a body about an axis",
          onSelect: () => openTransform("rotate"),
        },
        {
          id: "scale",
          label: "Scale",
          keywords: ["resize", "size"],
          title: "Scale (Transform): scale a body uniformly",
          onSelect: () => openTransform("scale"),
        },
      ],
    },
    {
      id: "mirror",
      icon: "⇋",
      label: "Mirror",
      shortcut: "M",
      title: "Mirror (M): mirror the selected body across a plane",
      keywords: ["reflect", "symmetry"],
      disabled: !transformTarget || !!editingSketch || picking,
      onSelect: openMirror,
    },
    {
      id: "pattern",
      icon: "⁙",
      label: "Pattern",
      shortcut: "X",
      title: "Pattern (X): arm a body, then a linear run/grid or a circular ring",
      keywords: ["array", "linear", "circular", "grid", "repeat"],
      disabled: !!editingSketch || picking || !!patternDialog,
      onSelect: openPattern,
    },
  ];

  return (
    <div className="app">
      <header className="topbar">
        <span className="logo">Open Poly</span>
        {titleDraft === null ? (
          <button className="doc-title" title="Rename document" onClick={() => setTitleDraft(docName)}>
            {docName}
          </button>
        ) : (
          <input
            className="doc-title-input"
            autoFocus
            value={titleDraft}
            onChange={(e) => setTitleDraft(e.target.value)}
            onFocus={(e) => e.target.select()}
            onBlur={() => {
              // Commit on blur; an all-whitespace draft reverts.
              const trimmed = titleDraft.trim();
              if (trimmed) setDocName(trimmed);
              setTitleDraft(null);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") (e.target as HTMLInputElement).blur();
              else if (e.key === "Escape") setTitleDraft(null);
            }}
          />
        )}
        <div className="doc-actions">
          <button
            className="text-btn newdoc-btn"
            title="Create and open a new empty document"
            onClick={() => void newDocument()}
          >
            ＋ New
          </button>
          <button className="text-btn docs-btn" title="Open a document" onClick={() => setDocsDialogOpen(true)}>
            Open…
          </button>
        </div>
        {docInOtherTab && (
          <span
            className="tab-warning"
            title="This document is open in another tab — concurrent edits will overwrite each other."
          >
            ⚠ Also open in another tab
          </span>
        )}
        {/* Undo/redo belong to the document, so they stay on the left with it.
            The app-level chrome (?, settings, report) sits at the far right —
            see .topbar-chrome below the status chip. */}
        <div className="topbar-actions">
          <button className="tool-btn" onClick={undo} disabled={!canUndo} title="Undo (⌘Z)">
            ↶
          </button>
          <button className="tool-btn" onClick={redo} disabled={!canRedo} title="Redo (⌘⇧Z)">
            ↷
          </button>
        </div>
        {/* The right-hand cluster is one group, not three loose children: the
            topbar's own 16px gap is meant to separate sections, and applied
            between the badge, the chip and the buttons it left them adrift. */}
        <div className="topbar-right">
          {agentStatus === "connected" && (
            <span className="agent-badge" title="An LLM agent is connected to this tab">
              ● Agent connected
            </span>
          )}
          {/* The two everyday states are glanced at, not read, so they're
              glyphs: a spinner while the kernel works, a tick once it's caught
              up. Errors keep their words — those you do read. The sentence
              rides along hidden for screen readers, and as the hover title,
              since a lone tick doesn't say what it's the tick for. */}
          <span className={`status ${statusClass}`} title={fatal ?? (errorDetail || status)}>
            {statusClass === "err" ? (
              status
            ) : (
              <>
                {statusClass === "busy" ? (
                  <span className="status-spinner" aria-hidden />
                ) : (
                  <span className="status-check" aria-hidden>
                    ✓
                  </span>
                )}
                {meshPercent !== null && <span aria-hidden>{meshPercent}%</span>}
                <span className="sr-only">{status}</span>
              </>
            )}
          </span>
          {/* App-level chrome, parked at the right edge past the status: none of
              it belongs to the document, and mixed in with New/Open/undo on the
              left it read as five unrelated things in a row. Icons only — these
              are recognised, not read, and the labels live in their tooltips. */}
          <div className="topbar-chrome">
            {/* Named, not a bare glyph: a lone "?" beside the gear read as
                "help", not "show me the shortcuts". The key that toggles it
                rides along as a key cap, the same treatment every shortcut
                gets on every other button. */}
            <button
              className={"tool-btn shortcuts-btn" + (showShortcuts ? " active" : "")}
              onClick={toggleShortcuts}
              title="Show keyboard shortcuts in button labels (?)"
              aria-pressed={showShortcuts}
            >
              Keyboard shortcuts<span className="kbd-hint">?</span>
            </button>
            <button
              className={"tool-btn settings-btn" + (settingsOpen ? " active" : "")}
              onClick={() => setSettingsOpen(true)}
              title="Settings"
              aria-label="Settings"
            >
              ⚙
            </button>
            <button
              className="tool-btn report-btn"
              onClick={() => setReportOpen(true)}
              title="Report an issue"
              aria-label="Report an issue"
            >
              {/* Drawn rather than an emoji: 🐞 came through in full colour, which
                  made the least-used control the loudest thing in the bar. This
                  is currentColor throughout, so it wears the same grey as the ?
                  and the gear, and the same blue when the button is hovered.
                  The body is filled and the legs kept short — an outlined body
                  with long legs reads as a sunburst at 14px, not a bug. */}
              <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
                <g stroke="currentColor" strokeWidth="1.15" strokeLinecap="round" fill="none">
                  {/* Antennae off the head, then three legs a side. */}
                  <path d="M6.8 3.3 5.8 2.2M9.2 3.3l1 -1.1" />
                  <path d="M4.6 7.8 3 7.1M4.4 10.2H2.7M5 12.4 3.7 13.3M11.4 7.8 13 7.1M11.6 10.2h1.7M11 12.4l1.3.9" />
                </g>
                <circle cx="8" cy="4.5" r="1.6" fill="currentColor" />
                <rect x="4.5" y="5.8" width="7" height="7.6" rx="3.5" fill="currentColor" />
              </svg>
            </button>
          </div>
        </div>
      </header>
      {updateAvailable && (
        <div className="update-banner">
          <span>A new version of Open Poly is available.</span>
          <button className="banner-link" onClick={() => location.reload()}>
            Refresh
          </button>
        </div>
      )}
      {docRecoveryBanner && (
        <div className="recovery-banner">
          <span>
            {docRecoveryBanner.kind === "corrupted" ? (
              <>
                Couldn't open "{docRecoveryBanner.name}" — it may be corrupted. Use <strong>Export as JSON</strong> in
                the{" "}
                <button
                  className="banner-link"
                  onClick={() => {
                    setDocRecoveryBanner(null);
                    setDocsDialogOpen(true);
                  }}
                >
                  Documents
                </button>{" "}
                menu to save its data, then Delete it.
              </>
            ) : (
              <>
                Couldn't read your last document from local storage.{" "}
                <button
                  className="banner-link"
                  onClick={() => {
                    setDocRecoveryBanner(null);
                    setDocsDialogOpen(true);
                  }}
                >
                  Open Documents
                </button>{" "}
                to see what's available.
              </>
            )}
          </span>
          <button className="row-icon" title="Dismiss" onClick={() => setDocRecoveryBanner(null)}>
            ✕
          </button>
        </div>
      )}
      {docsDialogOpen && (
        <DocumentsDialog
          activeId={activeId}
          onClose={() => setDocsDialogOpen(false)}
          onOpen={openDocument}
          onDuplicate={duplicateDocument}
          onDelete={deleteDocument}
          onRename={renameDocument}
          onExport={exportDocument}
          onImport={importDocumentFile}
        />
      )}
      {settingsOpen && (
        <SettingsDialog settings={settings} onChange={updateSettings} onClose={() => setSettingsOpen(false)} />
      )}
      {reportOpen && (
        <ReportDialog
          onClose={() => setReportOpen(false)}
          version={__BUILD_ID__}
          getDocJson={() => {
            try {
              return JSON.stringify(doc);
            } catch {
              return null;
            }
          }}
          getScreenshot={() => viewApiRef.current?.capturePNG({ plain: true }) ?? null}
        />
      )}
      <div className={"body" + (sidebarOpen ? "" : " sidebar-closed")}>
        {sidebarOpen && (
          // Backdrop only matters when the panel floats over the viewport
          // (mobile drawer); on desktop it's CSS-hidden. Tap to dismiss.
          <div className="sidebar-backdrop" onClick={() => setSidebarOpen(false)} />
        )}
        {/* Collapse/expand tab attached to the panel's right edge; slides to
            the viewport's left edge when the panel is hidden so it's always
            reachable (Onshape-style). */}
        <button
          className={"panel-toggle" + (sidebarOpen ? " open" : "")}
          onClick={() => setSidebarOpen((o) => !o)}
          title={sidebarOpen ? "Hide panel" : "Show panel"}
          aria-pressed={sidebarOpen}
          aria-label="Toggle side panel"
        >
          {sidebarOpen ? "‹" : "›"}
        </button>
        <aside className="panel">
          <button
            className="params-heading collapsible"
            aria-expanded={variablesOpen}
            onClick={() => setVariablesOpen((o) => !o)}
          >
            <span className={"collapse-caret" + (variablesOpen ? " open" : "")}>▶</span>
            Variables ({doc.variables.length})
          </button>
          {variablesOpen && (
            <VariablesPanel
              variables={doc.variables}
              scope={resolved.scope}
              errors={resolved.variableErrors}
              nameErrors={resolved.variableNameErrors}
              onAdd={() => {
                const { doc: next } = addVariable(doc);
                setDoc(next);
              }}
              onChange={(id, field, value) => setDoc(updateVariable(doc, id, field, value), `var:${id}:${field}`)}
              onDelete={(id) => setDoc(removeVariable(doc, id))}
            />
          )}
          <h2 className="params-heading">Timeline</h2>
          <FeatureTree
            doc={doc}
            height={timelineHeight}
            datums={DATUM_ROWS}
            datumVisibility={datumVisibility}
            onToggleDatum={(id) => setDatumVisibility((v) => ({ ...v, [id]: !v[id] }))}
            selectedIds={selectedFeatureIds}
            errors={errors}
            warnings={warnings}
            onSelect={selectFeature}
            onDoubleClick={handleTreeDoubleClick}
            onDelete={handleDelete}
            onToggleSuppress={(id) =>
              setDoc(setSuppressed(doc, id, !doc.features.find((f) => f.id === id)?.suppressed))
            }
            onToggleHidden={(id, hidden) => setDoc(setFeatureHidden(doc, id, hidden))}
            onSetRollback={(index) => setDoc(setRollbackIndex(doc, index))}
            onMove={(id, delta) => setDoc(moveFeature(doc, id, delta))}
          />
          <div className="panel-splitter" title="Drag to resize the timeline" onPointerDown={startTimelineResize} />
          <div className="parts-header">
            <h2 className="params-heading">Parts</h2>
            <div className="parts-import" ref={importMenuRef}>
              <button
                type="button"
                title="Import a STEP part or a DXF sketch"
                onClick={() => setImportMenuOpen((o) => !o)}
              >
                ⤓ Import ▾
              </button>
              {importMenuOpen && (
                <div className="mt-menu mt-menu-right">
                  <button
                    type="button"
                    title="Import a STEP file as a new part (⌘I / Ctrl+I)"
                    onClick={() => {
                      setImportMenuOpen(false);
                      importInputRef.current?.click();
                    }}
                  >
                    STEP part…
                  </button>
                  <button
                    type="button"
                    title="Import a DXF drawing as an editable sketch"
                    onClick={() => {
                      setImportMenuOpen(false);
                      dxfInputRef.current?.click();
                    }}
                  >
                    DXF sketch…
                  </button>
                </div>
              )}
            </div>
            <input
              ref={importInputRef}
              type="file"
              accept=".step,.stp,.STEP,.STP"
              style={{ display: "none" }}
              onChange={handleImportFile}
            />
            <input
              ref={dxfInputRef}
              type="file"
              accept=".dxf,.DXF"
              style={{ display: "none" }}
              onChange={handleDxfFile}
            />
          </div>
          <SolidsList
            doc={doc}
            bodyIds={bodyIds}
            selectedIds={selectedFeatureIds}
            onSelect={selectFeature}
            onRename={(id, name) => setDoc(renameFeature(doc, id, name), `rename:${id}`)}
            onDelete={handleDelete}
            onColorChange={handleSolidColor}
            onOpacityChange={handleSolidOpacity}
            onToggleHidden={handleSolidHidden}
            onExportStep={handleExportStep}
            onExportStl={handleExportStl}
            isolatedId={isolatedBodyId}
            onIsolate={handleIsolate}
          />
          {/* Constraints + Parameters used to live here, below Parts, where the
              thing you were editing was easy to miss. They're now the floating
              EditPanel over the viewport (see below). */}
        </aside>
        <main className="viewport" ref={viewportElRef}>
          <Viewport
            meshes={viewportMeshes}
            ghostMeshes={ghostMeshes}
            selection={selection}
            emphasize={constraintEmphasis}
            highlightBodyIds={highlightBodyIds}
            booleanHighlight={booleanHighlight}
            onSelect={handlePick}
            onSketchEntityDouble={handleSketchEntityDouble}
            datumVisibility={datumVisibility}
            userPlanes={visibleUserPlanes}
            ghostPlane={ghostPlaneFrame}
            transformEdit={transformEdit}
            transformMode={transformMode}
            onTransformInput={handleTransformInput}
            onTransformPreview={handleTransformPreview}
            extrudeGizmo={extrudeGizmo}
            onExtrudeDistanceChange={handleExtrudeGizmoDistance}
            picking={picking}
            onPick={handlePickRef}
            axisPick={
              picking &&
              (pickPurpose === "revolveAxis" || pickPurpose === "patternAxis" || pickPurpose === "patternDir")
            }
            onAxisPick={handleAxisPick}
            activeSketch={
              editingSketch ? { datumId: editingSketch.plane.kind === "datum" ? editingSketch.plane.id : null } : null
            }
            activeSketchFace={
              editingSketch && editingSketch.plane.kind === "face"
                ? { bodyId: editingSketch.plane.featureId, frame: editingSketch.plane.frame }
                : null
            }
            sketchTool={sketchTool}
            sketches={renderSketchesWithPreview}
            activeSketchId={editingSketchId}
            sketchFullyConstrained={fullyConstrained}
            draft={draft}
            polygonSides={polygonSides}
            onSketchClick={handleSketchClick}
            onSketchDragMove={handleSketchDragMove}
            onSketchDragEnd={handleSketchDragEnd}
            selectionFilter={selFilter}
            regionPickPriority={armingRevolveProfile}
            sectionView={{
              enabled: sectionView.enabled,
              frame: sectionFrame,
              offset: sectionView.offset,
              flip: sectionView.flip,
            }}
            onSectionOffsetChange={(offset) => setSectionView((s) => ({ ...s, offset }))}
            theme={resolvedTheme}
            mouseMiddle={settings.mouseMiddle}
            mouseRight={settings.mouseRight}
            apiRef={viewApiRef}
          />
          <OverflowToolbar
            className="model-toolbar"
            items={modelTools}
            showShortcuts={showShortcuts}
            openRequest={modelMoreRequest}
          />
          {/* The floating edit panel. It shows in two cases only (never on a
              plain selection — that just highlights): the constraints of the
              sketch being edited, and the parameters of a double-clicked
              no-dialog feature (primitive / import / sweep / loft). Every other
              feature type opens its own creation dialog in edit mode instead. */}
          {(editParamsFeature || (editingSketch && editingSketch.constraints.length > 0)) && (
            <EditPanel
              title={editParamsFeature ? featureTypeLabel(editParamsFeature) : "Sketch"}
              targetKey={`${editingSketchId ?? ""}|${editParamsId ?? ""}`}
              onClose={editParamsFeature ? () => setEditParamsId(null) : undefined}
            >
              {editingSketch && editingSketch.constraints.length > 0 && (
                <>
                  <div className="ep-heading">
                    Constraints ({editingSketch.constraints.length})
                    {solveConflict && (
                      <span className="constraint-warn" title="Over-constrained / conflicting">
                        {" "}
                        ⚠ conflict
                      </span>
                    )}
                  </div>
                  <ul className="constraint-list">
                    {editingSketch.constraints.map((c) => (
                      <li
                        key={c.id}
                        className={hoveredConstraintId === c.id ? "cl-hover" : ""}
                        onMouseEnter={() => setHoveredConstraintId(c.id)}
                        onMouseLeave={() => setHoveredConstraintId((id) => (id === c.id ? null : id))}
                      >
                        <span>{constraintLabel(c)}</span>
                        <button className="cl-del" title="Delete constraint" onClick={() => deleteConstraint(c.id)}>
                          ✕
                        </button>
                      </li>
                    ))}
                  </ul>
                </>
              )}
              {editParamsFeature && (
                <>
                  {/* No "Parameters" heading — the title already names the type,
                      matching the creation dialogs (which go straight to fields). */}
                  <ParamEditor
                    feature={editParamsFeature}
                    error={errors[editParamsFeature.id] ?? null}
                    editingSketchId={editingSketchId}
                    onChangeParam={(id, name, value) =>
                      setDoc(updateParam(doc, id, name, value), `param:${id}:${name}`)
                    }
                    onRename={(id, name) => setDoc(renameFeature(doc, id, name), `rename:${id}`)}
                    onEditSketch={editSketch}
                    onFinishSketch={finishSketch}
                    onEditTransform={editTransform}
                  />
                </>
              )}
            </EditPanel>
          )}
          {editingSketch && (
            <OverflowColumn
              className="sketch-toolbar"
              slots={sketchSlots}
              openRequest={sketchMoreRequest}
              showShortcuts={showShortcuts}
              searchPlaceholder="Search sketch tools…"
            />
          )}
          {dimPending && <div className="dim-hint">Pick a line or circle to dimension · Esc to cancel</div>}
          {dimInput && (
            <DraggableDialog
              className="dim-input"
              baseTransform="translate(14px, -130%)"
              style={{ left: dimInput.x, top: dimInput.y }}
            >
              <label data-drag-handle>
                {dimInput.kind === "radius"
                  ? "Radius"
                  : dimInput.kind === "angle"
                    ? "Angle °"
                    : dimInput.kind === "distance"
                      ? "Distance"
                      : "Length"}
              </label>
              <DimValueInput
                value={dimInput.value}
                variables={dimVarOptions}
                onChange={(v) => setDimInput((d) => (d ? { ...d, value: v } : d))}
                onSubmit={applyDimension}
                onCancel={() => setDimInput(null)}
              />
              <button onClick={applyDimension}>Set</button>
              <button className="ghost" onClick={() => setDimInput(null)}>
                ✕
              </button>
            </DraggableDialog>
          )}
          {/* Offset tool: a floating distance box (like the dimension input) plus
              a draggable arrow handle anchored on the chain. Dragging the arrow
              changes the signed distance live (cross to the other side → negative);
              the dashed offset preview updates as it moves. Set/Enter commits,
              ✕/Esc cancels. */}
          {editingSketch &&
            offsetSession &&
            (() => {
              // Guarded: a half-typed / non-numeric distance must not throw here.
              let raw = NaN;
              try {
                raw = evaluateExpression(offsetSession.value, resolved.scope);
              } catch {
                raw = NaN;
              }
              const dv = Number.isFinite(raw) ? raw : 0;
              const a0 = screenOf(offsetSession.anchor);
              const a1 = screenOf([
                offsetSession.anchor[0] + offsetSession.normal[0],
                offsetSession.anchor[1] + offsetSession.normal[1],
              ]);
              const axisX = a1.x - a0.x,
                axisY = a1.y - a0.y,
                axisLen2 = axisX * axisX + axisY * axisY || 1;
              const handle = screenOf([
                offsetSession.anchor[0] + offsetSession.normal[0] * dv,
                offsetSession.anchor[1] + offsetSession.normal[1] * dv,
              ]);
              // Point the arrow along the (screen-space) drag axis, flipping 180°
              // when the offset has gone negative — like the Transform gizmo's
              // translate handle pointing in the drag direction.
              const arrowAng = (Math.atan2(axisY, axisX) * 180) / Math.PI + (dv < 0 ? 180 : 0);
              const onDrag = (ev: React.PointerEvent) => {
                ev.preventDefault();
                ev.stopPropagation();
                const sx = ev.clientX,
                  sy = ev.clientY,
                  d0 = dv;
                const move = (m: WindowEventMap["pointermove"]) => {
                  const proj = ((m.clientX - sx) * axisX + (m.clientY - sy) * axisY) / axisLen2;
                  setOffsetSession((s) => (s ? { ...s, value: (d0 + proj).toFixed(2) } : s));
                };
                const up = () => {
                  window.removeEventListener("pointermove", move);
                  window.removeEventListener("pointerup", up);
                };
                window.addEventListener("pointermove", move);
                window.addEventListener("pointerup", up);
              };
              return (
                <>
                  <svg
                    className="offset-arrow"
                    onPointerDown={onDrag}
                    width={48}
                    height={18}
                    viewBox="0 0 48 18"
                    style={{ left: handle.x, top: handle.y, transform: `translate(-50%, -50%) rotate(${arrowAng}deg)` }}
                  >
                    <title>Drag to set the offset distance (cross over to flip the side)</title>
                    <line className="offset-arrow-shaft" x1="3" y1="9" x2="31" y2="9" />
                    <path className="offset-arrow-head" d="M30 2.5 L45 9 L30 15.5 Z" />
                  </svg>
                  <DraggableDialog
                    className="dim-input"
                    baseTransform="translate(14px, -130%)"
                    style={{ left: a0.x, top: a0.y }}
                  >
                    <label data-drag-handle>Offset</label>
                    <DimValueInput
                      value={offsetSession.value}
                      variables={dimVarOptions}
                      onChange={(v) => setOffsetSession((s) => (s ? { ...s, value: v } : s))}
                      onSubmit={commitOffset}
                      onCancel={cancelOffset}
                    />
                    <button onClick={commitOffset}>Set</button>
                    <button className="ghost" onClick={cancelOffset}>
                      ✕
                    </button>
                  </DraggableDialog>
                </>
              );
            })()}
          {/* Re-edit a committed offset's distance: shown when a single generated
              offset entity is selected. Editing re-runs applyDerived. */}
          {editingSketch &&
            !offsetSession &&
            selectedOffsetOp &&
            (() => {
              const e = selectedOffsetOp.entity;
              const uv: Vec2 =
                e.type === "line"
                  ? [(e.a[0] + e.b[0]) / 2, (e.a[1] + e.b[1]) / 2]
                  : e.type === "circle"
                    ? [e.c[0], e.c[1]]
                    : e.type === "arc"
                      ? [e.c[0] + e.r * Math.cos((e.start + e.end) / 2), e.c[1] + e.r * Math.sin((e.start + e.end) / 2)]
                      : [0, 0];
              const a0 = screenOf(uv);
              const shown =
                offsetEdit?.opId === selectedOffsetOp.op.id ? offsetEdit.value : selectedOffsetOp.op.distance;
              return (
                <DraggableDialog
                  className="dim-input"
                  baseTransform="translate(14px, -130%)"
                  style={{ left: a0.x, top: a0.y }}
                >
                  <label data-drag-handle>Offset</label>
                  <DimValueInput
                    value={shown}
                    variables={dimVarOptions}
                    onChange={(v) => setOffsetEdit({ opId: selectedOffsetOp.op.id, value: v })}
                    onSubmit={commitOffsetEdit}
                    onCancel={() => setOffsetEdit(null)}
                  />
                  <button onClick={commitOffsetEdit}>Set</button>
                </DraggableDialog>
              );
            })()}
          {/* Mirror tool: a floating prompt. Before an axis is armed it asks the
              user to click a line; once armed it shows the live mirrored count and
              Done/Cancel. Enter commits, Esc cancels (see the key handler). */}
          {editingSketch &&
            mirrorSession &&
            (() => {
              const sk = doc.features.find((f) => f.id === editingSketchId);
              const axis =
                mirrorSession.axisEntityId && sk?.type === "sketch"
                  ? sk.entities.find((x) => x.id === mirrorSession.axisEntityId)
                  : undefined;
              const anchorUv: Vec2 =
                axis && axis.type === "line" ? [(axis.a[0] + axis.b[0]) / 2, (axis.a[1] + axis.b[1]) / 2] : [0, 0];
              const a0 = screenOf(anchorUv);
              return (
                <DraggableDialog
                  className="dim-input"
                  baseTransform="translate(14px, -130%)"
                  style={{ left: a0.x, top: a0.y }}
                >
                  <label data-drag-handle>Mirror</label>
                  {!mirrorSession.axisEntityId ? (
                    <span className="dim-status" style={{ padding: "0 6px" }}>
                      Select a line to set the axis
                    </span>
                  ) : (
                    <>
                      <span className="dim-status" style={{ padding: "0 6px" }}>
                        {mirrorSession.previews.length} mirrored — select entities to add
                      </span>
                      {/* The axis is a pick like any other, so it has to be
                          undoable without throwing the session away. Its copies
                          are measured from it, so they go with it. */}
                      <button
                        className="ghost"
                        title="Clear the mirror axis and pick a different line"
                        onClick={() => {
                          setMirrorSession((m) => (m ? { ...m, axisEntityId: null, sourceIds: [], previews: [] } : m));
                          setSelection([]);
                        }}
                      >
                        Change axis
                      </button>
                    </>
                  )}
                  <button onClick={commitMirror} disabled={mirrorSession.previews.length === 0}>
                    Done
                  </button>
                  <button className="ghost" onClick={cancelMirror}>
                    ✕
                  </button>
                </DraggableDialog>
              );
            })()}
          {/* Pattern tool (linear/circular): a fixed floating prompt at the top
              (sources accumulate by clicks anywhere, so there's no single
              anchor). Expression fields for count/step/angle; Done/Enter commits
              the DerivedOp, ✕/Esc discards the session. */}
          {editingSketch &&
            patternSession &&
            (() => {
              const s = patternSession;
              const n = s.sourceIds.length;
              const status =
                s.kind === "circular" && !s.center
                  ? "Select the center point (a vertex, the origin, or empty space)"
                  : n === 0
                    ? "Select entities to pattern"
                    : `${n} in pattern — select entities to add`;
              // The center is a pick like any other, so the dialog shows it as a
              // slot: what it landed on, and ✕ to put it back to listening.
              const c = s.center;
              const centerAt = c && ("fixed" in c ? c.fixed : "at" in c && Array.isArray(c.at) ? c.at : null);
              const centerLabel = !c
                ? null
                : "origin" in c
                  ? "Origin"
                  : centerAt
                    ? `(${centerAt[0].toFixed(1)}, ${centerAt[1].toFixed(1)})`
                    : "Sketch point";
              return (
                <DraggableDialog
                  className="extrude-dialog"
                  style={{ left: "50%", top: 70 }}
                  baseTransform="translateX(-50%)"
                >
                  <div className="ed-title" data-drag-handle>
                    {s.kind === "linear" ? "Linear pattern" : "Circular pattern"}
                  </div>
                  <div className="ed-hint">{status}</div>
                  {s.kind === "circular" && (
                    <div className="ed-field">
                      <span>Center</span>
                      <PickSlot
                        noun="the center"
                        armed={!s.center}
                        value={centerLabel}
                        clearTitle="Pick a different center"
                        onArm={() => setPatternSession((p) => (p ? { ...p, center: null } : p))}
                      />
                    </div>
                  )}
                  <label className="ed-field">
                    <span>Count</span>
                    <DimValueInput
                      value={s.count}
                      variables={dimVarOptions}
                      onChange={(v) => setPatternSession((p) => (p ? { ...p, count: v } : p))}
                      onSubmit={commitPattern}
                      onCancel={cancelPattern}
                    />
                  </label>
                  {s.kind === "linear" ? (
                    <>
                      <label className="ed-field">
                        <span>ΔX</span>
                        <DimValueInput
                          value={s.dx}
                          variables={dimVarOptions}
                          onChange={(v) => setPatternSession((p) => (p ? { ...p, dx: v } : p))}
                          onSubmit={commitPattern}
                          onCancel={cancelPattern}
                        />
                      </label>
                      <label className="ed-field">
                        <span>ΔY</span>
                        <DimValueInput
                          value={s.dy}
                          variables={dimVarOptions}
                          onChange={(v) => setPatternSession((p) => (p ? { ...p, dy: v } : p))}
                          onSubmit={commitPattern}
                          onCancel={cancelPattern}
                        />
                      </label>
                    </>
                  ) : (
                    <>
                      <div className="ed-modes">
                        <button
                          className={s.mode === "full" ? "active" : ""}
                          title="Full circle: instances at equal 360°/count steps"
                          onClick={() => setPatternSession((p) => (p ? { ...p, mode: "full" } : p))}
                        >
                          Full (360°)
                        </button>
                        <button
                          className={s.mode === "angle" ? "active" : ""}
                          title="Spread the instances across a total sweep angle"
                          onClick={() => setPatternSession((p) => (p ? { ...p, mode: "angle" } : p))}
                        >
                          Angle
                        </button>
                      </div>
                      {s.mode === "angle" && (
                        <>
                          <label className="ed-field">
                            <span>Angle (°)</span>
                            <DimValueInput
                              value={s.angle}
                              variables={dimVarOptions}
                              onChange={(v) => setPatternSession((p) => (p ? { ...p, angle: v } : p))}
                              onSubmit={commitPattern}
                              onCancel={cancelPattern}
                            />
                          </label>
                          <label className="ed-field ed-flip" title="Spread ±angle/2 to both sides of the seed">
                            <span>Symmetric</span>
                            <input
                              type="checkbox"
                              checked={s.symmetric}
                              onChange={(ev) =>
                                setPatternSession((p) => (p ? { ...p, symmetric: ev.target.checked } : p))
                              }
                            />
                          </label>
                        </>
                      )}
                    </>
                  )}
                  <div className="ed-actions">
                    <button
                      className="ed-primary"
                      onClick={commitPattern}
                      disabled={n === 0 || (s.kind === "circular" && !s.center)}
                    >
                      Done
                    </button>
                    <button onClick={cancelPattern}>Cancel</button>
                  </div>
                </DraggableDialog>
              );
            })()}
          {/* Project/Convert tool: a fixed floating prompt. There's no single
              anchor (the user clicks body edges/vertices anywhere), so it sits at
              the top. Done commits the projected previews; ✕/Esc discards them. */}
          {editingSketch && projectSession && (
            <DraggableDialog className="dim-input" style={{ left: "50%", top: 70 }} baseTransform="translateX(-50%)">
              <label data-drag-handle>Project</label>
              <span className="dim-status" style={{ padding: "0 6px" }}>
                {projectSession.previews.length > 0
                  ? `${projectSession.previews.length} projected — select more edges/vertices`
                  : "Select body edges or vertices to project"}
              </span>
              <button onClick={commitProject} disabled={projectSession.previews.length === 0}>
                Done
              </button>
              <button className="ghost" onClick={cancelProject}>
                ✕
              </button>
            </DraggableDialog>
          )}
          {/* Text tool: once the anchor is clicked, a floating box takes the
              string + height. Enter commits, ✕/Esc cancels. The text is live-
              previewed in the sketch (see renderSketchesWithPreview). */}
          {editingSketch &&
            textDraft &&
            (() => {
              const a0 = screenOf(textDraft.anchor);
              return (
                <DraggableDialog
                  className="dim-input"
                  baseTransform="translate(14px, -130%)"
                  style={{ left: a0.x, top: a0.y }}
                >
                  <label data-drag-handle>Text</label>
                  <input
                    autoFocus
                    value={textDraft.value}
                    placeholder="Type text…"
                    style={{ width: 120 }}
                    onChange={(ev) => setTextDraft((s) => (s ? { ...s, value: ev.target.value } : s))}
                    onKeyDown={(ev) => {
                      if (ev.key === "Enter") {
                        ev.preventDefault();
                        commitText();
                      }
                    }}
                  />
                  <DimValueInput
                    value={textDraft.height}
                    variables={dimVarOptions}
                    onChange={(v) => setTextDraft((s) => (s ? { ...s, height: v } : s))}
                    onSubmit={commitText}
                    onCancel={() => setTextDraft(null)}
                  />
                  <button onClick={commitText} disabled={!textDraft.value.trim()}>
                    Set
                  </button>
                  <button className="ghost" onClick={() => setTextDraft(null)}>
                    ✕
                  </button>
                </DraggableDialog>
              );
            })()}
          {/* Polygon tool: a one-shot floating "Sides" box (like the dimension
              input). The draft is free text; Set (enabled only for an integer in
              3..24) commits the count and closes the box so the next viewport click
              draws. Cancel/✕/Esc just closes it, keeping the previous count. */}
          {editingSketch &&
            sketchTool === "polygon" &&
            polySidesOpen &&
            (() => {
              const n = Number(polySidesText);
              const valid = Number.isInteger(n) && n >= 3 && n <= 24;
              const commit = () => {
                if (valid) {
                  setPolygonSides(n);
                  setPolySidesOpen(false);
                }
              };
              return (
                <DraggableDialog
                  className="dim-input"
                  style={{ left: "50%", top: 70 }}
                  baseTransform="translateX(-50%)"
                >
                  <label data-drag-handle>Sides</label>
                  <input
                    autoFocus
                    value={polySidesText}
                    onChange={(e) => setPolySidesText(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") commit();
                      else if (e.key === "Escape") setPolySidesOpen(false);
                    }}
                  />
                  <button onClick={commit} disabled={!valid}>
                    Set
                  </button>
                  <button className="ghost" onClick={() => setPolySidesOpen(false)}>
                    ✕
                  </button>
                </DraggableDialog>
              );
            })()}
          {dimFrame && dimSpecs.length > 0 && (
            <DimensionOverlay
              frame={dimFrame}
              specs={dimSpecs}
              centroid={dimCentroid}
              viewApiRef={viewApiRef}
              onEdit={editConstraint}
              onDelete={deleteConstraint}
            />
          )}
          {hudMsg && (
            // Nudged below the sketch/pick banner when one is up, so it doesn't
            // land on top of it — they share the top-centre slot.
            <div
              className={"sketch-msg" + (editingSketch || picking || selectionArming ? " below-banner" : "")}
              role="alert"
            >
              ⚠ {hudMsg}
            </div>
          )}
          {/* Named views (Top/Front/Right/…) + iso corners live on the on-canvas
              navigation gizmo (see Viewport.tsx). This small Home button, tucked
              at the gizmo's bottom-right, snaps to the iso view zoomed to fit
              every body in the scene. */}
          <button
            className="view-reset"
            title="Home — iso view, fit all (H)"
            onClick={() => viewApiRef.current?.homeView()}
          >
            <svg
              viewBox="0 0 24 24"
              width="16"
              height="16"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M3 10.5 12 3l9 7.5" />
              <path d="M5 9.5V20h14V9.5" />
              <path d="M9.5 20v-6h5v6" />
            </svg>
          </button>
          {/* Perspective/orthographic toggle — a peer of Home/Section in the view-
              controls corner. View-only (the camera swap lives in the viewport API);
              the icon shows a box in one-point perspective, filled while active. */}
          <button
            className={"view-reset perspective-toggle" + (perspective ? " active" : "")}
            title={
              perspective
                ? "Perspective view: on — click for orthographic"
                : "Orthographic view — click for perspective"
            }
            aria-pressed={perspective}
            onClick={() => {
              const next = !perspective;
              setPerspective(next);
              viewApiRef.current?.setProjection(next ? "perspective" : "orthographic");
            }}
          >
            <svg
              viewBox="0 0 24 24"
              width="16"
              height="16"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              {/* Cube seen from a front corner (perspective feel via the asymmetric
                  top). Outer silhouette, then the 3 inner edges from the near
                  top-corner — each ends exactly on a silhouette vertex, so nothing
                  dangles. */}
              <path d="M4 8 12 5 20 7 20 16 12 21 4 18Z" />
              <path d="M12 11 4 8M12 11 20 7M12 11 12 21" />
            </svg>
          </button>
          {/* Section view toggle: a peer of Home in the same view-controls corner
              (not a modeling op — no undo, no timeline; see SectionViewState).
              Dragging the plane's own on-canvas handle changes the offset; this
              button only turns the feature on/off. */}
          <button
            className={"view-reset section-view-toggle" + (sectionView.enabled ? " active" : "")}
            title={
              sectionView.enabled
                ? "Section view: on — click to turn off"
                : "Section view: cut through the model to see the interior"
            }
            aria-pressed={sectionView.enabled}
            onClick={() => setSectionView((s) => ({ ...s, enabled: !s.enabled }))}
          >
            <svg
              viewBox="0 0 24 24"
              width="16"
              height="16"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <rect x="5" y="4" width="14" height="16" rx="1" />
              <path d="M2 12h20" />
            </svg>
          </button>
          {sectionView.enabled && (
            <div className="section-view-panel" title="Section view">
              <span className="section-view-label">{planeRefLabel(sectionView.ref)}</span>
              <input
                type="number"
                className="section-view-offset"
                value={sectionView.offset.toFixed(2)}
                onChange={(e) => {
                  const v = Number(e.target.value);
                  if (Number.isFinite(v)) setSectionView((s) => ({ ...s, offset: v }));
                }}
              />
              <button
                className={sectionView.flip ? "active" : ""}
                title="Flip which side is kept"
                onClick={() => setSectionView((s) => ({ ...s, flip: !s.flip }))}
              >
                ⇅ Flip
              </button>
              {/* The one arming affordance outside a dialog. It follows the same
                  vocabulary as the pick slots: "Select …" while idle, a dashed
                  pulse and "Selecting…" while it waits, and clicking again
                  calls the pick off. */}
              <button
                className={picking && pickPurpose === "sectionPlane" ? "arming" : undefined}
                title="Pick a different plane or face to cut through"
                onClick={() => {
                  if (picking && pickPurpose === "sectionPlane") {
                    setPicking(false);
                    setPickPurpose("sketch");
                    return;
                  }
                  setPickPurpose("sectionPlane");
                  setPicking(true);
                }}
              >
                {picking && pickPurpose === "sectionPlane" ? "⌖ Selecting…" : "⌖ Select plane"}
              </button>
            </div>
          )}
          {!editingSketch && !picking && (
            <div className="sel-filters" title="Selection filters — what a click can pick">
              <span className="sel-filters-label">Selection filters</span>
              <div className="sel-filters-row">
                {(["body", "face", "edge", "vertex"] as const).map((k) => (
                  <button
                    key={k}
                    className={selFilter[k] ? "active" : ""}
                    onClick={() => setSelFilter((f) => ({ ...f, [k]: !f[k] }))}
                  >
                    {k}
                  </button>
                ))}
              </div>
            </div>
          )}
          {isolatedBodyId && (
            <div className="isolate-banner">
              <span>
                Isolated · <strong>{doc.features.find((f) => f.id === isolatedBodyId)?.name ?? "body"}</strong>
              </span>
              <button onClick={() => setIsolatedBodyId(null)}>Exit isolate</button>
            </div>
          )}
          {editingSketch ? (
            <div className="sketch-banner">
              <span>
                Editing <strong>{editingSketch.name}</strong> · {planeRefLabel(editingSketch.plane)}
              </span>
              <button onClick={finishSketch}>Finish sketch ⏎</button>
            </div>
          ) : picking ? (
            <div className="sketch-banner pick">
              <span>
                {pickPurpose === "revolveAxis"
                  ? "Select a sketch line, a straight body edge, a plane, or a face to revolve around"
                  : pickPurpose === "patternAxis"
                    ? "Select a sketch line or a cylindrical face to pattern around"
                    : pickPurpose === "patternDir"
                      ? "Select a sketch line for the pattern direction"
                      : pickPurpose === "sectionPlane"
                        ? "Select a plane or planar face to cut the section through"
                        : pickPurpose === "plane"
                          ? // The wording only fits the offset method — the others
                            // build off their reference rather than offsetting it.
                            planeDialog?.method === "offset"
                            ? "Select a plane or planar face to offset the new plane from"
                            : "Select a plane or planar face for the new plane"
                          : "Select a plane or planar face for the sketch"}
              </span>
              <button
                onClick={() => {
                  setPicking(false);
                  if (pickPurpose !== "sketch" && pickPurpose !== "plane") setPickPurpose("sketch");
                }}
              >
                Cancel (Esc)
              </button>
            </div>
          ) : (
            selectionArming && (
              <div className="sketch-banner pick">
                <span>{selectionArming.message}</span>
                <button onClick={selectionArming.cancel}>Cancel</button>
              </div>
            )
          )}
          {extrudeDialog && (
            <DraggableDialog className="extrude-dialog" style={{ left: extrudeDialog.x, top: extrudeDialog.y }}>
              <div className="ed-title" data-drag-handle>
                {extrudeDialog.editId ? "Edit extrude" : "Extrude"}
                {!extrudeDialog.editId && extrudeDialogProfiles.length > 1
                  ? ` (${extrudeDialogProfiles.length} profiles)`
                  : ""}
              </div>
              <div className="ed-modes">
                {(["new", "add", "remove"] as const).map((m) => (
                  <button
                    key={m}
                    className={extrudeDialog.mode === m ? "active" : ""}
                    onClick={() =>
                      setExtrudeDialog((d) =>
                        // Through All is only meaningful for a cut (Remove); switching
                        // to New or Add drops it back to Blind.
                        d
                          ? { ...d, mode: m, extent: m !== "remove" && d.extent === "throughAll" ? "blind" : d.extent }
                          : d,
                      )
                    }
                  >
                    {m === "new" ? "New" : m === "add" ? "Add" : "Remove"}
                  </button>
                ))}
              </div>
              {extrudeDialog.mode !== "new" && (
                <label className="ed-field">
                  <span>Target</span>
                  <select
                    value={extrudeDialog.targetId ?? ""}
                    onChange={(e) => setExtrudeDialog((d) => (d ? { ...d, targetId: e.target.value || null } : d))}
                  >
                    <option value="" disabled>
                      Select a part…
                    </option>
                    {booleanCandidates.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <label className="ed-field">
                <span>Extent</span>
                <select
                  value={extrudeDialog.extent}
                  onChange={(e) => {
                    const extent = e.target.value as ExtrudeExtent;
                    setExtrudeDialog((d) => (d ? { ...d, extent } : d));
                    // Arm (or disarm) the face pick with the extent that needs
                    // it, the way the plane dialog arms the pick its method
                    // needs — choosing "Up to face" IS asking to pick a face.
                    setPickingUpFace(extent === "upToFace");
                  }}
                >
                  <option value="blind">Blind</option>
                  <option value="symmetric">Symmetric</option>
                  {/* Through All only makes sense as a cut, so it's shown for Remove only. */}
                  {extrudeDialog.mode === "remove" && <option value="throughAll">Through All</option>}
                  <option value="upToFace">Up to face</option>
                  {/* Up to next reaches the nearest body face ahead; like Up to
                      face it's offered in every mode (it errors clearly if nothing
                      lies ahead). */}
                  <option value="upToNext">Up to next</option>
                </select>
              </label>
              {extrudeDialog.extent === "upToFace" && (
                <div className="ed-field">
                  <span>Face</span>
                  <PickSlot
                    noun="a face"
                    armed={pickingUpFace}
                    value={
                      extrudeDialog.upTo
                        ? `On ${doc.features.find((f) => f.id === extrudeDialog.upTo!.featureId)?.name ?? "body"}`
                        : null
                    }
                    onArm={() => setPickingUpFace((v) => !v)}
                    onClear={() => {
                      setExtrudeDialog((d) => (d ? { ...d, upTo: null } : d));
                      setPickingUpFace(true);
                    }}
                  />
                </div>
              )}
              {extrudeDialog.extent !== "upToFace" && extrudeDialog.extent !== "upToNext" && (
                <label className="ed-field">
                  <span>Distance</span>
                  <input
                    autoFocus
                    value={extrudeDialog.distance}
                    onChange={(e) => setExtrudeDialog((d) => (d ? { ...d, distance: e.target.value } : d))}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") createExtrude();
                      else if (e.key === "Escape") closeExtrudeDialog();
                    }}
                  />
                </label>
              )}
              {extrudeDialog.extent !== "symmetric" && extrudeDialog.extent !== "upToFace" && (
                <label className="ed-field ed-flip">
                  <span>Flip direction</span>
                  <input
                    type="checkbox"
                    checked={extrudeDialog.flip}
                    onChange={(e) => setExtrudeDialog((d) => (d ? { ...d, flip: e.target.checked } : d))}
                  />
                </label>
              )}
              {extrudePreviewError && <p className="ed-warning">{extrudePreviewError}</p>}
              <div className="ed-actions">
                <button
                  className="ed-primary"
                  disabled={
                    (extrudeDialog.mode !== "new" && !extrudeDialog.targetId) ||
                    (extrudeDialog.extent === "upToFace" && !extrudeDialog.upTo)
                  }
                  onClick={createExtrude}
                >
                  {extrudeDialog.editId ? "Done" : "Create"}
                </button>
                <button onClick={closeExtrudeDialog}>Cancel</button>
              </div>
            </DraggableDialog>
          )}
          {dressUpDialog &&
            (() => {
              // Synchronous validation (empty / unparseable / ≤ 0) is instant and
              // kernel-free; the async geometry error (size too big) lives in
              // `dressUpError`. Show whichever applies; empty stays silent.
              const sv = validateDressUpDialog(dressUpDialog);
              const message = sv.value === null ? sv.error : dressUpError;
              const disabled = sv.value === null || !!dressUpError;
              return (
                <DraggableDialog className="extrude-dialog" style={{ left: dressUpDialog.x, top: dressUpDialog.y }}>
                  <div className="ed-title" data-drag-handle>
                    {dressUpDialog.editId ? "Edit " : ""}
                    {dressUpDialog.op === "chamfer" ? "Chamfer" : "Fillet"}
                  </div>
                  <label className="ed-field">
                    <span>{dressUpDialog.op === "chamfer" ? "Distance" : "Radius"}</span>
                    <input
                      autoFocus
                      onFocus={(e) => e.currentTarget.select()}
                      value={dressUpDialog.size}
                      onChange={(e) => setDressUpDialog((d) => (d ? { ...d, size: e.target.value } : d))}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") createDressUp();
                        else if (e.key === "Escape") closeDressUpDialog();
                      }}
                    />
                  </label>
                  {/* Chamfer only: the bevel angle off the reference face (45° is
                    the symmetric cut), and which of the edge's two adjacent
                    faces that reference is. Flip does nothing at 45°. */}
                  {dressUpDialog.op === "chamfer" && (
                    <>
                      <label className="ed-field">
                        <span>Angle (°)</span>
                        <input
                          value={dressUpDialog.angle}
                          onFocus={(e) => e.currentTarget.select()}
                          onChange={(e) => setDressUpDialog((d) => (d ? { ...d, angle: e.target.value } : d))}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") createDressUp();
                            else if (e.key === "Escape") closeDressUpDialog();
                          }}
                        />
                      </label>
                      <label
                        className="ed-field ed-flip"
                        title="Measure the distance and angle from the edge's other face"
                      >
                        <span>Flip angle</span>
                        <input
                          type="checkbox"
                          checked={dressUpDialog.flip}
                          onChange={(e) => setDressUpDialog((d) => (d ? { ...d, flip: e.target.checked } : d))}
                        />
                      </label>
                    </>
                  )}
                  {message && <p className="ed-warning">{message}</p>}
                  <div className="ed-actions">
                    <button className="ed-primary" onClick={createDressUp} disabled={disabled}>
                      {dressUpDialog.editId ? "Done" : "Create"}
                    </button>
                    <button onClick={closeDressUpDialog}>Cancel</button>
                  </div>
                </DraggableDialog>
              );
            })()}
          {shellDialog &&
            (() => {
              const d = shellDialog;
              // Synchronous validation (empty / unparseable / ≤ 0) is instant and
              // kernel-free; the async geometry error (thickness too big) lives in
              // `shellError`. Show whichever applies; empty stays silent.
              const sv = validateShellThickness(d.thickness, resolved.scope);
              const message = sv.value === null ? sv.error : shellError;
              const disabled = !d.targetId || sv.value === null || !!shellError;
              const bodyName = doc.features.find((f) => f.id === d.targetId)?.name ?? "Body";
              // Persistent face names are scoped by the body that owns them
              // ("<featureId>/-y"), so drop that prefix rather than showing the
              // user a raw UUID. Anything else (a re-matched or renamed face)
              // shows as-is.
              const faceLabel = (n: string) =>
                d.targetId && n.startsWith(`${d.targetId}/`) ? n.slice(d.targetId.length + 1) : n;
              const armBody = () => setShellDialog((p) => (p ? { ...p, arming: "body" } : p));
              const armFaces = () =>
                setShellDialog((p) => (p ? { ...p, arming: p.arming === "faces" ? null : "faces" } : p));
              const dropFace = (name: string) =>
                setShellDialog((p) => {
                  if (!p) return p;
                  const at = p.faces.indexOf(name);
                  return at === -1
                    ? p
                    : {
                        ...p,
                        faces: p.faces.filter((_, i) => i !== at),
                        faceRefs: p.faceRefs.filter((_, i) => i !== at),
                      };
                });
              return (
                <DraggableDialog
                  className="extrude-dialog"
                  style={{ left: "50%", top: 64 }}
                  baseTransform="translateX(-50%)"
                >
                  <div className="ed-title" data-drag-handle>
                    {/* `editId` is set the moment a Create commits, so that a
                        retry updates that feature instead of adding another —
                        but until it BUILDS this is still the creation the user
                        started, and saying "Edit" would be news to them. */}
                    {d.editId && !d.createdId ? "Edit " : ""}Shell
                  </div>
                  <div className="bool-group-label">Body</div>
                  <PickSlot
                    noun="a body"
                    armed={d.arming === "body"}
                    value={d.targetId ? bodyName : null}
                    wide
                    onArm={armBody}
                  />
                  {/* Openings are optional — no faces means a fully sealed hollow
                    shell, which is the common case and so must not require a
                    pick to get to. */}
                  <div className="bool-group-label">Faces to open (optional)</div>
                  {d.faces.map((name) => (
                    <PickedRow
                      key={name}
                      label={faceLabel(name)}
                      title={name}
                      clearTitle="Remove"
                      onClear={() => dropFace(name)}
                    />
                  ))}
                  <PickButton noun="faces" armed={d.arming === "faces"} wide disabled={!d.targetId} onClick={armFaces}>
                    {/* An accumulating slot: it keeps taking clicks after the
                        first, so it says how to stop and how to add more. */}
                    {d.arming === "faces"
                      ? "Selecting faces… (Esc to stop)"
                      : d.faces.length
                        ? "Add more faces"
                        : undefined}
                  </PickButton>
                  <label className="ed-field">
                    <span>Thickness</span>
                    <input
                      autoFocus
                      onFocus={(e) => e.currentTarget.select()}
                      value={d.thickness}
                      onChange={(e) => setShellDialog((p) => (p ? { ...p, thickness: e.target.value } : p))}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") createShell();
                        // The thickness field has autoFocus, so Escape almost
                        // always arrives here rather than at the global handler —
                        // it has to follow the same disarm-then-close order, or
                        // stopping a face pick would blow away the whole dialog.
                        else if (e.key === "Escape") {
                          if (d.arming) setShellDialog((p) => (p ? { ...p, arming: null } : p));
                          else closeShellDialog();
                        }
                      }}
                    />
                  </label>
                  {message && <p className="ed-warning">{message}</p>}
                  <div className="ed-actions">
                    {/* Hollowing a loft is seconds of OCCT work with nothing to
                        see: say so, and refuse further clicks while it runs. */}
                    <button className="ed-primary" onClick={createShell} disabled={disabled || shellBusy}>
                      {shellBusy ? "Working…" : d.editId && !d.createdId ? "Done" : "Create"}
                    </button>
                    <button onClick={closeShellDialog}>Cancel</button>
                  </div>
                </DraggableDialog>
              );
            })()}
          {revolveDialog &&
            (() => {
              const prof = revolveDialog.profile;
              const profileLabel = !prof
                ? null
                : prof.kind === "bodyFace"
                  ? (doc.features.find((f) => f.id === prof.featureId)?.name ?? "Body") + " · face"
                  : (doc.features.find((f) => f.id === prof.sketchId)?.name ?? "Region");
              const ax = revolveDialog.axis;
              const axisLabel = !ax
                ? null
                : "plane" in ax
                  ? planeRefLabel(ax.plane)
                  : "face" in ax
                    ? (doc.features.find((f) => f.id === ax.face.featureId)?.name ?? "Body") + " · face"
                    : "edge" in ax
                      ? (doc.features.find((f) => f.id === ax.edge.featureId)?.name ?? "Body") + " · edge"
                      : (doc.features.find((f) => f.id === ax.sketchId)?.name ?? "Sketch") + " · line";
              const axisArming = picking && pickPurpose === "revolveAxis";
              const armAxis = () => {
                setRevolveDialog((d) => (d ? { ...d, armed: null } : d));
                setPickPurpose("revolveAxis");
                setPicking(true);
              };
              // Arming the profile has to CANCEL an armed axis: the two roles read
              // different click streams (profile = the selection raycaster, axis =
              // picking mode), so without this both stay live — the axis button
              // keeps its armed styling and the next click still fills the axis.
              const armProfile = (clear = false) => {
                if (picking && pickPurpose === "revolveAxis") {
                  setPicking(false);
                  setPickPurpose("sketch");
                }
                setRevolveDialog((d) => (d ? { ...d, ...(clear ? { profile: null } : {}), armed: "profile" } : d));
              };
              return (
                <DraggableDialog className="extrude-dialog" style={{ left: revolveDialog.x, top: revolveDialog.y }}>
                  <div className="ed-title" data-drag-handle>
                    {revolveDialog.editId ? "Edit revolve" : "Revolve"}
                  </div>
                  <div className="ed-hint">
                    Profile: a closed sketch region or a planar body face. Axis: a sketch line, a straight body edge, a
                    plane, or a body face.
                  </div>
                  <div className="bool-group-label">Profile</div>
                  <PickSlot
                    noun="a profile"
                    armed={revolveDialog.armed === "profile"}
                    value={profileLabel}
                    wide
                    onArm={() => armProfile()}
                    onClear={() => armProfile(true)}
                  />
                  <div className="bool-group-label">Axis</div>
                  <PickSlot
                    noun="an axis"
                    armed={axisArming}
                    value={axisLabel}
                    wide
                    onArm={armAxis}
                    onClear={() => {
                      setRevolveDialog((d) => (d ? { ...d, axis: null } : d));
                      armAxis();
                    }}
                  />
                  <div className="ed-modes">
                    {(["full", "angle"] as const).map((m) => (
                      <button
                        key={m}
                        className={revolveDialog.mode === m ? "active" : ""}
                        onClick={() => setRevolveDialog((d) => (d ? { ...d, mode: m } : d))}
                      >
                        {m === "full" ? "Full (360°)" : "Angle"}
                      </button>
                    ))}
                  </div>
                  {revolveDialog.mode === "angle" && (
                    <>
                      <label className="ed-field">
                        <span>Angle (°)</span>
                        <input
                          autoFocus
                          value={revolveDialog.degrees}
                          onChange={(e) => setRevolveDialog((d) => (d ? { ...d, degrees: e.target.value } : d))}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") createRevolve();
                            else if (e.key === "Escape") closeRevolveDialog();
                          }}
                        />
                      </label>
                      <label className="ed-field ed-flip">
                        <span>Symmetric</span>
                        <input
                          type="checkbox"
                          checked={revolveDialog.symmetric}
                          onChange={(e) => setRevolveDialog((d) => (d ? { ...d, symmetric: e.target.checked } : d))}
                        />
                      </label>
                    </>
                  )}
                  {revolvePreviewError && <p className="ed-warning">{revolvePreviewError}</p>}
                  <div className="ed-actions">
                    <button
                      className="ed-primary"
                      disabled={!revolveDialog.profile || !revolveDialog.axis}
                      onClick={createRevolve}
                    >
                      {revolveDialog.editId ? "Done" : "Create"}
                    </button>
                    <button onClick={closeRevolveDialog}>Cancel</button>
                  </div>
                </DraggableDialog>
              );
            })()}
          {dxfDialog && (
            <DraggableDialog
              className="extrude-dialog"
              style={{ left: "50%", top: 64 }}
              baseTransform="translateX(-50%)"
            >
              <div className="ed-title" data-drag-handle>
                Import DXF sketch
              </div>
              <div className="ed-hint">
                {dxfDialog.fileName} — {dxfDialog.preview.total} entit{dxfDialog.preview.total === 1 ? "y" : "ies"}
                {dxfDialog.preview.skipped > 0 && `, ${dxfDialog.preview.skipped} unsupported skipped`}
              </div>
              <label className="ed-field">
                <span>Plane</span>
                <select
                  value={dxfDialog.planeKey}
                  onChange={(e) => setDxfDialog((d) => (d ? { ...d, planeKey: e.target.value } : d))}
                >
                  <option value="datum:plane-top">Top</option>
                  <option value="datum:plane-front">Front</option>
                  <option value="datum:plane-right">Right</option>
                  {userPlanes.map((pl) => (
                    <option key={pl.id} value={`plane:${pl.id}`}>
                      {pl.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="ed-field">
                <span>Units</span>
                <select
                  value={dxfDialog.unitsKey}
                  onChange={(e) => setDxfDialog((d) => (d ? { ...d, unitsKey: e.target.value as DxfUnitsKey } : d))}
                >
                  {DXF_UNITS.map((u) => (
                    <option key={u.key} value={u.key}>
                      {u.label}
                    </option>
                  ))}
                </select>
              </label>
              <div className="ed-actions">
                <button className="ed-primary" onClick={confirmDxfImport} disabled={dxfDialog.preview.total === 0}>
                  Import
                </button>
                <button onClick={() => setDxfDialog(null)}>Cancel</button>
              </div>
            </DraggableDialog>
          )}
          {planeDialog && (
            <DraggableDialog
              className="extrude-dialog"
              style={{ left: "50%", top: 64 }}
              baseTransform="translateX(-50%)"
            >
              <div className="ed-title" data-drag-handle>
                {planeDialog.editId ? "Edit plane" : "Reference plane"}
              </div>
              <label className="ed-field">
                <span>Method</span>
                <select
                  value={planeDialog.method}
                  onChange={(e) => {
                    const method = e.target.value as PlaneMethod;
                    setPlaneDialog((d) => (d ? { ...d, method } : d));
                    // Arm the first pick the method needs: a plane/face for all but
                    // "through", which collects vertices/sketch points via clicks.
                    armPlanePick(method === "through" ? "point" : "base");
                  }}
                >
                  <option value="offset">Offset</option>
                  <option value="midplane">Midplane</option>
                  <option value="angle">At angle</option>
                  <option value="through">Through 3 points</option>
                </select>
              </label>

              {planeDialog.method !== "through" && (
                <div className="ed-field">
                  <span>{planeDialog.method === "midplane" ? "First" : "Base"}</span>
                  <PickSlot
                    noun="a plane/face"
                    armed={planePick === "base"}
                    value={planeDialog.base && planeRefLabel(planeDialog.base)}
                    title={planeDialog.base ? planeRefLabel(planeDialog.base) : undefined}
                    onArm={() => armPlanePick("base")}
                    onClear={() => {
                      setPlaneDialog((d) => (d ? { ...d, base: null } : d));
                      armPlanePick("base");
                    }}
                  />
                </div>
              )}

              {planeDialog.method === "offset" && (
                <label className="ed-field">
                  <span>Offset</span>
                  <input
                    value={planeDialog.offset}
                    onChange={(e) => setPlaneDialog((d) => (d ? { ...d, offset: e.target.value } : d))}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") createPlane();
                      else if (e.key === "Escape") closePlaneDialog();
                    }}
                  />
                </label>
              )}

              {planeDialog.method === "midplane" && (
                <div className="ed-field">
                  <span>Second</span>
                  <PickSlot
                    noun="a plane/face"
                    armed={planePick === "refB"}
                    value={planeDialog.refB && planeRefLabel(planeDialog.refB)}
                    title={planeDialog.refB ? planeRefLabel(planeDialog.refB) : undefined}
                    onArm={() => armPlanePick("refB")}
                    onClear={() => {
                      setPlaneDialog((d) => (d ? { ...d, refB: null } : d));
                      armPlanePick("refB");
                    }}
                  />
                </div>
              )}

              {planeDialog.method === "angle" && (
                <>
                  <div className="ed-field">
                    <span>Hinge</span>
                    <div className="ed-modes" style={{ width: 112 }}>
                      {(["u", "v"] as const).map((ax) => (
                        <button
                          key={ax}
                          className={planeDialog.angleAxis === ax ? "active" : ""}
                          onClick={() => setPlaneDialog((d) => (d ? { ...d, angleAxis: ax } : d))}
                        >
                          {ax.toUpperCase()}
                        </button>
                      ))}
                    </div>
                  </div>
                  <label className="ed-field">
                    <span>Angle°</span>
                    <input
                      value={planeDialog.angle}
                      onChange={(e) => setPlaneDialog((d) => (d ? { ...d, angle: e.target.value } : d))}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") createPlane();
                        else if (e.key === "Escape") closePlaneDialog();
                      }}
                    />
                  </label>
                </>
              )}

              {planeDialog.method === "through" && (
                <div className="ed-field">
                  <span>Points</span>
                  {/* A counting slot: it takes three clicks, so the button
                      shows the tally in both states rather than a bare
                      "Selecting…", and it only reads as FILLED at 3/3 — where
                      it stops taking clicks and ✕ starts the three over. */}
                  <PickSlot
                    noun="points"
                    armed={planePick === "point" && planeDialog.points.length < 3}
                    value={planeDialog.points.length === 3 ? "3/3 picked" : null}
                    clearTitle="Clear the points and pick again"
                    onArm={() => armPlanePick("point")}
                    onClear={() => {
                      setPlaneDialog((d) => (d ? { ...d, points: [] } : d));
                      armPlanePick("point");
                    }}
                  >
                    {`${planeDialog.points.length}/3` + (planePick === "point" ? " · selecting…" : " picked")}
                  </PickSlot>
                </div>
              )}

              <div className="ed-actions">
                <button
                  className="ed-primary"
                  disabled={
                    planeDialog.method === "through"
                      ? planeDialog.points.length !== 3
                      : planeDialog.method === "midplane"
                        ? !planeDialog.base || !planeDialog.refB
                        : !planeDialog.base
                  }
                  onClick={createPlane}
                >
                  {planeDialog.editId ? "Done" : "Create"}
                </button>
                <button onClick={closePlaneDialog}>Cancel</button>
              </div>
            </DraggableDialog>
          )}
          {editingTransform && (
            <DraggableDialog
              className="extrude-dialog"
              style={{ left: transformPanelXY?.x ?? "50%", top: transformPanelXY?.y ?? 64 }}
              baseTransform={transformPanelXY ? undefined : "translateX(-50%)"}
            >
              <div className="ed-title" data-drag-handle>
                Transform · {editingTransform.name}
              </div>
              <div className="ed-modes">
                {(["translate", "rotate", "scale"] as const).map((m) => (
                  <button key={m} className={transformMode === m ? "active" : ""} onClick={() => setTransformMode(m)}>
                    {m === "translate" ? "Move" : m === "rotate" ? "Rotate" : "Scale"}
                  </button>
                ))}
              </div>
              {transformMode === "translate" ? (
                (["tx", "ty", "tz"] as const).map((k) => (
                  <label className="ed-field" key={k}>
                    <span>Move {k[1].toUpperCase()}</span>
                    <input
                      value={liveTransform ? fmt(liveTransform[k]) : editingTransform[k]}
                      onChange={(e) =>
                        setDoc(
                          updateParam(doc, editingTransform.id, k, e.target.value),
                          `param:${editingTransform.id}:${k}`,
                        )
                      }
                      onKeyDown={(e) => {
                        if (e.key === "Enter") finishTransform();
                        else if (e.key === "Escape") cancelTransform();
                      }}
                    />
                  </label>
                ))
              ) : transformMode === "scale" ? (
                <label className="ed-field">
                  <span>Factor</span>
                  <input
                    value={liveTransform ? fmt(liveTransform.scale) : editingTransform.scale}
                    onChange={(e) =>
                      setDoc(
                        updateParam(doc, editingTransform.id, "scale", e.target.value),
                        `param:${editingTransform.id}:scale`,
                      )
                    }
                    onKeyDown={(e) => {
                      if (e.key === "Enter") finishTransform();
                      else if (e.key === "Escape") cancelTransform();
                    }}
                  />
                </label>
              ) : (
                <>
                  <div className="ed-field">
                    <span>Axis</span>
                    <div className="ed-modes" style={{ width: 112 }}>
                      {(["x", "y", "z"] as const).map((ax) => (
                        <button
                          key={ax}
                          className={editingTransform.axis === ax ? "active" : ""}
                          onClick={() =>
                            setDoc(
                              updateParam(doc, editingTransform.id, "axis", ax),
                              `param:${editingTransform.id}:axis`,
                            )
                          }
                        >
                          {ax.toUpperCase()}
                        </button>
                      ))}
                    </div>
                  </div>
                  <label className="ed-field">
                    <span>Angle°</span>
                    <input
                      value={liveTransform ? fmt(liveTransform.angle) : editingTransform.angle}
                      onChange={(e) =>
                        setDoc(
                          updateParam(doc, editingTransform.id, "angle", e.target.value),
                          `param:${editingTransform.id}:angle`,
                        )
                      }
                      onKeyDown={(e) => {
                        if (e.key === "Enter") finishTransform();
                        else if (e.key === "Escape") cancelTransform();
                      }}
                    />
                  </label>
                </>
              )}
              <label className="ed-field ed-flip">
                <span>Keep original (copy)</span>
                <input
                  type="checkbox"
                  checked={editingTransform.copy}
                  onChange={(e) => setDoc(updateParam(doc, editingTransform.id, "copy", String(e.target.checked)))}
                />
              </label>
              <div className="ed-hint">
                {transformMode === "scale"
                  ? "Uniform scale about the body's centre — drag a corner of the box out to grow, in to shrink."
                  : "Drag the gizmo, or type exact values."}
              </div>
              <div className="ed-actions">
                <button className="ed-primary" onClick={finishTransform}>
                  Done
                </button>
                <button onClick={cancelTransform}>Cancel</button>
              </div>
            </DraggableDialog>
          )}
          {transformArming && !editingTransform && (
            <DraggableDialog
              className="extrude-dialog"
              style={{ left: transformPanelXY?.x ?? "50%", top: transformPanelXY?.y ?? 64 }}
              baseTransform={transformPanelXY ? undefined : "translateX(-50%)"}
            >
              <div className="ed-title" data-drag-handle>
                Transform
              </div>
              <div className="ed-modes">
                {(["translate", "rotate", "scale"] as const).map((m) => (
                  <button
                    key={m}
                    className={transformArming.mode === m ? "active" : ""}
                    onClick={() => setTransformArming({ mode: m })}
                  >
                    {m === "translate" ? "Move" : m === "rotate" ? "Rotate" : "Scale"}
                  </button>
                ))}
              </div>
              <PickSlot noun="a body" armed value={null} wide onArm={() => {}} />
              <div className="ed-actions">
                <button onClick={cancelTransformArming}>Cancel</button>
              </div>
            </DraggableDialog>
          )}
          {measure && (
            <div className="selection-info">
              <div className="si-title">{measure.title}</div>
              {measure.rows.map((r) => (
                <div className="si-row" key={r.label}>
                  <span className="si-label">{r.label}</span>
                  <span className="si-value">{r.value}</span>
                </div>
              ))}
            </div>
          )}
        </main>
      </div>
      {booleanDialog && (
        <BooleanDialog
          op={booleanDialog.op}
          editing={!!booleanDialog.editId}
          candidates={booleanCandidates}
          operandIds={booleanDialog.operandIds}
          base={booleanDialog.base}
          tools={booleanDialog.tools}
          armed={booleanDialog.armed}
          onOpChange={setBooleanOp}
          onArm={(slot) => setBooleanDialog((d) => (d ? { ...d, armed: slot } : d))}
          onRemoveOperand={(id) =>
            setBooleanDialog((d) => (d ? { ...d, operandIds: d.operandIds.filter((x) => x !== id) } : d))
          }
          onClearBase={() => setBooleanDialog((d) => (d ? { ...d, base: null, armed: "base" } : d))}
          onRemoveTool={(id) => setBooleanDialog((d) => (d ? { ...d, tools: d.tools.filter((x) => x !== id) } : d))}
          onConfirm={confirmBoolean}
          onCancel={closeBooleanDialog}
        />
      )}
      {mirrorDialog && (
        <DraggableDialog className="extrude-dialog" style={{ left: "50%", top: 70 }} baseTransform="translateX(-50%)">
          <div className="ed-title" data-drag-handle>
            Mirror across plane
          </div>
          <label className="ed-field">
            <span>Plane</span>
            <select
              value={mirrorDialog.plane}
              onChange={(e) => {
                const plane = e.target.value;
                setMirrorDialog((d) => (d ? { ...d, plane } : d));
                setPickingMirrorFace(plane === "face" && !mirrorDialog.faceRef);
              }}
            >
              {mirrorPlaneOptions.map((o) => (
                <option key={o.key} value={o.key}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
          {mirrorDialog.plane === "face" && (
            <div className="ed-field">
              <span>Face</span>
              <PickSlot
                noun="a face"
                armed={pickingMirrorFace}
                value={
                  mirrorDialog.faceRef
                    ? `On ${doc.features.find((f) => f.id === mirrorDialog.faceRef!.featureId)?.name ?? "body"}`
                    : null
                }
                onArm={() => setPickingMirrorFace((v) => !v)}
                onClear={() => {
                  setMirrorDialog((d) => (d ? { ...d, faceRef: null } : d));
                  setPickingMirrorFace(true);
                }}
              />
            </div>
          )}
          <div className="ed-actions">
            <button
              className="ed-primary"
              onClick={createMirror}
              disabled={mirrorDialog.plane === "face" && !mirrorDialog.faceRef}
            >
              Create
            </button>
            <button onClick={closeMirror}>Cancel</button>
          </div>
        </DraggableDialog>
      )}
      {patternDialog &&
        (() => {
          const d = patternDialog;
          const targetName = doc.features.find((f) => f.id === d.targetId)?.name ?? "Body";
          const lineLabel = (ref: { sketchId: string }) =>
            (doc.features.find((f) => f.id === ref.sketchId)?.name ?? "Sketch") + " · line";
          const axis = d.axis;
          const axisLabel = !axis
            ? null
            : "world" in axis
              ? `World ${axis.world.toUpperCase()}`
              : "face" in axis
                ? (doc.features.find((f) => f.id === axis.face.featureId)?.name ?? "Body") + " · face"
                : lineLabel(axis);
          // The direction dropdowns show "line" while a sketch-line ref is set OR
          // its pick is being armed; picking a world option cancels the arming.
          const dirValue = (slot: "dir1" | "dir2", ref: PatternDirRef | null) =>
            d.arming === slot || (ref && !("world" in ref)) ? "line" : ref ? ref.world : "";
          const setDir = (slot: "dir1" | "dir2") => (v: string) => {
            if (v === "line") {
              armPatternPick(slot);
              return;
            }
            if (v !== "x" && v !== "y" && v !== "z") return;
            if (picking && d.arming === slot) {
              setPicking(false);
              setPickPurpose("sketch");
            }
            setPatternDialog((p) => (p ? { ...p, [slot]: { world: v }, arming: null } : p));
          };
          const dirPicking = (slot: "dir1" | "dir2") => picking && pickPurpose === "patternDir" && d.arming === slot;
          const axisArming = picking && pickPurpose === "patternAxis";
          const targetArming = patternDialog.arming === "target";
          const armTarget = () => setPatternDialog((p) => (p ? { ...p, targetId: null, arming: "target" } : p));
          return (
            <DraggableDialog
              className="extrude-dialog"
              style={{ left: "50%", top: 64 }}
              baseTransform="translateX(-50%)"
            >
              <div className="ed-title" data-drag-handle>
                {d.editId ? "Edit pattern" : "Pattern"}
              </div>
              <div className="ed-modes">
                {(["linear", "circular"] as const).map((k) => (
                  <button
                    key={k}
                    className={d.kind === k ? "active" : ""}
                    onClick={() => setPatternDialog((p) => (p ? { ...p, kind: k, arming: null } : p))}
                  >
                    {k === "linear" ? "Linear" : "Circular"}
                  </button>
                ))}
              </div>
              <div className="bool-group-label">Body</div>
              <PickSlot
                noun="a body"
                armed={targetArming}
                value={d.targetId ? targetName : null}
                wide
                onArm={armTarget}
              />
              {d.kind === "linear" ? (
                <>
                  <div className="bool-group-label">Direction</div>
                  <label className="ed-field">
                    <span>Along</span>
                    <select value={dirValue("dir1", d.dir1)} onChange={(e) => setDir("dir1")(e.target.value)}>
                      <option value="x">World X</option>
                      <option value="y">World Y</option>
                      <option value="z">World Z</option>
                      <option value="line">Sketch line…</option>
                    </select>
                  </label>
                  {(dirPicking("dir1") || !("world" in d.dir1)) && (
                    <PickSlot
                      noun="a sketch line"
                      armed={dirPicking("dir1")}
                      value={"world" in d.dir1 ? null : lineLabel(d.dir1)}
                      wide
                      onArm={() => armPatternPick("dir1")}
                    />
                  )}
                  <label className="ed-field">
                    <span>Count</span>
                    <input
                      autoFocus
                      value={d.count1}
                      onChange={(e) => setPatternDialog((p) => (p ? { ...p, count1: e.target.value } : p))}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") createPattern();
                      }}
                    />
                  </label>
                  <label className="ed-field">
                    <span>Spacing</span>
                    <input
                      value={d.spacing1}
                      onChange={(e) => setPatternDialog((p) => (p ? { ...p, spacing1: e.target.value } : p))}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") createPattern();
                      }}
                    />
                  </label>
                  <label className="ed-field ed-flip">
                    <span>Flip</span>
                    <input
                      type="checkbox"
                      checked={d.flip1}
                      onChange={(e) => setPatternDialog((p) => (p ? { ...p, flip1: e.target.checked } : p))}
                    />
                  </label>
                  <label className="ed-field ed-flip">
                    <span>Second direction</span>
                    <input
                      type="checkbox"
                      checked={d.dir2on}
                      onChange={(e) =>
                        setPatternDialog((p) => (p ? { ...p, dir2on: e.target.checked, arming: null } : p))
                      }
                    />
                  </label>
                  {d.dir2on && (
                    <>
                      <label className="ed-field">
                        <span>Along</span>
                        <select value={dirValue("dir2", d.dir2)} onChange={(e) => setDir("dir2")(e.target.value)}>
                          <option value="" disabled>
                            Choose…
                          </option>
                          <option value="x">World X</option>
                          <option value="y">World Y</option>
                          <option value="z">World Z</option>
                          <option value="line">Sketch line…</option>
                        </select>
                      </label>
                      {(dirPicking("dir2") || (d.dir2 && !("world" in d.dir2))) && (
                        <PickSlot
                          noun="a sketch line"
                          armed={dirPicking("dir2")}
                          value={d.dir2 && !("world" in d.dir2) ? lineLabel(d.dir2) : null}
                          wide
                          onArm={() => armPatternPick("dir2")}
                        />
                      )}
                      <label className="ed-field">
                        <span>Count</span>
                        <input
                          value={d.count2}
                          onChange={(e) => setPatternDialog((p) => (p ? { ...p, count2: e.target.value } : p))}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") createPattern();
                          }}
                        />
                      </label>
                      <label className="ed-field">
                        <span>Spacing</span>
                        <input
                          value={d.spacing2}
                          onChange={(e) => setPatternDialog((p) => (p ? { ...p, spacing2: e.target.value } : p))}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") createPattern();
                          }}
                        />
                      </label>
                      <label className="ed-field ed-flip">
                        <span>Flip</span>
                        <input
                          type="checkbox"
                          checked={d.flip2}
                          onChange={(e) => setPatternDialog((p) => (p ? { ...p, flip2: e.target.checked } : p))}
                        />
                      </label>
                    </>
                  )}
                </>
              ) : (
                <>
                  <div className="bool-group-label">Axis</div>
                  {/* The world-axis shortcut only shows while the slot is empty —
                      once an axis is set, ✕ is the way back to choosing one. */}
                  {!axisLabel && (
                    <label className="ed-field">
                      <span>World</span>
                      <select
                        value=""
                        onChange={(e) => {
                          const v = e.target.value;
                          if (v !== "x" && v !== "y" && v !== "z") return;
                          if (picking && d.arming === "axis") {
                            setPicking(false);
                            setPickPurpose("sketch");
                          }
                          setPatternDialog((p) => (p ? { ...p, axis: { world: v }, arming: null } : p));
                        }}
                      >
                        <option value="">Choose…</option>
                        <option value="x">World X (through the origin)</option>
                        <option value="y">World Y (through the origin)</option>
                        <option value="z">World Z (through the origin)</option>
                      </select>
                    </label>
                  )}
                  <PickSlot
                    noun="an axis (sketch line / cylindrical face)"
                    armed={axisArming}
                    value={axisLabel}
                    wide
                    onArm={() => armPatternPick("axis")}
                    onClear={() => {
                      setPatternDialog((p) => (p ? { ...p, axis: null } : p));
                      armPatternPick("axis");
                    }}
                  >
                    {/* The full "which kinds qualify" phrase is only useful
                        before the pick; while arming, the banner says it. */}
                    {axisArming ? "Selecting an axis…" : undefined}
                  </PickSlot>
                  <label className="ed-field">
                    <span>Count</span>
                    <input
                      autoFocus
                      value={d.count}
                      onChange={(e) => setPatternDialog((p) => (p ? { ...p, count: e.target.value } : p))}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") createPattern();
                      }}
                    />
                  </label>
                  <div className="ed-modes">
                    {(["full", "angle"] as const).map((m) => (
                      <button
                        key={m}
                        className={d.mode === m ? "active" : ""}
                        onClick={() => setPatternDialog((p) => (p ? { ...p, mode: m } : p))}
                      >
                        {m === "full" ? "Full (360°)" : "Angle"}
                      </button>
                    ))}
                  </div>
                  {d.mode === "angle" && (
                    <>
                      <label className="ed-field">
                        <span>Angle (°)</span>
                        <input
                          value={d.angle}
                          onChange={(e) => setPatternDialog((p) => (p ? { ...p, angle: e.target.value } : p))}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") createPattern();
                          }}
                        />
                      </label>
                      <label className="ed-field ed-flip">
                        <span>Symmetric</span>
                        <input
                          type="checkbox"
                          checked={d.symmetric}
                          onChange={(e) => setPatternDialog((p) => (p ? { ...p, symmetric: e.target.checked } : p))}
                        />
                      </label>
                    </>
                  )}
                  {axis && "face" in axis && (
                    <div className="ed-hint">
                      A face axis resolves in the kernel — the preview appears after Create.
                    </div>
                  )}
                </>
              )}
              {patternDialogWarning && <p className="ed-warning">{patternDialogWarning}</p>}
              <div className="ed-actions">
                <button
                  className="ed-primary"
                  disabled={!!patternDialogWarning || (d.kind === "circular" && !d.axis)}
                  onClick={createPattern}
                >
                  {d.editId ? "Done" : "Create"}
                </button>
                <button onClick={closePattern}>Cancel</button>
              </div>
            </DraggableDialog>
          );
        })()}
    </div>
  );
}
