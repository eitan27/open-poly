// Pure helpers for reading and updating the document. Every mutation returns a
// new Document (immutable updates) so React state and undo/redo stay simple.
import { BOOLEAN_OP_LABELS, FEATURE_DEFS } from "./featureDefs";
import { randomSolidColor } from "./colors";
import { evaluateExpression, RESERVED_NAMES, type Scope } from "./expression";
import {
  angledFrame,
  frameOf,
  midplaneFrame,
  offsetFrame,
  planeThrough3Points,
  uvToWorld,
  type PlaneFrameData,
  type SketchPlaneRef,
} from "./planes";
import { detectSketchRegions } from "./regions";
import type {
  BooleanFeature,
  Document,
  DressUpFeature,
  ExtrudeFeature,
  ExtrudeProfile,
  Feature,
  FeatureKind,
  ImportFeature,
  LoftFeature,
  MirrorFeature,
  PlaneFeature,
  PlaneMethod,
  RevolveFeature,
  SketchConstraint,
  SketchEntity,
  SketchFeature,
  SweepFeature,
  TransformFeature,
  Variable,
} from "./types";
import type { BooleanOp, ResolvedFeature } from "../kernel/types";
import { sampleArc } from "./sketchTools";

function uid(): string {
  return crypto.randomUUID();
}

export const genId = uid;

export function createDocument(): Document {
  return { features: [], variables: [], rollbackIndex: 0 };
}

/** Backfill fields that were added to a feature type after a document may have
 *  been persisted (IndexedDB / imported `.json`), so older documents stay valid.
 *  Run on load. Uses `in` checks (the static types say the fields are present,
 *  but old stored data may lack them). */
export function migrateDocument(doc: Document): Document {
  let changed = false;
  const features = doc.features.map((feat) => {
    // The static types say these fields exist, but old persisted data may lack
    // them — read through a loose view to test for that.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const f = feat as any;
    // Transforms gained copy/color/opacity (copy = a body-producing duplicate).
    if (feat.type === "transform" && (f.copy === undefined || f.color === undefined || f.opacity === undefined)) {
      changed = true;
      return {
        ...feat,
        copy: f.copy ?? false,
        color: f.color ?? randomSolidColor(),
        opacity: f.opacity ?? 1,
      };
    }
    // Reference planes gained a color after they first shipped.
    if (feat.type === "plane" && f.color === undefined) {
      changed = true;
      return { ...feat, color: randomSolidColor() };
    }
    return feat;
  });
  return changed ? { ...doc, features } : doc;
}

export function makeFeature(kind: FeatureKind, existing: Feature[]): Feature {
  const def = FEATURE_DEFS[kind];
  const ordinal =
    existing.filter((f) => f.type === "primitive" && f.kind === kind).length + 1;
  const params: Record<string, string> = {};
  for (const p of def.params) params[p.name] = String(p.default);
  return {
    id: uid(),
    type: "primitive",
    kind,
    name: `${def.label} ${ordinal}`,
    suppressed: false,
    params,
    color: randomSolidColor(),
    opacity: 1,
  };
}

/** Insert a feature at the rollback point and advance the bar. */
function insertFeature(doc: Document, feature: Feature): { doc: Document; id: string } {
  const features = [...doc.features];
  features.splice(doc.rollbackIndex, 0, feature);
  return {
    doc: { ...doc, features, rollbackIndex: doc.rollbackIndex + 1 },
    id: feature.id,
  };
}

export function addFeature(doc: Document, kind: FeatureKind): { doc: Document; id: string } {
  return insertFeature(doc, makeFeature(kind, doc.features));
}

export function addSketch(doc: Document, plane: SketchPlaneRef): { doc: Document; id: string } {
  const ordinal = doc.features.filter((f) => f.type === "sketch").length + 1;
  const feature: SketchFeature = {
    id: uid(),
    type: "sketch",
    name: `Sketch ${ordinal}`,
    suppressed: false,
    plane,
    entities: [],
    constraints: [],
  };
  return insertFeature(doc, feature);
}

export function addExtrude(
  doc: Document,
  profile: ExtrudeProfile,
  opts: {
    distance?: string;
    flip?: boolean;
    extent?: ExtrudeFeature["extent"];
    mode?: ExtrudeFeature["mode"];
    targetId?: string;
    upTo?: ExtrudeFeature["upTo"];
  } = {},
): { doc: Document; id: string } {
  const ordinal = doc.features.filter((f) => f.type === "extrude").length + 1;
  const feature: ExtrudeFeature = {
    id: uid(),
    type: "extrude",
    name: `Extrude ${ordinal}`,
    suppressed: false,
    profile,
    distance: opts.distance ?? "10",
    flip: opts.flip ?? false,
    extent: opts.extent ?? "blind",
    mode: opts.mode ?? "new",
    targetId: opts.targetId,
    upTo: opts.upTo,
    color: randomSolidColor(),
    opacity: 1,
  };
  return insertFeature(doc, feature);
}

/** Boolean results inherit the first operand's color rather than a fresh random
 *  one, so the combined body still reads as "the same object" the user started
 *  from — true for all three ops, not just union. */
function colorOfFeature(doc: Document, id: string): number {
  const f = doc.features.find((x) => x.id === id);
  return f && (f.type === "primitive" || f.type === "extrude" || f.type === "boolean" || f.type === "transform" || f.type === "mirror" || f.type === "revolve" || f.type === "sweep" || f.type === "loft" || f.type === "import")
    ? f.color
    : randomSolidColor();
}

export function addBoolean(
  doc: Document,
  op: BooleanOp,
  operands: string[],
): { doc: Document; id: string } {
  const ordinal = doc.features.filter((f) => f.type === "boolean").length + 1;
  const feature: BooleanFeature = {
    id: uid(),
    type: "boolean",
    name: `${BOOLEAN_OP_LABELS[op]} ${ordinal}`,
    suppressed: false,
    op,
    operands,
    color: colorOfFeature(doc, operands[0]),
    opacity: 1,
  };
  return insertFeature(doc, feature);
}

export function addDressUp(
  doc: Document,
  op: "chamfer" | "fillet",
  targetId: string,
  edges: string[],
  size = "2",
): { doc: Document; id: string } {
  const label = op === "chamfer" ? "Chamfer" : "Fillet";
  const ordinal = doc.features.filter((f) => f.type === "dressup" && f.op === op).length + 1;
  const feature: DressUpFeature = {
    id: uid(),
    type: "dressup",
    op,
    name: `${label} ${ordinal}`,
    suppressed: false,
    targetId,
    edges,
    size,
  };
  return insertFeature(doc, feature);
}

export function addPlane(
  doc: Document,
  spec: {
    method: PlaneMethod;
    base: SketchPlaneRef;
    offset?: string;
    refB?: SketchPlaneRef;
    angleAxis?: "u" | "v";
    angle?: string;
    points?: [number, number, number][];
  },
): { doc: Document; id: string } {
  const ordinal = doc.features.filter((f) => f.type === "plane").length + 1;
  const feature: PlaneFeature = {
    id: uid(),
    type: "plane",
    name: `Plane ${ordinal}`,
    suppressed: false,
    method: spec.method,
    base: spec.base,
    offset: spec.offset ?? "20",
    refB: spec.refB,
    angleAxis: spec.angleAxis,
    angle: spec.angle,
    points: spec.points,
    color: randomSolidColor(),
  };
  return insertFeature(doc, feature);
}

export function addTransform(
  doc: Document,
  targetId: string,
  pivot: [number, number, number],
  opts: { tx?: string; ty?: string; tz?: string; angle?: string; axis?: "x" | "y" | "z"; copy?: boolean } = {},
): { doc: Document; id: string } {
  const ordinal = doc.features.filter((f) => f.type === "transform").length + 1;
  const feature: TransformFeature = {
    id: uid(),
    type: "transform",
    name: `Transform ${ordinal}`,
    suppressed: false,
    targetId,
    tx: opts.tx ?? "0",
    ty: opts.ty ?? "0",
    tz: opts.tz ?? "0",
    angle: opts.angle ?? "0",
    axis: opts.axis ?? "z",
    pivot,
    copy: opts.copy ?? false,
    color: randomSolidColor(),
    opacity: 1,
  };
  return insertFeature(doc, feature);
}

/** Patch a transform feature's fields (the gizmo writes numeric drags back here
 *  as strings; the dialog edits expressions). No-op for non-transform features. */
export function setTransform(
  doc: Document,
  id: string,
  patch: Partial<Pick<TransformFeature, "tx" | "ty" | "tz" | "angle" | "axis" | "copy">>,
): Document {
  return mapFeature(doc, id, (f) => (f.type === "transform" ? { ...f, ...patch } : f));
}

/** Revolve a sketch region around an axis line into a solid body. */
export function addRevolve(
  doc: Document,
  profile: { sketchId: string; regionId: string },
  axis: { sketchId: string; entityId: string },
  angle = "360",
): { doc: Document; id: string } {
  const ordinal = doc.features.filter((f) => f.type === "revolve").length + 1;
  const feature: RevolveFeature = {
    id: uid(),
    type: "revolve",
    name: `Revolve ${ordinal}`,
    suppressed: false,
    profile,
    axis,
    angle,
    color: randomSolidColor(),
    opacity: 1,
  };
  return insertFeature(doc, feature);
}

/** Mirror a body across a plane, producing a new reflected body (original kept). */
export function addMirror(
  doc: Document,
  targetId: string,
  plane: SketchPlaneRef,
): { doc: Document; id: string } {
  const ordinal = doc.features.filter((f) => f.type === "mirror").length + 1;
  const feature: MirrorFeature = {
    id: uid(),
    type: "mirror",
    name: `Mirror ${ordinal}`,
    suppressed: false,
    targetId,
    plane,
    color: colorOfFeature(doc, targetId),
    opacity: 1,
  };
  return insertFeature(doc, feature);
}

/** Sweep a sketch region along a path entity (line/arc/spline) into a solid. */
export function addSweep(
  doc: Document,
  profile: { sketchId: string; regionId: string },
  path: { sketchId: string; entityId: string },
): { doc: Document; id: string } {
  const ordinal = doc.features.filter((f) => f.type === "sweep").length + 1;
  const feature: SweepFeature = {
    id: uid(),
    type: "sweep",
    name: `Sweep ${ordinal}`,
    suppressed: false,
    profile,
    path,
    color: randomSolidColor(),
    opacity: 1,
  };
  return insertFeature(doc, feature);
}

/** Loft through two or more sketch regions (timeline order) into a solid. */
export function addLoft(
  doc: Document,
  profiles: { sketchId: string; regionId: string }[],
): { doc: Document; id: string } {
  const ordinal = doc.features.filter((f) => f.type === "loft").length + 1;
  const feature: LoftFeature = {
    id: uid(),
    type: "loft",
    name: `Loft ${ordinal}`,
    suppressed: false,
    profiles,
    color: randomSolidColor(),
    opacity: 1,
  };
  return insertFeature(doc, feature);
}

export function addImport(
  doc: Document,
  source: string,
  name?: string,
): { doc: Document; id: string } {
  const ordinal = doc.features.filter((f) => f.type === "import").length + 1;
  const feature: ImportFeature = {
    id: uid(),
    type: "import",
    format: "step",
    name: name && name.trim() ? name.trim() : `Import ${ordinal}`,
    suppressed: false,
    source,
    color: randomSolidColor(),
    opacity: 1,
  };
  return insertFeature(doc, feature);
}

/** Resolve every (active) reference-plane feature to a concrete frame, keyed by
 *  plane feature id. Processed in document order so a plane may be based on an
 *  earlier plane. Pure geometry — no kernel needed. */
export function resolvePlanes(doc: Document, scope: Scope): Map<string, PlaneFrameData> {
  const planes = new Map<string, PlaneFrameData>();
  for (const f of doc.features) {
    if (f.type !== "plane" || f.suppressed) continue;
    try {
      const method = f.method ?? "offset";
      if (method === "midplane" && f.refB) {
        planes.set(f.id, midplaneFrame(frameOf(f.base, planes), frameOf(f.refB, planes)));
      } else if (method === "angle") {
        planes.set(f.id, angledFrame(frameOf(f.base, planes), f.angleAxis ?? "u", evaluateExpression(f.angle ?? "0", scope)));
      } else if (method === "through" && f.points?.length === 3) {
        const fr = planeThrough3Points(f.points[0], f.points[1], f.points[2]);
        if (fr) planes.set(f.id, fr);
      } else {
        // offset (and the fallback for any incomplete spec)
        planes.set(f.id, offsetFrame(frameOf(f.base, planes), evaluateExpression(f.offset, scope)));
      }
    } catch {
      // a reference is unresolved (suppressed/missing) — skip this plane
    }
  }
  return planes;
}

function mapSketch(
  doc: Document,
  id: string,
  fn: (s: SketchFeature) => SketchFeature,
): Document {
  return {
    ...doc,
    features: doc.features.map((f) => (f.id === id && f.type === "sketch" ? fn(f) : f)),
  };
}

export function addSketchEntity(
  doc: Document,
  sketchId: string,
  entity: SketchEntity,
): Document {
  return mapSketch(doc, sketchId, (s) => ({ ...s, entities: [...s.entities, entity] }));
}

export function addSketchEntities(
  doc: Document,
  sketchId: string,
  entities: SketchEntity[],
): Document {
  return mapSketch(doc, sketchId, (s) => ({ ...s, entities: [...s.entities, ...entities] }));
}

export function setSketchEntities(
  doc: Document,
  sketchId: string,
  entities: SketchEntity[],
): Document {
  return mapSketch(doc, sketchId, (s) => ({ ...s, entities }));
}

export function addSketchConstraints(
  doc: Document,
  sketchId: string,
  constraints: SketchConstraint[],
): Document {
  if (constraints.length === 0) return doc;
  return mapSketch(doc, sketchId, (s) => ({
    ...s,
    constraints: [...s.constraints, ...constraints],
  }));
}

export function setSketchConstraints(
  doc: Document,
  sketchId: string,
  constraints: SketchConstraint[],
): Document {
  return mapSketch(doc, sketchId, (s) => ({ ...s, constraints }));
}

export function removeSketchConstraint(
  doc: Document,
  sketchId: string,
  constraintId: string,
): Document {
  return mapSketch(doc, sketchId, (s) => ({
    ...s,
    constraints: s.constraints.filter((c) => c.id !== constraintId),
  }));
}

function constraintRefsEntity(c: SketchConstraint, entityId: string): boolean {
  switch (c.type) {
    case "parallel":
    case "perpendicular":
    case "equal":
    case "angle":
    case "tangent":
      return c.a === entityId || c.b === entityId;
    case "coincident": {
      const refs = (r: typeof c.a) => !("origin" in r) && r.entity === entityId;
      return refs(c.a) || refs(c.b);
    }
    case "pointOnLine":
      return c.line === entityId || (!("origin" in c.point) && c.point.entity === entityId);
    case "midpoint":
      return c.target === entityId || (!("origin" in c.point) && c.point.entity === entityId);
    case "horizontal":
    case "vertical":
    case "distance":
    case "radius":
      return c.entity === entityId;
  }
}

export function removeSketchEntity(
  doc: Document,
  sketchId: string,
  entityId: string,
): Document {
  return mapSketch(doc, sketchId, (s) => ({
    ...s,
    entities: s.entities.filter((e) => e.id !== entityId),
    constraints: s.constraints.filter((c) => !constraintRefsEntity(c, entityId)),
  }));
}

export function removeFeature(doc: Document, id: string): Document {
  const idx = doc.features.findIndex((f) => f.id === id);
  if (idx === -1) return doc;
  const features = doc.features.filter((f) => f.id !== id);
  const rollbackIndex =
    idx < doc.rollbackIndex
      ? doc.rollbackIndex - 1
      : Math.min(doc.rollbackIndex, features.length);
  return { ...doc, features, rollbackIndex };
}

/** Swap a feature with its neighbour in the timeline (delta -1 = up, +1 = down). */
export function moveFeature(doc: Document, id: string, delta: -1 | 1): Document {
  const idx = doc.features.findIndex((f) => f.id === id);
  const j = idx + delta;
  if (idx < 0 || j < 0 || j >= doc.features.length) return doc;
  const features = [...doc.features];
  [features[idx], features[j]] = [features[j], features[idx]];
  return { ...doc, features };
}

function mapFeature(doc: Document, id: string, fn: (f: Feature) => Feature): Document {
  return { ...doc, features: doc.features.map((f) => (f.id === id ? fn(f) : f)) };
}

export function updateParam(
  doc: Document,
  id: string,
  name: string,
  value: string,
): Document {
  return mapFeature(doc, id, (f) => {
    if (f.type === "primitive") return { ...f, params: { ...f.params, [name]: value } };
    if (f.type === "extrude") {
      if (name === "distance") return { ...f, distance: value };
      if (name === "flip") return { ...f, flip: value === "true" };
      if (name === "extent" && (value === "blind" || value === "symmetric" || value === "throughAll" || value === "upToFace")) {
        return { ...f, extent: value };
      }
      if (name === "mode" && (value === "new" || value === "add" || value === "remove")) {
        // Through All is only meaningful for a cut (Remove); leaving New/Add reverts it.
        const extent = value !== "remove" && f.extent === "throughAll" ? "blind" : f.extent;
        return { ...f, mode: value, extent };
      }
    }
    if (f.type === "dressup" && name === "size") return { ...f, size: value };
    if (f.type === "revolve" && name === "angle") return { ...f, angle: value };
    if (f.type === "plane" && name === "offset") return { ...f, offset: value };
    if (f.type === "plane" && name === "angle") return { ...f, angle: value };
    if (f.type === "transform") {
      if (name === "tx" || name === "ty" || name === "tz" || name === "angle") {
        return { ...f, [name]: value };
      }
      if (name === "axis" && (value === "x" || value === "y" || value === "z")) {
        return { ...f, axis: value };
      }
      if (name === "copy") return { ...f, copy: value === "true" };
    }
    return f;
  });
}

export function setSuppressed(doc: Document, id: string, suppressed: boolean): Document {
  return mapFeature(doc, id, (f) => ({ ...f, suppressed }));
}

export function renameFeature(doc: Document, id: string, name: string): Document {
  return mapFeature(doc, id, (f) => ({ ...f, name }));
}

export function setFeatureColor(doc: Document, id: string, color: number): Document {
  return mapFeature(doc, id, (f) =>
    f.type === "primitive" || f.type === "extrude" || f.type === "boolean" || f.type === "transform" || f.type === "mirror" || f.type === "revolve" || f.type === "sweep" || f.type === "loft" || f.type === "import" ? { ...f, color } : f,
  );
}

export function setFeatureOpacity(doc: Document, id: string, opacity: number): Document {
  return mapFeature(doc, id, (f) =>
    f.type === "primitive" || f.type === "extrude" || f.type === "boolean" || f.type === "transform" || f.type === "mirror" || f.type === "revolve" || f.type === "sweep" || f.type === "loft" || f.type === "import"
      ? { ...f, opacity: Math.max(0, Math.min(1, opacity)) }
      : f,
  );
}

/** Hide/show a part — a view toggle (skips rendering), distinct from suppress. */
export function setFeatureHidden(doc: Document, id: string, hidden: boolean): Document {
  return mapFeature(doc, id, (f) =>
    f.type === "primitive" || f.type === "extrude" || f.type === "boolean" || f.type === "transform" || f.type === "mirror" || f.type === "revolve" || f.type === "sweep" || f.type === "loft" || f.type === "import" ? { ...f, hidden } : f,
  );
}

export function setRollbackIndex(doc: Document, index: number): Document {
  return { ...doc, rollbackIndex: Math.max(0, Math.min(index, doc.features.length)) };
}

// --- Variables ------------------------------------------------------------

/** The n-th letters-only name (0→a … 25→z, 26→aa …). Variable names can't
 *  contain digits, so we can't fall back to `var1`-style numbering. */
function letterName(n: number): string {
  let s = "";
  let k = n + 1;
  while (k > 0) {
    k--;
    s = String.fromCharCode(97 + (k % 26)) + s;
    k = Math.floor(k / 26);
  }
  return s;
}

export function addVariable(doc: Document): { doc: Document; id: string } {
  const used = new Set(doc.variables.map((v) => v.name));
  let i = 0;
  while (used.has(letterName(i)) || RESERVED_NAMES.has(letterName(i))) i++;
  const id = uid();
  const variable = { id, name: letterName(i), expression: "0" };
  return { doc: { ...doc, variables: [...doc.variables, variable] }, id };
}

/** Validate a variable's name. Names may contain letters only (no digits,
 *  spaces, or symbols), must be non-empty, can't collide with a built-in
 *  constant/function, and must be unique. Returns one error message per
 *  offending variable id (keyed for the panel to flag the name field). */
export function validateVariableNames(variables: Variable[]): Record<string, string> {
  const errors: Record<string, string> = {};
  const firstByName = new Map<string, string>();
  for (const v of variables) {
    const name = v.name;
    if (name.trim() === "") errors[v.id] = "Name can't be empty";
    else if (/\s/.test(name)) errors[v.id] = "Name can't contain spaces";
    else if (/[0-9]/.test(name)) errors[v.id] = "Name can't contain numbers";
    else if (!/^[A-Za-z]+$/.test(name)) errors[v.id] = "Name can't contain special characters";
    else if (RESERVED_NAMES.has(name)) errors[v.id] = `"${name}" is a reserved name`;
    else if (firstByName.has(name)) errors[v.id] = `Duplicate variable name "${name}"`;
    if (!firstByName.has(name)) firstByName.set(name, v.id);
  }
  return errors;
}

export function updateVariable(
  doc: Document,
  id: string,
  field: "name" | "expression",
  value: string,
): Document {
  return {
    ...doc,
    variables: doc.variables.map((v) => (v.id === id ? { ...v, [field]: value } : v)),
  };
}

export function removeVariable(doc: Document, id: string): Document {
  return { ...doc, variables: doc.variables.filter((v) => v.id !== id) };
}

// --- Resolution -----------------------------------------------------------

export interface ResolveResult {
  features: ResolvedFeature[];
  /** featureId -> error message for features that failed to evaluate. */
  errors: Record<string, string>;
  /** Evaluated variable values, available to the UI. */
  scope: Scope;
  /** variableId -> error message (cycle / unknown reference / bad expression). */
  variableErrors: Record<string, string>;
  /** variableId -> error message for an invalid variable *name*. */
  variableNameErrors: Record<string, string>;
  /** Reference-plane frames (planeId -> frame), for rendering + sketch placement. */
  planeFrames: Map<string, PlaneFrameData>;
}

/** Evaluate variables in dependency order via fixpoint iteration; whatever can't
 *  resolve after no further progress is a cycle or an undefined reference. */
function evaluateVariables(doc: Document): {
  scope: Scope;
  errors: Record<string, string>;
} {
  const scope: Scope = {};
  const errors: Record<string, string> = {};
  // Only well-named variables enter scope; an invalid name is flagged on the
  // name field separately (variableNameErrors) and isn't evaluated.
  const nameErrors = validateVariableNames(doc.variables);
  let remaining = doc.variables.filter((v) => !nameErrors[v.id]);

  let progressed = true;
  while (remaining.length > 0 && progressed) {
    progressed = false;
    const next: typeof remaining = [];
    for (const v of remaining) {
      try {
        scope[v.name] = evaluateExpression(v.expression, scope);
        progressed = true;
      } catch {
        next.push(v); // maybe an as-yet-unresolved dependency; retry next round
      }
    }
    remaining = next;
  }
  // Surface the real error for anything still unresolved.
  for (const v of remaining) {
    try {
      evaluateExpression(v.expression, scope);
    } catch (err) {
      errors[v.id] = String((err as Error).message ?? err);
    }
  }
  return { scope, errors };
}

/** Resolve the active (non-suppressed, pre-rollback) features to numeric params. */
export function resolveDocument(doc: Document): ResolveResult {
  const { scope, errors: variableErrors } = evaluateVariables(doc);
  const variableNameErrors = validateVariableNames(doc.variables);
  const planeFrames = resolvePlanes(doc, scope);

  const active = doc.features
    .slice(0, doc.rollbackIndex)
    .filter((f) => !f.suppressed);

  const features: ResolvedFeature[] = [];
  const errors: Record<string, string> = {};

  for (const f of active) {
    try {
      if (f.type === "primitive") {
        const params: Record<string, number> = {};
        for (const [name, expr] of Object.entries(f.params)) {
          params[name] = evaluateExpression(expr, scope);
        }
        features.push({ id: f.id, type: "primitive", kind: f.kind, params });
      } else if (f.type === "extrude") {
        const distance = evaluateExpression(f.distance, scope);
        const prof = f.profile;
        let profile;
        if (prof.kind === "sketchRegion") {
          // Bake the sketch region's outline + plane frame so the kernel sees
          // only numbers.
          const sketch = doc.features.find((x) => x.id === prof.sketchId);
          if (sketch?.type !== "sketch") throw new Error("extrude: profile sketch not found");
          const region = detectSketchRegions(sketch.entities).find((r) => r.id === prof.regionId);
          if (!region) throw new Error("extrude: profile region not found");
          profile = { kind: "sketchRegion" as const, outline: region.outline, frame: frameOf(sketch.plane, planeFrames) };
        } else {
          // A body face: pass the source + persistent name (+ centroid fallback);
          // the worker re-finds the face against the running body set.
          profile = { kind: "bodyFace" as const, sourceId: prof.featureId, faceName: prof.faceName, center: prof.center };
        }
        // `?? "blind"` guards documents persisted before this field existed.
        // For "up to face", pass the target face reference (source body id +
        // persistent name + centroid fallback); the worker re-finds it.
        const upTo =
          f.extent === "upToFace" && f.upTo
            ? { sourceId: f.upTo.featureId, faceName: f.upTo.faceName, center: f.upTo.center }
            : undefined;
        features.push({ id: f.id, type: "extrude", profile, distance, flip: f.flip, extent: f.extent ?? "blind", mode: f.mode, targetId: f.targetId, upTo });
      } else if (f.type === "dressup") {
        features.push({
          id: f.id,
          type: "dressup",
          op: f.op,
          targetId: f.targetId,
          edges: f.edges,
          size: evaluateExpression(f.size, scope),
        });
      } else if (f.type === "boolean") {
        if (f.operands.length < 2) throw new Error("A boolean needs at least two operands.");
        features.push({ id: f.id, type: "boolean", op: f.op, operands: f.operands });
      } else if (f.type === "transform") {
        features.push({
          id: f.id,
          type: "transform",
          targetId: f.targetId,
          tx: evaluateExpression(f.tx, scope),
          ty: evaluateExpression(f.ty, scope),
          tz: evaluateExpression(f.tz, scope),
          angle: evaluateExpression(f.angle, scope),
          axis: f.axis,
          pivot: f.pivot,
          copy: f.copy,
        });
      } else if (f.type === "mirror") {
        // Bake the mirror plane to a point + normal the kernel can reflect about.
        const frame = frameOf(f.plane, planeFrames);
        features.push({ id: f.id, type: "mirror", targetId: f.targetId, origin: frame.origin, normal: frame.normal });
      } else if (f.type === "revolve") {
        const angle = evaluateExpression(f.angle, scope);
        const sketch = doc.features.find((x) => x.id === f.profile.sketchId);
        if (sketch?.type !== "sketch") throw new Error("revolve: profile sketch not found");
        const region = detectSketchRegions(sketch.entities).find((r) => r.id === f.profile.regionId);
        if (!region) throw new Error("revolve: profile region not found");
        const frame = frameOf(sketch.plane, planeFrames);
        // Bake the axis line's two endpoints to world → origin + direction.
        const axisSketch = doc.features.find((x) => x.id === f.axis.sketchId);
        if (axisSketch?.type !== "sketch") throw new Error("revolve: axis sketch not found");
        const axisEnt = axisSketch.entities.find((e) => e.id === f.axis.entityId);
        if (axisEnt?.type !== "line") throw new Error("revolve: axis must be a line");
        const axisFrame = frameOf(axisSketch.plane, planeFrames);
        const a = uvToWorld(axisFrame, axisEnt.a[0], axisEnt.a[1]);
        const b = uvToWorld(axisFrame, axisEnt.b[0], axisEnt.b[1]);
        const dir: [number, number, number] = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
        features.push({
          id: f.id,
          type: "revolve",
          profile: { kind: "sketchRegion", outline: region.outline, frame },
          angle,
          axisOrigin: a,
          axisDir: dir,
        });
      } else if (f.type === "sweep") {
        const sketch = doc.features.find((x) => x.id === f.profile.sketchId);
        if (sketch?.type !== "sketch") throw new Error("sweep: profile sketch not found");
        const region = detectSketchRegions(sketch.entities).find((r) => r.id === f.profile.regionId);
        if (!region) throw new Error("sweep: profile region not found");
        const frame = frameOf(sketch.plane, planeFrames);
        // Bake the path entity to 2D points (+ a smooth flag) in its own frame.
        const pathSketch = doc.features.find((x) => x.id === f.path.sketchId);
        if (pathSketch?.type !== "sketch") throw new Error("sweep: path sketch not found");
        const pe = pathSketch.entities.find((e) => e.id === f.path.entityId);
        if (!pe) throw new Error("sweep: path entity not found");
        let points: [number, number][];
        let smooth = false;
        if (pe.type === "line") points = [pe.a, pe.b];
        else if (pe.type === "arc") { points = sampleArc(pe.c, pe.r, pe.start, pe.end, 32); smooth = true; }
        else if (pe.type === "spline") { points = pe.points; smooth = true; }
        else throw new Error("sweep: path must be a line, arc, or spline");
        if (points.length < 2) throw new Error("sweep: path needs at least 2 points");
        features.push({
          id: f.id,
          type: "sweep",
          profile: { kind: "sketchRegion", outline: region.outline, frame },
          path: { points, smooth, frame: frameOf(pathSketch.plane, planeFrames) },
        });
      } else if (f.type === "loft") {
        if (f.profiles.length < 2) throw new Error("loft: needs at least 2 sections");
        const profiles = f.profiles.map((p) => {
          const sketch = doc.features.find((x) => x.id === p.sketchId);
          if (sketch?.type !== "sketch") throw new Error("loft: section sketch not found");
          const region = detectSketchRegions(sketch.entities).find((r) => r.id === p.regionId);
          if (!region) throw new Error("loft: section region not found");
          return { kind: "sketchRegion" as const, outline: region.outline, frame: frameOf(sketch.plane, planeFrames) };
        });
        features.push({ id: f.id, type: "loft", profiles });
      } else if (f.type === "import") {
        features.push({ id: f.id, type: "import", source: f.source });
      }
      // sketches + planes contribute no body directly
    } catch (err) {
      errors[f.id] = String((err as Error).message ?? err);
    }
  }

  return { features, errors, scope, variableErrors, variableNameErrors, planeFrames };
}
