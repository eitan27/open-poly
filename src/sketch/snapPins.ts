// Turning a snap onto BODY geometry into a LASTING coincident constraint.
//
// When a drawn point snaps to a body vertex/edge/circle there's no sketch entity
// to constrain against, so we pin it to that world spot with a coincident to a
// `{fixed}` PointRef (an immovable external anchor). This module builds those
// constraints from the committed entities + the pinned uv locations, so the pure
// logic is unit-testable away from the sketch-tool UI.
import type { SketchConstraint, SketchEntity, Vec2 } from "../document/types";

/** The vertices of an entity that a `PointRef` can address — a line's ends
 *  (`a`/`b`) and a circle/arc's centre (`c`) — each with its uv. A 3-point
 *  circle/arc's on-curve clicks, a spline point, and a polygon/rect centre have
 *  no nameable vertex, so those entities contribute none (and can't be pinned). */
export function vertexRefsOf(e: SketchEntity): { at: "a" | "b" | "c"; uv: Vec2 }[] {
  if (e.type === "line") return [{ at: "a", uv: e.a }, { at: "b", uv: e.b }];
  if (e.type === "circle" || e.type === "arc") return [{ at: "c", uv: e.c }];
  return [];
}

/** For each pin location, a coincident-to-`{fixed}` on the FIRST entity vertex
 *  sitting there (the solver merges any other coincident vertices at that spot,
 *  so one pin suffices). `undefined` pins (an un-snapped click) are skipped, as
 *  are locations with no referenceable vertex. `genId` mints the constraint ids.
 *  Match tolerance is 1e-4 uv — the click already resolved to the vertex's uv. */
export function pinConstraints(
  entities: SketchEntity[],
  pins: (Vec2 | undefined)[],
  genId: () => string,
): SketchConstraint[] {
  const cons: SketchConstraint[] = [];
  for (const p of pins) {
    if (!p) continue;
    for (const e of entities) {
      const hit = vertexRefsOf(e).find((v) => Math.hypot(v.uv[0] - p[0], v.uv[1] - p[1]) < 1e-4);
      if (hit) {
        cons.push({ id: genId(), type: "coincident", a: { entity: e.id, at: hit.at }, b: { fixed: p } });
        break;
      }
    }
  }
  return cons;
}
