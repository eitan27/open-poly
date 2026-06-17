// Geometric constraint solving for sketches, backed by planegcs (FreeCAD's GCS
// compiled to WASM). It maps our 2D sketch entities + constraints to planegcs
// primitives, solves, and reads the updated coordinates back.
//
// NOTE (for the reviewing agent): point identity is currently derived by
// coordinate key, so coincident endpoints (chained lines, snapped points) merge
// into one solver point. This is correct immediately after drawing; a proper
// point-based sketch model would make coincidence robust across repeated solves.
// Only line geometry + horizontal/vertical/parallel/perpendicular/distance
// constraints are mapped so far; circles/arcs pass through unchanged.

import { make_gcs_wrapper, type GcsWrapper } from "@salusoft89/planegcs";
import wasmUrl from "@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm?url";
import type { SketchConstraint, SketchEntity, Vec2 } from "../document/types";

let wrapperPromise: Promise<GcsWrapper> | null = null;
function getWrapper(): Promise<GcsWrapper> {
  if (!wrapperPromise) wrapperPromise = make_gcs_wrapper(wasmUrl);
  return wrapperPromise;
}

export interface SolveResult {
  entities: SketchEntity[];
  /** Remaining degrees of freedom; 0 means the sketch is fully constrained. */
  dof: number;
  ok: boolean;
  hasConflicts: boolean;
}

// planegcs SketchPrimitive objects are loosely typed here to avoid coupling to
// its internal id typing; field names match its .d.ts (point/line + constraints).
type Prim = Record<string, unknown> & { id: string; type: string };

export async function solveSketch(
  entities: SketchEntity[],
  constraints: SketchConstraint[],
): Promise<SolveResult> {
  const wrapper = await getWrapper();
  wrapper.clear_data();

  const prims: Prim[] = [];
  const pointIdByKey = new Map<string, string>();
  const keyToCoord = new Map<string, Vec2>();
  const lineIdByEntity = new Map<string, string>();
  let pc = 0;
  let cc = 0;

  const key = (p: Vec2) => `${p[0].toFixed(4)},${p[1].toFixed(4)}`;
  const ensurePoint = (p: Vec2): string => {
    const k = key(p);
    let id = pointIdByKey.get(k);
    if (!id) {
      id = `pt${pc++}`;
      pointIdByKey.set(k, id);
      keyToCoord.set(k, p);
      prims.push({ id, type: "point", x: p[0], y: p[1], fixed: false });
    }
    return id;
  };

  for (const e of entities) {
    if (e.type === "line") {
      const p1 = ensurePoint(e.a);
      const p2 = ensurePoint(e.b);
      const id = `ln_${e.id}`;
      lineIdByEntity.set(e.id, id);
      prims.push({ id, type: "line", p1_id: p1, p2_id: p2 });
    }
  }

  for (const c of constraints) {
    const id = `c${cc++}`;
    if (c.type === "horizontal" && lineIdByEntity.has(c.entity)) {
      prims.push({ id, type: "horizontal_l", l_id: lineIdByEntity.get(c.entity) });
    } else if (c.type === "vertical" && lineIdByEntity.has(c.entity)) {
      prims.push({ id, type: "vertical_l", l_id: lineIdByEntity.get(c.entity) });
    } else if (c.type === "parallel" && lineIdByEntity.has(c.a) && lineIdByEntity.has(c.b)) {
      prims.push({ id, type: "parallel", l1_id: lineIdByEntity.get(c.a), l2_id: lineIdByEntity.get(c.b) });
    } else if (c.type === "perpendicular" && lineIdByEntity.has(c.a) && lineIdByEntity.has(c.b)) {
      prims.push({ id, type: "perpendicular_ll", l1_id: lineIdByEntity.get(c.a), l2_id: lineIdByEntity.get(c.b) });
    } else if (c.type === "distance") {
      const e = entities.find((x) => x.id === c.entity);
      if (e && e.type === "line") {
        prims.push({ id, type: "p2p_distance", p1_id: ensurePoint(e.a), p2_id: ensurePoint(e.b), distance: c.value });
      }
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  wrapper.push_primitives_and_params(prims as any);
  wrapper.solve();
  wrapper.apply_solution();

  const dof = wrapper.gcs.dof();
  const hasConflicts = wrapper.has_gcs_conflicting_constraints();

  // Read solved point coordinates back per key.
  const solvedByKey = new Map<string, Vec2>();
  for (const [k, id] of pointIdByKey) {
    const pt = wrapper.sketch_index.get_sketch_point(id);
    solvedByKey.set(k, [pt.x, pt.y]);
  }
  const movePoint = (p: Vec2): Vec2 => solvedByKey.get(key(p)) ?? p;

  const updated: SketchEntity[] = entities.map((e) =>
    e.type === "line" ? { ...e, a: movePoint(e.a), b: movePoint(e.b) } : e,
  );

  return { entities: updated, dof, ok: true, hasConflicts };
}
