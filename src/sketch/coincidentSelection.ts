// Decides what a click on the Coincident constraint button should do, given the
// current sketch selection. Pure and self-contained so the behaviour (and its
// past bugs) can be unit-tested without the viewport/React shell.
//
// The selection is a mix of *points* and *lines*:
//  • A point is a sketch vertex (an entity endpoint / centre, or the origin) —
//    which the solver may MOVE — or a body/solid vertex, projected onto the
//    sketch plane as a fixed uv it may NOT move (`editable: false`).
//  • Curves are the selected sketch edges: a line, or a circle/arc (whose RIM
//    is what a point sits on — never its centre).
//
// Prior bugs this encodes the fix for:
//  1. Selecting a sketch vertex + a solid-face vertex used to be seen as "one
//     sketch point" (the solid vertex was ignored), so coincident silently
//     anchored the sketch vertex to the ORIGIN. Now the solid vertex is a real
//     (fixed) point and the two are made coincident.
//  2. In the same selection the button was sometimes disabled outright. The
//     enable rule now counts body vertices as points too.
//  3. A point + a CIRCLE was seen as "one point and no edges", so coincident
//     anchored the point to the ORIGIN — a circle simply wasn't a thing a point
//     could be coincident with, which is most of what coincident is for on a
//     circle. It now resolves to point-on-circle, the same relationship the
//     drawing tool records when an endpoint is snapped onto a rim.

import type { PointRef } from "../document/types";

export interface CoincidentPoint {
  ref: PointRef;
  /** True for a sketch vertex the solver may move; false for a fixed external
   *  reference (e.g. a projected body/solid vertex) that stays put. */
  editable: boolean;
}

/** The constraint a coincident-button click resolves to, or null when the
 *  selection isn't a valid coincidence (which is also exactly when the button
 *  should be disabled). */
export type CoincidentPlan =
  | { kind: "coincident"; a: PointRef; b: PointRef }
  | { kind: "pointOnLine"; point: PointRef; lineId: string }
  | { kind: "pointOnCircle"; point: PointRef; circleId: string }
  | { kind: "originAnchor"; point: PointRef }
  | null;

/** A selected sketch edge a point can be made coincident WITH. */
export interface CoincidentCurve {
  id: string;
  /** "circle" covers arcs too — both are a rim the point lands on. */
  kind: "line" | "circle";
}

export function planCoincident(points: CoincidentPoint[], curves: CoincidentCurve[]): CoincidentPlan {
  // One point + one edge → the point lies ON that edge. The point may be a
  // sketch vertex (attached to the edge) or a fixed body vertex (the edge moves
  // to reach it).
  if (points.length === 1 && curves.length === 1) {
    const point = points[0].ref;
    const curve = curves[0];
    // A sketch vertex that's already a vertex of the very edge it's snapping to
    // is moot — nothing to constrain. (For a circle that's its centre, which a
    // point-on-rim would fight rather than describe.)
    if ("entity" in point && point.entity === curve.id) return null;
    return curve.kind === "line"
      ? { kind: "pointOnLine", point, lineId: curve.id }
      : { kind: "pointOnCircle", point, circleId: curve.id };
  }
  // Any other selection involving edges isn't a coincidence.
  if (curves.length > 0) return null;
  // Two points → make them coincident, provided at least one can move (two fixed
  // body vertices can't be reconciled — neither is free to move).
  if (points.length === 2) {
    if (!points[0].editable && !points[1].editable) return null;
    return { kind: "coincident", a: points[0].ref, b: points[1].ref };
  }
  // A single movable sketch vertex → anchor it to the origin. A lone fixed body
  // vertex has nothing to move, so there's nothing to do.
  if (points.length === 1 && points[0].editable) {
    return { kind: "originAnchor", point: points[0].ref };
  }
  return null;
}

/** Whether the Coincident button is applicable to the current selection. */
export function coincidentEnabled(points: CoincidentPoint[], curves: CoincidentCurve[]): boolean {
  return planCoincident(points, curves) !== null;
}
