// Associative derived sketch geometry. Offset/Mirror tools store a `DerivedOp`
// on the sketch instead of a static snapshot; `applyDerived` regenerates the
// op's output entities from the CURRENT source entities on every solve/regen, so
// the result follows when the sources move (a dimension changes, the solver
// nudges a point, …). Generated entities are tagged `derivedFrom: op.id`.
import { evaluateExpression, type Scope } from "./expression";
import { worldToUv, type PlaneFrameData, type Vec3 } from "./planes";
import {
  detectSingleChain,
  fitProjectedPolyline,
  offsetChain,
  mirrorEntity,
  type FittedProjection,
  type OffsetPrimitive,
} from "./sketchTools";
import type { Document, SketchEntity, SketchFeature } from "./types";

function primToEntity(p: OffsetPrimitive, id: string, construction?: boolean): SketchEntity {
  const base = construction ? { construction: true as const } : {};
  if (p.type === "line") return { type: "line", id, a: p.a, b: p.b, ...base };
  if (p.type === "circle") return { type: "circle", id, c: p.c, r: p.r, ...base };
  return { type: "arc", id, c: p.c, r: p.r, start: p.start, end: p.end, ...base };
}

/** Recompute a sketch's derived geometry from its current (source) entities.
 *  Drops every previously-generated entity (`derivedFrom` set) and regenerates
 *  outputs from each `DerivedOp`, tagging them with `derivedFrom` and a stable
 *  per-output id (`${op.id}:${index}`) so identity persists across recomputes.
 *  Never throws: an op whose sources are missing or whose geometry is degenerate
 *  simply contributes nothing. Sources are limited to the hand-authored
 *  (non-derived) entities, so derivations don't chain off each other. */
export function applyDerived(sketch: SketchFeature, scope: Scope): SketchFeature {
  const ops = sketch.derived ?? [];
  const base = sketch.entities.filter((e) => !e.derivedFrom);
  if (ops.length === 0) {
    // No ops: just drop any stale generated entities (e.g. after the last op was
    // deleted), otherwise return the sketch untouched.
    return base.length === sketch.entities.length ? sketch : { ...sketch, entities: base };
  }
  // Project ops aren't regenerated here (their sources are kernel body edges, not
  // sibling entities — `applyProjections` re-projects them in the app layer after
  // each build). So PRESERVE their existing outputs and only regenerate
  // offset/mirror outputs from the hand-authored entities.
  const projectOpIds = new Set(ops.filter((o) => o.kind === "project").map((o) => o.id));
  const projectKeep = sketch.entities.filter(
    (e) => e.derivedFrom && projectOpIds.has(e.derivedFrom),
  );
  const byId = new Map(base.map((e) => [e.id, e] as const));
  const generated: SketchEntity[] = [];
  for (const op of ops) {
    try {
      if (op.kind === "offset") {
        const sources = op.sourceIds.map((id) => byId.get(id)).filter((e): e is SketchEntity => !!e);
        if (sources.length !== op.sourceIds.length) continue; // a source was deleted
        const chain = detectSingleChain(sources);
        if (!chain) continue; // sources no longer form a single chain
        const d = evaluateExpression(op.distance, scope);
        if (!Number.isFinite(d) || Math.abs(d) < 1e-9) continue;
        offsetChain(chain, d).forEach((p, i) => {
          generated.push({ ...primToEntity(p, `${op.id}:${i}`, op.construction), derivedFrom: op.id });
        });
      } else if (op.kind === "mirror") {
        const axis = byId.get(op.axisId);
        if (!axis || axis.type !== "line") continue;
        op.sourceIds.forEach((sid, i) => {
          const src = byId.get(sid);
          if (!src) return;
          generated.push({ ...mirrorEntity(src, axis.a, axis.b, `${op.id}:${i}`), derivedFrom: op.id });
        });
      }
    } catch {
      // A single bad op never breaks the whole sketch.
    }
  }
  return { ...sketch, entities: [...base, ...projectKeep, ...generated] };
}

/** Run `applyDerived` on one sketch within a document (used after a live solve so
 *  the editor immediately reflects updated offsets/mirrors). */
export function applyDerivedToSketch(doc: Document, sketchId: string, scope: Scope): Document {
  return {
    ...doc,
    features: doc.features.map((f) =>
      f.id === sketchId && f.type === "sketch" ? applyDerived(f, scope) : f,
    ),
  };
}

// --- Project (Use/Convert): pure projection of body geometry into a sketch ---
// The impure part (fetching the live world-space edge polyline from the rendered
// body) lives in the app layer; these helpers turn an already-fetched world
// polyline/point into a tagged sketch entity, and compare two projected sets so
// the app layer can avoid an endless reproject→regen loop.

function fittedToEntity(f: FittedProjection, id: string, derivedFrom: string): SketchEntity {
  switch (f.type) {
    case "line": return { type: "line", id, a: f.a, b: f.b, derivedFrom };
    case "circle": return { type: "circle", id, c: f.c, r: f.r, derivedFrom };
    case "arc": return { type: "arc", id, c: f.c, r: f.r, start: f.start, end: f.end, derivedFrom };
    case "spline": return { type: "spline", id, points: f.points, derivedFrom };
  }
}

/** Project a body edge's world-space polyline onto a sketch frame and fit it to
 *  the simplest primitive, tagged `derivedFrom`. Null if the polyline is too
 *  short / un-fittable. */
export function projectedEntityFromPolyline(
  frame: PlaneFrameData,
  worldPts: Vec3[],
  id: string,
  derivedFrom: string,
): SketchEntity | null {
  const uv = worldPts.map((p) => worldToUv(frame, p));
  const fit = fitProjectedPolyline(uv);
  return fit ? fittedToEntity(fit, id, derivedFrom) : null;
}

/** Project a single world-space vertex onto a sketch frame as a point entity. */
export function projectedPointEntity(
  frame: PlaneFrameData,
  worldPt: Vec3,
  id: string,
  derivedFrom: string,
): SketchEntity {
  return { type: "point", id, p: worldToUv(frame, worldPt), derivedFrom };
}

/** Are two projected-entity sets geometrically equal within `eps`? Ignores id
 *  order is preserved (stable `${op.id}:${i}` ids), so this compares positionally.
 *  The app layer only re-writes the document when this returns false — which is
 *  what makes the reproject→regen loop converge: an unchanged body re-projects to
 *  the same geometry ⇒ equal ⇒ no write ⇒ no further regen. */
export function sameProjectedEntities(a: SketchEntity[], b: SketchEntity[], eps = 1e-6): boolean {
  if (a.length !== b.length) return false;
  const near = (x: number, y: number) => Math.abs(x - y) <= eps;
  const nearPt = (p: [number, number], q: [number, number]) => near(p[0], q[0]) && near(p[1], q[1]);
  for (let i = 0; i < a.length; i++) {
    const e = a[i], f = b[i];
    if (e.type !== f.type) return false;
    if (e.type === "line" && f.type === "line") {
      if (!nearPt(e.a, f.a) || !nearPt(e.b, f.b)) return false;
    } else if (e.type === "circle" && f.type === "circle") {
      if (!nearPt(e.c, f.c) || !near(e.r, f.r)) return false;
    } else if (e.type === "arc" && f.type === "arc") {
      if (!nearPt(e.c, f.c) || !near(e.r, f.r) || !near(e.start, f.start) || !near(e.end, f.end)) return false;
    } else if (e.type === "point" && f.type === "point") {
      if (!nearPt(e.p, f.p)) return false;
    } else if (e.type === "spline" && f.type === "spline") {
      if (e.points.length !== f.points.length) return false;
      if (!e.points.every((p, j) => nearPt(p, f.points[j]))) return false;
    } else {
      return false;
    }
  }
  return true;
}
