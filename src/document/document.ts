// Pure helpers for reading and updating the document. Every mutation returns a
// new Document (immutable updates) so React state and undo/redo stay simple.
import { FEATURE_DEFS } from "./featureDefs";
import { evaluateExpression, type Scope } from "./expression";
import { frameOf, type SketchPlaneRef } from "./planes";
import { detectSketchRegions } from "./regions";
import type {
  Document,
  DressUpFeature,
  ExtrudeFeature,
  ExtrudeProfile,
  Feature,
  FeatureKind,
  SketchConstraint,
  SketchEntity,
  SketchFeature,
} from "./types";
import type { ResolvedFeature } from "../kernel/types";

function uid(): string {
  return crypto.randomUUID();
}

export const genId = uid;

export function createDocument(): Document {
  return { features: [], variables: [], rollbackIndex: 0 };
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
  };
}

/** Insert a feature at the rollback point (Onshape-style) and advance the bar. */
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
  opts: { distance?: string; flip?: boolean; mode?: ExtrudeFeature["mode"] } = {},
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
    mode: opts.mode ?? "new",
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

export function removeSketchEntity(
  doc: Document,
  sketchId: string,
  entityId: string,
): Document {
  return mapSketch(doc, sketchId, (s) => ({
    ...s,
    entities: s.entities.filter((e) => e.id !== entityId),
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
      if (name === "mode" && (value === "new" || value === "add" || value === "remove")) {
        return { ...f, mode: value };
      }
    }
    if (f.type === "dressup" && name === "size") return { ...f, size: value };
    return f;
  });
}

export function setSuppressed(doc: Document, id: string, suppressed: boolean): Document {
  return mapFeature(doc, id, (f) => ({ ...f, suppressed }));
}

export function renameFeature(doc: Document, id: string, name: string): Document {
  return mapFeature(doc, id, (f) => ({ ...f, name }));
}

export function setRollbackIndex(doc: Document, index: number): Document {
  return { ...doc, rollbackIndex: Math.max(0, Math.min(index, doc.features.length)) };
}

// --- Variables ------------------------------------------------------------

export function addVariable(doc: Document): { doc: Document; id: string } {
  const id = uid();
  const variable = { id, name: `var${doc.variables.length + 1}`, expression: "0" };
  return { doc: { ...doc, variables: [...doc.variables, variable] }, id };
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
}

/** Evaluate variables in dependency order via fixpoint iteration; whatever can't
 *  resolve after no further progress is a cycle or an undefined reference. */
function evaluateVariables(doc: Document): {
  scope: Scope;
  errors: Record<string, string>;
} {
  const scope: Scope = {};
  const errors: Record<string, string> = {};
  let remaining = doc.variables.filter((v) => v.name.trim() !== "");

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
          profile = { kind: "sketchRegion" as const, outline: region.outline, frame: frameOf(sketch.plane) };
        } else {
          // A body face: pass the source + persistent name (+ centroid fallback);
          // the worker re-finds the face against the running body set.
          profile = { kind: "bodyFace" as const, sourceId: prof.featureId, faceName: prof.faceName, center: prof.center };
        }
        features.push({ id: f.id, type: "extrude", profile, distance, flip: f.flip, mode: f.mode });
      } else if (f.type === "dressup") {
        features.push({
          id: f.id,
          type: "dressup",
          op: f.op,
          targetId: f.targetId,
          edges: f.edges,
          size: evaluateExpression(f.size, scope),
        });
      }
      // sketches contribute no body directly
    } catch (err) {
      errors[f.id] = String((err as Error).message ?? err);
    }
  }

  return { features, errors, scope, variableErrors };
}
