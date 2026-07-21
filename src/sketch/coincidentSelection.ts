// Decides what a click on the Coincident constraint button should do, given the
// current sketch selection. Pure and self-contained so the behaviour (and its
// past bugs) can be unit-tested without the viewport/React shell.
//
// The selection is a mix of *points* and *lines*:
//  • A point is a sketch vertex (an entity endpoint / centre, or the origin) —
//    which the solver may MOVE — or a body/solid vertex, projected onto the
//    sketch plane as a fixed uv it may NOT move (`editable: false`).
//  • Lines are selected sketch line entities.
//
// Prior bugs this encodes the fix for:
//  1. Selecting a sketch vertex + a solid-face vertex used to be seen as "one
//     sketch point" (the solid vertex was ignored), so coincident silently
//     anchored the sketch vertex to the ORIGIN. Now the solid vertex is a real
//     (fixed) point and the two are made coincident.
//  2. In the same selection the button was sometimes disabled outright. The
//     enable rule now counts body vertices as points too.

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
  | { kind: "originAnchor"; point: PointRef }
  | null;

export function planCoincident(points: CoincidentPoint[], lineIds: string[]): CoincidentPlan {
  // One point + one line → point-on-line. The point may be a sketch vertex
  // (attached to the line) or a fixed body vertex (the line moves to reach it).
  if (points.length === 1 && lineIds.length === 1) {
    const point = points[0].ref;
    const lineId = lineIds[0];
    // A sketch vertex that's already an endpoint of the very line it's snapping
    // to is moot — nothing to constrain.
    if ("entity" in point && point.entity === lineId) return null;
    return { kind: "pointOnLine", point, lineId };
  }
  // Any other selection involving lines isn't a coincidence.
  if (lineIds.length > 0) return null;
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
export function coincidentEnabled(points: CoincidentPoint[], lineIds: string[]): boolean {
  return planCoincident(points, lineIds) !== null;
}
