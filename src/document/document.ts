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
  planeIntersectionLine,
  planeThrough3Points,
  uvToWorld,
  type PlaneFrameData,
  type SketchPlaneRef,
} from "./planes";
import { detectSketchRegions, regionProfileSegments } from "./regions";
import { applyDerived, circularPatternAngles, resolvePatternCount } from "./derived";
import type {
  BooleanFeature,
  DerivedOp,
  Document,
  DressUpFeature,
  EdgeRef,
  ExtrudeFeature,
  ExtrudeProfile,
  Feature,
  FeatureKind,
  ImportFeature,
  LoftFeature,
  MirrorFeature,
  PatternDirRef,
  PatternFeature,
  PlaneFeature,
  PlaneMethod,
  RevolveAxis,
  RevolveFeature,
  SketchConstraint,
  SketchEntity,
  SketchFeature,
  SweepFeature,
  TransformFeature,
  Variable,
} from "./types";
import type { BooleanOp, ResolvedFeature } from "../kernel/types";
import { sampleArc, splineBeziers } from "./sketchTools";

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
    // Revolve gained a `symmetric` flag (one-sided was the only prior behavior).
    if (feat.type === "revolve" && f.symmetric === undefined) {
      changed = true;
      return { ...feat, symmetric: false };
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
  return f && (f.type === "primitive" || f.type === "extrude" || f.type === "boolean" || f.type === "transform" || f.type === "mirror" || f.type === "pattern" || f.type === "revolve" || f.type === "sweep" || f.type === "loft" || f.type === "import")
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
  edgeRefs?: EdgeRef[],
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
    edgeRefs,
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
  axis: RevolveAxis,
  angle = "360",
  symmetric = false,
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
    symmetric,
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

/** Repeat a body as rigid copies (linear run/grid or circular ring) compounded
 *  into one new body; the seed is kept. Pass the per-kind fields pre-filled —
 *  the dialog/agent owns defaults. */
export function addPattern(
  doc: Document,
  targetId: string,
  fields: Omit<PatternFeature, "id" | "type" | "name" | "suppressed" | "targetId" | "color" | "opacity">,
): { doc: Document; id: string } {
  const ordinal = doc.features.filter((f) => f.type === "pattern").length + 1;
  const feature: PatternFeature = {
    id: uid(),
    type: "pattern",
    name: `Pattern ${ordinal}`,
    suppressed: false,
    targetId,
    ...fields,
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
      const refs = (r: typeof c.a) => "entity" in r && r.entity === entityId;
      return refs(c.a) || refs(c.b);
    }
    case "pointOnLine":
      return c.line === entityId || ("entity" in c.point && c.point.entity === entityId);
    case "midpoint":
      return c.target === entityId || ("entity" in c.point && c.point.entity === entityId);
    case "distanceBetween": {
      const refs = (r: typeof c.a) => (r.on === "point" ? "entity" in r.ref && r.ref.entity === entityId : r.entity === entityId);
      return refs(c.a) || refs(c.b);
    }
    case "horizontal":
    case "vertical":
    case "distance":
    case "radius":
      return c.entity === entityId;
  }
}

/** Append an associative derived-geometry op (offset/mirror) to a sketch. Its
 *  output entities are seeded by the next `applyDerived` (run on solve/regen). */
export function addDerivedOp(doc: Document, sketchId: string, op: DerivedOp): Document {
  return mapSketch(doc, sketchId, (s) => ({ ...s, derived: [...(s.derived ?? []), op] }));
}

/** Edit an offset op's distance expression after the fact (re-evaluated by the
 *  next `applyDerived`, so the offset edges shift to the new distance). */
export function setDerivedOffsetDistance(
  doc: Document,
  sketchId: string,
  opId: string,
  distance: string,
): Document {
  return mapSketch(doc, sketchId, (s) => ({
    ...s,
    derived: (s.derived ?? []).map((o) =>
      o.id === opId && o.kind === "offset" ? { ...o, distance } : o,
    ),
  }));
}

export function removeSketchEntity(
  doc: Document,
  sketchId: string,
  entityId: string,
): Document {
  return mapSketch(doc, sketchId, (s) => {
    const ent = s.entities.find((e) => e.id === entityId);
    // Deleting a generated (derived) entity removes its whole op — and with it
    // every sibling output that op produced.
    if (ent?.derivedFrom) {
      const opId = ent.derivedFrom;
      return {
        ...s,
        derived: (s.derived ?? []).filter((o) => o.id !== opId),
        entities: s.entities.filter((e) => e.derivedFrom !== opId),
      };
    }
    // Deleting a source entity also drops any derived op that referenced it (its
    // outputs would be meaningless), plus those outputs and the entity's own
    // constraints.
    const deadOpIds = new Set(
      (s.derived ?? [])
        .filter((o) =>
          o.kind === "offset"
            ? o.sourceIds.includes(entityId)
            : o.kind === "mirror"
              ? o.axisId === entityId || o.sourceIds.includes(entityId)
              : o.kind === "linearPattern"
                ? o.sourceIds.includes(entityId)
                : o.kind === "circularPattern"
                  ? o.sourceIds.includes(entityId) ||
                    ("entity" in o.center && o.center.entity === entityId)
                  : false, // project ops reference body edges, not sketch entities
        )
        .map((o) => o.id),
    );
    return {
      ...s,
      derived: (s.derived ?? []).filter((o) => !deadOpIds.has(o.id)),
      entities: s.entities.filter(
        (e) => e.id !== entityId && !(e.derivedFrom && deadOpIds.has(e.derivedFrom)),
      ),
      constraints: s.constraints.filter((c) => !constraintRefsEntity(c, entityId)),
    };
  });
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
      if (name === "extent" && (value === "blind" || value === "symmetric" || value === "throughAll" || value === "upToFace" || value === "upToNext")) {
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
    if (f.type === "pattern") {
      if (
        name === "count1" || name === "spacing1" || name === "count2" ||
        name === "spacing2" || name === "count" || name === "angle"
      ) {
        return { ...f, [name]: value };
      }
      if (name === "flip1" || name === "flip2" || name === "symmetric") {
        return { ...f, [name]: value === "true" };
      }
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
    f.type === "primitive" || f.type === "extrude" || f.type === "boolean" || f.type === "transform" || f.type === "mirror" || f.type === "pattern" || f.type === "revolve" || f.type === "sweep" || f.type === "loft" || f.type === "import" ? { ...f, color } : f,
  );
}

export function setFeatureOpacity(doc: Document, id: string, opacity: number): Document {
  return mapFeature(doc, id, (f) =>
    f.type === "primitive" || f.type === "extrude" || f.type === "boolean" || f.type === "transform" || f.type === "mirror" || f.type === "pattern" || f.type === "revolve" || f.type === "sweep" || f.type === "loft" || f.type === "import"
      ? { ...f, opacity: Math.max(0, Math.min(1, opacity)) }
      : f,
  );
}

/** Hide/show a part — a view toggle (skips rendering), distinct from suppress. */
export function setFeatureHidden(doc: Document, id: string, hidden: boolean): Document {
  return mapFeature(doc, id, (f) =>
    f.type === "primitive" || f.type === "extrude" || f.type === "boolean" || f.type === "transform" || f.type === "mirror" || f.type === "pattern" || f.type === "revolve" || f.type === "sweep" || f.type === "loft" || f.type === "import" ? { ...f, hidden } : f,
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

  // Regenerate every sketch's derived geometry (offset/mirror) from its current
  // sources BEFORE region/profile detection, so extrude/revolve/sweep/loft see
  // up-to-date offset & mirror entities. `dDoc` is `doc` with derived sketches
  // applied; the per-feature lookups below read sketch geometry from it.
  const dDoc: Document = {
    ...doc,
    features: doc.features.map((f) => (f.type === "sketch" ? applyDerived(f, scope) : f)),
  };

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
          const sketch = dDoc.features.find((x) => x.id === prof.sketchId);
          if (sketch?.type !== "sketch") throw new Error("extrude: profile sketch not found");
          const region = detectSketchRegions(sketch.entities).find((r) => r.id === prof.regionId);
          if (!region) throw new Error("extrude: profile region not found");
          profile = { kind: "sketchRegion" as const, outline: region.outline, holes: region.holes, frame: frameOf(sketch.plane, planeFrames) };
        } else if (prof.kind === "sketchText") {
          // Bake the text entity's value/height/rotation/anchor + plane frame; the
          // worker re-builds the glyph wires (with counters/holes) and extrudes.
          const sketch = dDoc.features.find((x) => x.id === prof.sketchId);
          if (sketch?.type !== "sketch") throw new Error("extrude: text sketch not found");
          const ent = sketch.entities.find((e) => e.id === prof.textId);
          if (ent?.type !== "text") throw new Error("extrude: text entity not found");
          if (!ent.value.trim()) throw new Error("extrude: text is empty");
          profile = {
            kind: "sketchText" as const,
            value: ent.value,
            height: ent.height,
            rotation: ent.rotation ?? 0,
            anchor: ent.p,
            frame: frameOf(sketch.plane, planeFrames),
          };
        } else {
          // A body face: pass the source + persistent name (+ geometric
          // fingerprint); the worker re-finds the face against the running set.
          profile = { kind: "bodyFace" as const, sourceId: prof.featureId, faceName: prof.faceName, center: prof.center, normal: prof.normal };
        }
        // `?? "blind"` guards documents persisted before this field existed.
        // For "up to face", pass the target face reference (source body id +
        // persistent name + centroid fallback); the worker re-finds it.
        const upTo =
          f.extent === "upToFace" && f.upTo
            ? { sourceId: f.upTo.featureId, faceName: f.upTo.faceName, center: f.upTo.center, normal: f.upTo.normal }
            : undefined;
        features.push({ id: f.id, type: "extrude", profile, distance, flip: f.flip, extent: f.extent ?? "blind", mode: f.mode, targetId: f.targetId, upTo });
      } else if (f.type === "dressup") {
        features.push({
          id: f.id,
          type: "dressup",
          op: f.op,
          targetId: f.targetId,
          edges: f.edges,
          edgeRefs: f.edgeRefs,
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
      } else if (f.type === "pattern") {
        // Bake every copy's rigid motion so the kernel just loops: linear →
        // world offsets (spacing × direction, grid = both counts crossed);
        // circular → rotation angles about a world line (or a body-face axis
        // carried through for the worker to resolve). Counts/angles share the
        // sketch pattern's helpers so the two levels can't disagree.
        const worldDir = (d: PatternDirRef): [number, number, number] => {
          if ("world" in d) return d.world === "x" ? [1, 0, 0] : d.world === "y" ? [0, 1, 0] : [0, 0, 1];
          const dirSketch = dDoc.features.find((x) => x.id === d.sketchId);
          if (dirSketch?.type !== "sketch") throw new Error("pattern: direction sketch not found");
          const ent = dirSketch.entities.find((e) => e.id === d.entityId);
          if (ent?.type !== "line") throw new Error("pattern: direction must be a line");
          const dirFrame = frameOf(dirSketch.plane, planeFrames);
          const a = uvToWorld(dirFrame, ent.a[0], ent.a[1]);
          const b = uvToWorld(dirFrame, ent.b[0], ent.b[1]);
          const v: [number, number, number] = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
          const len = Math.hypot(v[0], v[1], v[2]);
          if (len < 1e-9) throw new Error("pattern: direction line is degenerate");
          return [v[0] / len, v[1] / len, v[2] / len];
        };
        if (f.kind === "linear") {
          if (!f.dir1) throw new Error("pattern: missing direction");
          const count1 = resolvePatternCount(f.count1 ?? "", scope);
          if (count1 === null) throw new Error("pattern: count must be 2 or more");
          const s1 = evaluateExpression(f.spacing1 ?? "0", scope) * (f.flip1 ? -1 : 1);
          if (!Number.isFinite(s1) || Math.abs(s1) < 1e-9) throw new Error("pattern: spacing must be non-zero");
          const d1 = worldDir(f.dir1);
          // The second direction is optional; without it the grid is 1×count1.
          let count2 = 1;
          let s2 = 0;
          let d2: [number, number, number] = [0, 0, 0];
          if (f.dir2) {
            const c2 = resolvePatternCount(f.count2 ?? "", scope);
            if (c2 === null) throw new Error("pattern: second count must be 2 or more");
            s2 = evaluateExpression(f.spacing2 ?? "0", scope) * (f.flip2 ? -1 : 1);
            if (!Number.isFinite(s2) || Math.abs(s2) < 1e-9) throw new Error("pattern: second spacing must be non-zero");
            count2 = c2;
            d2 = worldDir(f.dir2);
          }
          const offsets: [number, number, number][] = [];
          for (let j = 0; j < count2; j++) {
            for (let i = 0; i < count1; i++) {
              if (i === 0 && j === 0) continue; // the seed
              offsets.push([
                i * s1 * d1[0] + j * s2 * d2[0],
                i * s1 * d1[1] + j * s2 * d2[1],
                i * s1 * d1[2] + j * s2 * d2[2],
              ]);
            }
          }
          features.push({ id: f.id, type: "pattern", targetId: f.targetId, offsets });
        } else {
          if (!f.axis) throw new Error("pattern: missing axis");
          const count = resolvePatternCount(f.count ?? "", scope);
          if (count === null) throw new Error("pattern: count must be 2 or more");
          const totalDeg = evaluateExpression(f.angle ?? "360", scope);
          if (!Number.isFinite(totalDeg) || Math.abs(totalDeg) < 1e-9) throw new Error("pattern: angle must be non-zero");
          const angles = circularPatternAngles(count, totalDeg, f.symmetric);
          const axis = f.axis;
          if ("face" in axis) {
            features.push({
              id: f.id, type: "pattern", targetId: f.targetId, angles,
              axisFace: { sourceId: axis.face.featureId, faceName: axis.face.faceName, center: axis.face.center, normal: axis.face.normal },
            });
          } else if ("world" in axis) {
            features.push({
              id: f.id, type: "pattern", targetId: f.targetId, angles,
              axisOrigin: [0, 0, 0], axisDir: worldDir({ world: axis.world }),
            });
          } else {
            const axisSketch = dDoc.features.find((x) => x.id === axis.sketchId);
            if (axisSketch?.type !== "sketch") throw new Error("pattern: axis sketch not found");
            const axisEnt = axisSketch.entities.find((e) => e.id === axis.entityId);
            if (axisEnt?.type !== "line") throw new Error("pattern: axis must be a line");
            const axisFrame = frameOf(axisSketch.plane, planeFrames);
            const a = uvToWorld(axisFrame, axisEnt.a[0], axisEnt.a[1]);
            const b = uvToWorld(axisFrame, axisEnt.b[0], axisEnt.b[1]);
            features.push({
              id: f.id, type: "pattern", targetId: f.targetId, angles,
              axisOrigin: a, axisDir: [b[0] - a[0], b[1] - a[1], b[2] - a[2]],
            });
          }
        }
      } else if (f.type === "revolve") {
        const angle = evaluateExpression(f.angle, scope);
        const sketch = dDoc.features.find((x) => x.id === f.profile.sketchId);
        if (sketch?.type !== "sketch") throw new Error("revolve: profile sketch not found");
        const region = detectSketchRegions(sketch.entities).find((r) => r.id === f.profile.regionId);
        if (!region) throw new Error("revolve: profile region not found");
        const frame = frameOf(sketch.plane, planeFrames);
        // Bake the axis. A sketch line (its two endpoints) or a plane (the line
        // where it meets the profile plane) resolve here to a world line; a body
        // face can't be resolved without kernel geometry, so its reference is
        // carried through and resolved by the worker against the profile frame.
        const axis = f.axis;
        let axisPart:
          | { axisOrigin: [number, number, number]; axisDir: [number, number, number] }
          | { axisFace: { sourceId: string; faceName?: string; center: [number, number, number]; normal?: [number, number, number] } };
        if ("face" in axis) {
          axisPart = { axisFace: { sourceId: axis.face.featureId, faceName: axis.face.faceName, center: axis.face.center, normal: axis.face.normal } };
        } else if ("plane" in axis) {
          const axisFrame = frameOf(axis.plane, planeFrames);
          const line = planeIntersectionLine(axisFrame, frame);
          if (!line) throw new Error("revolve: axis plane is parallel to the profile plane (no intersection line)");
          axisPart = { axisOrigin: line.origin, axisDir: line.dir };
        } else {
          const axisSketch = dDoc.features.find((x) => x.id === axis.sketchId);
          if (axisSketch?.type !== "sketch") throw new Error("revolve: axis sketch not found");
          const axisEnt = axisSketch.entities.find((e) => e.id === axis.entityId);
          if (axisEnt?.type !== "line") throw new Error("revolve: axis must be a line");
          const axisFrame = frameOf(axisSketch.plane, planeFrames);
          const a = uvToWorld(axisFrame, axisEnt.a[0], axisEnt.a[1]);
          const b = uvToWorld(axisFrame, axisEnt.b[0], axisEnt.b[1]);
          axisPart = { axisOrigin: a, axisDir: [b[0] - a[0], b[1] - a[1], b[2] - a[2]] };
        }
        features.push({
          id: f.id,
          type: "revolve",
          profile: { kind: "sketchRegion", outline: region.outline, holes: region.holes, frame },
          angle,
          symmetric: f.symmetric ?? false,
          ...axisPart,
        });
      } else if (f.type === "sweep") {
        const sketch = dDoc.features.find((x) => x.id === f.profile.sketchId);
        if (sketch?.type !== "sketch") throw new Error("sweep: profile sketch not found");
        const region = detectSketchRegions(sketch.entities).find((r) => r.id === f.profile.regionId);
        if (!region) throw new Error("sweep: profile region not found");
        const frame = frameOf(sketch.plane, planeFrames);
        // Bake the path entity to 2D points (+ a smooth flag) in its own frame.
        const pathSketch = dDoc.features.find((x) => x.id === f.path.sketchId);
        if (pathSketch?.type !== "sketch") throw new Error("sweep: path sketch not found");
        const pe = pathSketch.entities.find((e) => e.id === f.path.entityId);
        if (!pe) throw new Error("sweep: path entity not found");
        let points: [number, number][];
        let smooth = false;
        // A spline path carries its exact cubic-Bézier spans (the SAME curve the
        // sketch draws — see `splineBeziers`), so the spine matches the sketch
        // exactly. An arc is sampled + `smooth` (kernel fits a B-spline); a line
        // is a plain polyline.
        let beziers: { c1: [number, number]; c2: [number, number]; end: [number, number] }[] | undefined;
        if (pe.type === "line") points = [pe.a, pe.b];
        else if (pe.type === "arc") { points = sampleArc(pe.c, pe.r, pe.start, pe.end, 32); smooth = true; }
        else if (pe.type === "spline") {
          const { start, spans } = splineBeziers(pe.points);
          points = [start, ...spans.map((s) => s.end)];
          beziers = spans;
          smooth = true;
        }
        else throw new Error("sweep: path must be a line, arc, or spline");
        if (points.length < 2) throw new Error("sweep: path needs at least 2 points");
        // Prefer exact boundary curves so a circular/arc cross-section sweeps as
        // a smooth tube, not a faceted polygon; fall back to the polyline outline.
        const curves = regionProfileSegments(region, sketch.entities);
        features.push({
          id: f.id,
          type: "sweep",
          profile: { kind: "sketchRegion", outline: region.outline, frame, ...(curves && { segmentStart: curves.start, segments: curves.segments }) },
          path: { points, smooth, beziers, frame: frameOf(pathSketch.plane, planeFrames) },
        });
      } else if (f.type === "loft") {
        if (f.profiles.length < 2) throw new Error("loft: needs at least 2 sections");
        const profiles = f.profiles.map((p) => {
          const sketch = dDoc.features.find((x) => x.id === p.sketchId);
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
