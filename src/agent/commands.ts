// The command layer: apply a typed Operation to the live document and read the
// document / a scene summary / the selection / a screenshot. Vendor-neutral —
// no MCP, no networking. `applyOperation` routes every mutation through the
// document.ts pure helpers and the host's `setDoc` (the undo setter), so the
// human can Cmd-Z anything the agent does — the agent is "just another input
// device".
//
// L0 scope: synchronous document mutations + reads, driven from the dev console
// via `window.__openpoly` (see useAgentBridge). Awaiting kernel regen before
// resolving a mutating op (so the agent knows it succeeded) lands in L3; for now
// we surface the synchronous resolve errors (bad expressions, missing refs).
import {
  addBoolean,
  addDerivedOp,
  addDressUp,
  addExtrude,
  addImport,
  addLoft,
  addMirror,
  addPattern,
  addPlane,
  addRevolve,
  addSketch,
  addSweep,
  addSketchEntities,
  addTransform,
  addVariable,
  genId,
  makeFeature,
  removeFeature,
  renameFeature,
  resolveDocument,
  setFeatureColor,
  setFeatureHidden,
  setFeatureOpacity,
  setRollbackIndex,
  updateParam,
  updateVariable,
  validateVariableNames,
} from "../document/document";
import { detectSketchRegions } from "../document/regions";
import { applyDerived } from "../document/derived";
import {
  deriveFaceFrame,
  planeRefLabel,
  type SketchPlaneId,
  type SketchPlaneRef,
} from "../document/planes";
import type { Document, EdgeRef, ExtrudeProfile, Feature, PatternAxisRef, PatternDirRef, PointRef, PrimitiveFeature, RevolveAxis, Variable, Vec2 } from "../document/types";
import { listMeta } from "../storage/db";
import type { MeshedEdges, MeshedFaces, ShapeMeshPayload } from "../kernel/types";
import type { Selection, ViewName } from "../viewport/Viewport";
import {
  expandEntities,
  type Operation,
  type DocumentListing,
  type OpResult,
  type PlaneRefSpec,
  type ProfileSpec,
  type SceneSummary,
} from "./operations";

/** A regenerated body the agent can read: its id + tessellation (geometry,
 *  named faces/edges). Appearance is derived from the producing feature. */
export interface AgentMesh {
  id: string;
  mesh: ShapeMeshPayload;
}

/** The outcome of a kernel regeneration, delivered to whoever awaited it via
 *  `waitForRegen`: the merged per-feature error map (resolve + kernel), the
 *  non-fatal per-feature warnings (a topological reference re-matched after an
 *  upstream edit, or partially lost), and the ids of the bodies that built.
 *  `timedOut` if regen didn't settle in time. */
export interface RegenSettle {
  errors: Record<string, string>;
  warnings?: Record<string, string>;
  bodyIds?: string[];
  timedOut?: boolean;
}

/** Everything the command layer needs from the live app, exposed via getters so
 *  it always reads the latest committed state (never a stale closure) — mirrors
 *  how Viewport uses refs. Built by useAgentBridge. */
export interface AgentContext {
  getDoc(): Document;
  /** Apply a new document through the undo setter (each agent op = one step). */
  setDoc(next: Document): void;
  getSelection(): Selection[];
  setSelection(sel: Selection[]): void;
  /** The latest regenerated bodies — fed synchronously when regen settles, so a
   *  read right after an awaited mutation sees fresh geometry (not stale React
   *  state). */
  getMeshes(): AgentMesh[];
  /** Per-feature resolve + kernel errors (merged), kept fresh on each regen. */
  getErrors(): Record<string, string>;
  /** Resolve after the next kernel regeneration settles — so a mutating op can
   *  report success/errors and a follow-up read/screenshot sees the result. */
  waitForRegen(): Promise<RegenSettle>;
  /** The viewport API (camera + capturePNG), or null before it mounts. */
  getViewport(): {
    setView(name: ViewName): void;
    capturePNG(): string | null;
  } | null;
  /** Multi-document workspace (Phase 8.7 M4). All mutations run through the
   *  App's switch flow (flush → load → adopt) — NEVER a raw setDoc — so
   *  autosave/undo/meshes stay consistent across the boundary. */
  documents: {
    /** Active document identity (id + display name). */
    info(): { id: string; name: string };
    open(id: string): Promise<void>;
    /** Create + open an empty document (name auto-deduped "Untitled N"). */
    create(): Promise<void>;
    /** Duplicate `id` and open the copy. */
    duplicate(id: string): Promise<void>;
    rename(id: string, name: string): Promise<void>;
  };
}

class OpError extends Error {
  constructor(public kind: OpResult["errorKind"], message: string) {
    super(message);
  }
}

const DATUM_ID: Record<"top" | "front" | "right", SketchPlaneId> = {
  top: "plane-top",
  front: "plane-front",
  right: "plane-right",
};

// --- Geometry helpers (read tessellation back for face refs / bboxes) -----

interface FaceGeom {
  faceId: number;
  center: [number, number, number];
  normal: [number, number, number];
}

/** Centroid + averaged normal of a named face, from its tessellated group. */
function faceGeomByName(faces: MeshedFaces, name: string): FaceGeom | null {
  const g = faces.faceGroups?.find((fg) => fg.name === name);
  if (!g) return null;
  const { triangles, vertices, normals } = faces;
  let cx = 0, cy = 0, cz = 0, nx = 0, ny = 0, nz = 0, n = 0;
  for (let k = g.start; k < g.start + g.count; k++) {
    const vi = triangles[k] * 3;
    cx += vertices[vi]; cy += vertices[vi + 1]; cz += vertices[vi + 2];
    if (normals) { nx += normals[vi]; ny += normals[vi + 1]; nz += normals[vi + 2]; }
    n++;
  }
  if (!n) return null;
  const center: [number, number, number] = [cx / n, cy / n, cz / n];
  const len = Math.hypot(nx, ny, nz);
  const normal: [number, number, number] = len > 1e-9 ? [nx / len, ny / len, nz / len] : [0, 0, 1];
  return { faceId: g.faceId, center, normal };
}

/** Geometric fingerprint of a named edge from its tessellated polyline — the
 *  bounding-box centre (robust for closed edges, where an endpoint average
 *  degenerates to the seam) + arc length. Stored with a dress-up alongside the
 *  persistent name so the kernel can re-match the edge if an upstream edit
 *  renames it (mirrors `edgeFingerprint` in App.tsx for UI picks). */
function edgeFingerprintByName(edges: MeshedEdges, name: string): EdgeRef {
  const g = edges.edgeGroups?.find((eg) => eg.name === name);
  if (!g || g.count === 0) return { name };
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
  return { name, mid: [(minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2], length };
}

function bbox(faces: MeshedFaces): { min: [number, number, number]; max: [number, number, number] } | undefined {
  const v = faces.vertices;
  if (v.length === 0) return undefined;
  let m0 = Infinity, m1 = Infinity, m2 = Infinity, x0 = -Infinity, x1 = -Infinity, x2 = -Infinity;
  for (let i = 0; i < v.length; i += 3) {
    if (v[i] < m0) m0 = v[i]; if (v[i] > x0) x0 = v[i];
    if (v[i + 1] < m1) m1 = v[i + 1]; if (v[i + 1] > x1) x1 = v[i + 1];
    if (v[i + 2] < m2) m2 = v[i + 2]; if (v[i + 2] > x2) x2 = v[i + 2];
  }
  return { min: [m0, m1, m2], max: [x0, x1, x2] };
}

function bboxCenter(faces: MeshedFaces): [number, number, number] {
  const b = bbox(faces);
  if (!b) return [0, 0, 0];
  return [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2];
}

// --- Reference resolution -------------------------------------------------

function resolvePlaneRef(ctx: AgentContext, spec: PlaneRefSpec): SketchPlaneRef {
  if ("datum" in spec) return { kind: "datum", id: DATUM_ID[spec.datum] };
  if ("planeId" in spec) return { kind: "plane", planeId: spec.planeId };
  // A body face → derive a coordinate frame from its centroid + normal.
  const mesh = ctx.getMeshes().find((m) => m.id === spec.bodyId);
  if (!mesh) throw new OpError("not_found", `No body "${spec.bodyId}" (it may not be regenerated yet).`);
  const fg = faceGeomByName(mesh.mesh.faces, spec.faceName);
  if (!fg) throw new OpError("not_found", `Face "${spec.faceName}" not found on body "${spec.bodyId}".`);
  return { kind: "face", featureId: spec.bodyId, frame: deriveFaceFrame(fg.center, fg.normal) };
}

function resolveProfile(ctx: AgentContext, spec: ProfileSpec): ExtrudeProfile {
  if ("textId" in spec) {
    const sketch = ctx.getDoc().features.find((f) => f.id === spec.sketchId);
    if (sketch?.type !== "sketch") throw new OpError("not_found", `No sketch "${spec.sketchId}".`);
    const ent = sketch.entities.find((e) => e.id === spec.textId);
    if (!ent) throw new OpError("not_found", `No entity "${spec.textId}" in sketch "${spec.sketchId}".`);
    if (ent.type !== "text") throw new OpError("invalid_op", `Entity "${spec.textId}" is not text.`);
    return { kind: "sketchText", sketchId: spec.sketchId, textId: spec.textId };
  }
  if ("sketchId" in spec) {
    const sketch = ctx.getDoc().features.find((f) => f.id === spec.sketchId);
    if (sketch?.type !== "sketch") throw new OpError("not_found", `No sketch "${spec.sketchId}".`);
    const regions = detectSketchRegions(sketch.entities);
    if (regions.length === 0) throw new OpError("invalid_op", `Sketch "${spec.sketchId}" has no closed region to extrude.`);
    let regionId = spec.regionId;
    if (regionId === undefined) {
      if (regions.length > 1) {
        throw new OpError("invalid_op", `Sketch "${spec.sketchId}" has ${regions.length} regions; specify regionId (${regions.map((r) => r.id).join(", ")}).`);
      }
      regionId = regions[0].id;
    } else if (!regions.some((r) => r.id === regionId)) {
      throw new OpError("not_found", `Region "${regionId}" not in sketch "${spec.sketchId}".`);
    }
    return { kind: "sketchRegion", sketchId: spec.sketchId, regionId };
  }
  const mesh = ctx.getMeshes().find((m) => m.id === spec.bodyId);
  if (!mesh) throw new OpError("not_found", `No body "${spec.bodyId}".`);
  const fg = faceGeomByName(mesh.mesh.faces, spec.faceName);
  if (!fg) throw new OpError("not_found", `Face "${spec.faceName}" not found on body "${spec.bodyId}".`);
  // center + normal are the geometric fingerprint the kernel falls back to if
  // an upstream edit renames the face.
  return { kind: "bodyFace", featureId: spec.bodyId, faceId: fg.faceId, faceName: spec.faceName, center: fg.center, normal: fg.normal };
}

/** Resolve an "up to face" target (body id + persistent face name) to the
 *  reference the document model expects: the source body + name + centroid
 *  (read back from the tessellation, like a body-face profile). */
function resolveUpToFace(
  ctx: AgentContext,
  spec: { bodyId: string; faceName: string },
): { featureId: string; faceName: string; center: [number, number, number]; normal?: [number, number, number] } {
  const mesh = ctx.getMeshes().find((m) => m.id === spec.bodyId);
  if (!mesh) throw new OpError("not_found", `No body "${spec.bodyId}" for the up-to-face target.`);
  const fg = faceGeomByName(mesh.mesh.faces, spec.faceName);
  if (!fg) throw new OpError("not_found", `Face "${spec.faceName}" not found on body "${spec.bodyId}".`);
  return { featureId: spec.bodyId, faceName: spec.faceName, center: fg.center, normal: fg.normal };
}

function requireFeature(doc: Document, id: string): Feature {
  const f = doc.features.find((x) => x.id === id);
  if (!f) throw new OpError("not_found", `No feature "${id}".`);
  return f;
}

// --- Apply ----------------------------------------------------------------

/** Apply one Operation. Resolves to a structured result; throws nothing (errors
 *  are returned in `OpResult`). Mutations go through `ctx.setDoc` (undoable) and
 *  then **await the kernel regen** so the result reflects settled geometry (and a
 *  follow-up read/screenshot sees it). */
export async function applyOperation(ctx: AgentContext, op: Operation): Promise<OpResult> {
  try {
    const doc = ctx.getDoc();
    let next: Document;
    let createdId: string | undefined;

    switch (op.op) {
      case "addPrimitive": {
        // makeFeature seeds the kind's default params; apply overrides + name.
        let feature = makeFeature(op.kind, doc.features) as PrimitiveFeature;
        if (op.params) feature = { ...feature, params: { ...feature.params, ...op.params } };
        if (op.name) feature = { ...feature, name: op.name };
        const features = [...doc.features];
        features.splice(doc.rollbackIndex, 0, feature);
        next = { ...doc, features, rollbackIndex: doc.rollbackIndex + 1 };
        createdId = feature.id;
        break;
      }
      case "addSketch": {
        const plane = resolvePlaneRef(ctx, op.plane);
        const r = addSketch(doc, plane);
        let d = addSketchEntities(r.doc, r.id, expandEntities(op.entities));
        if (op.name) d = renameFeature(d, r.id, op.name);
        next = d;
        createdId = r.id;
        break;
      }
      case "addExtrude": {
        const profile = resolveProfile(ctx, op.profile);
        if (op.extent === "upToFace" && !op.upTo) {
          throw new OpError("invalid_op", 'extent "upToFace" requires `upTo` (the target face).');
        }
        const upTo = op.extent === "upToFace" && op.upTo ? resolveUpToFace(ctx, op.upTo) : undefined;
        const r = addExtrude(doc, profile, {
          distance: op.distance,
          flip: op.flip,
          extent: op.extent,
          mode: op.mode,
          targetId: op.targetId,
          upTo,
        });
        next = op.name ? renameFeature(r.doc, r.id, op.name) : r.doc;
        createdId = r.id;
        break;
      }
      case "addRevolve": {
        // Validate the region (so the agent gets a clear error, not a kernel
        // failure). The axis is one of: a sketch line, a plane, or a body face.
        const prof = resolveProfile(ctx, op.profile);
        if (prof.kind !== "sketchRegion") throw new OpError("invalid_op", "revolve profile must be a sketch region.");
        let axis: RevolveAxis;
        // Bind to a const so the `in`-narrowing survives the .find() closures.
        const ax = op.axis;
        if ("entityId" in ax) {
          const axisSketch = requireFeature(doc, ax.sketchId);
          if (axisSketch.type !== "sketch") throw new OpError("not_found", `Axis "${ax.sketchId}" is not a sketch.`);
          const axisEnt = axisSketch.entities.find((e) => e.id === ax.entityId);
          if (!axisEnt) throw new OpError("not_found", `No entity "${ax.entityId}" in sketch "${ax.sketchId}".`);
          if (axisEnt.type !== "line") throw new OpError("invalid_op", "revolve axis must be a line entity.");
          axis = { sketchId: ax.sketchId, entityId: ax.entityId };
        } else if ("plane" in ax) {
          axis = { plane: resolvePlaneRef(ctx, ax.plane) };
        } else {
          const mesh = ctx.getMeshes().find((m) => m.id === ax.bodyId);
          if (!mesh) throw new OpError("not_found", `No body "${ax.bodyId}" for the revolve axis.`);
          const fg = faceGeomByName(mesh.mesh.faces, ax.faceName);
          if (!fg) throw new OpError("not_found", `Face "${ax.faceName}" not found on body "${ax.bodyId}".`);
          axis = { face: { featureId: ax.bodyId, faceName: ax.faceName, faceId: fg.faceId, center: fg.center, normal: fg.normal } };
        }
        const r = addRevolve(doc, { sketchId: prof.sketchId, regionId: prof.regionId }, axis, op.angle, op.symmetric);
        next = op.name ? renameFeature(r.doc, r.id, op.name) : r.doc;
        createdId = r.id;
        break;
      }
      case "addMirror": {
        requireFeature(doc, op.targetId);
        const plane = resolvePlaneRef(ctx, op.plane);
        const r = addMirror(doc, op.targetId, plane);
        next = op.name ? renameFeature(r.doc, r.id, op.name) : r.doc;
        createdId = r.id;
        break;
      }
      case "addSweep": {
        const prof = resolveProfile(ctx, op.profile);
        if (prof.kind !== "sketchRegion") throw new OpError("invalid_op", "sweep profile must be a sketch region.");
        const pathSketch = requireFeature(doc, op.path.sketchId);
        if (pathSketch.type !== "sketch") throw new OpError("not_found", `Path "${op.path.sketchId}" is not a sketch.`);
        const pathEnt = pathSketch.entities.find((e) => e.id === op.path.entityId);
        if (!pathEnt) throw new OpError("not_found", `No entity "${op.path.entityId}" in sketch "${op.path.sketchId}".`);
        if (pathEnt.type !== "line" && pathEnt.type !== "arc" && pathEnt.type !== "spline") {
          throw new OpError("invalid_op", "sweep path must be a line, arc, or spline entity.");
        }
        const r = addSweep(doc, { sketchId: prof.sketchId, regionId: prof.regionId }, op.path);
        next = op.name ? renameFeature(r.doc, r.id, op.name) : r.doc;
        createdId = r.id;
        break;
      }
      case "addLoft": {
        const sections = op.profiles.map((p) => {
          const rp = resolveProfile(ctx, p);
          if (rp.kind !== "sketchRegion") throw new OpError("invalid_op", "loft sections must be sketch regions.");
          return { sketchId: rp.sketchId, regionId: rp.regionId };
        });
        const r = addLoft(doc, sections);
        next = op.name ? renameFeature(r.doc, r.id, op.name) : r.doc;
        createdId = r.id;
        break;
      }
      case "addOffset": {
        const sketch = requireFeature(doc, op.sketchId);
        if (sketch.type !== "sketch") throw new OpError("invalid_op", `"${op.sketchId}" is not a sketch.`);
        for (const id of op.sourceIds) {
          const e = sketch.entities.find((x) => x.id === id);
          if (!e) throw new OpError("not_found", `No entity "${id}" in sketch "${op.sketchId}".`);
          if (e.type !== "line" && e.type !== "arc" && e.type !== "circle") {
            throw new OpError("invalid_op", `Offset sources must be lines/arcs/circles; "${id}" is a ${e.type}.`);
          }
        }
        const opId = genId();
        next = addDerivedOp(doc, op.sketchId, { id: opId, kind: "offset", sourceIds: op.sourceIds, distance: op.distance, ...(op.construction ? { construction: true } : {}) });
        createdId = opId;
        break;
      }
      case "addSketchMirror": {
        const sketch = requireFeature(doc, op.sketchId);
        if (sketch.type !== "sketch") throw new OpError("invalid_op", `"${op.sketchId}" is not a sketch.`);
        const axis = sketch.entities.find((e) => e.id === op.axisId);
        if (!axis) throw new OpError("not_found", `No entity "${op.axisId}" in sketch "${op.sketchId}".`);
        if (axis.type !== "line") throw new OpError("invalid_op", "the mirror axis must be a line entity.");
        for (const id of op.sourceIds) {
          if (!sketch.entities.some((x) => x.id === id)) throw new OpError("not_found", `No entity "${id}" in sketch "${op.sketchId}".`);
        }
        const opId = genId();
        next = addDerivedOp(doc, op.sketchId, { id: opId, kind: "mirror", axisId: op.axisId, sourceIds: op.sourceIds });
        createdId = opId;
        break;
      }
      case "addSketchPattern": {
        const sketch = requireFeature(doc, op.sketchId);
        if (sketch.type !== "sketch") throw new OpError("invalid_op", `"${op.sketchId}" is not a sketch.`);
        for (const id of op.sourceIds) {
          const e = sketch.entities.find((x) => x.id === id);
          if (!e) throw new OpError("not_found", `No entity "${id}" in sketch "${op.sketchId}".`);
          if (e.derivedFrom) throw new OpError("invalid_op", `"${id}" is derived geometry — pattern its source instead.`);
        }
        const opId = genId();
        if (op.kind === "linear") {
          if (op.dx === undefined && op.dy === undefined) {
            throw new OpError("invalid_op", "a linear sketch pattern needs a step (dx and/or dy).");
          }
          next = addDerivedOp(doc, op.sketchId, {
            id: opId, kind: "linearPattern", sourceIds: op.sourceIds,
            count: String(op.count), dx: String(op.dx ?? 0), dy: String(op.dy ?? 0),
          });
        } else {
          if (!op.center) throw new OpError("invalid_op", "a circular sketch pattern needs a center.");
          let center: PointRef | { at: Vec2 };
          if (Array.isArray(op.center)) {
            center = { at: op.center };
          } else {
            const ce = sketch.entities.find((x) => x.id === (op.center as { entityId: string }).entityId);
            if (!ce) throw new OpError("not_found", `No entity "${(op.center as { entityId: string }).entityId}" in sketch "${op.sketchId}".`);
            if (ce.derivedFrom) throw new OpError("invalid_op", "the center can't be derived geometry.");
            center = { entity: ce.id, at: (op.center as { at?: "a" | "b" | "c" }).at ?? "c" };
          }
          next = addDerivedOp(doc, op.sketchId, {
            id: opId, kind: "circularPattern", sourceIds: op.sourceIds, center,
            count: String(op.count), angle: String(op.angle ?? 360), symmetric: op.symmetric ?? false,
          });
        }
        createdId = opId;
        break;
      }
      case "addPattern": {
        requireFeature(doc, op.targetId);
        const dirRef = (d: { world: "x" | "y" | "z" } | { sketchId: string; entityId: string }): PatternDirRef => {
          if ("world" in d) return d;
          const sk = requireFeature(doc, d.sketchId);
          if (sk.type !== "sketch") throw new OpError("not_found", `"${d.sketchId}" is not a sketch.`);
          const e = sk.entities.find((x) => x.id === d.entityId);
          if (!e) throw new OpError("not_found", `No entity "${d.entityId}" in sketch "${d.sketchId}".`);
          if (e.type !== "line") throw new OpError("invalid_op", "a pattern direction/axis entity must be a line.");
          return { sketchId: d.sketchId, entityId: d.entityId };
        };
        let r;
        if (op.kind === "linear") {
          if (!op.dir1) throw new OpError("invalid_op", "a linear pattern needs dir1.");
          if (op.count1 === undefined || op.spacing1 === undefined) {
            throw new OpError("invalid_op", "a linear pattern needs count1 and spacing1.");
          }
          if (op.dir2 && (op.count2 === undefined || op.spacing2 === undefined)) {
            throw new OpError("invalid_op", "a second direction needs count2 and spacing2.");
          }
          r = addPattern(doc, op.targetId, {
            kind: "linear",
            dir1: dirRef(op.dir1), count1: String(op.count1), spacing1: String(op.spacing1), flip1: op.flip1 ?? false,
            ...(op.dir2
              ? { dir2: dirRef(op.dir2), count2: String(op.count2), spacing2: String(op.spacing2), flip2: op.flip2 ?? false }
              : {}),
          });
        } else {
          if (!op.axis) throw new OpError("invalid_op", "a circular pattern needs an axis.");
          if (op.count === undefined) throw new OpError("invalid_op", "a circular pattern needs a count.");
          let axis: PatternAxisRef;
          if ("bodyId" in op.axis) {
            const mesh = ctx.getMeshes().find((m) => m.id === (op.axis as { bodyId: string }).bodyId);
            if (!mesh) throw new OpError("not_found", `No body "${(op.axis as { bodyId: string }).bodyId}" for the pattern axis.`);
            const fg = faceGeomByName(mesh.mesh.faces, (op.axis as { faceName: string }).faceName);
            if (!fg) throw new OpError("not_found", `Face "${(op.axis as { faceName: string }).faceName}" not found on body "${(op.axis as { bodyId: string }).bodyId}".`);
            axis = { face: { featureId: (op.axis as { bodyId: string }).bodyId, faceName: (op.axis as { faceName: string }).faceName, faceId: fg.faceId, center: fg.center, normal: fg.normal } };
          } else {
            axis = dirRef(op.axis);
          }
          r = addPattern(doc, op.targetId, {
            kind: "circular",
            axis, count: String(op.count), angle: String(op.angle ?? 360), symmetric: op.symmetric ?? false,
          });
        }
        next = op.name ? renameFeature(r.doc, r.id, op.name) : r.doc;
        createdId = r.id;
        break;
      }
      case "addPlane": {
        const method = op.method ?? "offset";
        let r;
        if (method === "through") {
          if (!op.points || op.points.length !== 3) {
            throw new OpError("invalid_op", "addPlane 'through' needs exactly 3 points.");
          }
          // `base` is unused for through-geometry; pass a datum to satisfy the shape.
          r = addPlane(doc, { method, base: { kind: "datum", id: "plane-top" }, points: op.points });
        } else {
          if (!op.base) throw new OpError("invalid_op", `addPlane '${method}' needs a base.`);
          const base = resolvePlaneRef(ctx, op.base);
          if (method === "midplane") {
            if (!op.refB) throw new OpError("invalid_op", "addPlane 'midplane' needs a second reference (refB).");
            r = addPlane(doc, { method, base, refB: resolvePlaneRef(ctx, op.refB) });
          } else if (method === "angle") {
            r = addPlane(doc, { method, base, angleAxis: op.angleAxis ?? "u", angle: op.angle ?? "30" });
          } else {
            r = addPlane(doc, { method: "offset", base, offset: op.offset ?? "20" });
          }
        }
        next = op.name ? renameFeature(r.doc, r.id, op.name) : r.doc;
        createdId = r.id;
        break;
      }
      case "transform": {
        requireFeature(doc, op.targetId);
        const mesh = ctx.getMeshes().find((m) => m.id === op.targetId);
        const pivot = mesh ? bboxCenter(mesh.mesh.faces) : ([0, 0, 0] as [number, number, number]);
        const r = addTransform(doc, op.targetId, pivot, {
          tx: op.tx, ty: op.ty, tz: op.tz, angle: op.angle, axis: op.axis, copy: op.copy,
        });
        next = r.doc;
        createdId = r.id;
        break;
      }
      case "boolean": {
        for (const id of op.operands) requireFeature(doc, id);
        const r = addBoolean(doc, op.kind, op.operands);
        next = r.doc;
        createdId = r.id;
        break;
      }
      case "dressUp": {
        requireFeature(doc, op.targetId);
        // Bake geometric fingerprints for the named edges (from the target's
        // tessellation) so the kernel can re-match them if a later upstream
        // edit renames the edges. A name the mesh doesn't know stays a bare
        // name-only ref — the kernel will report it properly.
        const mesh = ctx.getMeshes().find((m) => m.id === op.targetId);
        const edgeRefs = mesh ? op.edges.map((nm) => edgeFingerprintByName(mesh.mesh.edges, nm)) : undefined;
        const r = addDressUp(doc, op.kind, op.targetId, op.edges, op.size, edgeRefs);
        next = r.doc;
        createdId = r.id;
        break;
      }
      case "setParam": {
        requireFeature(doc, op.featureId);
        next = updateParam(doc, op.featureId, op.name, op.value);
        break;
      }
      case "setVariable": {
        const existing = doc.variables.find((v) => v.name === op.name);
        if (existing) {
          next = updateVariable(doc, existing.id, "expression", op.expression);
          createdId = existing.id;
        } else {
          // Validate the new name up front (letters-only, non-reserved, unique)
          // so the agent gets a clear error rather than a variable that's
          // silently dropped from scope at regen.
          const candidate: Variable[] = [...doc.variables, { id: "__candidate__", name: op.name, expression: op.expression }];
          const nameError = validateVariableNames(candidate)["__candidate__"];
          if (nameError) {
            throw new OpError(
              "invalid_op",
              `Invalid variable name "${op.name}": ${nameError}. Variable names must be letters only — no digits, spaces, underscores, or reserved math names (pi, sin, …).`,
            );
          }
          const r = addVariable(doc);
          next = updateVariable(updateVariable(r.doc, r.id, "name", op.name), r.id, "expression", op.expression);
          createdId = r.id;
        }
        break;
      }
      case "setAppearance": {
        requireFeature(doc, op.featureId);
        let d = doc;
        if (op.color !== undefined) d = setFeatureColor(d, op.featureId, op.color);
        if (op.opacity !== undefined) d = setFeatureOpacity(d, op.featureId, op.opacity);
        if (op.hidden !== undefined) d = setFeatureHidden(d, op.featureId, op.hidden);
        next = d;
        break;
      }
      case "rename": {
        requireFeature(doc, op.featureId);
        next = renameFeature(doc, op.featureId, op.name);
        break;
      }
      case "delete": {
        requireFeature(doc, op.featureId);
        next = removeFeature(doc, op.featureId);
        break;
      }
      case "setRollback": {
        next = setRollbackIndex(doc, op.index);
        break;
      }
      case "select": {
        ctx.setSelection(op.refs as Selection[]);
        return { ok: true };
      }
      case "importStep": {
        const r = addImport(doc, op.source, op.name);
        next = r.doc;
        createdId = r.id;
        break;
      }
      // --- Multi-document ops: these switch/mutate the WORKSPACE, not `doc`,
      // so they bypass the shared setDoc tail and settle their own regen.
      case "openDocument": {
        if (op.id === ctx.documents.info().id) return { ok: true, createdId: op.id };
        if (!(await listMeta()).some((m) => m.id === op.id)) {
          throw new OpError("not_found", `No document "${op.id}" — get ids from list_documents.`);
        }
        await ctx.documents.open(op.id);
        const { errors, warnings } = await ctx.waitForRegen();
        return {
          ok: true,
          createdId: op.id,
          featureErrors: Object.keys(errors).length ? errors : undefined,
          warnings: warnings && Object.keys(warnings).length ? warnings : undefined,
        };
      }
      case "newDocument": {
        await ctx.documents.create();
        const id = ctx.documents.info().id;
        if (op.name) await ctx.documents.rename(id, op.name);
        await ctx.waitForRegen(); // empty doc — settles immediately
        return { ok: true, createdId: id };
      }
      case "renameDocument": {
        const id = op.id ?? ctx.documents.info().id;
        // The ACTIVE doc is exempt from the existence check: a brand-new doc
        // may not have autosaved yet (600 ms debounce), and its rename lands
        // through the app state either way.
        if (id !== ctx.documents.info().id && !(await listMeta()).some((m) => m.id === id)) {
          throw new OpError("not_found", `No document "${id}".`);
        }
        await ctx.documents.rename(id, op.name);
        return { ok: true, createdId: id };
      }
      case "duplicateDocument": {
        const id = op.id ?? ctx.documents.info().id;
        // Active doc exempt (see renameDocument) — App flushes it before copying.
        if (id !== ctx.documents.info().id && !(await listMeta()).some((m) => m.id === id)) {
          throw new OpError("not_found", `No document "${id}".`);
        }
        await ctx.documents.duplicate(id);
        const { errors, warnings } = await ctx.waitForRegen();
        return {
          ok: true,
          createdId: ctx.documents.info().id, // the copy is now active
          featureErrors: Object.keys(errors).length ? errors : undefined,
          warnings: warnings && Object.keys(warnings).length ? warnings : undefined,
        };
      }
    }

    ctx.setDoc(next);
    // Wait for the worker to regenerate, then report what actually happened —
    // resolve (expression/reference) AND kernel (build) errors, merged, plus
    // non-fatal warnings (topological references re-matched / partially lost
    // after this edit) so the agent can verify a re-match landed right.
    const { errors, warnings: regenWarnings } = await ctx.waitForRegen();
    const warnings = regenWarnings && Object.keys(regenWarnings).length ? regenWarnings : undefined;
    // If the feature this op created failed to build, surface it as the op's
    // own failure so the agent self-corrects instead of building on nothing.
    if (createdId && errors[createdId]) {
      return { ok: false, createdId, error: errors[createdId], errorKind: "kernel_error", featureErrors: errors, warnings };
    }
    const featureErrors = Object.keys(errors).length ? errors : undefined;
    return { ok: true, createdId, featureErrors, warnings };
  } catch (err) {
    if (err instanceof OpError) return { ok: false, error: err.message, errorKind: err.kind };
    return { ok: false, error: String((err as Error)?.message ?? err), errorKind: "invalid_op" };
  }
}

// --- Reads ----------------------------------------------------------------

export function getDocument(ctx: AgentContext): Document {
  return ctx.getDoc();
}

export function getSelection(ctx: AgentContext): Selection[] {
  return ctx.getSelection();
}

const uniqueNames = (groups?: { name?: string }[]): string[] =>
  groups ? [...new Set(groups.map((g) => g.name).filter((n): n is string => !!n))] : [];

/** Compact, LLM-first digest — the agent's primary planning input. Small and
 *  semantic (named faces/edges, region ids, variables), not raw geometry. */
export function getSceneSummary(ctx: AgentContext): SceneSummary {
  const doc = ctx.getDoc();
  const meshes = ctx.getMeshes();
  const errors = ctx.getErrors();
  const resolved = resolveDocument(doc);

  const featureById = new Map(doc.features.map((f) => [f.id, f]));
  // Bodies that own appearance carry a color; in-place modifiers inherit it.
  const hasColor = (f: Feature | undefined): f is Extract<Feature, { color: number }> =>
    !!f && (f.type === "primitive" || f.type === "extrude" || f.type === "boolean" || f.type === "transform" || f.type === "mirror" || f.type === "pattern" || f.type === "revolve" || f.type === "sweep" || f.type === "loft" || f.type === "import");
  const bodies: SceneSummary["bodies"] = meshes.map((m) => {
    const f = featureById.get(m.id);
    const mesh: ShapeMeshPayload = m.mesh;
    return {
      id: m.id,
      name: f?.name ?? m.id,
      kind: f ? (f.type === "primitive" ? f.kind : f.type) : "body",
      bbox: bbox(mesh.faces),
      color: hasColor(f) ? f.color : undefined,
      hidden: f && "hidden" in f ? f.hidden : undefined,
      faces: uniqueNames(mesh.faces.faceGroups),
      edges: uniqueNames(mesh.edges.edgeGroups),
    };
  });

  const sketches: SceneSummary["sketches"] = doc.features
    .filter((f) => f.type === "sketch")
    .map((f) => {
      const s = f as Extract<Feature, { type: "sketch" }>;
      // Apply derived geometry (offset/mirror) so the agent SEES the generated
      // edges + any region they close — otherwise it couldn't reference/extrude
      // them. (Project outputs are already stored on `entities`.)
      const ds = applyDerived(s, resolved.scope);
      return {
        id: s.id,
        name: s.name,
        plane: planeRefLabel(s.plane),
        entityCount: ds.entities.length,
        entities: ds.entities.map((e) => ({
          id: e.id,
          type: e.type,
          ...(e.construction ? { construction: true } : {}),
          ...(e.derivedFrom ? { derived: true } : {}),
        })),
        regions: detectSketchRegions(ds.entities).map((r) => ({ id: r.id, area: r.area })),
      };
    });

  const planes: SceneSummary["planes"] = doc.features
    .filter((f) => f.type === "plane")
    .map((f) => ({ id: f.id, name: f.name }));

  const variables: SceneSummary["variables"] = doc.variables.map((v) => ({
    name: v.name,
    expression: v.expression,
    value: resolved.scope[v.name],
  }));

  const docInfo = ctx.documents.info();
  return {
    documentId: docInfo.id,
    documentName: docInfo.name,
    bodies,
    sketches,
    planes,
    variables,
    rollbackIndex: doc.rollbackIndex,
    featureCount: doc.features.length,
    selection: ctx.getSelection(),
    errors,
  };
}

/** All stored documents' metadata (most-recently-edited first), with the
 *  active one flagged — the agent's entry point for "continue yesterday's X". */
export async function listDocuments(ctx: AgentContext): Promise<DocumentListing[]> {
  const activeId = ctx.documents.info().id;
  const metas = await listMeta();
  return metas.map((m) => ({
    id: m.id,
    name: m.name,
    updatedAt: m.updatedAt,
    featureCount: m.featureCount,
    partCount: m.partCount,
    active: m.id === activeId,
  }));
}

/** Capture the viewport as a PNG data URL, optionally snapping to a view first.
 *  Returns null if the viewport isn't mounted. */
export function screenshot(ctx: AgentContext, opts?: { view?: ViewName }): string | null {
  const vp = ctx.getViewport();
  if (!vp) return null;
  if (opts?.view) vp.setView(opts.view);
  return vp.capturePNG();
}
