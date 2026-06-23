import { useEffect, useMemo, useRef, useState, type ChangeEvent, type PointerEvent } from "react";
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
import { DEFAULT_SOLID_COLOR } from "./document/colors";
import type {
  Document,
  ExtrudeExtent,
  ExtrudeProfile,
  FeatureKind,
  UpToFaceRef,
  PlaneFeature,
  PlaneMethod,
  SketchConstraint,
  SketchEntity,
  SketchFeature,
  TransformFeature,
  Vec2,
} from "./document/types";
import type { BooleanOp, MeshedEdges, MeshedFaces } from "./kernel/types";
import { solveSketch } from "./sketch/solver";
import { measureSelection } from "./selection/measure";
import { deriveFaceFrame, frameOf, planeRefLabel, uvToWorld, type PlaneFrameData, type SketchPlaneId, type SketchPlaneRef } from "./document/planes";
import { evaluateExpression } from "./document/expression";
import { detectSketchRegions, regionsEnclosedBy } from "./document/regions";
import { FEATURE_DEFS, FEATURE_KINDS } from "./document/featureDefs";
import { listDocs, saveDoc } from "./storage/db";
import {
  arcFrom3,
  circleFrom3,
  loopSegments,
  rectangleCorners,
  rectangleFromCenter,
  regularPolygon,
} from "./document/sketchTools";
import { useHistory } from "./hooks/useHistory";
import { ConstructionIcon, ParallelIcon } from "./ui/icons";
import { BooleanDialog } from "./ui/BooleanDialog";
import { DraggableDialog } from "./ui/DraggableDialog";
import { DimensionOverlay, type DimSpec } from "./ui/DimensionOverlay";
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

const SKETCH_TOOLS: { tool: SketchTool; label: string; title: string }[] = [
  { tool: "select", label: "↖", title: "Select (V)" },
  { tool: "line", label: "╱", title: "Line (L)" },
  { tool: "rect-corner", label: "▭", title: "Rectangle: 2 corners (R)" },
  { tool: "rect-center", label: "⊞", title: "Rectangle: center + corner (Shift+R)" },
  { tool: "circle-center", label: "○", title: "Circle: center + radius (C)" },
  { tool: "circle-3p", label: "◔", title: "Circle: 3 points (Shift+C)" },
  { tool: "polygon", label: "⬢", title: "Regular polygon (P)" },
  { tool: "arc-3p", label: "⌒", title: "Arc: 3 points (A)" },
  { tool: "spline", label: "∿", title: "Spline (S): click points, Enter to finish" },
];

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
          setExtrudeDialog((d) => (d ? { ...d, upTo: { featureId: picked.featureId, faceName, center } } : d));
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
    // Dimension mode armed: the next picked line/circle is the dimension target.
    if (dimPending) {
      const sk = doc.features.find((f) => f.id === editingSketchId);
      const e =
        picked?.kind === "sketchEntity" && picked.sketchId === editingSketchId && sk?.type === "sketch"
          ? sk.entities.find((x) => x.id === picked.entityId)
          : undefined;
      if (e?.type === "line" || e?.type === "circle") {
        setSelection([picked!]);
        openDimensionFor(e);
      } else {
        setDimPending(false); // clicked empty / non-dimensionable → cancel
      }
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
  const [pickPurpose, setPickPurpose] = useState<"sketch" | "plane">("sketch");
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
  const [polygonSides, setPolygonSides] = useState(6);
  // When on, newly drawn entities are marked as construction (reference) geometry.
  const [constructionMode, setConstructionMode] = useState(false);
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
  const [dressUpDialog, setDressUpDialog] = useState<
    { op: "chamfer" | "fillet"; size: string; x: number; y: number } | null
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
  // The Variables section is collapsible (to reclaim panel space). Default:
  // open for a short list (< 5 variables), collapsed for a long one so it
  // doesn't dominate the panel. Set from the loaded doc (see the restore effect)
  // and then left wherever the user puts it.
  const VARS_OPEN_THRESHOLD = 5;
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
    setSketchToolState(t);
    setDraft([]); // starting a new tool abandons any in-progress points
  };
  // Geometry from the last kernel regen, keyed by feature id. Color/opacity
  // live on the feature and are overlaid in `meshes` below so tweaking them
  // doesn't require re-running the (expensive) kernel regen.
  const [rawMeshes, setRawMeshes] = useState<{ id: string; mesh: FeatureMesh["mesh"] }[]>([]);
  // When set, only this body is rendered (isolate); others are hidden until exit.
  const [isolatedBodyId, setIsolatedBodyId] = useState<string | null>(null);
  // Which geometry kinds clicking can pick (selection filters).
  const [selFilter, setSelFilter] = useState<SelectionFilter>({ body: true, face: true, edge: true, vertex: true });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [fatal, setFatal] = useState<string | null>(null);
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

  // Restore the working document from IndexedDB on first load (most recent), or
  // keep the seed and adopt its id. Autosave only starts once this completes so
  // the placeholder can't overwrite a saved document.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const docs = await listDocs();
        if (cancelled) return;
        if (docs.length > 0) {
          docIdRef.current = docs[0].id;
          const migrated = migrateDocument(docs[0].doc);
          resetDoc(migrated);
          // Default the Variables section open/collapsed by the restored count.
          setVariablesOpen(migrated.variables.length < VARS_OPEN_THRESHOLD);
        }
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
  useEffect(() => {
    if (!persistLoaded) return;
    const t = setTimeout(() => {
      saveDoc({ id: docIdRef.current!, name: "Untitled", doc, updatedAt: Date.now() }).catch((err) =>
        console.warn("autosave failed:", err),
      );
    }, 600);
    return () => clearTimeout(t);
  }, [doc, persistLoaded]);

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
  useEffect(() => {
    const kernel = kernelRef.current;
    if (!ready || !kernel) return;
    let cancelled = false;
    setBusy(true);

    kernel
      .regenerate(resolved.features)
      .then((results) => {
        if (cancelled) return;
        const nextMeshes: { id: string; mesh: FeatureMesh["mesh"] }[] = [];
        const regenErrors: Record<string, string> = { ...resolved.errors };
        for (const r of results) {
          if (r.ok) nextMeshes.push({ id: r.id, mesh: r.mesh });
          else regenErrors[r.id] = r.error;
        }
        setRawMeshes(nextMeshes);
        setErrors(regenErrors);
        setFatal(null);
      })
      .catch((err) => {
        if (cancelled) return;
        console.error("regeneration failed:", err);
        setFatal(String(err?.message ?? err));
      })
      .finally(() => {
        if (!cancelled) setBusy(false);
      });

    return () => {
      cancelled = true;
    };
  }, [resolved, ready]);

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
    () => (extrudePreview ? extrudePreview.map((p) => ({ mesh: p.mesh })) : []),
    [extrudePreview],
  );

  // Feature ids that produced an actual rendered body — what the Solids list
  // shows and what a Boolean can combine (primitives, "new" extrusions,
  // booleans, and add/dressup-targets that kept their id).
  const bodyIds = useMemo(() => new Set(rawMeshes.map((m) => m.id)), [rawMeshes]);

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

  // A single line/circle selected → eligible for a length/radius dimension.
  const dimEntity = useMemo(() => {
    if (selectedSketchEntities.length !== 1) return null;
    const e = selectedSketchEntities[0];
    return e.type === "line" || e.type === "circle" ? e : null;
  }, [selectedSketchEntities]);

  // Exactly two lines / two circles selected → eligible for the line-pair
  // constraints (angle/parallel/perpendicular/equal-length) and equal-radius.
  const twoSelectedLines = useMemo(() => {
    const es = selectedSketchEntities;
    return es.length === 2 && es[0].type === "line" && es[1].type === "line"
      ? ([es[0], es[1]] as Extract<SketchEntity, { type: "line" }>[])
      : null;
  }, [selectedSketchEntities]);
  const twoSelectedCircles = useMemo(() => {
    const es = selectedSketchEntities;
    return es.length === 2 && es[0].type === "circle" && es[1].type === "circle"
      ? ([es[0], es[1]] as Extract<SketchEntity, { type: "circle" }>[])
      : null;
  }, [selectedSketchEntities]);

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
  const dimSpecs = useMemo<DimSpec[]>(() => {
    if (!editingSketch) return [];
    return editingSketch.constraints.flatMap((c): DimSpec[] => {
      if (c.id === dimInput?.editId) return [];
      if (c.type === "distance") {
        const e = ent(c.entity);
        if (e?.type === "line") return [{ id: c.id, kind: "length", text: fmt(c.value), a: e.a, b: e.b }];
      } else if (c.type === "radius") {
        const e = ent(c.entity);
        if (e?.type === "circle") return [{ id: c.id, kind: "radius", text: `R${fmt(c.value)}`, c: e.c, r: e.r }];
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
    }
    for (const s of selection) {
      if (s.kind === "sketchFace") {
        addRegion(s.sketchId, s.regionId);
      } else if (s.kind === "face") {
        const m = meshes.find((x) => x.id === s.featureId);
        const center = m ? faceCentroid(m.mesh.faces, s.faceId) : null;
        if (!center) continue;
        const faceName = m ? faceNameOf(m.mesh.faces, s.faceId) : undefined;
        profiles.push({ kind: "bodyFace", featureId: s.featureId, faceId: s.faceId, faceName, center });
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
      next = profile.kind === "sketchRegion" ? setSuppressed(res.doc, profile.sketchId, true) : res.doc;
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
      .then((results) => {
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
    for (const e of edges) {
      const nm = edgeNameOf(m.mesh.edges, e.edgeId);
      if (!nm) return null; // unnamed edge — can't reference it stably
      names.push(nm);
    }
    const anchor = edgeMidpoint(m.mesh.edges, edges[0].edgeId);
    return { targetId, edges: names, anchor };
  }, [selection, meshes]);

  const openDressUp = (op: "chamfer" | "fillet") => {
    if (!dressUpTarget) return;
    const s = (dressUpTarget.anchor && viewApiRef.current?.worldToScreen(dressUpTarget.anchor)) || { x: 240, y: 160 };
    setDressUpDialog({ op, size: "2", x: s.x, y: s.y });
  };

  const createDressUp = () => {
    if (!dressUpTarget || !dressUpDialog) return;
    const { doc: next, id } = addDressUp(
      doc, dressUpDialog.op, dressUpTarget.targetId, dressUpTarget.edges, dressUpDialog.size,
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

  // Create a Revolve (360° by default; edit the angle in the parameter editor).
  const openRevolve = () => {
    if (!revolveInputs) return;
    const { doc: next, id } = addRevolve(doc, revolveInputs.profile, revolveInputs.axis);
    setDoc(next);
    selectFeature(id);
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
      v: "select",
      l: "line",
      r: "rect-corner",
      c: "circle-center",
      p: "polygon",
      a: "arc-3p",
      s: "spline", // S = Spline (freed up when the Solve shortcut was removed)
    };
    // Shift-modified variants of an existing tool key (Shift+R/Shift+C).
    const SKETCH_SHIFT_KEYS: Record<string, SketchTool> = {
      r: "rect-center",
      c: "circle-3p",
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (dimInputRef.current) setDimInput(null);
        else if (dimPendingRef.current) setDimPending(false);
        else if (planeDialog) closePlaneDialog();
        else if (transformEditId) cancelTransform();
        else if (picking) setPicking(false);
        else if (draft.length > 0) setDraft([]); // cancel the in-progress shape
        else if (editingSketchId) finishSketch();
        return;
      }
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      if ((e.key === "Delete" || e.key === "Backspace") && selection.length > 0) {
        e.preventDefault();
        handleDeleteSelection();
        return;
      }
      if (e.key === "Enter" && draft.length > 0) {
        // Spline: Enter commits the accumulated points; other tools just abandon.
        if (!finishSpline()) setDraft([]);
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
        if (e.shiftKey && SKETCH_SHIFT_KEYS[key]) {
          setSketchTool(SKETCH_SHIFT_KEYS[key]);
          return;
        }
        if (!e.shiftKey && SKETCH_KEYS[key]) {
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
        if (e.shiftKey && key === "p" && twoSelectedLines) {
          addGeoConstraint("parallel", twoSelectedLines[0].id, twoSelectedLines[1].id);
          return;
        }
        if (e.key === "=") {
          const pair = twoSelectedLines ?? twoSelectedCircles;
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
          if (revolveInputs) openRevolve();
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
    sweepInputs,
    loftInputs,
    dressUpTarget,
    bodyIds,
    transformTarget,
    twoSelectedLines,
    twoSelectedCircles,
    primaryFeatureId,
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
  const handleSketchClick = (uv: Vec2, hv?: "horizontal" | "vertical") => {
    if (!editingSketchId || sketchTool === "select") return;
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
        if (draft.length === 0) setDraft([uv]);
        else {
          const line = lineEntity(draft[0], uv);
          let next = addSketchEntities(doc, sketchId, [line]);
          if (hv) {
            next = addSketchConstraints(next, sketchId, [{ id: genId(), type: hv, entity: line.id }]);
          }
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
        // Accumulate control points; the spline is committed on Enter / Finish
        // (see finishSpline) so it can take any number of points.
        setDraft([...draft, uv]);
        break;
    }
  };

  // Commit the in-progress spline (≥2 points) as a spline entity, then clear the
  // draft. Called from Enter while the spline tool is active.
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
      return { doc: setSketchEntities(docArg, sketchId, res.entities), res };
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

  const screenOf = (uv: Vec2) => {
    const frame = frameOf(editingSketch!.plane, resolved.planeFrames);
    return viewApiRef.current?.worldToScreen(uvToWorld(frame, uv[0], uv[1])) ?? { x: 240, y: 120 };
  };

  // Open the dimension input anchored next to the given entity: a line → length
  // (input next to its midpoint); a circle → radius (input next to its centre).
  // `editId`/`prefill` are supplied when reopening an existing constraint (its
  // label hides while the input is open, and the input shows the stored value);
  // for a fresh dimension the value is computed from the current geometry.
  const openDimensionFor = (
    entity: Extract<SketchEntity, { type: "line" | "circle" }>,
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

  // Add a geometric (non-dimensional) constraint between two entities and re-solve.
  // No-op if an equivalent constraint already exists (avoids redundant piles). Like
  // a dimension, one the solver can't satisfy is rejected (not saved as a dead
  // constraint) and reported by name instead of silently freezing the geometry.
  const addGeoConstraint = async (type: "parallel" | "perpendicular" | "equal", a: string, b: string) => {
    if (!editingSketch) return;
    const sketchId = editingSketch.id;
    const exists = editingSketch.constraints.some(
      (c) => c.type === type && ((c.a === a && c.b === b) || (c.a === b && c.b === a)),
    );
    if (exists) return;
    const name = { parallel: "Parallel", perpendicular: "Perpendicular", equal: "Equal" }[type];
    const candidate = addSketchConstraints(doc, sketchId, [{ id: genId(), type, a, b }]);
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
      if (e?.type === "line" || e?.type === "circle") openDimensionFor(e, c.id, c.value);
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
    Object.keys(errors).length + Object.keys(resolved.variableErrors).length;
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
        <span className="phase">Phase&nbsp;3 · modeling</span>
        <div className="topbar-actions">
          <button className="tool-btn" onClick={undo} disabled={!canUndo} title="Undo (⌘Z)">
            ↶
          </button>
          <button className="tool-btn" onClick={redo} disabled={!canRedo} title="Redo (⌘⇧Z)">
            ↷
          </button>
        </div>
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
            activeSketch={
              editingSketch
                ? { datumId: editingSketch.plane.kind === "datum" ? editingSketch.plane.id : null }
                : null
            }
            sketchTool={sketchTool}
            sketches={renderSketches}
            activeSketchId={editingSketchId}
            sketchFullyConstrained={fullyConstrained}
            draft={draft}
            polygonSides={polygonSides}
            onSketchClick={handleSketchClick}
            selectionFilter={selFilter}
            apiRef={viewApiRef}
          />
          <div className="model-toolbar">
            <button
              title="Sketch (S): start a sketch — pick a plane or face"
              disabled={!!editingSketch || picking}
              onClick={() => { setPickPurpose("sketch"); setPicking(true); }}
            >
              ✎ Sketch
            </button>
            <div className="mt-dropdown" ref={newSolidRef}>
              <button
                title="New Body (N): create a new solid body"
                disabled={!!editingSketch}
                onClick={() => setNewSolidOpen((o) => !o)}
              >
                ◧ New Body ▾
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
              ⧉ Plane
            </button>
            <button
              title="Extrude (E): extrude the selected sketch region(s) and/or face(s)"
              disabled={extrudeProfiles.length === 0 || !!editingSketch || picking || !!extrudeDialog}
              onClick={openExtrudeDialog}
            >
              ⬆ Extrude
            </button>
            <button
              title="Revolve (R): revolve a sketch region around an axis line (select both)"
              disabled={!revolveInputs || !!editingSketch || picking}
              onClick={openRevolve}
            >
              ⟳ Revolve
            </button>
            <button
              title="Sweep (W): sweep a sketch region along a path — line / arc / spline (select both)"
              disabled={!sweepInputs || !!editingSketch || picking}
              onClick={openSweep}
            >
              ⊃ Sweep
            </button>
            <button
              title="Loft (L): loft through 2+ sketch regions (select the sections)"
              disabled={!loftInputs || !!editingSketch || picking}
              onClick={openLoft}
            >
              ⌧ Loft
            </button>
            <button
              title="Chamfer (C): chamfer the selected edge(s)"
              disabled={!dressUpTarget || !!editingSketch || picking}
              onClick={() => openDressUp("chamfer")}
            >
              ◣ Chamfer
            </button>
            <button
              title="Fillet (F): round the selected edge(s)"
              disabled={!dressUpTarget || !!editingSketch || picking}
              onClick={() => openDressUp("fillet")}
            >
              ◖ Fillet
            </button>
            <button
              title="Boolean (B): union / subtract / intersect"
              disabled={bodyIds.size < 2 || !!editingSketch || picking}
              onClick={openBooleanDialog}
            >
              ⊕ Boolean
            </button>
            <button
              title="Transform (T): move / rotate the selected body"
              disabled={!transformTarget || !!editingSketch || picking || !!transformEditId}
              onClick={openTransform}
            >
              ✥ Transform
            </button>
            <button
              title="Mirror (M): mirror the selected body across a plane"
              disabled={!transformTarget || !!editingSketch || picking}
              onClick={openMirror}
            >
              ⇋ Mirror
            </button>
          </div>
          {editingSketch && (
            <div className="sketch-toolbar">
              {SKETCH_TOOLS.map((t) => (
                <button
                  key={t.tool}
                  className={sketchTool === t.tool ? "active" : ""}
                  title={t.title}
                  onClick={() => setSketchTool(t.tool)}
                >
                  {t.label}
                </button>
              ))}
              <button
                title="Dimension (D): a line (length), circle (radius), or two lines (angle) — pick one if none selected"
                className={dimPending ? "active" : ""}
                onClick={startDimension}
              >
                ↔
              </button>
              <div className="sketch-toolbar-sep" />
              <button
                title="Parallel (Shift+P) — select two lines"
                disabled={!twoSelectedLines}
                onClick={() =>
                  twoSelectedLines &&
                  addGeoConstraint("parallel", twoSelectedLines[0].id, twoSelectedLines[1].id)
                }
              >
                <ParallelIcon />
              </button>
              <button
                title="Perpendicular (N) — select two lines"
                disabled={!twoSelectedLines}
                onClick={() =>
                  twoSelectedLines &&
                  addGeoConstraint("perpendicular", twoSelectedLines[0].id, twoSelectedLines[1].id)
                }
              >
                ⊥
              </button>
              <button
                title="Equal (=) — select two lines (equal length) or two circles (equal radius)"
                disabled={!twoSelectedLines && !twoSelectedCircles}
                onClick={() => {
                  const pair = twoSelectedLines ?? twoSelectedCircles;
                  if (pair) addGeoConstraint("equal", pair[0].id, pair[1].id);
                }}
              >
                ＝
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
                <ConstructionIcon />
              </button>
              {sketchTool === "polygon" && (
                <label className="poly-sides" title="Polygon sides">
                  <span>n</span>
                  <input
                    type="number"
                    min={3}
                    max={24}
                    value={polygonSides}
                    onChange={(e) =>
                      setPolygonSides(Math.max(3, Math.min(24, Number(e.target.value) || 3)))
                    }
                  />
                </label>
              )}
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
              <input
                autoFocus
                value={dimInput.value}
                onChange={(e) => setDimInput((d) => (d ? { ...d, value: e.target.value } : d))}
                onKeyDown={(e) => {
                  if (e.key === "Enter") applyDimension();
                  else if (e.key === "Escape") setDimInput(null);
                }}
              />
              <button onClick={applyDimension}>Set</button>
              <button className="ghost" onClick={() => setDimInput(null)}>
                ✕
              </button>
            </DraggableDialog>
          )}
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
          <div className="view-controls">
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
                  {pickPurpose === "plane"
                    ? "Select a plane or planar face to offset the new plane from"
                    : "Select a plane or planar face for the sketch"}
                </span>
                <button onClick={() => setPicking(false)}>Cancel (Esc)</button>
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
          className="extrude-dialog mirror-dialog"
          style={{ left: "50%", top: 70 }}
          baseTransform="translateX(-50%)"
        >
          <div className="ed-title" data-drag-handle>Mirror across plane</div>
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
          {mirrorDialog.plane === "face" && (
            <button
              className={"ed-pick-btn" + (pickingMirrorFace ? " active" : "")}
              onClick={() => setPickingMirrorFace((v) => !v)}
            >
              {pickingMirrorFace
                ? "Click a planar face…"
                : mirrorDialog.faceRef
                  ? `Face on ${doc.features.find((f) => f.id === mirrorDialog.faceRef!.featureId)?.name ?? "body"}`
                  : "Select a face"}
            </button>
          )}
          <div className="mirror-actions">
            <button onClick={createMirror} disabled={mirrorDialog.plane === "face" && !mirrorDialog.faceRef}>
              Create
            </button>
            <button className="ghost" onClick={closeMirror}>Cancel</button>
          </div>
        </DraggableDialog>
      )}
    </div>
  );
}
