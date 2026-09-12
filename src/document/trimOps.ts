// Applying a trim or an extend to a document — which is mostly a question about
// CONSTRAINTS, not geometry.
//
// A trimmed entity is shorter, split in two, or gone, and the constraints
// attached to it were written about the entity it used to be. Now that point
// identity is referential (sketch/solver.ts), a constraint naming `L:b` means
// that specific end of that specific line — so when that end is cut away, the
// constraint has to be dropped or re-pointed, and dropping it silently is the
// failure mode this codebase keeps working to avoid. The rules, in one place:
//
//   • gone entirely   → the entity and everything referencing it go (the same
//                       path a manual delete takes)
//   • shortened       → the end that moved is no longer where its joint was, so
//                       constraints on THAT vertex go; everything about the
//                       entity as a whole (horizontal, parallel, radius…) holds
//   • split in two    → the first fragment keeps the id and the `a` end; the
//                       second is new and holds the original `b`, so joints on
//                       `b` are RE-POINTED to it rather than lost. Horizontal /
//                       vertical are copied onto the new fragment (a collinear
//                       piece is still exactly that); nothing else is, because
//                       nothing else is guaranteed still true of it.
//   • circle → arc    → same entity, same centre and radius: nothing to undo.
//
// A length dimension is dropped wherever a trim or extend changed the length it
// measured. Keeping it would be worse than useless: the next solve would stretch
// the geometry back to the dimensioned length and quietly undo the edit.

import { genId, removeSketchEntity } from "./document";
import { extendPlan, isTrimTarget, nearestEnd, trimPlan, type ExtendPlan, type TrimPlan } from "../sketch/trim";
import type { Document, PointRef, SketchConstraint, SketchFeature, Vec2 } from "./types";

type Vertex = "a" | "b" | "c";

const isVertexRef = (r: PointRef, entityId: string, at: Vertex): boolean =>
  "entity" in r && r.entity === entityId && r.at === at;

/** Every PointRef a constraint holds, so vertex questions can be asked once. */
function pointRefsOf(c: SketchConstraint): PointRef[] {
  switch (c.type) {
    case "coincident":
      return [c.a, c.b];
    case "pointOnLine":
    case "pointOnCircle":
    case "midpoint":
      return [c.point];
    case "distanceBetween":
      return [c.a, c.b].filter((s) => s.on === "point").map((s) => (s as { ref: PointRef }).ref);
    default:
      return [];
  }
}

const refsVertex = (c: SketchConstraint, entityId: string, at: Vertex): boolean =>
  pointRefsOf(c).some((r) => isVertexRef(r, entityId, at));

/** Rewrite a constraint's references to one vertex so they name another. */
function retargetVertex(c: SketchConstraint, entityId: string, at: Vertex, toId: string): SketchConstraint {
  const swap = (r: PointRef): PointRef => (isVertexRef(r, entityId, at) ? { entity: toId, at } : r);
  switch (c.type) {
    case "coincident":
      return { ...c, a: swap(c.a), b: swap(c.b) };
    case "pointOnLine":
    case "pointOnCircle":
    case "midpoint":
      return { ...c, point: swap(c.point) };
    case "distanceBetween": {
      const side = (s: typeof c.a) => (s.on === "point" ? { ...s, ref: swap(s.ref) } : s);
      return { ...c, a: side(c.a), b: side(c.b) };
    }
    default:
      return c;
  }
}

/** A length dimension on this entity — the one thing a trim always invalidates. */
const isLengthDimOf = (c: SketchConstraint, entityId: string): boolean =>
  c.type === "distance" && c.entity === entityId;

function mapSketchFeature(doc: Document, sketchId: string, fn: (s: SketchFeature) => SketchFeature): Document {
  return {
    ...doc,
    features: doc.features.map((f) => (f.id === sketchId && f.type === "sketch" ? fn(f) : f)),
  };
}

const sketchOf = (doc: Document, sketchId: string): SketchFeature | null => {
  const f = doc.features.find((x) => x.id === sketchId);
  return f?.type === "sketch" ? f : null;
};

/** The result of asking for a trim, so callers can preview it and report why
 *  nothing happened without doing the work twice. */
export function planTrim(doc: Document, sketchId: string, entityId: string, click: Vec2): TrimPlan | null {
  const s = sketchOf(doc, sketchId);
  const target = s?.entities.find((e) => e.id === entityId);
  if (!s || !target || !isTrimTarget(target)) return null;
  return trimPlan(target, s.entities, click, genId());
}

/** Trim the piece of `entityId` under `click`. Returns the document unchanged if
 *  the entity isn't something trim understands. */
export function trimSketchEntity(doc: Document, sketchId: string, entityId: string, click: Vec2): Document {
  const plan = planTrim(doc, sketchId, entityId, click);
  if (!plan) return doc;
  return applyTrim(doc, sketchId, entityId, plan);
}

export function applyTrim(doc: Document, sketchId: string, entityId: string, plan: TrimPlan): Document {
  if (plan.kind === "delete") return removeSketchEntity(doc, sketchId, entityId);

  return mapSketchFeature(doc, sketchId, (s) => {
    if (plan.kind === "shorten") {
      return {
        ...s,
        entities: s.entities.map((e) => (e.id === entityId ? plan.entity : e)),
        // The moved end isn't where its joint was any more, and the length the
        // dimension measured isn't the length any more.
        constraints: s.constraints.filter(
          (c) => !refsVertex(c, entityId, plan.movedEnd) && !isLengthDimOf(c, entityId),
        ),
      };
    }
    if (plan.kind === "open") {
      // A circle that became an arc: same id, same centre, same radius — every
      // constraint it carried is still about the same thing.
      return { ...s, entities: s.entities.map((e) => (e.id === entityId ? plan.entity : e)) };
    }
    // split: the tail fragment inherits the original `b` end, and with it the
    // joints that were anchored there.
    const restId = plan.rest.id;
    const carried: SketchConstraint[] = s.constraints
      .filter((c) => (c.type === "horizontal" || c.type === "vertical") && c.entity === entityId)
      .map((c) => ({ ...c, id: genId(), entity: restId }) as SketchConstraint);
    return {
      ...s,
      entities: [...s.entities.map((e) => (e.id === entityId ? plan.keep : e)), plan.rest],
      constraints: [
        ...s.constraints
          .filter((c) => !isLengthDimOf(c, entityId))
          .map((c) => retargetVertex(c, entityId, "b", restId)),
        ...carried,
      ],
    };
  });
}

/** What extending `entityId` from the end nearest `click` would do, or null if
 *  nothing lies ahead of that end. */
export function planExtend(doc: Document, sketchId: string, entityId: string, click: Vec2): ExtendPlan | null {
  const s = sketchOf(doc, sketchId);
  const target = s?.entities.find((e) => e.id === entityId);
  if (!s || !target || !isTrimTarget(target)) return null;
  return extendPlan(target, s.entities, nearestEnd(target, click));
}

/** Grow `entityId` from the end nearest `click` until it meets something, and
 *  RECORD that meeting: a coincidence when it landed on the other entity's own
 *  vertex, a point-on otherwise. Without it the extension would touch only until
 *  the next solve moved either of them. */
export function extendSketchEntity(doc: Document, sketchId: string, entityId: string, click: Vec2): Document {
  const plan = planExtend(doc, sketchId, entityId, click);
  if (!plan) return doc;
  return applyExtend(doc, sketchId, entityId, plan);
}

export function applyExtend(doc: Document, sketchId: string, entityId: string, plan: ExtendPlan): Document {
  return mapSketchFeature(doc, sketchId, (s) => {
    const hit = s.entities.find((e) => e.id === plan.hitId);
    const point: PointRef = { entity: entityId, at: plan.end };
    let joint: SketchConstraint | null = null;
    if (plan.hitVertex) {
      joint = { id: genId(), type: "coincident", a: point, b: { entity: plan.hitId, at: plan.hitVertex } };
    } else if (hit?.type === "line") {
      joint = { id: genId(), type: "pointOnLine", point, line: plan.hitId };
    } else if (hit?.type === "circle" || hit?.type === "arc") {
      joint = { id: genId(), type: "pointOnCircle", point, circle: plan.hitId };
    }
    return {
      ...s,
      entities: s.entities.map((e) => (e.id === entityId ? plan.entity : e)),
      constraints: [
        // The end moved, so whatever pinned it there — and the length dimension
        // it no longer satisfies — goes, replaced by the new joint.
        ...s.constraints.filter((c) => !refsVertex(c, entityId, plan.end) && !isLengthDimOf(c, entityId)),
        ...(joint ? [joint] : []),
      ],
    };
  });
}
