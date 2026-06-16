// Pure helpers for reading and updating the document. Every mutation returns a
// new Document (immutable updates) so React state and undo/redo stay simple.
import { FEATURE_DEFS } from "./featureDefs";
import { evaluateExpression, type Scope } from "./expression";
import type { Document, Feature, FeatureKind } from "./types";
import type { ResolvedFeature } from "../kernel/types";

function uid(): string {
  return crypto.randomUUID();
}

export function createDocument(): Document {
  return { features: [], variables: [], rollbackIndex: 0 };
}

export function makeFeature(kind: FeatureKind, existing: Feature[]): Feature {
  const def = FEATURE_DEFS[kind];
  const ordinal = existing.filter((f) => f.kind === kind).length + 1;
  const params: Record<string, string> = {};
  for (const p of def.params) params[p.name] = String(p.default);
  return {
    id: uid(),
    kind,
    name: `${def.label} ${ordinal}`,
    suppressed: false,
    params,
  };
}

/** Insert a new feature at the rollback point (Onshape-style) and advance it. */
export function addFeature(doc: Document, kind: FeatureKind): { doc: Document; id: string } {
  const feature = makeFeature(kind, doc.features);
  const features = [...doc.features];
  features.splice(doc.rollbackIndex, 0, feature);
  return {
    doc: { ...doc, features, rollbackIndex: doc.rollbackIndex + 1 },
    id: feature.id,
  };
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

function mapFeature(doc: Document, id: string, fn: (f: Feature) => Feature): Document {
  return { ...doc, features: doc.features.map((f) => (f.id === id ? fn(f) : f)) };
}

export function updateParam(
  doc: Document,
  id: string,
  name: string,
  value: string,
): Document {
  return mapFeature(doc, id, (f) => ({ ...f, params: { ...f.params, [name]: value } }));
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
      const params: Record<string, number> = {};
      for (const [name, expr] of Object.entries(f.params)) {
        params[name] = evaluateExpression(expr, scope);
      }
      features.push({ id: f.id, kind: f.kind, params });
    } catch (err) {
      errors[f.id] = String((err as Error).message ?? err);
    }
  }

  return { features, errors, scope, variableErrors };
}
