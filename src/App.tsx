import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ChangeEvent, type PointerEvent, type ReactNode } from "react";
import { KernelClient } from "./kernel/KernelClient";
import {
  addBoolean,
  addDressUp,
  addExtrude,
  addFeature,
  addImport,
  addLoft,
  addMirror,
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
  setRollbackIndex,
  setSketchConstraints,
  setSketchEntities,
  setSuppressed,
  setTransform,
  updateParam,
  updateVariable,
} from "./document/document";
import {
  applyDerivedToSketch,
  projectedEntityFromPolyline,
  projectedPointEntity,
  sameProjectedEntities,
} from "./document/derived";
import { DEFAULT_SOLID_COLOR } from "./document/colors";
import type {
  DerivedOp,
  ProjectRef,
  Document,
  EdgeRef,
  ExtrudeExtent,
  ExtrudeProfile,
  FeatureKind,
  UpToFaceRef,
  PlaneFeature,
  PlaneMethod,
  PointRef,
  RevolveAxis,
  SketchConstraint,
  SketchEntity,
  SketchFeature,
  TransformFeature,
  Vec2,
} from "./document/types";
import type { BooleanOp, MeshedEdges, MeshedFaces } from "./kernel/types";
import { solveSketch } from "./sketch/solver";
import { measureSelection } from "./selection/measure";
import { deriveFaceFrame, frameOf, planeRefLabel, uvToWorld, worldToUv, type PlaneFrameData, type SketchPlaneId, type SketchPlaneRef } from "./document/planes";
import { evaluateExpression } from "./document/expression";
import { detectSketchRegions, regionsEnclosedBy } from "./document/regions";
import { FEATURE_DEFS, FEATURE_KINDS } from "./document/featureDefs";
import { getActiveDocId, listMeta, loadDoc, putDoc, setActiveDocId } from "./storage/db";
import {
  arcFrom3,
  circleFrom3,
  detectSingleChain,
  fitProjectedPolyline,
  loopSegments,
  mirrorEntity,
  offsetChain,
  rectangleCorners,
  rectangleFromCenter,
  regularPolygon,
  type ChainEdge,
  type FittedProjection,
  type OffsetPrimitive,
} from "./document/sketchTools";
import { useHistory } from "./hooks/useHistory";
import { useAgentBridge } from "./agent/useAgentBridge";
import type { AgentMesh, RegenSettle } from "./agent/commands";
import { ConstructionIcon, HorizontalIcon, OffsetIcon, ParallelIcon, VerticalIcon } from "./ui/icons";
import { BooleanDialog } from "./ui/BooleanDialog";
import { DraggableDialog } from "./ui/DraggableDialog";
import { DimensionOverlay, type DimSpec } from "./ui/DimensionOverlay";
import { DimValueInput, type VarOption } from "./ui/DimValueInput";
import { FeatureTree } from "./ui/FeatureTree";
import { ParamEditor } from "./ui/ParamEditor";
import { SolidsList } from "./ui/SolidsList";
import { VariablesPanel } from "./ui/VariablesPanel";
import {
  Viewport,
  sameSelection,
  type DatumId,
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

/** Compact number formatting for the dimension input (trims trailing zeros). */
const fmt = (n: number) => {
  const r = Math.round(n * 1000) / 1000;
  return Number.isInteger(r) ? String(r) : String(r);
};

/** Human-readable label for a sketch constraint (for the constraints list). */
const constraintLabel = (c: SketchConstraint): string => {
  switch (c.type) {
    case "horizontal": return "Horizontal";
    case "vertical": return "Vertical";
    case "parallel": return "Parallel";
    case "perpendicular": return "Perpendicular";
    case "equal": return "Equal";
    case "distance": return `Length ${fmt(c.value)}`;
    case "radius": return `Radius ${fmt(c.value)}`;
    case "angle": return `Angle ${fmt(c.value)}°`;
    case "tangent": return "Tangent";
    case "coincident": return "origin" in c.a || "origin" in c.b ? "Coincident (origin)" : "Coincident";
    case "pointOnLine": return "origin" in c.point ? "On line (origin)" : "Point on line";
    case "midpoint": return "Midpoint";
  }
};

/** Average position of a tessellated body face — the centroid fallback used to
 *  re-find a face that has no persistent name yet. */
function faceCentroid(
  faces: MeshedFaces,
  faceId: number,
): [number, number, number] | null {
  const g = faces.faceGroups?.find((fg) => fg.faceId === faceId);
  if (!g) return null;
  const { triangles, vertices } = faces;
  let sx = 0, sy = 0, sz = 0, n = 0;
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
    let nx = 0, ny = 0, nz = 0;
    for (let k = g.start; k < g.start + g.count; k++) {
      const vi = triangles[k] * 3;
      nx += normals[vi]; ny += normals[vi + 1]; nz += normals[vi + 2];
    }
    const l = Math.hypot(nx, ny, nz);
    if (l > 1e-9) n = [nx / l, ny / l, nz / l];
  }
  if (!n) {
    for (let k = g.start; k + 2 < g.start + g.count; k += 3) {
      const a = triangles[k] * 3, b = triangles[k + 1] * 3, c = triangles[k + 2] * 3;
      const ux = vertices[b] - vertices[a], uy = vertices[b + 1] - vertices[a + 1], uz = vertices[b + 2] - vertices[a + 2];
      const vx = vertices[c] - vertices[a], vy = vertices[c + 1] - vertices[a + 1], vz = vertices[c + 2] - vertices[a + 2];
      const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      const l = Math.hypot(nx, ny, nz);
      if (l > 1e-9) { n = [nx / l, ny / l, nz / l]; break; }
    }
  }
  if (!n) return null;
  // Reject a non-planar face: every vertex must lie on the plane (point + n).
  const a0 = triangles[g.start] * 3;
  const px = vertices[a0], py = vertices[a0 + 1], pz = vertices[a0 + 2];
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
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < vertices.length; i += 3) {
    const x = vertices[i], y = vertices[i + 1], z = vertices[i + 2];
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }
  return [(minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2];
}

/** 2D: is point p inside triangle a-b-c (uv space)? (sign-consistency test) */
function pointInTriangle(p: Vec2, a: Vec2, b: Vec2, c: Vec2): boolean {
  const cross = (o: Vec2, u: Vec2, w: Vec2) => (u[0] - o[0]) * (w[1] - o[1]) - (u[1] - o[1]) * (w[0] - o[0]);
  const d1 = cross(p, a, b), d2 = cross(p, b, c), d3 = cross(p, c, a);
  return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0));
}

/** Where two infinite lines (uv space) cross, or null if they're parallel
 *  (within ~0.006°) — the corner an angle dimension's arc/box is anchored on. */
function lineLineIntersection(a1: Vec2, b1: Vec2, a2: Vec2, b2: Vec2): Vec2 | null {
  const d1x = b1[0] - a1[0], d1y = b1[1] - a1[1];
  const d2x = b2[0] - a2[0], d2y = b2[1] - a2[1];
  const len1 = Math.hypot(d1x, d1y) || 1, len2 = Math.hypot(d2x, d2y) || 1;
  const ux1 = d1x / len1, uy1 = d1y / len1, ux2 = d2x / len2, uy2 = d2y / len2;
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
  const dx = far[0] - p[0], dy = far[1] - p[1];
  const l = Math.hypot(dx, dy) || 1;
  return [dx / l, dy / l];
}

/** Rough uv-space centre of a sketch's geometry (bounding-box midpoint) — lets
 *  a length dimension pick the offset side that reads outside the profile
 *  rather than across it. */
function sketchBoundsCenter(entities: SketchEntity[]): Vec2 {
  let minU = Infinity, minV = Infinity, maxU = -Infinity, maxV = -Infinity;
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
function moveSketchPoints(
  entities: SketchEntity[],
  points: { from: Vec2; to: Vec2 }[],
): SketchEntity[] {
  const key = (p: Vec2) => `${p[0].toFixed(4)},${p[1].toFixed(4)}`;
  const moves = new Map(points.map((m) => [key(m.from), m.to]));
  const mv = (p: Vec2): Vec2 => moves.get(key(p)) ?? p;
  return entities.map((e) => {
    switch (e.type) {
      case "line": return { ...e, a: mv(e.a), b: mv(e.b) };
      case "circle": return { ...e, c: mv(e.c) };
      case "arc": return { ...e, c: mv(e.c) };
      case "spline": return { ...e, points: e.points.map(mv) };
      case "point": return { ...e, p: mv(e.p) };
      case "text": return { ...e, p: mv(e.p) };
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
  let cu = 0, cv = 0;
  for (const p of outline) { cu += p[0]; cv += p[1]; }
  const centroid: Vec2 = [cu / outline.length, cv / outline.length];
  for (const m of meshes) {
    const { vertices, triangles, faceGroups } = m.mesh.faces;
    if (!faceGroups) continue;
    for (const g of faceGroups) {
      const uv: Vec2[] = [];
      let coplanar = true;
      for (let k = g.start; k < g.start + g.count; k++) {
        const i = triangles[k] * 3;
        const dx = vertices[i] - ox, dy = vertices[i + 1] - oy, dz = vertices[i + 2] - oz;
        if (Math.abs(dx * nx + dy * ny + dz * nz) > TOL) { coplanar = false; break; }
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
  let sx = 0, sy = 0, sz = 0, n = 0;
  for (let v = g.start; v < g.start + g.count; v++) {
    sx += lines[v * 3]; sy += lines[v * 3 + 1]; sz += lines[v * 3 + 2]; n++;
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
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  let length = 0;
  for (let v = g.start; v < g.start + g.count; v++) {
    const x = lines[v * 3], y = lines[v * 3 + 1], z = lines[v * 3 + 2];
    minX = Math.min(minX, x); minY = Math.min(minY, y); minZ = Math.min(minZ, z);
    maxX = Math.max(maxX, x); maxY = Math.max(maxY, y); maxZ = Math.max(maxZ, z);
    if (v > g.start) {
      length += Math.hypot(x - lines[(v - 1) * 3], y - lines[(v - 1) * 3 + 1], z - lines[(v - 1) * 3 + 2]);
    }
  }
  return { mid: [(minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2], length };
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
const safeFilename = (name: string) => name.replace(/[^a-z0-9_\-]+/gi, "_");

const DATUM_ROWS: { id: DatumId; kind: string; label: string }[] = [
  { id: "origin", kind: "Point", label: "Origin" },
  { id: "plane-top", kind: "Plane", label: "Top" },
  { id: "plane-front", kind: "Plane", label: "Front" },
  { id: "plane-right", kind: "Plane", label: "Right" },
];

const SKETCH_TOOLS: { tool: SketchTool; label: ReactNode; title: string; sc: string }[] = [
  { tool: "select", label: "↖", title: "Select (S)", sc: "S" },
  { tool: "line", label: "╱", title: "Line (L)", sc: "L" },
  { tool: "rect-corner", label: "▭", title: "Rectangle: 2 corners (R)", sc: "R" },
  { tool: "rect-center", label: "⊞", title: "Rectangle: center + corner (Shift+R)", sc: "⇧R" },
  { tool: "circle-center", label: "○", title: "Circle: center + radius (C)", sc: "C" },
  { tool: "circle-3p", label: "◔", title: "Circle: 3 points (Shift+C)", sc: "⇧C" },
  { tool: "polygon", label: "⬢", title: "Regular polygon (P)", sc: "P" },
  { tool: "arc-3p", label: "⌒", title: "Arc: 3 points (A)", sc: "A" },
  { tool: "spline", label: "∿", title: "Spline (Shift+S): click points, Esc to finish", sc: "⇧S" },
  { tool: "offset", label: <OffsetIcon />, title: "Offset (O): select a single chain of edges, then drag / type the distance", sc: "O" },
  { tool: "mirror", label: "◫", title: "Mirror (M): click a line to arm the mirror axis, then click entities to mirror; Enter commits, Esc cancels", sc: "M" },
  { tool: "project", label: "⧉", title: "Project / Convert (U): click body edges & vertices to project them onto the sketch; Enter commits, Esc cancels", sc: "U" },
  { tool: "text", label: "T", title: "Text (T): click to place, then type the text & height; Enter commits, Esc cancels", sc: "T" },
];
const sketchToolMeta = (t: SketchTool) => SKETCH_TOOLS.find((x) => x.tool === t)!;

// The two circle tools and the two rectangle tools each collapse into a single
// flyout button that expands horizontally to reveal its variants. Shortcuts are
// unchanged: the bare key picks variant[0], Shift the second (see SKETCH_KEYS /
// SKETCH_SHIFT_KEYS). The collapsed button shows the last-used variant's icon.
const SKETCH_GROUPS = {
  rect: { title: "Rectangle (R = 2 corners, Shift+R = center)", variants: ["rect-corner", "rect-center"] as const },
  circle: { title: "Circle (C = center + radius, Shift+C = 3 points)", variants: ["circle-center", "circle-3p"] as const },
};
type SketchGroupId = keyof typeof SKETCH_GROUPS;
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

const VIEW_BUTTONS: { name: ViewName; label: string }[] = [
  { name: "top", label: "Top" },
  { name: "front", label: "Front" },
  { name: "right", label: "Right" },
  { name: "back", label: "Back" },
  { name: "left", label: "Left" },
  { name: "bottom", label: "Bottom" },
  { name: "iso", label: "Iso" },
];

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
      else if (f?.type === "transform") ids.add(f.copy ? f.id : f.targetId);
      else ids.add(s.id);
    }
    return ids;
  }, [selection, doc]);
  const primaryFeatureId = selection.length ? featureIdOf(selection[selection.length - 1]) : null;
  const selectFeature = (id: string | null) =>
    setSelection(id === null ? [] : [{ kind: "feature", id }]);
  // Regular clicks accumulate into the set; clicking a selected element removes
  // it; clicking empty space clears.
  const handlePick = (picked: Selection | null) => {
    // Up-to-face pick armed (from the extrude dialog): the next clicked body
    // face becomes the extrude's target face; anything else cancels the arming.
    if (pickingUpFace) {
      if (picked?.kind === "face") {
        const m = meshes.find((x) => x.id === picked.featureId);
        const center = m ? faceCentroid(m.mesh.faces, picked.faceId) : null;
        if (center) {
          const faceName = m ? faceNameOf(m.mesh.faces, picked.faceId) : undefined;
          // normal completes the geometric fingerprint (null for non-planar).
          const normal = (m && faceNormal(m.mesh.faces, picked.faceId)) || undefined;
          setExtrudeDialog((d) => (d ? { ...d, upTo: { featureId: picked.featureId, faceName, center, normal } } : d));
        }
      }
      setPickingUpFace(false);
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
    // Revolve dialog open: arming the PROFILE (a sketch region) happens here via
    // the normal selection raycaster. Arming the AXIS uses picking mode instead
    // (→ handleAxisPick), so one click stream can take a sketch line, a body
    // face, or a datum/reference plane.
    if (revolveDialog && revolveDialog.armed === "profile") {
      if (picked?.kind === "sketchFace") {
        const profile = { sketchId: picked.sketchId, regionId: picked.regionId };
        setRevolveDialog((d) => (d ? { ...d, profile, armed: null } : d));
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
          flashSketchMsg("Click a line to set the mirror axis.");
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
      if (!entity) { flashSketchMsg("Couldn't project that edge."); return; }
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
  const [picking, setPicking] = useState(false);
  // What the plane/face pick flow is for: starting a sketch, or the base of a
  // new reference plane.
  const [pickPurpose, setPickPurpose] = useState<"sketch" | "plane" | "revolveAxis">("sketch");
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
  } | null>(null);
  // What the next viewport pick fills in the plane dialog (null = not arming a
  // plane pick). "base"/"refB" use plane/face pick mode; "point" reads a vertex /
  // sketch point from a normal click.
  const [planePick, setPlanePick] = useState<"base" | "refB" | "point" | null>(null);
  // The Mirror dialog: the body to mirror + the chosen plane key (see plane keys).
  // `plane === "face"` mirrors across a picked planar body face, stored in
  // `faceRef` (a frozen frame snapshot, like a sketch-on-face placement).
  const [mirrorDialog, setMirrorDialog] = useState<
    { targetId: string; plane: string; faceRef: { featureId: string; frame: PlaneFrameData } | null } | null
  >(null);
  // Armed by the Mirror dialog: the next clicked planar body face is the plane.
  const [pickingMirrorFace, setPickingMirrorFace] = useState(false);
  const [editingSketchId, setEditingSketchId] = useState<string | null>(null);
  const [sketchTool, setSketchToolState] = useState<SketchTool>("line");
  const [draft, setDraft] = useState<Vec2[]>([]);
  // Line tool: the active-sketch entity (if any) that the *current* draft start
  // point landed on, and whether it was that entity's midpoint — so the first
  // segment's start gets a point-on-line / midpoint constraint (the end of each
  // segment is constrained from its own snap).
  const lineStartOnRef = useRef<{ id: string; mid: boolean } | undefined>(undefined);
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
  const [projectSession, setProjectSession] = useState<{ refs: ProjectRef[]; keys: string[]; previews: SketchEntity[] } | null>(null);
  const projectSessionRef = useRef(projectSession);
  projectSessionRef.current = projectSession;
  const commitProjectRef = useRef<() => void>(() => {});
  // Text tool: after clicking the plane to set the anchor, the user types the
  // string + height in a floating box. Live-previewed; committed on Enter,
  // discarded on Esc. Null = no placement in progress.
  // `editId` set ⇒ editing an existing text entity in place (re-edit), else a
  // fresh placement.
  const [textDraft, setTextDraft] = useState<{ anchor: Vec2; value: string; height: string; editId?: string } | null>(null);
  const textDraftRef = useRef(textDraft);
  textDraftRef.current = textDraft;
  // In-progress edit of a committed offset op's distance (keyed by op id). Shown
  // when a single derived offset entity is selected; null = not editing.
  const [offsetEdit, setOffsetEdit] = useState<{ opId: string; value: string } | null>(null);
  const [fullyConstrained, setFullyConstrained] = useState(false);
  // The last solve reported conflicting/redundant (over-)constraints.
  const [solveConflict, setSolveConflict] = useState(false);
  // A transient banner shown over the sketch (e.g. a rejected, conflicting
  // dimension), auto-dismissed after a few seconds.
  const [sketchMsg, setSketchMsg] = useState<string | null>(null);
  const sketchMsgTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flashSketchMsg = (text: string) => {
    setSketchMsg(text);
    if (sketchMsgTimer.current) clearTimeout(sketchMsgTimer.current);
    sketchMsgTimer.current = setTimeout(() => setSketchMsg(null), 4000);
  };
  // Dimension entry: the entity being dimensioned, whether it's a line length or
  // a circle radius, the in-progress text, and the on-screen position (px,
  // canvas-relative) to anchor the input box.
  const [dimInput, setDimInput] = useState<
    {
      entityId: string;
      /** Second line, for an angle dimension between two lines. */
      entityId2?: string;
      kind: "length" | "radius" | "angle";
      /** The constraint being edited (if reopening an existing one), so its
       *  on-canvas label is hidden while the input is open. */
      editId?: string;
      value: string;
      x: number;
      y: number;
    } | null
  >(null);
  // Armed dimension mode: D was pressed with nothing selected; the next picked
  // line/circle becomes the dimension target.
  const [dimPending, setDimPending] = useState(false);
  // The extrude dialog (anchored at the profile) while choosing parameters.
  const [extrudeDialog, setExtrudeDialog] = useState<
    { mode: "new" | "add" | "remove"; distance: string; flip: boolean; extent: ExtrudeExtent; targetId: string | null; upTo: UpToFaceRef | null; x: number; y: number } | null
  >(null);
  // True while the extrude dialog's "Select a face" pick is armed: the next
  // body face clicked in the viewport fills the up-to-face target.
  const [pickingUpFace, setPickingUpFace] = useState(false);
  // Live ghost preview of the extrude dialog's current params: one entry per
  // body the regen result represents (every new extrude for "new", or the
  // single chosen target for "add"/"remove") — used to swap those bodies' real
  // meshes out for the translucent previews while the dialog is open.
  const [extrudePreview, setExtrudePreview] = useState<{ bodyId: string; mesh: FeatureMesh["mesh"] }[] | null>(
    null,
  );
  const [extrudePreviewError, setExtrudePreviewError] = useState<string | null>(null);
  // Live ghost of the revolve dialog's currently-armed inputs (translucent solid
  // of the would-be result), and its build/resolve error if any.
  const [revolvePreview, setRevolvePreview] = useState<FeatureMesh["mesh"] | null>(null);
  const [revolvePreviewError, setRevolvePreviewError] = useState<string | null>(null);
  const [dressUpDialog, setDressUpDialog] = useState<
    { op: "chamfer" | "fillet"; size: string; x: number; y: number } | null
  >(null);
  // Revolve dialog. The user arms a profile face and an axis (a sketch line or a
  // plane) by clicking in the viewport — like the Boolean dialog — then sets the
  // angle (Full 360° vs. a specified angle + optional symmetric sweep). `armed`
  // says which role the next viewport click fills.
  const [revolveDialog, setRevolveDialog] = useState<
    {
      profile: { sketchId: string; regionId: string } | null;
      axis: RevolveAxis | null;
      armed: "profile" | "axis" | null;
      mode: "full" | "angle";
      degrees: string;
      symmetric: boolean;
      x: number;
      y: number;
    } | null
  >(null);
  // The Transform feature currently being edited with the gizmo (a floating
  // panel + viewport gizmo are shown while this is set), and which gizmo to show.
  const [transformEditId, setTransformEditId] = useState<string | null>(null);
  const [transformMode, setTransformMode] = useState<TransformMode>("translate");
  // Live numeric readout during a gizmo drag (display only; cleared on commit).
  // Kept out of the document so dragging never regenerates the kernel.
  const [liveTransform, setLiveTransform] = useState<{ tx: number; ty: number; tz: number; angle: number } | null>(null);
  // How the current transform edit began, so Cancel knows what to undo: a
  // just-created transform is dropped entirely; an existing one being re-edited
  // is reverted to the snapshot it had when this edit started.
  const [transformOrigin, setTransformOrigin] = useState<
    | { created: true }
    | { created: false; snapshot: Pick<TransformFeature, "tx" | "ty" | "tz" | "angle" | "axis" | "copy"> }
    | null
  >(null);
  // The "New Body" dropdown (box/cylinder/sphere) in the viewport toolbar.
  const [newSolidOpen, setNewSolidOpen] = useState(false);
  // Toggle (via the "?" button in the topbar, or the "?" key) that appends each
  // toolbar button's keyboard shortcut to its label, e.g. "⬆ Extrude (E)".
  const [showShortcuts, setShowShortcuts] = useState(false);
  const kbd = (sc: string): ReactNode =>
    showShortcuts ? <span className="kbd-hint">&nbsp;({sc})</span> : null;
  // Collapsed circle/rectangle flyouts: which group (if any) is expanded, and the
  // last-used variant each collapses to. Selecting any tool (button OR shortcut)
  // updates the remembered variant and closes any open flyout.
  const [expandedSketchGroup, setExpandedSketchGroup] = useState<SketchGroupId | null>(null);
  const [circleVariant, setCircleVariant] = useState<SketchTool>("circle-center");
  const [rectVariant, setRectVariant] = useState<SketchTool>("rect-corner");
  useEffect(() => {
    if (sketchTool === "circle-center" || sketchTool === "circle-3p") setCircleVariant(sketchTool);
    else if (sketchTool === "rect-corner" || sketchTool === "rect-center") setRectVariant(sketchTool);
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
  // The toolbar buttons stretch to a uniform width; the flyout variants live in
  // an absolute overlay (out of that flow), so match them to a stretched button's
  // measured width — otherwise the expanded variants look narrower than the
  // collapsed button that was clicked.
  const sketchToolbarRef = useRef<HTMLDivElement>(null);
  const [sketchBtnWidth, setSketchBtnWidth] = useState<number | null>(null);
  useLayoutEffect(() => {
    const el = sketchToolbarRef.current;
    if (!el) return;
    const measure = () => {
      const b = el.querySelector<HTMLButtonElement>(":scope > button");
      if (b) setSketchBtnWidth(b.getBoundingClientRect().width);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [editingSketchId, showShortcuts]);
  // When the (left-anchored, horizontal) modeling toolbar grows wide enough to
  // run under the (right-anchored) camera selector — e.g. once shortcut hints
  // widen it, or on a narrow viewport — drop the camera selector below the
  // toolbar so nothing is obstructed. Measured live because the trigger (toolbar
  // width, viewport width) is dynamic.
  const modelToolbarRef = useRef<HTMLDivElement>(null);
  const viewControlsRef = useRef<HTMLDivElement>(null);
  const [viewControlsTop, setViewControlsTop] = useState<number | null>(null);
  useLayoutEffect(() => {
    const tb = modelToolbarRef.current;
    const vc = viewControlsRef.current;
    if (!tb || !vc) return;
    const TOP = 12; // matches the CSS resting top of both toolbars
    const GAP = 8;
    const measure = () => {
      const t = tb.getBoundingClientRect();
      const v = vc.getBoundingClientRect();
      // The selector is right-anchored, so its left/width don't depend on its
      // own `top` — testing the toolbar's right edge against it is stable (no
      // oscillation once we've moved the selector down).
      const wouldOverlap = t.left + t.width + GAP > v.left;
      const top = wouldOverlap ? TOP + t.height + GAP : TOP;
      setViewControlsTop(top === TOP ? null : top);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(tb);
    ro.observe(vc);
    window.addEventListener("resize", measure);
    return () => { ro.disconnect(); window.removeEventListener("resize", measure); };
  }, []);
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
    const move = (ev: globalThis.PointerEvent) =>
      setTimelineHeight(Math.min(600, Math.max(80, startHeight + ev.clientY - startY)));
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  const newSolidRef = useRef<HTMLDivElement>(null);
  const importInputRef = useRef<HTMLInputElement>(null);
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

  const setSketchTool = (t: SketchTool) => {
    // Activating Text with a single text entity selected re-opens it for editing
    // (pre-filled), instead of starting a fresh placement.
    if (t === "text") {
      const sel = selectedSketchEntities;
      const existing = sel.length === 1 && sel[0].type === "text" ? sel[0] : null;
      setProjectSession(null);
      setOffsetSession(null);
      setMirrorSession(null);
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
    if (t === "offset") { setProjectSession(null); beginOffsetRef.current(); return; }
    setOffsetSession(null);
    // Mirror opens a session that arms an axis on the next line click, then
    // mirrors each subsequently clicked entity. Starting any other tool ends it.
    if (t === "mirror") {
      setProjectSession(null);
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
      setSketchToolState("project");
      setDraft([]);
      setPolySidesOpen(false);
      return;
    }
    setProjectSession(null);
    setSketchToolState(t);
    setDraft([]); // starting a new tool abandons any in-progress points
    // Selecting the polygon tool (re)opens its Sides prompt, seeded with the
    // committed count; any other tool dismisses it.
    if (t === "polygon") { setPolySidesText(String(polygonSides)); setPolySidesOpen(true); }
    else setPolySidesOpen(false);
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
    (): Promise<RegenSettle> =>
      new Promise((resolve) => {
        let done = false;
        const settle = (s: RegenSettle) => {
          if (!done) { done = true; resolve(s); }
        };
        regenWaitersRef.current.push({ threshold: regenStartSeqRef.current, settle });
        // Never hang: if regen doesn't settle (kernel not ready, a competing
        // edit cancelled it), resolve with whatever errors we last knew.
        setTimeout(() => settle({ errors: agentErrorsRef.current, warnings: agentWarningsRef.current, timedOut: true }), 8000);
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
        let record = activeId ? await loadDoc(activeId) : undefined;
        if (!record) {
          const metas = await listMeta();
          if (metas.length > 0) record = await loadDoc(metas[0].id);
        }
        if (cancelled) return;
        if (record) {
          docIdRef.current = record.id;
          docCreatedAtRef.current = record.createdAt ?? record.updatedAt;
          setDocName(record.name || "Untitled");
          const migrated = migrateDocument(record.doc);
          // Paint the last-saved meshes immediately so a heavy document shows its
          // geometry at once — the regen `resetDoc` kicks off (which rebuilds
          // every feature through OCCT and can take many seconds) then swaps in
          // fresh meshes when it settles. Without this the viewport stays blank
          // until that full rebuild finishes.
          if (record.meshes?.length) setRawMeshes(record.meshes);
          resetDoc(migrated);
          // Default the Variables section open/collapsed by the restored count.
          setVariablesOpen(migrated.variables.length < VARS_OPEN_THRESHOLD);
        }
        // Adopt whichever doc we ended up with (restored or fresh seed) as the
        // tab's active document.
        setActiveDocId(docIdRef.current!);
      } catch (err) {
        console.warn("could not load saved document:", err);
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
      }).catch((err) => console.warn("autosave failed:", err));
    }, 600);
    return () => clearTimeout(t);
  }, [doc, rawMeshes, docName, persistLoaded]);

  // Mirror the document name to the browser tab.
  useEffect(() => {
    document.title = `${docName} — Open Poly`;
  }, [docName]);

  // Close the "New Body" dropdown when clicking anywhere outside it.
  useEffect(() => {
    if (!newSolidOpen) return;
    const onDown = (e: MouseEvent) => {
      if (!newSolidRef.current?.contains(e.target as Node)) setNewSolidOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [newSolidOpen]);

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

  // User-created reference planes that resolved to a frame — rendered in the
  // viewport and selectable for sketching / as a base for further planes.
  const userPlanes = useMemo(
    () =>
      doc.features
        .filter((f): f is PlaneFeature => f.type === "plane" && resolved.planeFrames.has(f.id))
        .map((f) => ({ id: f.id, name: f.name, frame: resolved.planeFrames.get(f.id)!, color: f.color })),
    [doc, resolved.planeFrames],
  );

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

      kernel
        .regenerate(resolved.features, (r) => {
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
        })
        .then(({ results, warnings: regenWarnings }) => {
          if (cancelled) return;
          const nextMeshes: { id: string; mesh: FeatureMesh["mesh"] }[] = [];
          const regenErrors: Record<string, string> = { ...resolved.errors };
          for (const r of results) {
            if (r.ok) nextMeshes.push({ id: r.id, mesh: r.mesh });
            else regenErrors[r.id] = r.error;
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
    if (changed && dangling) flashSketchMsg("A projected edge's source is missing.");
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
  const ghostMeshes = useMemo<GhostMesh[]>(
    () => [
      ...(extrudePreview ? extrudePreview.map((p) => ({ mesh: p.mesh })) : []),
      ...(revolvePreview ? [{ mesh: revolvePreview }] : []),
    ],
    [extrudePreview, revolvePreview],
  );

  // Feature ids that produced an actual rendered body — what the Solids list
  // shows and what a Boolean can combine (primitives, "new" extrusions,
  // booleans, and add/dressup-targets that kept their id).
  const bodyIds = useMemo(() => new Set(rawMeshes.map((m) => m.id)), [rawMeshes]);

  // Agent command layer (Phase 9): exposes window.__openpoly for console testing
  // and runs the WebSocket bridge to the local MCP hub. `agentStatus` drives the
  // "Agent connected" badge.
  const { status: agentStatus } = useAgentBridge({
    doc, setDoc, selection, setSelection,
    meshesRef: agentMeshesRef, errorsRef: agentErrorsRef, waitForRegen, viewApiRef,
  });

  // Exit isolate if the isolated body disappears (deleted / consumed / regen).
  useEffect(() => {
    if (isolatedBodyId && !bodyIds.has(isolatedBodyId)) setIsolatedBodyId(null);
  }, [bodyIds, isolatedBodyId]);
  const handleIsolate = (id: string) => setIsolatedBodyId((cur) => (cur === id ? null : id));

  // Bodies available as Boolean operands: features with a rendered body.
  const booleanCandidates = useMemo(
    () =>
      doc.features
        .filter((f) => bodyIds.has(f.id))
        .map((f) => ({ id: f.id, name: f.name })),
    [doc, bodyIds],
  );

  const selected = useMemo(
    () => doc.features.find((f) => f.id === primaryFeatureId) ?? null,
    [doc, primaryFeatureId],
  );

  const editingSketch = useMemo(() => {
    const f = doc.features.find((x) => x.id === editingSketchId);
    return f && f.type === "sketch" ? f : null;
  }, [doc, editingSketchId]);

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
    return selection.flatMap((s) =>
      s.kind === "sketchPoint" && s.sketchId === editingSketch.id ? [s.point] : [],
    );
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
  const dimCentroid = useMemo<Vec2>(
    () => sketchBoundsCenter(editingSketch?.entities ?? []),
    [editingSketch],
  );
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
    () => measureSelection(selection, doc, meshes),
    [selection, doc, meshes],
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

  // World-space anchor for the extrude dialog: a body face's centroid, or a
  // sketch region's centroid mapped to 3D. Anchored on the first profile when
  // several are selected.
  const profileAnchorWorld = (): [number, number, number] | null => {
    const p = extrudeProfiles[0];
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
    let u = 0, v = 0;
    for (const pt of region.outline) { u += pt[0]; v += pt[1]; }
    const n = region.outline.length;
    return uvToWorld(frameOf(sk.plane, resolved.planeFrames), u / n, v / n);
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
      first.kind === "bodyFace"
        ? bodyIds.has(first.featureId)
          ? first.featureId
          : null
        : extrudeHostBody();
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
    if (extrudeProfiles.length === 0 || !extrudeDialog) return;
    // Add/Remove require a target body to affect.
    if (extrudeDialog.mode !== "new" && !extrudeDialog.targetId) return;
    // Up to face requires a chosen target face.
    if (extrudeDialog.extent === "upToFace" && !extrudeDialog.upTo) return;
    // One Extrude feature per selected profile, sharing the dialog's settings —
    // folded into a single undo step by threading `next` through every
    // addExtrude/setSuppressed call before the one setDoc at the end.
    let next = doc;
    let lastId = "";
    for (const profile of extrudeProfiles) {
      const res = addExtrude(next, profile, {
        distance: extrudeDialog.distance,
        flip: extrudeDialog.flip,
        extent: extrudeDialog.extent,
        mode: extrudeDialog.mode,
        targetId: extrudeDialog.mode === "new" ? undefined : extrudeDialog.targetId ?? undefined,
        upTo: extrudeDialog.extent === "upToFace" ? extrudeDialog.upTo ?? undefined : undefined,
      });
      // Hide the source sketch once it's been consumed by an extrude. It stays
      // in place and editable — toggle the timeline eye (or edit it) to bring
      // it back.
      next =
        profile.kind === "sketchRegion" || profile.kind === "sketchText"
          ? setSuppressed(res.doc, profile.sketchId, true)
          : res.doc;
      lastId = res.id;
    }
    setDoc(next);
    selectFeature(lastId);
    closeExtrudeDialog();
  };

  // Dismiss the extrude dialog, also disarming any pending up-to-face pick.
  const closeExtrudeDialog = () => {
    setExtrudeDialog(null);
    setPickingUpFace(false);
  };

  // Live ghost preview of the extrude dialog: mirrors the main regen effect
  // above, but against a throwaway document (current doc + this draft extrude)
  // that's never assigned via `setDoc` — no undo entry, no effect on the real
  // model. Re-runs on every dialog/profile change, same as editing a committed
  // feature's params already does.
  useEffect(() => {
    if (
      !extrudeDialog ||
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
        targetId: extrudeDialog.mode === "new" ? undefined : extrudeDialog.targetId ?? undefined,
        upTo: extrudeDialog.extent === "upToFace" ? extrudeDialog.upTo ?? undefined : undefined,
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
    if (!revolveDialog || !revolveDialog.profile || !revolveDialog.axis) {
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

  // One or more selected body edges, all on the same body — what a chamfer or
  // fillet would dress. Resolves each edge to its persistent name.
  const dressUpTarget = useMemo(() => {
    const edges = selection.filter((s): s is Extract<Selection, { kind: "edge" }> => s.kind === "edge");
    if (edges.length === 0 || edges.length !== selection.length) return null;
    const targetId = edges[0].featureId;
    if (!edges.every((e) => e.featureId === targetId)) return null;
    const m = meshes.find((x) => x.id === targetId);
    if (!m) return null;
    const names: string[] = [];
    const edgeRefs: EdgeRef[] = [];
    for (const e of edges) {
      const nm = edgeNameOf(m.mesh.edges, e.edgeId);
      if (!nm) return null; // unnamed edge — can't reference it stably
      names.push(nm);
      // Geometric fingerprint stored alongside the name, so the kernel can
      // re-match the edge if an upstream edit renames it.
      const fp = edgeFingerprint(m.mesh.edges, e.edgeId);
      edgeRefs.push(fp ? { name: nm, mid: fp.mid, length: fp.length } : { name: nm });
    }
    const anchor = edgeMidpoint(m.mesh.edges, edges[0].edgeId);
    return { targetId, edges: names, edgeRefs, anchor };
  }, [selection, meshes]);

  const openDressUp = (op: "chamfer" | "fillet") => {
    if (!dressUpTarget) return;
    const s = (dressUpTarget.anchor && viewApiRef.current?.worldToScreen(dressUpTarget.anchor)) || { x: 240, y: 160 };
    setDressUpDialog({ op, size: "2", x: s.x, y: s.y });
  };

  const createDressUp = () => {
    if (!dressUpTarget || !dressUpDialog) return;
    const { doc: next, id } = addDressUp(
      doc, dressUpDialog.op, dressUpTarget.targetId, dressUpTarget.edges, dressUpDialog.size, dressUpTarget.edgeRefs,
    );
    setDoc(next);
    selectFeature(id);
    setDressUpDialog(null);
  };

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

  // Revolve needs a profile region + an axis line, both in the same sketch.
  const revolveInputs = useMemo(() => {
    let profile: { sketchId: string; regionId: string } | null = null;
    let axis: { sketchId: string; entityId: string } | null = null;
    for (const s of selection) {
      if (s.kind === "sketchFace") profile = { sketchId: s.sketchId, regionId: s.regionId };
      else if (s.kind === "sketchEntity") {
        const sk = doc.features.find((f) => f.id === s.sketchId);
        const e = sk?.type === "sketch" ? sk.entities.find((x) => x.id === s.entityId) : undefined;
        if (e?.type === "line") axis = { sketchId: s.sketchId, entityId: s.entityId };
      }
    }
    return profile && axis && profile.sketchId === axis.sketchId ? { profile, axis } : null;
  }, [selection, doc]);

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
  };

  const createRevolve = () => {
    if (!revolveDialog || !revolveDialog.profile || !revolveDialog.axis) return;
    // Full revolve = 360°; symmetric is meaningless there, so force it off.
    const angle = revolveDialog.mode === "full" ? "360" : revolveDialog.degrees;
    const symmetric = revolveDialog.mode === "angle" && revolveDialog.symmetric;
    const { doc: created, id } = addRevolve(doc, revolveDialog.profile, revolveDialog.axis, angle, symmetric);
    // Hide the originating sketch once it's been consumed (like extrude does).
    const next = setSuppressed(created, revolveDialog.profile.sketchId, true);
    setDoc(next);
    selectFeature(id);
    closeRevolveDialog();
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
    const { doc: next, id } = addSweep(doc, sweepInputs.profile, sweepInputs.path);
    setDoc(next);
    selectFeature(id);
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
    };
    // Shift-modified variants of an existing tool key (Shift+R/Shift+C/Shift+S).
    const SKETCH_SHIFT_KEYS: Record<string, SketchTool> = {
      r: "rect-center",
      c: "circle-3p",
      s: "spline", // Shift+S = Spline (bare S now selects the Select tool)
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (offsetSessionRef.current) { setOffsetSession(null); setSketchToolState("select"); }
        else if (mirrorSessionRef.current) { setMirrorSession(null); setSelection([]); setSketchToolState("select"); }
        else if (projectSessionRef.current) { setProjectSession(null); setSketchToolState("select"); }
        else if (textDraftRef.current) setTextDraft(null);
        else if (dimInputRef.current) setDimInput(null);
        else if (dimPendingRef.current) setDimPending(false);
        else if (polySidesOpen) setPolySidesOpen(false);
        else if (planeDialog) closePlaneDialog();
        // While the revolve dialog is arming a plane axis, Esc cancels just that
        // pick (keeping the dialog); a second Esc then closes the dialog.
        else if (revolveDialog && picking) { setPicking(false); setPickPurpose("sketch"); }
        else if (revolveDialog) closeRevolveDialog();
        // Mirror dialog: like Revolve, Esc first cancels an in-progress face
        // pick (keeping the dialog), then a second Esc closes the dialog.
        else if (mirrorDialog && pickingMirrorFace) setPickingMirrorFace(false);
        else if (mirrorDialog) closeMirror();
        else if (transformEditId) cancelTransform();
        else if (picking) setPicking(false);
        // Esc finishes an in-progress draft: the spline commits its accumulated
        // points (like ending a polyline); every other tool just abandons the
        // draft. finishSpline() returns false unless the spline tool has ≥2
        // points, so non-spline drafts fall through to setDraft([]).
        else if (draft.length > 0) { if (!finishSpline()) setDraft([]); }
        else if (editingSketchId) finishSketch();
        return;
      }
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      // "?" toggles the keyboard-shortcut hints appended to toolbar labels.
      if (e.key === "?") {
        e.preventDefault();
        setShowShortcuts((s) => !s);
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

      // Standard views: the view-controls bar is visible (and clickable) in
      // both modeling and sketch mode, so digits 1-7 work in both — letters
      // were deliberately avoided here (they'd collide with modeling-toolbar
      // actions live in the same context: T-op/T-ransform, F-ront/F-illet...).
      if (/^[1-7]$/.test(e.key)) {
        const v = VIEW_BUTTONS[Number(e.key) - 1];
        if (v) viewApiRef.current?.setView(v.name);
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
      if (key === "h" && primaryFeatureId) {
        setDoc(setSuppressed(doc, primaryFeatureId, !doc.features.find((f) => f.id === primaryFeatureId)?.suppressed));
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
        case "b":
          if (bodyIds.size >= 2) openBooleanDialog();
          break;
        case "t":
          if (transformTarget && !transformEditId) openTransform();
          break;
        case "m":
          if (transformTarget) openMirror();
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
    sweepInputs,
    loftInputs,
    dressUpTarget,
    bodyIds,
    transformTarget,
    twoSelectedLines,
    twoRadiusEntities,
    oneSelectedLine,
    primaryFeatureId,
    polySidesOpen,
  ]);

  const openLoft = () => {
    if (!loftInputs) return;
    const { doc: next, id } = addLoft(doc, loftInputs);
    setDoc(next);
    selectFeature(id);
  };

  const openMirror = () => {
    if (!transformTarget) return;
    setMirrorDialog({ targetId: transformTarget, plane: "datum:plane-front", faceRef: null });
  };
  const closeMirror = () => {
    setMirrorDialog(null);
    setPickingMirrorFace(false);
  };
  const createMirror = () => {
    if (!mirrorDialog) return;
    const ref: SketchPlaneRef | null =
      mirrorDialog.plane === "face"
        ? mirrorDialog.faceRef
          ? { kind: "face", featureId: mirrorDialog.faceRef.featureId, frame: mirrorDialog.faceRef.frame }
          : null
        : planeKeyToRef(mirrorDialog.plane);
    if (!ref) return; // a face plane was chosen but none picked yet
    const { doc: next, id } = addMirror(doc, mirrorDialog.targetId, ref);
    setDoc(next);
    closeMirror();
    selectFeature(id);
  };

  // Create a Transform on the selected body and open the gizmo to edit it.
  const openTransform = () => {
    if (!transformTarget) return;
    const m = rawMeshes.find((x) => x.id === transformTarget);
    const pivot = m ? bodyCenter(m.mesh.faces) : ([0, 0, 0] as [number, number, number]);
    const { doc: next, id } = addTransform(doc, transformTarget, pivot);
    setDoc(next);
    selectFeature(id);
    setTransformMode("translate");
    setTransformEditId(id);
    setTransformOrigin({ created: true });
  };

  // Re-open the gizmo for an existing Transform (from the parameter editor).
  // Snapshot its current values so Cancel can revert this edit (vs. delete).
  const editTransform = (id: string) => {
    const f = doc.features.find((x) => x.id === id);
    if (f?.type !== "transform") return;
    selectFeature(id);
    setTransformMode("translate");
    setTransformEditId(id);
    setTransformOrigin({
      created: false,
      snapshot: { tx: f.tx, ty: f.ty, tz: f.tz, angle: f.angle, axis: f.axis, copy: f.copy },
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
  const handleTransformInput = (d: { tx: number; ty: number; tz: number; angle: number }) => {
    if (!transformEditId) return;
    setLiveTransform(null); // commit supersedes the live readout
    setDoc(
      setTransform(doc, transformEditId, {
        tx: fmt(d.tx),
        ty: fmt(d.ty),
        tz: fmt(d.tz),
        angle: fmt(d.angle),
      }),
      `transform:${transformEditId}`,
    );
  };

  // Per-frame readout while dragging — drives the floating panel's numbers only,
  // never the document, so it can't trigger a regenerate.
  const handleTransformPreview = (d: { tx: number; ty: number; tz: number; angle: number }) => {
    setLiveTransform(d);
  };

  // Close the gizmo, keeping the Transform feature as-is.
  const finishTransform = () => {
    setTransformEditId(null);
    setTransformOrigin(null);
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
    setLiveTransform(null);
  };

  // All visible sketches (so finished sketches stay rendered), each with its frame.
  const renderSketches = useMemo(
    () =>
      doc.features
        .slice(0, doc.rollbackIndex)
        // Hidden (suppressed) sketches aren't drawn — except the one being
        // actively edited, so editing a post-extrude hidden sketch still shows it.
        .filter((f): f is SketchFeature => f.type === "sketch" && (!f.suppressed || f.id === editingSketchId))
        .map((f) => ({
          id: f.id,
          frame: frameOf(f.plane, resolved.planeFrames),
          entities: f.entities,
          regions: detectSketchRegions(f.entities),
        })),
    [doc, editingSketchId, resolved.planeFrames],
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
      try { h = evaluateExpression(textDraft.height, resolved.scope); } catch { h = NaN; }
      if (Number.isFinite(h) && h > 0)
        textPreview = [{ type: "text", id: "__textpv", p: textDraft.anchor, value: textDraft.value, height: h }];
    }
    if (
      (offsetPreview.length === 0 && mirrorPreview.length === 0 && projectPreview.length === 0 && textPreview.length === 0) ||
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
    return [...renderSketches, ...extra];
  }, [renderSketches, offsetPreview, mirrorSession, projectSession, textDraft, resolved.scope, dimFrame]);

  const startSketchOn = (ref: SketchPlaneRef) => {
    const { doc: next, id } = addSketch(doc, ref);
    setDoc(next);
    selectFeature(id);
    setPicking(false);
    setEditingSketchId(id);
    setSketchTool("select");
    setFullyConstrained(false);
    viewApiRef.current?.lookAtFrame(frameOf(ref, resolved.planeFrames));
  };

  // Open the reference-plane dialog and arm the base pick (offset is the default
  // method; the dropdown switches to midplane / at-angle / through 3 points).
  const openPlaneDialog = () => {
    setPlaneDialog({ method: "offset", base: null, offset: "20", refB: null, angleAxis: "u", angle: "30", points: [] });
    setPickPurpose("plane");
    setPlanePick("base");
    setPicking(true);
  };
  const closePlaneDialog = () => {
    setPlaneDialog(null);
    setPlanePick(null);
    setPicking(false);
  };

  // The plane/face pick resolved: start a sketch on it, or fill the plane
  // dialog's base / second reference (whichever slot is armed).
  const handlePickRef = (ref: SketchPlaneRef) => {
    if (pickPurpose === "plane") {
      setPicking(false);
      if (planePick === "refB") setPlaneDialog((d) => (d ? { ...d, refB: ref } : d));
      else setPlaneDialog((d) => (d ? { ...d, base: ref } : d));
      setPlanePick(null);
    } else {
      startSketchOn(ref);
    }
  };

  // The revolve "Select axis" arming resolved: fill the dialog's axis role from a
  // sketch line, a body face, or a datum/reference plane (one unified pick path).
  const handleAxisPick = (pick: RevolveAxisPick) => {
    if (pick.kind === "line") {
      const sk = doc.features.find((f) => f.id === pick.sketchId);
      const e = sk?.type === "sketch" ? sk.entities.find((x) => x.id === pick.entityId) : undefined;
      if (e?.type !== "line") { flashSketchMsg("The axis must be a straight edge, a plane, or a face."); return; }
      setRevolveDialog((d) => (d ? { ...d, axis: { sketchId: pick.sketchId, entityId: pick.entityId } } : d));
    } else if (pick.kind === "bodyFace") {
      const m = meshes.find((x) => x.id === pick.featureId);
      const center = m ? faceCentroid(m.mesh.faces, pick.faceId) : null;
      if (!center) return;
      const faceName = m ? faceNameOf(m.mesh.faces, pick.faceId) : undefined;
      const normal = (m && faceNormal(m.mesh.faces, pick.faceId)) || undefined;
      setRevolveDialog((d) => (d ? { ...d, axis: { face: { featureId: pick.featureId, faceId: pick.faceId, faceName, center, normal } } } : d));
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
    const { doc: next, id } = addPlane(doc, {
      method,
      base: base ?? { kind: "datum", id: "plane-top" }, // unused for "through"
      offset,
      refB: refB ?? undefined,
      angleAxis,
      angle,
      points: method === "through" ? points : undefined,
    });
    setDoc(next);
    selectFeature(id);
    closePlaneDialog();
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

  // Double-clicking a timeline row enters its edit mode directly — sketches and
  // transforms have a distinct edit mode (gizmo / sketch canvas); every other
  // feature type already shows editable fields in the param editor on select,
  // so a double-click there is just a (harmless) select.
  const handleTreeDoubleClick = (id: string) => {
    const f = doc.features.find((x) => x.id === id);
    if (f?.type === "sketch") editSketch(id);
    else if (f?.type === "transform") editTransform(id);
  };

  // A snapped click on the sketch plane (already in uv coords). Drives the
  // multi-click construction tools. `hv` records a horizontal/vertical inference
  // (line tool) so it can be captured as a constraint.
  const handleSketchClick = (uv: Vec2, hv?: "horizontal" | "vertical", on?: { id: string; mid: boolean }) => {
    if (!editingSketchId || sketchTool === "select" || sketchTool === "offset") return;
    const sketchId = editingSketchId;
    // Drawing solves immediately: the constraints captured while drawing (auto
    // H/V, rectangle edges, shared corners) are enforced on the spot, the geometry
    // snaps clean, and the fully-constrained / conflict status stays live — so
    // there's no separate "Solve" step. For the chained line tool, the next
    // segment continues from the *solved* endpoint so the chain stays coincident.
    const applyAndSolve = async (mutated: Document, chainLineId?: string) => {
      const solved = await solveSketchIn(mutated, sketchId);
      setDoc(solved);
      if (chainLineId) {
        const sk = solved.features.find((f) => f.id === sketchId);
        const e = sk?.type === "sketch" ? sk.entities.find((x) => x.id === chainLineId) : undefined;
        if (e?.type === "line") setDraft([e.b]);
      }
    };
    const commit = (entities: SketchEntity[]) => void applyAndSolve(addSketchEntities(doc, sketchId, entities));
    // Stamp construction (reference) geometry when that draw-mode is on.
    const mark = <T extends SketchEntity>(e: T): T => (constructionMode ? { ...e, construction: true } : e);
    const lineEntity = (a: Vec2, b: Vec2): SketchEntity => mark({ type: "line", id: genId(), a, b });
    const loopLines = (pts: Vec2[]) => loopSegments(pts).map(([a, b]) => lineEntity(a, b));

    // Commit a rectangle as 4 looped lines plus the implicit horizontal/vertical
    // constraints (each edge is axis-aligned, so it's exactly H or V). Without
    // these a "rectangle" is just four coincident lines, free to shear the
    // moment any later constraint is added.
    const commitRect = (pts: Vec2[]) => {
      const segs = loopSegments(pts);
      const lines = segs.map(([a, b]) => lineEntity(a, b));
      let next = addSketchEntities(doc, sketchId, lines);
      const cons: SketchConstraint[] = segs.map(([a, b], i) => ({
        id: genId(),
        type: Math.abs(b[0] - a[0]) >= Math.abs(b[1] - a[1]) ? "horizontal" : "vertical",
        entity: lines[i].id,
      }));
      next = addSketchConstraints(next, sketchId, cons);
      void applyAndSolve(next);
    };

    switch (sketchTool) {
      case "line":
        if (draft.length === 0) {
          setDraft([uv]);
          lineStartOnRef.current = on; // remember an entity the start landed on
        } else {
          const line = lineEntity(draft[0], uv);
          let next = addSketchEntities(doc, sketchId, [line]);
          const cons: SketchConstraint[] = [];
          if (hv) cons.push({ id: genId(), type: hv, entity: line.id });
          // Keep an endpoint attached to whatever it was snapped onto: a line's
          // body → point-on-line; a line/arc midpoint → midpoint — so a later
          // dimension can't slide it off.
          const attach = (at: "a" | "b", t: { id: string; mid: boolean }): SketchConstraint =>
            t.mid
              ? { id: genId(), type: "midpoint", point: { entity: line.id, at }, target: t.id }
              : { id: genId(), type: "pointOnLine", point: { entity: line.id, at }, line: t.id };
          if (lineStartOnRef.current) cons.push(attach("a", lineStartOnRef.current));
          if (on) cons.push(attach("b", on));
          if (cons.length) next = addSketchConstraints(next, sketchId, cons);
          // The chain continues from this end; it's now constrained, so the next
          // segment's start needs no further attachment.
          lineStartOnRef.current = undefined;
          setDraft([uv]); // chain optimistically; applyAndSolve resets to the solved endpoint
          void applyAndSolve(next, line.id);
        }
        break;
      case "rect-corner":
        if (draft.length === 0) setDraft([uv]);
        else {
          commitRect(rectangleCorners(draft[0], uv));
          setDraft([]);
        }
        break;
      case "rect-center":
        if (draft.length === 0) setDraft([uv]);
        else {
          commitRect(rectangleFromCenter(draft[0], uv));
          setDraft([]);
        }
        break;
      case "circle-center":
        if (draft.length === 0) setDraft([uv]);
        else {
          const r = Math.hypot(uv[0] - draft[0][0], uv[1] - draft[0][1]);
          commit([mark({ type: "circle", id: genId(), c: draft[0], r })]);
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
          commit(loopLines(regularPolygon(draft[0], uv, polygonSides)));
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
        setTextDraft({ anchor: uv, value: textDraft?.value ?? "", height: textDraft?.height ?? "10", editId: textDraft?.editId });
        break;
    }
  };

  // Commit the in-progress text placement as a `text` entity (no solve needed —
  // text isn't a constraint participant). Empty string → cancel.
  const commitText = () => {
    const td = textDraftRef.current;
    if (!editingSketchId || !td) return;
    let h = NaN;
    try { h = evaluateExpression(td.height, resolved.scope); } catch { h = NaN; }
    if (!td.value.trim() || !Number.isFinite(h) || h <= 0) { setTextDraft(null); return; }
    if (td.editId) {
      // Re-edit: update the existing text entity in place (preserving its
      // construction flag), so its glyphs / any extrude of it follow.
      const sk = doc.features.find((f) => f.id === editingSketchId);
      if (sk?.type === "sketch") {
        const entities = sk.entities.map((en) =>
          en.id === td.editId && en.type === "text"
            ? { ...en, p: td.anchor, value: td.value, height: h }
            : en,
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
    const mutated = addSketchEntities(doc, sketchId, [constructionMode ? { ...e, construction: true } : e]);
    void solveSketchIn(mutated, sketchId).then(setDoc);
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

  const solveSketchIn = async (docArg: Document, sketchId: string): Promise<Document> => {
    const { doc: solved, res } = await runSolve(docArg, sketchId);
    if (res) {
      setFullyConstrained(res.dof === 0 && !res.hasConflicts);
      setSolveConflict(res.hasConflicts);
    }
    return solved;
  };

  // --- Live sketch dragging -------------------------------------------------
  // Every frame solves from a snapshot of the geometry taken when the drag began
  // (so repeated frames don't accumulate) with the grabbed points relocated to
  // their cursor targets. Only one solve runs at a time; the latest request waits
  // and supersedes any earlier pending one (coalescing fast pointer moves).
  const dragBaseRef = useRef<{ sketchId: string; key: string; entities: SketchEntity[]; constraints: SketchConstraint[] } | null>(null);
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
        } catch { /* pinning threw → fall back */ }
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
      flashSketchMsg("Can only offset a single chain at once.");
      setSketchToolState("select");
      return;
    }
    const e0 = chain[0];
    let anchor: Vec2;
    let normal: Vec2;
    if (e0.type === "line") {
      anchor = [(e0.a[0] + e0.b[0]) / 2, (e0.a[1] + e0.b[1]) / 2];
      const dx = e0.b[0] - e0.a[0], dy = e0.b[1] - e0.a[1], len = Math.hypot(dx, dy) || 1;
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
    try { d = evaluateExpression(sess.value, resolved.scope); } catch { d = NaN; }
    // A non-numeric / unparseable distance: flag it and keep the box open so the
    // user can correct it (don't throw, don't silently discard the chain).
    if (!Number.isFinite(d)) { flashSketchMsg("Enter a numeric offset distance."); return; }
    if (Math.abs(d) < 1e-9) { cancelOffset(); return; }
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
    const next = addDerivedOp(doc, sketchId, op);
    setOffsetSession(null);
    setSketchToolState("select");
    setDoc(await solveSketchIn(next, sketchId));
  };

  // Re-edit a committed offset op's distance: write the new expression and
  // re-solve (which re-runs applyDerived, shifting the offset edges).
  const commitOffsetEdit = async () => {
    if (!offsetEdit || !editingSketch) return;
    const sketchId = editingSketch.id;
    const next = setDerivedOffsetDistance(doc, sketchId, offsetEdit.opId, offsetEdit.value);
    setOffsetEdit(null);
    setDoc(await solveSketchIn(next, sketchId));
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
    const next = addDerivedOp(doc, sketchId, op);
    setMirrorSession(null);
    setSelection([]);
    setSketchToolState("select");
    setDoc(await solveSketchIn(next, sketchId));
  };
  commitMirrorRef.current = commitMirror;

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
    if (sess.refs.length === 0) { cancelProject(); return; }
    const sketchId = editingSketch.id;
    const op: DerivedOp = { id: genId(), kind: "project", refs: sess.refs };
    const seeded: SketchEntity[] = sess.previews.map((e, i) => ({
      ...e,
      id: `${op.id}:${i}`,
      derivedFrom: op.id,
    }));
    let next = addDerivedOp(doc, sketchId, op);
    next = addSketchEntities(next, sketchId, seeded);
    setProjectSession(null);
    setSketchToolState("select");
    setDoc(await solveSketchIn(next, sketchId));
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
      return (Math.acos(Math.max(-1, Math.min(1, dot / m))) * 180) / Math.PI;
    };
    const deg = prefill ?? interiorDeg();
    const ma = mid(la);
    const mb = mid(lb);
    const s = screenOf([(ma[0] + mb[0]) / 2, (ma[1] + mb[1]) / 2]);
    setDimPending(false);
    setDimInput({ entityId: la.id, entityId2: lb.id, kind: "angle", editId, value: fmt(deg), x: s.x, y: s.y });
  };

  // D (or the ↔ button): dimension the current selection — a single line/circle
  // (length/radius), or two lines (angle) — else arm "pick one to dimension"
  // mode (forcing the Select tool so clicks pick).
  const startDimension = () => {
    if (!editingSketch) return;
    if (dimEntity) return openDimensionFor(dimEntity);
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
    const candidate = addSketchConstraints(doc, sketchId, [constraint]);
    const { doc: solved, res } = await runSolve(candidate, sketchId);
    if (res) {
      // A contradictory geometric constraint (e.g. forcing a horizontal and a
      // vertical line parallel) often isn't flagged as a formal conflict —
      // planegcs "satisfies" it by collapsing a line to zero length. So reject on
      // a conflict, a failed/invalid solve, OR a degenerate (near-zero) entity.
      const sk = solved.features.find((f) => f.id === sketchId);
      const degenerate =
        sk?.type === "sketch" &&
        sk.entities.some((e) => e.type === "line" && Math.hypot(e.b[0] - e.a[0], e.b[1] - e.a[1]) < 1e-3);
      if (res.hasConflicts || res.status >= 2 || degenerate) {
        flashSketchMsg(`${name} conflicts with existing constraints — not applied. Edit or remove the conflicting one instead.`);
        setSelection([]);
        return;
      }
      if (res.hasRedundant) {
        flashSketchMsg(`${name} is already implied by existing constraints — not added.`);
        setSelection([]);
        return;
      }
      setFullyConstrained(res.dof === 0 && !res.hasConflicts);
      setSolveConflict(res.hasConflicts);
    }
    setDoc(solved);
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
        if (near([e.c[0] + e.r * Math.cos(e.start), e.c[1] + e.r * Math.sin(e.start)])) return { entity: e.id, at: "a" };
        if (near([e.c[0] + e.r * Math.cos(e.end), e.c[1] + e.r * Math.sin(e.end)])) return { entity: e.id, at: "b" };
      }
    }
    if (Math.hypot(uv[0], uv[1]) < 1e-4) return { origin: true };
    return null;
  };

  const samePointRef = (x: PointRef, y: PointRef) =>
    "origin" in x || "origin" in y ? "origin" in x && "origin" in y : x.entity === y.entity && x.at === y.at;

  // Coincident, dispatched on the selection:
  //  • one point + one line → the point lies ON the line (point-on-line). This
  //    is the "select a square's edge + the origin" case (origin pulled onto it),
  //    and "select a point + an edge" (point attached to the edge).
  //  • two points → make them coincident.
  //  • one point → anchor it to the origin.
  const addCoincident = async () => {
    const pts = selectedSketchPoints;
    const lines = selectedSketchLines;

    // Point-on-line: exactly one selected point and one selected line.
    if (pts.length === 1 && lines.length === 1) {
      const point = pointRefAt(pts[0]);
      const line = lines[0].id;
      if (!point) return;
      // A point that's an endpoint of the very line it's snapping to is moot.
      if (!("origin" in point) && point.entity === line) return;
      const exists = editingSketch?.constraints.some(
        (c) => c.type === "pointOnLine" && c.line === line && samePointRef(c.point, point),
      );
      if (exists) return;
      await commitConstraint({ id: genId(), type: "pointOnLine", point, line }, "Point on line");
      return;
    }

    let a: PointRef | null = null;
    let b: PointRef | null = null;
    if (pts.length === 1) {
      a = pointRefAt(pts[0]);
      b = { origin: true };
    } else if (pts.length === 2) {
      a = pointRefAt(pts[0]);
      b = pointRefAt(pts[1]);
    }
    if (!a || !b) return;
    if (samePointRef(a, b)) return;
    const exists = editingSketch?.constraints.some(
      (c) =>
        c.type === "coincident" &&
        ((samePointRef(c.a, a!) && samePointRef(c.b, b!)) || (samePointRef(c.a, b!) && samePointRef(c.b, a!))),
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
    const entities = editingSketch.entities.map((e) =>
      ids.has(e.id) ? { ...e, construction: makeConstruction } : e,
    );
    setDoc(setSketchEntities(doc, editingSketch.id, entities));
    // Keep the draw-mode button in sync with what the selection just became, so
    // the toolbar reflects the current construction state.
    setConstructionMode(makeConstruction);
  };

  // Remove a single constraint (from the constraints list) and re-solve.
  const deleteConstraint = async (id: string) => {
    if (!editingSketch) return;
    let next = removeSketchConstraint(doc, editingSketch.id, id);
    next = await solveSketchIn(next, editingSketch.id);
    setDoc(next);
  };

  // Reopen the editor for an existing constraint (double-clicking its label).
  const editConstraint = (constraintId: string) => {
    if (!editingSketch) return;
    const c = editingSketch.constraints.find((x) => x.id === constraintId);
    if (!c) return;
    if (c.type === "distance" || c.type === "radius") {
      const e = ent(c.entity);
      if (e?.type === "line" || e?.type === "circle" || e?.type === "arc") openDimensionFor(e, c.id, c.value);
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
    const kept = editingSketch.constraints.filter((c) => {
      if (kind === "angle") return !(c.type === "angle" && samePair(c.a, c.b));
      const ctype = kind === "radius" ? "radius" : "distance";
      return !(c.type === ctype && c.entity === entityId);
    });
    const added: SketchConstraint =
      kind === "angle"
        ? { id: genId(), type: "angle", a: entityId, b: entityId2!, value }
        : { id: genId(), type: kind === "radius" ? "radius" : "distance", entity: entityId, value };
    const candidate = setSketchConstraints(doc, sketchId, [...kept, added]);
    const { doc: solved, res } = await runSolve(candidate, sketchId);
    // A dimension the solver can't satisfy would otherwise be saved as a dead
    // constraint that silently freezes (or wrecks) the geometry. Reject it and tell
    // the user — the sketch is left exactly as it was. As with geometric
    // constraints, an over-constraint shows as `hasConflicts`, but an impossible
    // one (e.g. a second right angle in a triangle) instead fails the solve or
    // collapses a line to zero length, so check those too.
    if (res) {
      const sk = solved.features.find((f) => f.id === sketchId);
      const degenerate =
        sk?.type === "sketch" &&
        sk.entities.some((e) => e.type === "line" && Math.hypot(e.b[0] - e.a[0], e.b[1] - e.a[1]) < 1e-3);
      if (res.hasConflicts || res.status >= 2 || degenerate) {
        flashSketchMsg(
          `That ${kind} can't be satisfied with the existing constraints — not applied. Edit or remove a conflicting one instead.`,
        );
        setSelection([]);
        return;
      }
      setFullyConstrained(res.dof === 0 && !res.hasConflicts);
      setSolveConflict(res.hasConflicts);
    }
    setDoc(solved);
    setSelection([]);
  };

  const errorCount =
    Object.keys(errors).length +
    Object.keys(resolved.variableErrors).length +
    Object.keys(resolved.variableNameErrors).length;
  const status = fatal
    ? "kernel error"
    : busy
      ? "regenerating…"
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
    const operandIds = [...new Set(selection.map(featureIdOf))].filter((id) =>
      candidateIds.has(id),
    );
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

  const confirmBoolean = () => {
    if (!booleanDialog) return;
    const d = booleanDialog;
    const operands =
      d.op === "subtract"
        ? d.base && d.tools.length >= 1 ? [d.base, ...d.tools] : null
        : d.operandIds.length >= 2 ? d.operandIds : null;
    if (!operands) return;
    const { doc: next, id } = addBoolean(doc, d.op, operands);
    setDoc(next);
    selectFeature(id);
    setBooleanDialog(null);
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

  const handleSolidHidden = (id: string, hidden: boolean) =>
    setDoc(setFeatureHidden(doc, id, hidden));

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
    const { doc: next, id } = addImport(doc, text, base);
    setDoc(next);
    selectFeature(id);
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
        <div className="topbar-actions">
          <button className="tool-btn" onClick={undo} disabled={!canUndo} title="Undo (⌘Z)">
            ↶
          </button>
          <button className="tool-btn" onClick={redo} disabled={!canRedo} title="Redo (⌘⇧Z)">
            ↷
          </button>
          <button
            className={"tool-btn" + (showShortcuts ? " active" : "")}
            onClick={() => setShowShortcuts((s) => !s)}
            title="Show keyboard shortcuts in button labels (?)"
            aria-pressed={showShortcuts}
          >
            ?
          </button>
        </div>
        {agentStatus === "connected" && (
          <span className="agent-badge" title="An LLM agent is connected to this tab">
            ● Agent connected
          </span>
        )}
        <span className={`status ${statusClass}`} title={fatal ?? undefined}>
          {status}
        </span>
      </header>
      <div className="body">
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
              onChange={(id, field, value) =>
                setDoc(updateVariable(doc, id, field, value), `var:${id}:${field}`)
              }
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
            onSetRollback={(index) => setDoc(setRollbackIndex(doc, index))}
            onMove={(id, delta) => setDoc(moveFeature(doc, id, delta))}
          />
          <div
            className="panel-splitter"
            title="Drag to resize the timeline"
            onPointerDown={startTimelineResize}
          />
          <div className="parts-header">
            <h2 className="params-heading">Parts</h2>
            <button
              className="parts-import"
              type="button"
              title="Import a STEP file as a new part (⌘I / Ctrl+I)"
              onClick={() => importInputRef.current?.click()}
            >
              ⤓ Import STEP
            </button>
            <input
              ref={importInputRef}
              type="file"
              accept=".step,.stp,.STEP,.STP"
              style={{ display: "none" }}
              onChange={handleImportFile}
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
          {editingSketch && editingSketch.constraints.length > 0 && (
            <>
              <h2 className="params-heading">
                Constraints
                {solveConflict && <span className="constraint-warn" title="Over-constrained / conflicting"> ⚠ conflict</span>}
              </h2>
              <ul className="constraint-list">
                {editingSketch.constraints.map((c) => (
                  <li key={c.id}>
                    <span>{constraintLabel(c)}</span>
                    <button className="cl-del" title="Delete constraint" onClick={() => deleteConstraint(c.id)}>
                      ✕
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}
          <h2 className="params-heading">Parameters</h2>
          <ParamEditor
            feature={selected}
            error={selected ? (errors[selected.id] ?? null) : null}
            editingSketchId={editingSketchId}
            onChangeParam={(id, name, value) =>
              setDoc(updateParam(doc, id, name, value), `param:${id}:${name}`)
            }
            onRename={(id, name) => setDoc(renameFeature(doc, id, name), `rename:${id}`)}
            onEditSketch={editSketch}
            onFinishSketch={finishSketch}
            onEditTransform={editTransform}
          />
        </aside>
        <main className="viewport">
          <Viewport
            meshes={viewportMeshes}
            ghostMeshes={ghostMeshes}
            selection={selection}
            highlightBodyIds={highlightBodyIds}
            booleanHighlight={booleanHighlight}
            onSelect={handlePick}
            datumVisibility={datumVisibility}
            userPlanes={userPlanes}
            transformEdit={transformEdit}
            transformMode={transformMode}
            onTransformInput={handleTransformInput}
            onTransformPreview={handleTransformPreview}
            picking={picking}
            onPick={handlePickRef}
            axisPick={picking && pickPurpose === "revolveAxis"}
            onAxisPick={handleAxisPick}
            activeSketch={
              editingSketch
                ? { datumId: editingSketch.plane.kind === "datum" ? editingSketch.plane.id : null }
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
            apiRef={viewApiRef}
          />
          <div className="model-toolbar" ref={modelToolbarRef}>
            <button
              title="Sketch (S): start a sketch — pick a plane or face"
              disabled={!!editingSketch || picking}
              onClick={() => { setPickPurpose("sketch"); setPicking(true); }}
            >
              ✎ Sketch{kbd("S")}
            </button>
            <div className="mt-dropdown" ref={newSolidRef}>
              <button
                title="New Body (N): create a new solid body"
                disabled={!!editingSketch}
                onClick={() => setNewSolidOpen((o) => !o)}
              >
                ◧ New Body ▾{kbd("N")}
              </button>
              {newSolidOpen && (
                <div className="mt-menu">
                  {FEATURE_KINDS.map((kind) => (
                    <button
                      key={kind}
                      onClick={() => { handleAdd(kind); setNewSolidOpen(false); }}
                    >
                      {FEATURE_DEFS[kind].label}
                    </button>
                  ))}
                </div>
              )}
            </div>
            <button
              title="Plane (P): create a reference plane (offset, midplane, at-angle, or through 3 points)"
              disabled={!!editingSketch || picking || !!planeDialog}
              onClick={openPlaneDialog}
            >
              ⧉ Plane{kbd("P")}
            </button>
            <button
              title="Extrude (E): extrude the selected sketch region(s) and/or face(s)"
              disabled={extrudeProfiles.length === 0 || !!editingSketch || picking || !!extrudeDialog}
              onClick={openExtrudeDialog}
            >
              ⬆ Extrude{kbd("E")}
            </button>
            <button
              title="Revolve (R): arm a profile face + an axis (edge or plane) in the dialog"
              disabled={!!editingSketch || picking || !!revolveDialog}
              onClick={openRevolve}
            >
              ⟳ Revolve{kbd("R")}
            </button>
            <button
              title="Sweep (W): sweep a sketch region along a path — line / arc / spline (select both)"
              disabled={!sweepInputs || !!editingSketch || picking}
              onClick={openSweep}
            >
              ⊃ Sweep{kbd("W")}
            </button>
            <button
              title="Loft (L): loft through 2+ sketch regions (select the sections)"
              disabled={!loftInputs || !!editingSketch || picking}
              onClick={openLoft}
            >
              ⌧ Loft{kbd("L")}
            </button>
            <button
              title="Chamfer (C): chamfer the selected edge(s)"
              disabled={!dressUpTarget || !!editingSketch || picking}
              onClick={() => openDressUp("chamfer")}
            >
              ◣ Chamfer{kbd("C")}
            </button>
            <button
              title="Fillet (F): round the selected edge(s)"
              disabled={!dressUpTarget || !!editingSketch || picking}
              onClick={() => openDressUp("fillet")}
            >
              ◖ Fillet{kbd("F")}
            </button>
            <button
              title="Boolean (B): union / subtract / intersect"
              disabled={bodyIds.size < 2 || !!editingSketch || picking}
              onClick={openBooleanDialog}
            >
              ⊕ Boolean{kbd("B")}
            </button>
            <button
              title="Transform (T): move / rotate the selected body"
              disabled={!transformTarget || !!editingSketch || picking || !!transformEditId}
              onClick={openTransform}
            >
              ✥ Transform{kbd("T")}
            </button>
            <button
              title="Mirror (M): mirror the selected body across a plane"
              disabled={!transformTarget || !!editingSketch || picking}
              onClick={openMirror}
            >
              ⇋ Mirror{kbd("M")}
            </button>
          </div>
          {editingSketch && (
            <div className="sketch-toolbar" ref={sketchToolbarRef}>
              {SKETCH_LAYOUT.map((slot) => {
                if (slot.kind === "tool") {
                  const t = sketchToolMeta(slot.tool);
                  // Offset needs a selected chain of edges — grey it out when
                  // nothing is selected.
                  const disabled = slot.tool === "offset" && selectedSketchEntities.length === 0;
                  return (
                    <button
                      key={t.tool}
                      className={sketchTool === t.tool ? "active" : ""}
                      title={t.title}
                      disabled={disabled}
                      onClick={() => setSketchTool(t.tool)}
                    >
                      {t.label}{kbd(t.sc)}
                    </button>
                  );
                }
                const g = SKETCH_GROUPS[slot.group];
                const variant = slot.group === "circle" ? circleVariant : rectVariant;
                const groupActive = (g.variants as readonly SketchTool[]).includes(sketchTool);
                const expanded = expandedSketchGroup === slot.group;
                return (
                  <div className="sketch-group" key={slot.group}>
                    {/* In-flow collapsed button — keeps the column width stable.
                        Clicking it reveals the variants as a horizontal flyout. */}
                    <button
                      className={(groupActive ? "active" : "") + (expanded ? " expanded" : "")}
                      title={g.title}
                      aria-expanded={expanded}
                      onClick={() => setExpandedSketchGroup(expanded ? null : slot.group)}
                    >
                      {sketchToolMeta(variant).label}{kbd(sketchToolMeta(variant).sc)}
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
                              style={sketchBtnWidth != null ? { width: sketchBtnWidth } : undefined}
                              onClick={() => setSketchTool(tv)}
                            >
                              {t.label}{kbd(t.sc)}
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })}
              <button
                title="Dimension (D): a line (length), circle (radius), or two lines (angle) — pick one if none selected"
                className={dimPending ? "active" : ""}
                onClick={startDimension}
              >
                ↔{kbd("D")}
              </button>
              <div className="sketch-toolbar-sep" />
              <button
                title="Horizontal (H) — select a line"
                disabled={!oneSelectedLine}
                onClick={() => oneSelectedLine && addHVConstraint("horizontal", oneSelectedLine.id)}
              >
                <HorizontalIcon />{kbd("H")}
              </button>
              <button
                title="Vertical (V) — select a line"
                disabled={!oneSelectedLine}
                onClick={() => oneSelectedLine && addHVConstraint("vertical", oneSelectedLine.id)}
              >
                <VerticalIcon />{kbd("V")}
              </button>
              <button
                title="Parallel (Shift+P) — select two lines"
                disabled={!twoSelectedLines}
                onClick={() =>
                  twoSelectedLines &&
                  addGeoConstraint("parallel", twoSelectedLines[0].id, twoSelectedLines[1].id)
                }
              >
                <ParallelIcon />{kbd("⇧P")}
              </button>
              <button
                title="Perpendicular (N) — select two lines"
                disabled={!twoSelectedLines}
                onClick={() =>
                  twoSelectedLines &&
                  addGeoConstraint("perpendicular", twoSelectedLines[0].id, twoSelectedLines[1].id)
                }
              >
                ⊥{kbd("N")}
              </button>
              <button
                title="Equal (=) — select two lines (equal length) or two circles/arcs (equal radius)"
                disabled={!twoSelectedLines && !twoRadiusEntities}
                onClick={() => {
                  const pair = twoSelectedLines ?? twoRadiusEntities;
                  if (pair) addGeoConstraint("equal", pair[0].id, pair[1].id);
                }}
              >
                ＝{kbd("=")}
              </button>
              <button
                title="Coincident — a point + a line puts the point on the line; one point anchors it to the origin; two points make them coincident"
                disabled={
                  !(
                    (selectedSketchPoints.length === 1 && selectedSketchLines.length === 1) ||
                    ((selectedSketchPoints.length === 1 || selectedSketchPoints.length === 2) &&
                      selectedSketchLines.length === 0)
                  )
                }
                onClick={addCoincident}
              >
                ⌖
              </button>
              <button
                title="Tangent — select two curves (circle/arc) or a line and a curve"
                disabled={!tangentPair}
                onClick={() => tangentPair && addGeoConstraint("tangent", tangentPair[0].id, tangentPair[1].id)}
              >
                ◯⌐
              </button>
              <div className="sketch-toolbar-sep" />
              <button
                title={
                  selectedSketchEntities.length > 0
                    ? "Construction (Q): toggle construction (reference) geometry on the selection"
                    : "Construction (Q): draw reference geometry (toggle)"
                }
                className={constructionMode ? "active" : ""}
                onClick={toggleConstruction}
              >
                <ConstructionIcon />{kbd("Q")}
              </button>
              {editingSketch.constraints.length > 0 && (
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
              )}
            </div>
          )}
          {dimPending && (
            <div className="dim-hint">Pick a line or circle to dimension · Esc to cancel</div>
          )}
          {dimInput && (
            <DraggableDialog
              className="dim-input"
              baseTransform="translate(14px, -130%)"
              style={{ left: dimInput.x, top: dimInput.y }}
            >
              <label data-drag-handle>
                {dimInput.kind === "radius" ? "Radius" : dimInput.kind === "angle" ? "Angle °" : "Length"}
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
          {editingSketch && offsetSession && (() => {
            // Guarded: a half-typed / non-numeric distance must not throw here.
            let raw = NaN;
            try { raw = evaluateExpression(offsetSession.value, resolved.scope); } catch { raw = NaN; }
            const dv = Number.isFinite(raw) ? raw : 0;
            const a0 = screenOf(offsetSession.anchor);
            const a1 = screenOf([offsetSession.anchor[0] + offsetSession.normal[0], offsetSession.anchor[1] + offsetSession.normal[1]]);
            const axisX = a1.x - a0.x, axisY = a1.y - a0.y, axisLen2 = axisX * axisX + axisY * axisY || 1;
            const handle = screenOf([offsetSession.anchor[0] + offsetSession.normal[0] * dv, offsetSession.anchor[1] + offsetSession.normal[1] * dv]);
            // Point the arrow along the (screen-space) drag axis, flipping 180°
            // when the offset has gone negative — like the Transform gizmo's
            // translate handle pointing in the drag direction.
            const arrowAng = (Math.atan2(axisY, axisX) * 180) / Math.PI + (dv < 0 ? 180 : 0);
            const onDrag = (ev: React.PointerEvent) => {
              ev.preventDefault();
              ev.stopPropagation();
              const sx = ev.clientX, sy = ev.clientY, d0 = dv;
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
                <DraggableDialog className="dim-input" baseTransform="translate(14px, -130%)" style={{ left: a0.x, top: a0.y }}>
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
          {editingSketch && !offsetSession && selectedOffsetOp && (() => {
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
            const shown = offsetEdit?.opId === selectedOffsetOp.op.id ? offsetEdit.value : selectedOffsetOp.op.distance;
            return (
              <DraggableDialog className="dim-input" baseTransform="translate(14px, -130%)" style={{ left: a0.x, top: a0.y }}>
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
          {editingSketch && mirrorSession && (() => {
            const sk = doc.features.find((f) => f.id === editingSketchId);
            const axis =
              mirrorSession.axisEntityId && sk?.type === "sketch"
                ? sk.entities.find((x) => x.id === mirrorSession.axisEntityId)
                : undefined;
            const anchorUv: Vec2 =
              axis && axis.type === "line"
                ? [(axis.a[0] + axis.b[0]) / 2, (axis.a[1] + axis.b[1]) / 2]
                : [0, 0];
            const a0 = screenOf(anchorUv);
            return (
              <DraggableDialog className="dim-input" baseTransform="translate(14px, -130%)" style={{ left: a0.x, top: a0.y }}>
                <label data-drag-handle>Mirror</label>
                {!mirrorSession.axisEntityId ? (
                  <span style={{ padding: "0 6px" }}>Click a line to set the axis</span>
                ) : (
                  <span style={{ padding: "0 6px" }}>
                    {mirrorSession.previews.length} mirrored — click entities to add
                  </span>
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
          {/* Project/Convert tool: a fixed floating prompt. There's no single
              anchor (the user clicks body edges/vertices anywhere), so it sits at
              the top. Done commits the projected previews; ✕/Esc discards them. */}
          {editingSketch && projectSession && (
            <DraggableDialog className="dim-input" style={{ left: "50%", top: 70 }} baseTransform="translateX(-50%)">
              <label data-drag-handle>Project</label>
              <span style={{ padding: "0 6px" }}>
                {projectSession.previews.length > 0
                  ? `${projectSession.previews.length} projected — click more edges/vertices`
                  : "Click body edges or vertices to project"}
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
          {editingSketch && textDraft && (() => {
            const a0 = screenOf(textDraft.anchor);
            return (
              <DraggableDialog className="dim-input" baseTransform="translate(14px, -130%)" style={{ left: a0.x, top: a0.y }}>
                <label data-drag-handle>Text</label>
                <input
                  autoFocus
                  value={textDraft.value}
                  placeholder="Type text…"
                  style={{ width: 120 }}
                  onChange={(ev) => setTextDraft((s) => (s ? { ...s, value: ev.target.value } : s))}
                  onKeyDown={(ev) => {
                    if (ev.key === "Enter") { ev.preventDefault(); commitText(); }
                  }}
                />
                <DimValueInput
                  value={textDraft.height}
                  variables={dimVarOptions}
                  onChange={(v) => setTextDraft((s) => (s ? { ...s, height: v } : s))}
                  onSubmit={commitText}
                  onCancel={() => setTextDraft(null)}
                />
                <button onClick={commitText} disabled={!textDraft.value.trim()}>Set</button>
                <button className="ghost" onClick={() => setTextDraft(null)}>✕</button>
              </DraggableDialog>
            );
          })()}
          {/* Polygon tool: a one-shot floating "Sides" box (like the dimension
              input). The draft is free text; Set (enabled only for an integer in
              3..24) commits the count and closes the box so the next viewport click
              draws. Cancel/✕/Esc just closes it, keeping the previous count. */}
          {editingSketch && sketchTool === "polygon" && polySidesOpen && (() => {
            const n = Number(polySidesText);
            const valid = Number.isInteger(n) && n >= 3 && n <= 24;
            const commit = () => { if (valid) { setPolygonSides(n); setPolySidesOpen(false); } };
            return (
              <DraggableDialog className="dim-input" style={{ left: "50%", top: 70 }} baseTransform="translateX(-50%)">
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
                <button onClick={commit} disabled={!valid}>Set</button>
                <button className="ghost" onClick={() => setPolySidesOpen(false)}>✕</button>
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
          {editingSketch && sketchMsg && <div className="sketch-msg" role="alert">⚠ {sketchMsg}</div>}
          <div
            className="view-controls"
            ref={viewControlsRef}
            style={viewControlsTop != null ? { top: viewControlsTop } : undefined}
          >
            {VIEW_BUTTONS.map((v, i) => (
              <button
                key={v.name}
                title={`${v.label} (${i + 1})`}
                onClick={() => viewApiRef.current?.setView(v.name)}
              >
                {v.label}
              </button>
            ))}
          </div>
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
                Editing <strong>{editingSketch.name}</strong> ·{" "}
                {planeRefLabel(editingSketch.plane)}
              </span>
              <button onClick={finishSketch}>Finish sketch ⏎</button>
            </div>
          ) : (
            picking && (
              <div className="sketch-banner pick">
                <span>
                  {pickPurpose === "revolveAxis"
                    ? "Click an edge, plane, or face to revolve around"
                    : pickPurpose === "plane"
                      ? "Select a plane or planar face to offset the new plane from"
                      : "Select a plane or planar face for the sketch"}
                </span>
                <button onClick={() => { setPicking(false); if (pickPurpose === "revolveAxis") setPickPurpose("sketch"); }}>Cancel (Esc)</button>
              </div>
            )
          )}
          {extrudeDialog && (
            <DraggableDialog className="extrude-dialog" style={{ left: extrudeDialog.x, top: extrudeDialog.y }}>
              <div className="ed-title" data-drag-handle>
                Extrude{extrudeProfiles.length > 1 ? ` (${extrudeProfiles.length} profiles)` : ""}
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
                        d ? { ...d, mode: m, extent: m !== "remove" && d.extent === "throughAll" ? "blind" : d.extent } : d,
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
                    <option value="" disabled>Select a part…</option>
                    {booleanCandidates.map((c) => (
                      <option key={c.id} value={c.id}>{c.name}</option>
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
                    if (extent !== "upToFace") setPickingUpFace(false);
                  }}
                >
                  <option value="blind">Blind</option>
                  <option value="symmetric">Symmetric</option>
                  {/* Through All only makes sense as a cut, so it's shown for Remove only. */}
                  {extrudeDialog.mode === "remove" && <option value="throughAll">Through All</option>}
                  <option value="upToFace">Up to face</option>
                </select>
              </label>
              {extrudeDialog.extent === "upToFace" && (
                <label className="ed-field">
                  <span>Face</span>
                  <button
                    type="button"
                    className={"ed-pick-btn" + (pickingUpFace ? " active" : "")}
                    onClick={() => setPickingUpFace((v) => !v)}
                  >
                    {pickingUpFace
                      ? "Click a face…"
                      : extrudeDialog.upTo
                        ? `On ${doc.features.find((f) => f.id === extrudeDialog.upTo!.featureId)?.name ?? "body"}`
                        : "Select a face"}
                  </button>
                </label>
              )}
              {extrudeDialog.extent !== "upToFace" && (
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
                  Create
                </button>
                <button onClick={closeExtrudeDialog}>Cancel</button>
              </div>
            </DraggableDialog>
          )}
          {dressUpDialog && (
            <DraggableDialog className="extrude-dialog" style={{ left: dressUpDialog.x, top: dressUpDialog.y }}>
              <div className="ed-title" data-drag-handle>{dressUpDialog.op === "chamfer" ? "Chamfer" : "Fillet"}</div>
              <label className="ed-field">
                <span>{dressUpDialog.op === "chamfer" ? "Distance" : "Radius"}</span>
                <input
                  autoFocus
                  value={dressUpDialog.size}
                  onChange={(e) => setDressUpDialog((d) => (d ? { ...d, size: e.target.value } : d))}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") createDressUp();
                    else if (e.key === "Escape") setDressUpDialog(null);
                  }}
                />
              </label>
              <div className="ed-actions">
                <button className="ed-primary" onClick={createDressUp}>Create</button>
                <button onClick={() => setDressUpDialog(null)}>Cancel</button>
              </div>
            </DraggableDialog>
          )}
          {revolveDialog && (() => {
            const profileLabel = revolveDialog.profile
              ? doc.features.find((f) => f.id === revolveDialog.profile!.sketchId)?.name ?? "Region"
              : null;
            const ax = revolveDialog.axis;
            const axisLabel = !ax
              ? null
              : "plane" in ax
                ? planeRefLabel(ax.plane)
                : "face" in ax
                  ? (doc.features.find((f) => f.id === ax.face.featureId)?.name ?? "Body") + " · face"
                  : (doc.features.find((f) => f.id === ax.sketchId)?.name ?? "Edge") + " · edge";
            const axisArming = picking && pickPurpose === "revolveAxis";
            const armAxis = () => {
              setRevolveDialog((d) => (d ? { ...d, armed: null } : d));
              setPickPurpose("revolveAxis");
              setPicking(true);
            };
            return (
            <DraggableDialog className="extrude-dialog" style={{ left: revolveDialog.x, top: revolveDialog.y }}>
              <div className="ed-title" data-drag-handle>Revolve</div>
              <div className="ed-hint">Arm a profile face, then an axis — a sketch line, a plane, or a body face.</div>
              <div className="bool-group-label">Profile</div>
              {profileLabel ? (
                <div className="bool-operand-row">
                  <span className="bool-operand-name">{profileLabel}</span>
                  <button className="bool-operand-x" title="Re-pick" onClick={() => setRevolveDialog((d) => (d ? { ...d, profile: null, armed: "profile" } : d))}>✕</button>
                </div>
              ) : (
                <button
                  className={"ed-pick-btn" + (revolveDialog.armed === "profile" ? " active" : "")}
                  onClick={() => setRevolveDialog((d) => (d ? { ...d, armed: "profile" } : d))}
                >
                  {revolveDialog.armed === "profile" ? "Click a region…" : "Select profile face"}
                </button>
              )}
              <div className="bool-group-label">Axis</div>
              {axisLabel ? (
                <div className="bool-operand-row">
                  <span className="bool-operand-name">{axisLabel}</span>
                  <button className="bool-operand-x" title="Re-pick" onClick={() => { setRevolveDialog((d) => (d ? { ...d, axis: null } : d)); armAxis(); }}>✕</button>
                </div>
              ) : (
                <button
                  className={"ed-pick-btn" + (axisArming ? " active" : "")}
                  onClick={armAxis}
                >
                  {axisArming ? "Click an edge, plane, or face…" : "Select axis"}
                </button>
              )}
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
                  Create
                </button>
                <button onClick={closeRevolveDialog}>Cancel</button>
              </div>
            </DraggableDialog>
            );
          })()}
          {planeDialog && (
            <DraggableDialog className="extrude-dialog" style={{ left: "50%", top: 64 }} baseTransform="translateX(-50%)">
              <div className="ed-title" data-drag-handle>Reference plane</div>
              <label className="ed-field">
                <span>Method</span>
                <select
                  value={planeDialog.method}
                  onChange={(e) => {
                    const method = e.target.value as PlaneMethod;
                    setPlaneDialog((d) => (d ? { ...d, method } : d));
                    // Arm the first pick the method needs: a plane/face for all but
                    // "through", which collects vertices/sketch points via clicks.
                    if (method === "through") { setPlanePick("point"); setPicking(false); }
                    else { setPlanePick("base"); setPickPurpose("plane"); setPicking(true); }
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
                  <button
                    className={"ed-pick-btn" + (planePick === "base" ? " active" : "")}
                    onClick={() => { setPlanePick("base"); setPickPurpose("plane"); setPicking(true); }}
                  >
                    {planePick === "base" ? "Click a plane/face…" : planeDialog.base ? planeRefLabel(planeDialog.base) : "Select plane/face"}
                  </button>
                </div>
              )}

              {planeDialog.method === "offset" && (
                <label className="ed-field">
                  <span>Offset</span>
                  <input
                    value={planeDialog.offset}
                    onChange={(e) => setPlaneDialog((d) => (d ? { ...d, offset: e.target.value } : d))}
                    onKeyDown={(e) => { if (e.key === "Enter") createPlane(); else if (e.key === "Escape") closePlaneDialog(); }}
                  />
                </label>
              )}

              {planeDialog.method === "midplane" && (
                <div className="ed-field">
                  <span>Second</span>
                  <button
                    className={"ed-pick-btn" + (planePick === "refB" ? " active" : "")}
                    onClick={() => { setPlanePick("refB"); setPickPurpose("plane"); setPicking(true); }}
                  >
                    {planePick === "refB" ? "Click a plane/face…" : planeDialog.refB ? planeRefLabel(planeDialog.refB) : "Select plane/face"}
                  </button>
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
                      onKeyDown={(e) => { if (e.key === "Enter") createPlane(); else if (e.key === "Escape") closePlaneDialog(); }}
                    />
                  </label>
                </>
              )}

              {planeDialog.method === "through" && (
                <div className="ed-field">
                  <span>Points</span>
                  <button
                    className={"ed-pick-btn" + (planePick === "point" ? " active" : "")}
                    onClick={() => { setPlanePick("point"); setPicking(false); }}
                  >
                    {`${planeDialog.points.length}/3 picked`}{planePick === "point" ? " · click vertices/points…" : ""}
                  </button>
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
                  Create
                </button>
                <button onClick={closePlaneDialog}>Cancel</button>
              </div>
            </DraggableDialog>
          )}
          {editingTransform && (
            <DraggableDialog className="extrude-dialog" style={{ left: "50%", top: 64 }} baseTransform="translateX(-50%)">
              <div className="ed-title" data-drag-handle>Transform · {editingTransform.name}</div>
              <div className="ed-modes">
                {(["translate", "rotate"] as const).map((m) => (
                  <button
                    key={m}
                    className={transformMode === m ? "active" : ""}
                    onClick={() => setTransformMode(m)}
                  >
                    {m === "translate" ? "Move" : "Rotate"}
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
                        setDoc(updateParam(doc, editingTransform.id, k, e.target.value), `param:${editingTransform.id}:${k}`)
                      }
                      onKeyDown={(e) => {
                        if (e.key === "Enter") finishTransform();
                        else if (e.key === "Escape") cancelTransform();
                      }}
                    />
                  </label>
                ))
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
                            setDoc(updateParam(doc, editingTransform.id, "axis", ax), `param:${editingTransform.id}:axis`)
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
                        setDoc(updateParam(doc, editingTransform.id, "angle", e.target.value), `param:${editingTransform.id}:angle`)
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
                  onChange={(e) =>
                    setDoc(updateParam(doc, editingTransform.id, "copy", String(e.target.checked)))
                  }
                />
              </label>
              <div className="ed-hint">Drag the gizmo, or type exact values.</div>
              <div className="ed-actions">
                <button className="ed-primary" onClick={finishTransform}>Done</button>
                <button onClick={cancelTransform}>Cancel</button>
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
          onRemoveTool={(id) =>
            setBooleanDialog((d) => (d ? { ...d, tools: d.tools.filter((x) => x !== id) } : d))
          }
          onConfirm={confirmBoolean}
          onCancel={() => setBooleanDialog(null)}
        />
      )}
      {mirrorDialog && (
        <DraggableDialog
          className="extrude-dialog"
          style={{ left: "50%", top: 70 }}
          baseTransform="translateX(-50%)"
        >
          <div className="ed-title" data-drag-handle>Mirror across plane</div>
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
                <option key={o.key} value={o.key}>{o.label}</option>
              ))}
            </select>
          </label>
          {mirrorDialog.plane === "face" && (
            <label className="ed-field">
              <span>Face</span>
              <button
                type="button"
                className={"ed-pick-btn" + (pickingMirrorFace ? " active" : "")}
                onClick={() => setPickingMirrorFace((v) => !v)}
              >
                {pickingMirrorFace
                  ? "Click a planar face…"
                  : mirrorDialog.faceRef
                    ? `On ${doc.features.find((f) => f.id === mirrorDialog.faceRef!.featureId)?.name ?? "body"}`
                    : "Select a face"}
              </button>
            </label>
          )}
          <div className="ed-actions">
            <button className="ed-primary" onClick={createMirror} disabled={mirrorDialog.plane === "face" && !mirrorDialog.faceRef}>
              Create
            </button>
            <button onClick={closeMirror}>Cancel</button>
          </div>
        </DraggableDialog>
      )}
    </div>
  );
}
