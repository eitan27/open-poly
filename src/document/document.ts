// Pure helpers for reading and updating the document. Every mutation returns a
// new Document (immutable updates) so React state and undo/redo stay simple.
import { FEATURE_DEFS } from "./featureDefs";
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

// --- Resolution -----------------------------------------------------------

export interface ResolveResult {
  features: ResolvedFeature[];
  /** featureId -> error message for features that failed to evaluate. */
  errors: Record<string, string>;
}

// Phase 1a: parameters are plain numeric literals. Phase 1b replaces this with
// a real expression evaluator over the variable scope.
function evalNumber(expr: string): number {
  const value = Number(expr.trim());
  if (!Number.isFinite(value)) throw new Error(`"${expr}" is not a number`);
  return value;
}

/** Resolve the active (non-suppressed, pre-rollback) features to numeric params. */
export function resolveDocument(doc: Document): ResolveResult {
  const active = doc.features
    .slice(0, doc.rollbackIndex)
    .filter((f) => !f.suppressed);

  const features: ResolvedFeature[] = [];
  const errors: Record<string, string> = {};

  for (const f of active) {
    try {
      const params: Record<string, number> = {};
      for (const [name, expr] of Object.entries(f.params)) {
        params[name] = evalNumber(expr);
      }
      features.push({ id: f.id, kind: f.kind, params });
    } catch (err) {
      errors[f.id] = String((err as Error).message ?? err);
    }
  }

  return { features, errors };
}
