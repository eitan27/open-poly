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
  rotateEntity,
  translateEntity,
  type FittedProjection,
  type OffsetPrimitive,
} from "./sketchTools";
import type { Document, PointRef, SketchEntity, SketchFeature, Vec2 } from "./types";

/** Write `value` into the numeric field of `obj` addressed by a dot-path
 *  ("a.0", "c.1", "r", "start", "points.2.1"). Walks existing containers only —
 *  a path that doesn't resolve to an existing slot is a no-op. Returns whether it
 *  wrote. Mutates `obj` (call on a clone). */
function setNumericPath(obj: unknown, path: string, value: number): boolean {
  const parts = path.split(".");
  let cur: Record<string, unknown> = obj as Record<string, unknown>;
  for (let i = 0; i < parts.length - 1; i++) {
    const nextVal = cur?.[parts[i]];
    if (nextVal == null || typeof nextVal !== "object") return false;
    cur = nextVal as Record<string, unknown>;
  }
  const key = parts[parts.length - 1];
  if (cur == null || !(key in cur)) return false;
  cur[key] = value;
  return true;
}

/** Re-evaluate one entity's `exprs` overlay against `scope`, returning a copy
 *  with the results written over its numeric coordinates. Never throws: a key
 *  whose expression is invalid, unknown, or non-finite keeps the stored literal.
 *  Returns the same reference when nothing changed. */
function evalEntityExprs(e: SketchEntity, scope: Scope): SketchEntity {
  if (!e.exprs) return e;
  const keys = Object.keys(e.exprs);
  if (keys.length === 0) return e;
  const clone = JSON.parse(JSON.stringify(e)) as SketchEntity;
  let changed = false;
  for (const key of keys) {
    let v: number;
    try {
      v = evaluateExpression(e.exprs[key], scope);
    } catch {
      continue;
    }
    if (!Number.isFinite(v)) continue;
    if (setNumericPath(clone, key, v)) changed = true;
  }
  return changed ? clone : e;
}

/** Reflow a sketch's expression-driven coordinates: every entity carrying an
 *  `exprs` overlay is re-evaluated against `scope` and its numeric coordinates
 *  refreshed. Pure; returns the same sketch when no entity has an overlay. Run
 *  before derived geometry so offsets/mirrors/patterns build off reflowed
 *  coordinates. */
export function applyEntityExprs(sketch: SketchFeature, scope: Scope): SketchFeature {
  if (!sketch.entities.some((e) => e.exprs && Object.keys(e.exprs).length > 0)) return sketch;
  return { ...sketch, entities: sketch.entities.map((e) => evalEntityExprs(e, scope)) };
}

function primToEntity(p: OffsetPrimitive, id: string, construction?: boolean): SketchEntity {
  const base = construction ? { construction: true as const } : {};
  if (p.type === "line") return { type: "line", id, a: p.a, b: p.b, ...base };
  if (p.type === "circle") return { type: "circle", id, c: p.c, r: p.r, ...base };
  return { type: "arc", id, c: p.c, r: p.r, start: p.start, end: p.end, ...base };
}

/** Hard cap on a pattern op's TOTAL instance count — a typo'd count ("1000")
 *  clamps instead of freezing the solver under thousands of entities. */
export const MAX_PATTERN_INSTANCES = 200;

/** Evaluate + sanitize a pattern count expression: an integer 2..MAX, or null
 *  when the expression is unevaluable / non-finite / below 2 (op contributes
 *  nothing rather than throwing, per the DerivedOp policy). */
export function resolvePatternCount(expr: string, scope: Scope): number | null {
  let n: number;
  try {
    n = evaluateExpression(expr, scope);
  } catch {
    return null;
  }
  if (!Number.isFinite(n)) return null;
  n = Math.round(n);
  if (n < 2) return null;
  return Math.min(n, MAX_PATTERN_INSTANCES);
}

/** The per-instance rotation angles (radians) of a circular pattern, EXCLUDING
 *  the seed (instance 0). `totalDeg` "360" (mod 360 ≈ 0) means a full circle:
 *  equal 360/count steps with no duplicate at the wrap. Any other sweep spreads
 *  the count instances endpoints-inclusive (step = total/(count−1)), and
 *  `symmetric` re-centers the spread on the seed (±total/2). Shared by
 *  applyDerived and the tool's live preview so they can never disagree. */
export function circularPatternAngles(count: number, totalDeg: number, symmetric?: boolean): number[] {
  const full = Math.abs(((totalDeg % 360) + 360) % 360) < 1e-9 && Math.abs(totalDeg) > 1e-9;
  const rad = (totalDeg * Math.PI) / 180;
  const angles: number[] = [];
  if (full) {
    const step = (2 * Math.PI * Math.sign(totalDeg)) / count;
    for (let i = 1; i < count; i++) angles.push(step * i);
    return angles;
  }
  const step = count > 1 ? rad / (count - 1) : 0;
  const start = symmetric ? -rad / 2 : 0;
  for (let i = 0; i < count; i++) {
    const a = start + step * i;
    if (Math.abs(a) < 1e-12) continue; // the seed itself
    angles.push(a);
  }
  return angles;
}

/** Resolve a circular-pattern center to live uv coordinates: a raw uv, the
 *  sketch origin, or a named vertex of a source entity (line ends, circle/arc
 *  center, arc endpoints — and, beyond the solver's `refCoord`, a point
 *  entity's own position, which the tool uses for a free-placed construction
 *  point center). Null when the referenced entity is gone. */
export function resolvePatternCenter(center: PointRef | { at: Vec2 }, byId: Map<string, SketchEntity>): Vec2 | null {
  // NB: check the PointRef variants FIRST — the entity variant also has an
  // `at` field (the vertex name), so `"at" in center` alone would match it.
  if ("origin" in center) return [0, 0];
  if ("fixed" in center) return center.fixed;
  if (!("entity" in center)) return center.at;
  const e = byId.get(center.entity);
  if (!e) return null;
  if (e.type === "point") return e.p;
  if (e.type === "line") return center.at === "a" ? e.a : e.b;
  if (e.type === "circle") return e.c;
  if (e.type === "arc") {
    if (center.at === "c") return e.c;
    const ang = center.at === "a" ? e.start : e.end;
    return [e.c[0] + e.r * Math.cos(ang), e.c[1] + e.r * Math.sin(ang)];
  }
  return null;
}

/** Recompute a sketch's derived geometry from its current (source) entities.
 *  Drops every previously-generated entity (`derivedFrom` set) and regenerates
 *  outputs from each `DerivedOp`, tagging them with `derivedFrom` and a stable
 *  per-output id (`${op.id}:${index}`) so identity persists across recomputes.
 *  Never throws: an op whose sources are missing or whose geometry is degenerate
 *  simply contributes nothing. Sources are limited to the hand-authored
 *  (non-derived) entities, so derivations don't chain off each other. */
export function applyDerived(sketch: SketchFeature, scope: Scope): SketchFeature {
  // Reflow expression-driven coordinates first, so derived geometry (offset/
  // mirror/pattern) builds off the up-to-date base coordinates.
  sketch = applyEntityExprs(sketch, scope);
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
  const projectKeep = sketch.entities.filter((e) => e.derivedFrom && projectOpIds.has(e.derivedFrom));
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
      } else if (op.kind === "linearPattern") {
        const count = resolvePatternCount(op.count, scope);
        if (count === null) continue;
        const dx = evaluateExpression(op.dx, scope);
        const dy = evaluateExpression(op.dy, scope);
        if (!Number.isFinite(dx) || !Number.isFinite(dy) || Math.hypot(dx, dy) < 1e-9) continue;
        op.sourceIds.forEach((sid, j) => {
          const src = byId.get(sid);
          if (!src) return;
          // Instances 1..count-1 (the seed IS instance 0). Stable per-output ids
          // `${op.id}:${srcIndex}:${instanceIndex}` persist across recomputes.
          for (let i = 1; i < count; i++) {
            generated.push({ ...translateEntity(src, dx * i, dy * i, `${op.id}:${j}:${i}`), derivedFrom: op.id });
          }
        });
      } else if (op.kind === "circularPattern") {
        const count = resolvePatternCount(op.count, scope);
        if (count === null) continue;
        const totalDeg = evaluateExpression(op.angle, scope);
        if (!Number.isFinite(totalDeg) || Math.abs(totalDeg) < 1e-9) continue;
        const center = resolvePatternCenter(op.center, byId);
        if (!center) continue;
        const angles = circularPatternAngles(count, totalDeg, op.symmetric);
        op.sourceIds.forEach((sid, j) => {
          const src = byId.get(sid);
          if (!src) return;
          angles.forEach((a, i) => {
            generated.push({ ...rotateEntity(src, center, a, `${op.id}:${j}:${i + 1}`), derivedFrom: op.id });
          });
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
    features: doc.features.map((f) => (f.id === sketchId && f.type === "sketch" ? applyDerived(f, scope) : f)),
  };
}

// --- Project (Use/Convert): pure projection of body geometry into a sketch ---
// The impure part (fetching the live world-space edge polyline from the rendered
// body) lives in the app layer; these helpers turn an already-fetched world
// polyline/point into a tagged sketch entity, and compare two projected sets so
// the app layer can avoid an endless reproject→regen loop.

function fittedToEntity(f: FittedProjection, id: string, derivedFrom: string): SketchEntity {
  switch (f.type) {
    case "line":
      return { type: "line", id, a: f.a, b: f.b, derivedFrom };
    case "circle":
      return { type: "circle", id, c: f.c, r: f.r, derivedFrom };
    case "arc":
      return { type: "arc", id, c: f.c, r: f.r, start: f.start, end: f.end, derivedFrom };
    case "spline":
      return { type: "spline", id, points: f.points, derivedFrom };
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
    const e = a[i],
      f = b[i];
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
