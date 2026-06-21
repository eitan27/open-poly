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
  addDressUp,
  addExtrude,
  addImport,
  addLoft,
  addMirror,
  addPlane,
  addRevolve,
  addSketch,
  addSweep,
  addSketchEntities,
  addTransform,
  addVariable,
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
} from "../document/document";
import { detectSketchRegions } from "../document/regions";
import {
  deriveFaceFrame,
  planeRefLabel,
  type SketchPlaneId,
  type SketchPlaneRef,
} from "../document/planes";
import type { Document, ExtrudeProfile, Feature, PrimitiveFeature } from "../document/types";
import type { MeshedFaces, ShapeMeshPayload } from "../kernel/types";
import type { Selection, ViewName } from "../viewport/Viewport";
import {
  expandEntities,
  type Operation,
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
 *  `waitForRegen`: the merged per-feature error map (resolve + kernel) and the
 *  ids of the bodies that built. `timedOut` if regen didn't settle in time. */
export interface RegenSettle {
  errors: Record<string, string>;
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
  return { kind: "bodyFace", featureId: spec.bodyId, faceId: fg.faceId, faceName: spec.faceName, center: fg.center };
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
        const r = addExtrude(doc, profile, {
          distance: op.distance,
          flip: op.flip,
          extent: op.extent,
          mode: op.mode,
          targetId: op.targetId,
        });
        next = op.name ? renameFeature(r.doc, r.id, op.name) : r.doc;
        createdId = r.id;
        break;
      }
      case "addRevolve": {
        // Validate the region (so the agent gets a clear error, not a kernel
        // failure) and the axis line, both in the same sketch.
        const prof = resolveProfile(ctx, op.profile);
        if (prof.kind !== "sketchRegion") throw new OpError("invalid_op", "revolve profile must be a sketch region.");
        const axisSketch = requireFeature(doc, op.axis.sketchId);
        if (axisSketch.type !== "sketch") throw new OpError("not_found", `Axis "${op.axis.sketchId}" is not a sketch.`);
        const axisEnt = axisSketch.entities.find((e) => e.id === op.axis.entityId);
        if (!axisEnt) throw new OpError("not_found", `No entity "${op.axis.entityId}" in sketch "${op.axis.sketchId}".`);
        if (axisEnt.type !== "line") throw new OpError("invalid_op", "revolve axis must be a line entity.");
        const r = addRevolve(doc, { sketchId: prof.sketchId, regionId: prof.regionId }, op.axis, op.angle);
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
      case "addPlane": {
        const base = resolvePlaneRef(ctx, op.base);
        const r = addPlane(doc, base, op.offset);
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
        const r = addDressUp(doc, op.kind, op.targetId, op.edges, op.size);
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
    }

    ctx.setDoc(next);
    // Wait for the worker to regenerate, then report what actually happened —
    // resolve (expression/reference) AND kernel (build) errors, merged.
    const { errors } = await ctx.waitForRegen();
    // If the feature this op created failed to build, surface it as the op's
    // own failure so the agent self-corrects instead of building on nothing.
    if (createdId && errors[createdId]) {
      return { ok: false, createdId, error: errors[createdId], errorKind: "kernel_error", featureErrors: errors };
    }
    const featureErrors = Object.keys(errors).length ? errors : undefined;
    return { ok: true, createdId, featureErrors };
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
    !!f && (f.type === "primitive" || f.type === "extrude" || f.type === "boolean" || f.type === "transform" || f.type === "mirror" || f.type === "revolve" || f.type === "sweep" || f.type === "loft" || f.type === "import");
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
      return {
        id: s.id,
        name: s.name,
        plane: planeRefLabel(s.plane),
        entityCount: s.entities.length,
        entities: s.entities.map((e) => ({
          id: e.id,
          type: e.type,
          ...(e.construction ? { construction: true } : {}),
        })),
        regions: detectSketchRegions(s.entities).map((r) => ({ id: r.id, area: r.area })),
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

  return {
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

/** Capture the viewport as a PNG data URL, optionally snapping to a view first.
 *  Returns null if the viewport isn't mounted. */
export function screenshot(ctx: AgentContext, opts?: { view?: ViewName }): string | null {
  const vp = ctx.getViewport();
  if (!vp) return null;
  if (opts?.view) vp.setView(opts.view);
  return vp.capturePNG();
}
