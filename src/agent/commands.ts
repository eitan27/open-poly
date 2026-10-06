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
  addShell,
  addSketch,
  addSketchConstraints,
  addSweep,
  addSketchEntities,
  addTransform,
  addVariable,
  genId,
  removeSketchConstraint,
  setSketchEntities,
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
import { expandPickToChains } from "../geom/edgeChains";
import { edgeLine } from "../geom/meshQuery";
import { applyExtend, applyTrim, planExtend, planTrim } from "../document/trimOps";
import { detectSketchRegions } from "../document/regions";
import { DEFAULT_SOLID_COLOR } from "../document/colors";
import { featureIdOfPart, partAppearance } from "../document/parts";
import { parseDxfToEntities } from "../document/dxfImport";
import { applyDerived, applyDerivedToSketch } from "../document/derived";
import { evaluateExpression } from "../document/expression";
import { solveSketch } from "../sketch/solver";
import { isVariableExpression } from "../document/dimensionExpr";
import { deriveFaceFrame, planeRefLabel, type SketchPlaneId, type SketchPlaneRef } from "../document/planes";
import type {
  DistanceRef,
  Document,
  EdgeRef,
  ExtrudeProfile,
  FaceRef,
  Feature,
  PatternAxisRef,
  PatternDirRef,
  PointRef,
  PrimitiveFeature,
  RevolveAxis,
  SketchConstraint,
  SketchEntity,
  SketchFeature,
  TransformAxis,
  Variable,
  Vec2,
} from "../document/types";
import { listMeta } from "../storage/db";
import type { MeshedEdges, MeshedFaces, ShapeMeshPayload } from "../kernel/types";
import type { SectionViewState } from "../document/sectionView";
import type { Selection, ViewName } from "../viewport/Viewport";
import {
  expandEntities,
  type ConstraintSpec,
  type DimensionSpec,
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
  getSectionView(): SectionViewState;
  setSectionView(next: SectionViewState): void;
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
  /** Multi-document workspace. All mutations run through the
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
  constructor(
    public kind: OpResult["errorKind"],
    message: string,
  ) {
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
  let cx = 0,
    cy = 0,
    cz = 0,
    nx = 0,
    ny = 0,
    nz = 0,
    n = 0;
  for (let k = g.start; k < g.start + g.count; k++) {
    const vi = triangles[k] * 3;
    cx += vertices[vi];
    cy += vertices[vi + 1];
    cz += vertices[vi + 2];
    if (normals) {
      nx += normals[vi];
      ny += normals[vi + 1];
      nz += normals[vi + 2];
    }
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
  return { name, mid: [(minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2], length };
}

/** Geometric fingerprint of a named face (centroid + averaged normal), stored
 *  with a Shell alongside the persistent name so the kernel can re-match the
 *  face if an upstream edit renames it — mirrors `edgeFingerprintByName`. */
function faceFingerprintByName(faces: MeshedFaces, name: string): FaceRef {
  const g = faceGeomByName(faces, name);
  return g ? { name, center: g.center, normal: g.normal } : { name };
}

function bbox(faces: MeshedFaces): { min: [number, number, number]; max: [number, number, number] } | undefined {
  const v = faces.vertices;
  if (v.length === 0) return undefined;
  let m0 = Infinity,
    m1 = Infinity,
    m2 = Infinity,
    x0 = -Infinity,
    x1 = -Infinity,
    x2 = -Infinity;
  for (let i = 0; i < v.length; i += 3) {
    if (v[i] < m0) m0 = v[i];
    if (v[i] > x0) x0 = v[i];
    if (v[i + 1] < m1) m1 = v[i + 1];
    if (v[i + 1] > x1) x1 = v[i + 1];
    if (v[i + 2] < m2) m2 = v[i + 2];
    if (v[i + 2] > x2) x2 = v[i + 2];
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
    const doc = ctx.getDoc();
    const sketch = doc.features.find((f) => f.id === spec.sketchId);
    if (sketch?.type !== "sketch") throw new OpError("not_found", `No sketch "${spec.sketchId}".`);
    // Detect regions on the DERIVED-APPLIED sketch (offset/mirror/pattern
    // outputs included) — the same view the scene summary shows the agent and
    // resolveDocument bakes profiles from, so a region the summary lists is
    // always accepted here.
    const regions = detectSketchRegions(applyDerived(sketch, resolveDocument(doc).scope).entities);
    if (regions.length === 0)
      throw new OpError("invalid_op", `Sketch "${spec.sketchId}" has no closed region to extrude.`);
    let regionId = spec.regionId;
    if (regionId === undefined) {
      if (regions.length > 1) {
        throw new OpError(
          "invalid_op",
          `Sketch "${spec.sketchId}" has ${regions.length} regions; specify regionId (${regions.map((r) => r.id).join(", ")}).`,
        );
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
  return {
    kind: "bodyFace",
    featureId: spec.bodyId,
    faceId: fg.faceId,
    faceName: spec.faceName,
    center: fg.center,
    normal: fg.normal,
  };
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

// --- Sketch constraint/dimension resolution -------------------------------

function requireSketch(doc: Document, id: string): SketchFeature {
  const f = doc.features.find((x) => x.id === id);
  if (!f) throw new OpError("not_found", `No sketch "${id}".`);
  if (f.type !== "sketch") throw new OpError("invalid_op", `Feature "${id}" is not a sketch.`);
  return f;
}

/** Find a constrainable sketch entity by id. Derived (offset/mirror/project)
 *  output isn't editable/constrainable — it's driven by its source — so it's
 *  rejected here like the UI does. */
function requireEntity(sk: SketchFeature, id: string): SketchEntity {
  const e = sk.entities.find((x) => x.id === id);
  if (!e) throw new OpError("not_found", `No entity "${id}" in sketch "${sk.id}".`);
  if (e.derivedFrom) throw new OpError("invalid_op", `Entity "${id}" is derived (driven) — not constrainable.`);
  return e;
}

function requireLine(sk: SketchFeature, id: string, role: string): SketchEntity {
  const e = requireEntity(sk, id);
  if (e.type !== "line") throw new OpError("invalid_op", `${role} "${id}" must be a line (is ${e.type}).`);
  return e;
}

function requireCircular(sk: SketchFeature, id: string, role: string): SketchEntity {
  const e = requireEntity(sk, id);
  if (e.type !== "circle" && e.type !== "arc") {
    throw new OpError("invalid_op", `${role} "${id}" must be a circle or arc (is ${e.type}).`);
  }
  return e;
}

type PointRefSpec = { entityId: string; at: "a" | "b" | "c" } | { origin: true };

/** Map an agent point-ref spec to the document PointRef, validating the vertex
 *  makes sense for the entity ("a"/"b" ends need a line/arc; "c" needs a
 *  circle/arc/point). */
function resolvePointRef(sk: SketchFeature, spec: PointRefSpec): PointRef {
  if ("origin" in spec) return { origin: true };
  const e = requireEntity(sk, spec.entityId);
  const ok =
    spec.at === "c"
      ? e.type === "circle" || e.type === "arc" || e.type === "point"
      : e.type === "line" || e.type === "arc";
  if (!ok) {
    throw new OpError("invalid_op", `Point "${spec.at}" isn't a vertex of ${e.type} "${spec.entityId}".`);
  }
  return { entity: spec.entityId, at: spec.at };
}

/** Map an agent distance-ref spec (one side of a distance dimension) to the
 *  document DistanceRef, validating the referenced entity's kind. */
function resolveDistanceRef(
  sk: SketchFeature,
  spec: { on: "point"; point: PointRefSpec } | { on: "line"; entity: string } | { on: "rim"; entity: string },
): DistanceRef {
  if (spec.on === "point") return { on: "point", ref: resolvePointRef(sk, spec.point) };
  if (spec.on === "line") {
    requireLine(sk, spec.entity, "distance line");
    return { on: "line", entity: spec.entity };
  }
  requireCircular(sk, spec.entity, "distance rim");
  return { on: "rim", entity: spec.entity };
}

/** Build a geometric SketchConstraint from the agent spec, validating that the
 *  referenced entities exist and are compatible with the constraint. */
function buildGeoConstraint(sk: SketchFeature, spec: ConstraintSpec): SketchConstraint {
  const id = genId();
  switch (spec.kind) {
    case "horizontal":
    case "vertical":
      requireLine(sk, spec.entity, "entity");
      return { id, type: spec.kind, entity: spec.entity };
    case "parallel":
    case "perpendicular":
      requireLine(sk, spec.a, "a");
      requireLine(sk, spec.b, "b");
      return { id, type: spec.kind, a: spec.a, b: spec.b };
    case "equal": {
      const a = requireEntity(sk, spec.a);
      const b = requireEntity(sk, spec.b);
      const lineLike = (e: SketchEntity) => e.type === "line";
      const circLike = (e: SketchEntity) => e.type === "circle" || e.type === "arc";
      if (!((lineLike(a) && lineLike(b)) || (circLike(a) && circLike(b)))) {
        throw new OpError("invalid_op", "equal needs two lines (equal length) or two circles/arcs (equal radius).");
      }
      return { id, type: "equal", a: spec.a, b: spec.b };
    }
    case "tangent": {
      const a = requireEntity(sk, spec.a);
      const b = requireEntity(sk, spec.b);
      const circLike = (e: SketchEntity) => e.type === "circle" || e.type === "arc";
      const ok =
        (circLike(a) && circLike(b)) || (a.type === "line" && circLike(b)) || (circLike(a) && b.type === "line");
      if (!ok) throw new OpError("invalid_op", "tangent needs a line + circle/arc, or two circles/arcs.");
      return { id, type: "tangent", a: spec.a, b: spec.b };
    }
    case "coincident":
      return { id, type: "coincident", a: resolvePointRef(sk, spec.a), b: resolvePointRef(sk, spec.b) };
    case "pointOnLine":
      requireLine(sk, spec.line, "line");
      return { id, type: "pointOnLine", point: resolvePointRef(sk, spec.point), line: spec.line };
    case "midpoint": {
      const t = requireEntity(sk, spec.target);
      if (t.type !== "line" && t.type !== "arc") {
        throw new OpError("invalid_op", `midpoint target "${spec.target}" must be a line or arc (is ${t.type}).`);
      }
      return { id, type: "midpoint", point: resolvePointRef(sk, spec.point), target: spec.target };
    }
  }
}

/** Build a dimensional SketchConstraint, evaluating `value` (number or variable
 *  expression) to a number against the document scope and range-checking it. */
function buildDimension(sk: SketchFeature, spec: DimensionSpec, scope: Record<string, number>): SketchConstraint {
  const id = genId();
  let value: number;
  try {
    value = evaluateExpression(String(spec.value), scope);
  } catch (e) {
    throw new OpError("invalid_op", `Couldn't evaluate value "${spec.value}": ${(e as Error).message}`);
  }
  // A value that NAMES a variable keeps its text, so the dimension re-evaluates
  // when that variable moves — the same link the dimension input records. A
  // plain number stores nothing extra (see document/dimensionExpr.ts).
  const text = String(spec.value);
  const expr = isVariableExpression(text) ? { expr: text.trim() } : {};
  if (!Number.isFinite(value)) throw new OpError("invalid_op", `Value "${spec.value}" isn't a finite number.`);
  const requirePositive = () => {
    if (value <= 0) throw new OpError("invalid_op", `${spec.kind} must be > 0 (got ${value}).`);
  };
  switch (spec.kind) {
    case "length":
      requireLine(sk, spec.entity, "entity");
      requirePositive();
      return { id, type: "distance", entity: spec.entity, value, ...expr };
    case "radius":
      requireCircular(sk, spec.entity, "entity");
      requirePositive();
      return { id, type: "radius", entity: spec.entity, value, ...expr };
    case "diameter":
      requireCircular(sk, spec.entity, "entity");
      requirePositive();
      return { id, type: "diameter", entity: spec.entity, value, ...expr };
    case "angle":
      requireLine(sk, spec.a, "a");
      requireLine(sk, spec.b, "b");
      if (value < 0 || value >= 180)
        throw new OpError("invalid_op", `angle must be in [0, 180) degrees (got ${value}).`);
      return { id, type: "angle", a: spec.a, b: spec.b, value, ...expr };
    case "distance": {
      const a = resolveDistanceRef(sk, spec.a);
      const b = resolveDistanceRef(sk, spec.b);
      requirePositive();
      return { id, type: "distanceBetween", a, b, value, ...expr };
    }
  }
}

/** Add `constraint` to the sketch, re-solve, and either return the solved
 *  document or throw — mirroring the UI's commitConstraint/applyDimension
 *  guardrails so the agent gets the same behaviour: reject a solve throw, a
 *  conflict / failed solve, a collapsed (near-zero) line, or a constraint the
 *  solver flags as already-implied (redundant). */
/** Re-solve a sketch after an edit that changed its geometry (rather than adding
 *  a constraint), and regenerate anything derived from it. Unlike
 *  `addConstraintSolved` there's nothing to reject: a trim removes constraints
 *  rather than adding one, so it can't conflict. */
async function resolvedSketch(doc: Document, sketchId: string, label: string): Promise<Document> {
  const scope = resolveDocument(doc).scope;
  const sk = doc.features.find((f) => f.id === sketchId);
  if (sk?.type !== "sketch") throw new OpError("not_found", `No sketch "${sketchId}".`);
  try {
    const res = await solveSketch(sk.entities, sk.constraints);
    return applyDerivedToSketch(setSketchEntities(doc, sketchId, res.entities), sketchId, scope);
  } catch {
    throw new OpError("invalid_op", `${label} left the sketch unsolvable — not applied.`);
  }
}

async function addConstraintSolved(
  doc: Document,
  sketchId: string,
  constraint: SketchConstraint,
  label: string,
): Promise<Document> {
  const scope = resolveDocument(doc).scope;
  const candidate = addSketchConstraints(doc, sketchId, [constraint]);
  const sk = candidate.features.find((f) => f.id === sketchId);
  if (sk?.type !== "sketch") throw new OpError("not_found", `No sketch "${sketchId}".`);
  let res: Awaited<ReturnType<typeof solveSketch>>;
  try {
    res = await solveSketch(sk.entities, sk.constraints);
  } catch {
    throw new OpError("invalid_op", `${label} couldn't be solved — not applied.`);
  }
  const solved = applyDerivedToSketch(setSketchEntities(candidate, sketchId, res.entities), sketchId, scope);
  const solvedSk = solved.features.find((f) => f.id === sketchId);
  const degenerate =
    solvedSk?.type === "sketch" &&
    solvedSk.entities.some((e) => e.type === "line" && Math.hypot(e.b[0] - e.a[0], e.b[1] - e.a[1]) < 1e-3);
  if (res.hasConflicts || res.status >= 2 || degenerate) {
    const culprits = [
      ...new Set(
        res.conflictingIds
          .filter((cid) => cid !== constraint.id)
          .map((cid) => sk.constraints.find((c) => c.id === cid)?.type)
          .filter((t): t is NonNullable<typeof t> => !!t),
      ),
    ];
    throw new OpError(
      "invalid_op",
      culprits.length
        ? `${label} conflicts with existing constraints (${culprits.join(", ")}) — not applied. Remove one with remove_constraint first.`
        : `${label} can't be satisfied with the existing constraints — not applied.`,
    );
  }
  // planegcs naming the NEW constraint as redundant is precise (unlike a
  // pre-existing redundant), so reject only that case.
  if (res.redundantIds.includes(constraint.id)) {
    throw new OpError("invalid_op", `${label} is already implied by the existing constraints — not added.`);
  }
  return solved;
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
    // A non-fatal note the op wants surfaced against the feature it created
    // (e.g. DXF entity types that were skipped) — merged into the result's
    // warnings at the tail, keyed by createdId.
    let opWarning: string | undefined;

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
        // Pass the current variable scope so expression coordinates ("innerRad")
        // get correct initial numbers; the exprs overlay reflows them on regen.
        const scope = resolveDocument(doc).scope;
        let d = addSketchEntities(r.doc, r.id, expandEntities(op.entities, scope));
        if (op.name) d = renameFeature(d, r.id, op.name);
        next = d;
        createdId = r.id;
        break;
      }
      case "addConstraint": {
        const sk = requireSketch(doc, op.sketchId);
        const constraint = buildGeoConstraint(sk, op.constraint);
        next = await addConstraintSolved(doc, op.sketchId, constraint, op.constraint.kind);
        createdId = constraint.id;
        break;
      }
      case "addDimension": {
        const sk = requireSketch(doc, op.sketchId);
        const constraint = buildDimension(sk, op.dimension, resolveDocument(doc).scope);
        next = await addConstraintSolved(doc, op.sketchId, constraint, op.dimension.kind);
        createdId = constraint.id;
        break;
      }
      case "trimEntity": {
        const sk = requireSketch(doc, op.sketchId);
        if (!sk.entities.some((e) => e.id === op.entityId))
          throw new OpError("not_found", `No entity "${op.entityId}" in sketch "${op.sketchId}".`);
        const plan = planTrim(doc, op.sketchId, op.entityId, op.at);
        if (!plan) throw new OpError("invalid_op", "Trim works on lines, arcs and circles.");
        next = await resolvedSketch(applyTrim(doc, op.sketchId, op.entityId, plan), op.sketchId, "trim");
        createdId = op.entityId;
        break;
      }
      case "extendEntity": {
        const sk = requireSketch(doc, op.sketchId);
        if (!sk.entities.some((e) => e.id === op.entityId))
          throw new OpError("not_found", `No entity "${op.entityId}" in sketch "${op.sketchId}".`);
        const plan = planExtend(doc, op.sketchId, op.entityId, op.at);
        if (!plan) throw new OpError("invalid_op", "Nothing lies ahead of that end to extend to.");
        next = await resolvedSketch(applyExtend(doc, op.sketchId, op.entityId, plan), op.sketchId, "extend");
        createdId = op.entityId;
        break;
      }
      case "removeConstraint": {
        const sk = requireSketch(doc, op.sketchId);
        if (!sk.constraints.some((c) => c.id === op.constraintId)) {
          throw new OpError("not_found", `No constraint "${op.constraintId}" in sketch "${op.sketchId}".`);
        }
        next = removeSketchConstraint(doc, op.sketchId, op.constraintId);
        createdId = op.constraintId;
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
        // Validate the profile (so the agent gets a clear error, not a kernel
        // failure). A region or a planar body face; the axis is one of: a sketch
        // line, a plane, or a body face.
        const prof = resolveProfile(ctx, op.profile);
        if (prof.kind !== "sketchRegion" && prof.kind !== "bodyFace") {
          throw new OpError("invalid_op", "revolve profile must be a sketch region or a planar body face.");
        }
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
        } else if ("edgeName" in ax) {
          const mesh = ctx.getMeshes().find((m) => m.id === ax.bodyId);
          if (!mesh) throw new OpError("not_found", `No body "${ax.bodyId}" for the revolve axis.`);
          const g = mesh.mesh.edges.edgeGroups?.find((eg) => eg.name === ax.edgeName);
          if (!g) throw new OpError("not_found", `Edge "${ax.edgeName}" not found on body "${ax.bodyId}".`);
          const fp = edgeFingerprintByName(mesh.mesh.edges, ax.edgeName);
          axis = {
            edge: { featureId: ax.bodyId, edgeName: ax.edgeName, edgeId: g.edgeId, mid: fp.mid, length: fp.length },
          };
        } else {
          const mesh = ctx.getMeshes().find((m) => m.id === ax.bodyId);
          if (!mesh) throw new OpError("not_found", `No body "${ax.bodyId}" for the revolve axis.`);
          const fg = faceGeomByName(mesh.mesh.faces, ax.faceName);
          if (!fg) throw new OpError("not_found", `Face "${ax.faceName}" not found on body "${ax.bodyId}".`);
          axis = {
            face: {
              featureId: ax.bodyId,
              faceName: ax.faceName,
              faceId: fg.faceId,
              center: fg.center,
              normal: fg.normal,
            },
          };
        }
        const r = addRevolve(doc, prof, axis, op.angle, op.symmetric);
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
        if (!pathEnt)
          throw new OpError("not_found", `No entity "${op.path.entityId}" in sketch "${op.path.sketchId}".`);
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
        next = addDerivedOp(doc, op.sketchId, {
          id: opId,
          kind: "offset",
          sourceIds: op.sourceIds,
          distance: op.distance,
          ...(op.construction ? { construction: true } : {}),
        });
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
          if (!sketch.entities.some((x) => x.id === id))
            throw new OpError("not_found", `No entity "${id}" in sketch "${op.sketchId}".`);
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
          if (e.derivedFrom)
            throw new OpError("invalid_op", `"${id}" is derived geometry — pattern its source instead.`);
        }
        const opId = genId();
        if (op.kind === "linear") {
          if (op.dx === undefined && op.dy === undefined) {
            throw new OpError("invalid_op", "a linear sketch pattern needs a step (dx and/or dy).");
          }
          next = addDerivedOp(doc, op.sketchId, {
            id: opId,
            kind: "linearPattern",
            sourceIds: op.sourceIds,
            count: String(op.count),
            dx: String(op.dx ?? 0),
            dy: String(op.dy ?? 0),
          });
        } else {
          if (!op.center) throw new OpError("invalid_op", "a circular sketch pattern needs a center.");
          let center: PointRef | { at: Vec2 };
          if (Array.isArray(op.center)) {
            center = { at: op.center };
          } else {
            const ce = sketch.entities.find((x) => x.id === (op.center as { entityId: string }).entityId);
            if (!ce)
              throw new OpError(
                "not_found",
                `No entity "${(op.center as { entityId: string }).entityId}" in sketch "${op.sketchId}".`,
              );
            if (ce.derivedFrom) throw new OpError("invalid_op", "the center can't be derived geometry.");
            center = { entity: ce.id, at: (op.center as { at?: "a" | "b" | "c" }).at ?? "c" };
          }
          next = addDerivedOp(doc, op.sketchId, {
            id: opId,
            kind: "circularPattern",
            sourceIds: op.sourceIds,
            center,
            count: String(op.count),
            angle: String(op.angle ?? 360),
            symmetric: op.symmetric ?? false,
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
            dir1: dirRef(op.dir1),
            count1: String(op.count1),
            spacing1: String(op.spacing1),
            flip1: op.flip1 ?? false,
            ...(op.dir2
              ? {
                  dir2: dirRef(op.dir2),
                  count2: String(op.count2),
                  spacing2: String(op.spacing2),
                  flip2: op.flip2 ?? false,
                }
              : {}),
          });
        } else {
          if (!op.axis) throw new OpError("invalid_op", "a circular pattern needs an axis.");
          if (op.count === undefined) throw new OpError("invalid_op", "a circular pattern needs a count.");
          let axis: PatternAxisRef;
          if ("bodyId" in op.axis) {
            const mesh = ctx.getMeshes().find((m) => m.id === (op.axis as { bodyId: string }).bodyId);
            if (!mesh)
              throw new OpError(
                "not_found",
                `No body "${(op.axis as { bodyId: string }).bodyId}" for the pattern axis.`,
              );
            const fg = faceGeomByName(mesh.mesh.faces, (op.axis as { faceName: string }).faceName);
            if (!fg)
              throw new OpError(
                "not_found",
                `Face "${(op.axis as { faceName: string }).faceName}" not found on body "${(op.axis as { bodyId: string }).bodyId}".`,
              );
            axis = {
              face: {
                featureId: (op.axis as { bodyId: string }).bodyId,
                faceName: (op.axis as { faceName: string }).faceName,
                faceId: fg.faceId,
                center: fg.center,
                normal: fg.normal,
              },
            };
          } else {
            axis = dirRef(op.axis);
          }
          r = addPattern(doc, op.targetId, {
            kind: "circular",
            axis,
            count: String(op.count),
            angle: String(op.angle ?? 360),
            symmetric: op.symmetric ?? false,
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
        // A world axis is taken as-is; the two reference axes are validated here
        // (sketch line present and straight, edge present and straight) so a bad
        // reference is an error the agent can act on rather than a broken
        // feature sitting in the timeline.
        let axis: TransformAxis | undefined;
        const tax = op.axis;
        if (typeof tax === "string" || tax === undefined) {
          axis = tax;
        } else if ("entityId" in tax) {
          const axisSketch = requireFeature(doc, tax.sketchId);
          if (axisSketch.type !== "sketch") throw new OpError("not_found", `Axis "${tax.sketchId}" is not a sketch.`);
          const axisEnt = axisSketch.entities.find((e) => e.id === tax.entityId);
          if (!axisEnt) throw new OpError("not_found", `No entity "${tax.entityId}" in sketch "${tax.sketchId}".`);
          if (axisEnt.type !== "line") throw new OpError("invalid_op", "transform axis must be a line entity.");
          axis = { sketchId: tax.sketchId, entityId: tax.entityId };
        } else {
          const axMesh = ctx.getMeshes().find((m) => m.id === tax.bodyId);
          if (!axMesh) throw new OpError("not_found", `No body "${tax.bodyId}" for the rotation axis.`);
          const g = axMesh.mesh.edges.edgeGroups?.find((eg) => eg.name === tax.edgeName);
          if (!g) throw new OpError("not_found", `Edge "${tax.edgeName}" not found on body "${tax.bodyId}".`);
          if (!edgeLine(axMesh.mesh.edges, g.edgeId)) {
            throw new OpError("invalid_op", `Edge "${tax.edgeName}" is curved — a rotation axis must be straight.`);
          }
          const fp = edgeFingerprintByName(axMesh.mesh.edges, tax.edgeName);
          axis = {
            edge: { featureId: tax.bodyId, edgeName: tax.edgeName, edgeId: g.edgeId, mid: fp.mid, length: fp.length },
          };
        }
        const r = addTransform(doc, op.targetId, pivot, {
          tx: op.tx,
          ty: op.ty,
          tz: op.tz,
          angle: op.angle,
          axis,
          copy: op.copy,
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
        if (op.edges.length === 0 && !op.faces?.length) {
          throw new Error("dressUp needs at least one edge or face.");
        }
        const mesh = ctx.getMeshes().find((m) => m.id === op.targetId);
        // Naming one chord of a faceted rim means the rim: the kernel expands a
        // partial chain at build time anyway, and says so ("the stored selection
        // covered 1 of 96 segments … re-pick the edge to store it afresh"). That
        // notice exists for a selection gone stale after an upstream edit, so
        // raising it on every agent dress-up was noise — and the stored list was
        // a lossy record of what actually got dressed. Expanding here changes no
        // geometry; it just writes down the whole curve, as UI picks now do.
        const groups = mesh?.mesh.edges.edgeGroups ?? [];
        const idOf = new Map(groups.filter((g) => g.name).map((g) => [g.name!, g.edgeId]));
        const picked = op.edges.map((nm) => idOf.get(nm)).filter((id): id is number => id !== undefined);
        const nameOf = new Map(groups.filter((g) => g.name).map((g) => [g.edgeId, g.name!]));
        const expanded =
          picked.length === op.edges.length
            ? expandPickToChains(groups, picked)
                .map((id) => nameOf.get(id)!)
                .filter(Boolean)
            : op.edges; // a name the mesh doesn't know — pass the request through untouched
        // Bake geometric fingerprints (from the target's tessellation) so the
        // kernel can re-match each edge if a later upstream edit renames it. A
        // name the mesh doesn't know stays a bare name-only ref.
        const edgeRefs = mesh ? expanded.map((nm) => edgeFingerprintByName(mesh.mesh.edges, nm)) : undefined;
        // Faces get the same treatment: a centroid/normal fingerprint beside the
        // name, so a renamed face can still be re-matched geometrically.
        const faceRefs =
          mesh && op.faces
            ? op.faces.map((nm) => {
                const g = faceGeomByName(mesh.mesh.faces, nm);
                return g ? { name: nm, center: g.center, normal: g.normal } : { name: nm };
              })
            : undefined;
        // The agent dresses one body per call; the feature can hold several
        // (the UI picks across parts), so it goes in as a one-target list.
        const r = addDressUp(
          doc,
          op.kind,
          [
            {
              targetId: op.targetId,
              edges: expanded,
              edgeRefs,
              ...(op.faces?.length ? { faces: op.faces, faceRefs } : {}),
            },
          ],
          op.size,
          op.angle,
          op.flip,
        );
        next = r.doc;
        createdId = r.id;
        break;
      }
      case "shell": {
        requireFeature(doc, op.targetId);
        // Bake geometric fingerprints for the named faces (from the target's
        // tessellation) so the kernel can re-match them if a later upstream
        // edit renames the faces. A name the mesh doesn't know stays a
        // bare name-only ref — the kernel will report it properly.
        const faces = op.faces ?? [];
        const mesh = ctx.getMeshes().find((m) => m.id === op.targetId);
        const faceRefs = mesh ? faces.map((nm) => faceFingerprintByName(mesh.mesh.faces, nm)) : undefined;
        const r = addShell(doc, op.targetId, faces, op.thickness, faceRefs);
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
          const candidate: Variable[] = [
            ...doc.variables,
            { id: "__candidate__", name: op.name, expression: op.expression },
          ];
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
      case "setSectionView": {
        const cur = ctx.getSectionView();
        ctx.setSectionView({
          enabled: op.enabled,
          ref: op.plane ? resolvePlaneRef(ctx, op.plane) : cur.ref,
          offset: op.offset ?? cur.offset,
          flip: op.flip ?? cur.flip,
        });
        return { ok: true };
      }
      case "importStep": {
        const r = addImport(doc, op.source, op.name);
        next = r.doc;
        createdId = r.id;
        break;
      }
      case "importDxf": {
        const plane = resolvePlaneRef(ctx, op.plane);
        let parsed;
        try {
          parsed = parseDxfToEntities(op.source, { scale: op.scale });
        } catch (e) {
          throw new OpError("invalid_op", `Couldn't parse the DXF: ${(e as Error).message}`);
        }
        if (parsed.entities.length === 0) {
          throw new OpError(
            "invalid_op",
            "No importable geometry found in the DXF (LINE/CIRCLE/ARC/POLYLINE/SPLINE/TEXT).",
          );
        }
        const r = addSketch(doc, plane);
        let d = addSketchEntities(r.doc, r.id, parsed.entities);
        if (op.name) d = renameFeature(d, r.id, op.name);
        next = d;
        createdId = r.id;
        const skipped = Object.entries(parsed.skipped);
        if (skipped.length) {
          const n = skipped.reduce((a, [, c]) => a + c, 0);
          opWarning = `Skipped ${n} unsupported DXF ${n === 1 ? "entity" : "entities"}: ${skipped.map(([t, c]) => `${t}×${c}`).join(", ")}.`;
        }
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
    if (createdId) ctx.setSelection([]);
    // Wait for the worker to regenerate, then report what actually happened —
    // resolve (expression/reference) AND kernel (build) errors, merged, plus
    // non-fatal warnings (topological references re-matched / partially lost
    // after this edit) so the agent can verify a re-match landed right.
    const { errors, warnings: regenWarnings } = await ctx.waitForRegen();
    let warnings = regenWarnings && Object.keys(regenWarnings).length ? regenWarnings : undefined;
    // Fold in an op-level note (e.g. skipped DXF entities) against its feature.
    if (opWarning && createdId) warnings = { ...(warnings ?? {}), [createdId]: opWarning };
    // If the feature this op created failed to build, surface it as the op's
    // own failure so the agent self-corrects instead of building on nothing.
    if (createdId && errors[createdId]) {
      return {
        ok: false,
        createdId,
        error: errors[createdId],
        errorKind: "kernel_error",
        featureErrors: errors,
        warnings,
      };
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
/** The entity ids a constraint touches (a point ref → its entity id, or the
 *  literal "origin"), for the scene summary. */
function pointRefId(r: PointRef): string {
  if ("origin" in r) return "origin";
  if ("fixed" in r) return "fixed";
  return r.entity;
}
function distanceRefIds(r: DistanceRef): string[] {
  return r.on === "point" ? [pointRefId(r.ref)] : [r.entity];
}
function constraintRefIds(c: SketchConstraint): string[] {
  switch (c.type) {
    case "horizontal":
    case "vertical":
    case "distance":
    case "radius":
    case "diameter":
      return [c.entity];
    case "parallel":
    case "perpendicular":
    case "equal":
    case "angle":
    case "tangent":
      return [c.a, c.b];
    case "distanceBetween":
      return [...distanceRefIds(c.a), ...distanceRefIds(c.b)];
    case "coincident":
      return [pointRefId(c.a), pointRefId(c.b)];
    case "pointOnLine":
      return [pointRefId(c.point), c.line];
    case "pointOnCircle":
      return [pointRefId(c.point), c.circle];
    case "midpoint":
      return [pointRefId(c.point), c.target];
  }
}

export function getSceneSummary(ctx: AgentContext): SceneSummary {
  const doc = ctx.getDoc();
  const meshes = ctx.getMeshes();
  const errors = ctx.getErrors();
  const resolved = resolveDocument(doc);

  const featureById = new Map(doc.features.map((f) => [f.id, f]));
  const bodies: SceneSummary["bodies"] = meshes.map((m) => {
    // A body is a PART: usually the feature that made it, but a feature whose
    // result came out disconnected owns several (`<featureId>#n`), each with
    // its own name and colour (see document/parts.ts).
    const f = featureById.get(featureIdOfPart(m.id));
    const look = partAppearance(doc, m.id, DEFAULT_SOLID_COLOR);
    const mesh: ShapeMeshPayload = m.mesh;
    return {
      id: m.id,
      name: look.name,
      kind: f ? (f.type === "primitive" ? f.kind : f.type) : "body",
      bbox: bbox(mesh.faces),
      color: look.owned ? look.color : undefined,
      hidden: look.hidden || undefined,
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
        constraints: s.constraints.map((c) => ({
          id: c.id,
          type: c.type,
          refs: constraintRefIds(c),
          ...("value" in c ? { value: c.value } : {}),
        })),
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
