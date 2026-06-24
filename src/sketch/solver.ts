// Geometric constraint solving for sketches, backed by planegcs (FreeCAD's GCS
// compiled to WASM). It maps our 2D sketch entities + constraints to planegcs
// primitives, solves, and reads the updated coordinates back.
//
// NOTE (for the reviewing agent): point identity is currently derived by
// coordinate key, so coincident endpoints (chained lines, snapped points) merge
// into one solver point. This is correct immediately after drawing; a proper
// point-based sketch model would make coincidence robust across repeated solves.
// Lines, circles, and arcs are all mapped (a circle's/arc's centre + radius are
// solvable; an arc also has solvable endpoints + start/end angles tied by
// arc_rules). Constraints mapped: horizontal/vertical/parallel/perpendicular/
// equal/distance/radius/angle/tangent/coincident/point-on-line/midpoint, across
// lines, circles, and arcs where meaningful.

import { make_gcs_wrapper, type GcsWrapper } from "@salusoft89/planegcs";
import wasmUrl from "@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm?url";
import type { PointRef, SketchConstraint, SketchEntity, Vec2 } from "../document/types";

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
  /** Redundant (already-implied) constraints were detected. */
  hasRedundant: boolean;
  /** planegcs SolveStatus: 0 Success, 1 Converged, 2 Failed, 3 SolutionInvalid.
   *  A failed / invalid solve means the just-added constraint can't be satisfied
   *  (e.g. forcing a horizontal and a vertical line parallel), even when planegcs
   *  doesn't flag it as a formal "conflict". */
  status: number;
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
  const circleIdByEntity = new Map<string, string>();
  const arcIdByEntity = new Map<string, string>();
  let pc = 0;
  let cc = 0;

  // The two endpoints of an arc, in uv, at its current start/end angles.
  const arcEnds = (a: Extract<SketchEntity, { type: "arc" }>): { start: Vec2; end: Vec2 } => ({
    start: [a.c[0] + a.r * Math.cos(a.start), a.c[1] + a.r * Math.sin(a.start)],
    end: [a.c[0] + a.r * Math.cos(a.end), a.c[1] + a.r * Math.sin(a.end)],
  });

  // Round to 4dp for point identity, normalizing "-0.0000" → "0.0000" so a tiny
  // negative coordinate near the origin still merges with a point at exactly 0
  // (otherwise an arc endpoint and a coincident line endpoint decouple at the
  // origin across re-solves).
  const coord = (v: number) => {
    const s = v.toFixed(4);
    return s === "-0.0000" ? "0.0000" : s;
  };
  const key = (p: Vec2) => `${coord(p[0])},${coord(p[1])}`;
  // The sketch origin is fixed ground: any point that sits exactly on it is
  // pinned (like Onshape's automatic origin coincidence). Without this, a line
  // drawn *from* the origin and then lengthened drifts — the solver grows it
  // symmetrically so it passes *through* the origin instead of staying anchored.
  const ORIGIN_KEY = key([0, 0]);
  // Resolve a PointRef to live coordinates: the origin is the sketch origin
  // (0,0); otherwise the named vertex of the referenced entity.
  const refCoord = (ref: PointRef): Vec2 | null => {
    if ("origin" in ref) return [0, 0];
    const e = entities.find((x) => x.id === ref.entity);
    if (!e) return null;
    if (e.type === "line") return ref.at === "a" ? e.a : e.b;
    if (e.type === "circle") return e.c;
    if (e.type === "arc") {
      if (ref.at === "c") return e.c;
      const ends = arcEnds(e);
      return ref.at === "a" ? ends.start : ends.end;
    }
    return null;
  };
  const ensurePoint = (p: Vec2): string => {
    const k = key(p);
    let id = pointIdByKey.get(k);
    if (!id) {
      id = `pt${pc++}`;
      pointIdByKey.set(k, id);
      keyToCoord.set(k, p);
      prims.push({ id, type: "point", x: p[0], y: p[1], fixed: k === ORIGIN_KEY });
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
    } else if (e.type === "circle") {
      // A circle's centre is a solver point (so it merges with a coincident
      // endpoint), and its radius is a free parameter until a radius constraint
      // drives it.
      const cId = ensurePoint(e.c);
      const id = `ci_${e.id}`;
      circleIdByEntity.set(e.id, id);
      prims.push({ id, type: "circle", c_id: cId, radius: e.r });
    } else if (e.type === "arc") {
      // An arc maps to a planegcs arc: centre + two endpoint points + radius +
      // start/end angles, tied together by `arc_rules` (so the endpoints stay on
      // the circle at those angles). The endpoints are solver points, so they
      // merge with coincident line/arc ends and the arc moves as a real curve.
      const ends = arcEnds(e);
      const cId = ensurePoint(e.c);
      const sId = ensurePoint(ends.start);
      const eId = ensurePoint(ends.end);
      const id = `ar_${e.id}`;
      arcIdByEntity.set(e.id, id);
      prims.push({
        id,
        type: "arc",
        c_id: cId,
        start_id: sId,
        end_id: eId,
        start_angle: e.start,
        end_angle: e.end,
        radius: e.r,
      });
      prims.push({ id: `arules_${e.id}`, type: "arc_rules", a_id: id });
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
    } else if (c.type === "radius" && circleIdByEntity.has(c.entity)) {
      prims.push({ id, type: "circle_radius", c_id: circleIdByEntity.get(c.entity), radius: c.value });
    } else if (c.type === "radius" && arcIdByEntity.has(c.entity)) {
      prims.push({ id, type: "arc_radius", a_id: arcIdByEntity.get(c.entity), radius: c.value });
    } else if (c.type === "equal") {
      // Equal applies to two lines (equal length) or two of {circle, arc} (equal
      // radius, any mix).
      if (lineIdByEntity.has(c.a) && lineIdByEntity.has(c.b)) {
        prims.push({ id, type: "equal_length", l1_id: lineIdByEntity.get(c.a), l2_id: lineIdByEntity.get(c.b) });
      } else {
        const ra = circleIdByEntity.has(c.a) ? "c" : arcIdByEntity.has(c.a) ? "a" : null;
        const rb = circleIdByEntity.has(c.b) ? "c" : arcIdByEntity.has(c.b) ? "a" : null;
        const idA = ra === "c" ? circleIdByEntity.get(c.a) : arcIdByEntity.get(c.a);
        const idB = rb === "c" ? circleIdByEntity.get(c.b) : arcIdByEntity.get(c.b);
        if (ra === "c" && rb === "c") prims.push({ id, type: "equal_radius_cc", c1_id: idA, c2_id: idB });
        else if (ra === "a" && rb === "a") prims.push({ id, type: "equal_radius_aa", a1_id: idA, a2_id: idB });
        else if (ra === "c" && rb === "a") prims.push({ id, type: "equal_radius_ca", c1_id: idA, a2_id: idB });
        else if (ra === "a" && rb === "c") prims.push({ id, type: "equal_radius_ca", c1_id: idB, a2_id: idA });
      }
    } else if (c.type === "angle" && lineIdByEntity.has(c.a) && lineIdByEntity.has(c.b)) {
      // `c.value` is the INTERIOR angle the user sees (degrees). planegcs's
      // l2l_angle_ll constrains the *directed* angle between the two line
      // direction vectors (a→b), which equals the interior angle only when both
      // lines point away from (or both toward) their shared vertex; if one points
      // toward it, the directed angle is the supplement. So convert to the directed
      // target, and carry the current directed angle's sign so the solver keeps the
      // line on the side it's already on (no flip to the supplement / rearrange).
      const la = entities.find((x) => x.id === c.a);
      const lb = entities.find((x) => x.id === c.b);
      if (la?.type === "line" && lb?.type === "line") {
        const d1: Vec2 = [la.b[0] - la.a[0], la.b[1] - la.a[1]];
        const d2: Vec2 = [lb.b[0] - lb.a[0], lb.b[1] - lb.a[1]];
        const phi0 = Math.atan2(d1[0] * d2[1] - d1[1] * d2[0], d1[0] * d2[0] + d1[1] * d2[1]);
        const k = (p: Vec2) => `${p[0].toFixed(4)},${p[1].toFixed(4)}`;
        let shared: Vec2 | null = null;
        for (const p of [la.a, la.b]) for (const q of [lb.a, lb.b]) if (k(p) === k(q)) shared = p;
        const opposed = shared ? (k(la.a) === k(shared) ? 1 : -1) * (k(lb.a) === k(shared) ? 1 : -1) < 0 : false;
        const interior = (c.value * Math.PI) / 180;
        const magnitude = opposed ? Math.PI - interior : interior;
        const angle = (phi0 >= 0 ? 1 : -1) * magnitude;
        prims.push({ id, type: "l2l_angle_ll", l1_id: lineIdByEntity.get(c.a), l2_id: lineIdByEntity.get(c.b), angle });
      }
    } else if (c.type === "tangent") {
      // Tangency between any two of {line, circle, arc}.
      const a = entities.find((x) => x.id === c.a);
      const b = entities.find((x) => x.id === c.b);
      const lid = (e: SketchEntity) => lineIdByEntity.get(e.id);
      const cid = (e: SketchEntity) => circleIdByEntity.get(e.id);
      const aid = (e: SketchEntity) => arcIdByEntity.get(e.id);
      if (a && b) {
        const [p, q] = [a, b].sort((x, y) => x.type.localeCompare(y.type)); // arc < circle < line
        const t = `${p.type}-${q.type}`;
        if (t === "circle-line") prims.push({ id, type: "tangent_lc", l_id: lid(q), c_id: cid(p) });
        else if (t === "circle-circle") prims.push({ id, type: "tangent_cc", c1_id: cid(p), c2_id: cid(q) });
        else if (t === "arc-line") prims.push({ id, type: "tangent_la", l_id: lid(q), a_id: aid(p) });
        else if (t === "arc-circle") prims.push({ id, type: "tangent_ca", c_id: cid(q), a_id: aid(p) });
        else if (t === "arc-arc") prims.push({ id, type: "tangent_aa", a1_id: aid(p), a2_id: aid(q) });
      }
    } else if (c.type === "coincident") {
      const pa = refCoord(c.a);
      const pb = refCoord(c.b);
      const aIsOrigin = "origin" in c.a;
      const bIsOrigin = "origin" in c.b;
      if (pa && pb && !(aIsOrigin && bIsOrigin)) {
        if (aIsOrigin || bIsOrigin) {
          // Anchor the non-origin point at the sketch origin: lock both
          // coordinates to 0 so re-solves (e.g. a length dimension) can't drag
          // it off the origin.
          const p = ensurePoint(aIsOrigin ? pb : pa);
          prims.push({ id, type: "coordinate_x", p_id: p, x: 0 });
          prims.push({ id: `c${cc++}`, type: "coordinate_y", p_id: p, y: 0 });
        } else {
          const p1 = ensurePoint(pa);
          const p2 = ensurePoint(pb);
          // Distinct coordinates today; if they already share a key they're the
          // same solver point (implicitly coincident), so the constraint is moot.
          if (p1 !== p2) prims.push({ id, type: "p2p_coincident", p1_id: p1, p2_id: p2 });
        }
      }
    } else if (c.type === "pointOnLine") {
      // A point (entity vertex or origin) lies on a line — keeps a drawn endpoint
      // attached to the line it landed on, or pulls the origin onto a line.
      const p = refCoord(c.point);
      if (p && lineIdByEntity.has(c.line)) {
        prims.push({ id, type: "point_on_line_pl", p_id: ensurePoint(p), l_id: lineIdByEntity.get(c.line) });
      }
    } else if (c.type === "midpoint") {
      const p = refCoord(c.point);
      const target = entities.find((x) => x.id === c.target);
      if (p && target?.type === "line") {
        // The point is the midpoint of the line's two ends (p1, p2 symmetric
        // about p). Parametric, so it tracks the line as it moves/scales.
        prims.push({
          id,
          type: "p2p_symmetric_ppp",
          p1_id: ensurePoint(target.a),
          p2_id: ensurePoint(target.b),
          p_id: ensurePoint(p),
        });
      } else if (p && target?.type === "arc" && arcIdByEntity.has(target.id)) {
        // Mid-arc point: on the arc, and on the perpendicular bisector of the
        // chord (= equidistant from the two ends ⇒ the angular midpoint). Both are
        // arc-relative, so the point tracks the arc as it moves/resizes.
        const ends = arcEnds(target);
        const pid = ensurePoint(p);
        prims.push({ id, type: "point_on_arc", p_id: pid, a_id: arcIdByEntity.get(target.id) });
        prims.push({
          id: `c${cc++}`,
          type: "point_on_perp_bisector_ppp",
          p_id: pid,
          lp1_id: ensurePoint(ends.start),
          lp2_id: ensurePoint(ends.end),
        });
      }
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  wrapper.push_primitives_and_params(prims as any);
  const status = wrapper.solve();
  wrapper.apply_solution();

  const dof = wrapper.gcs.dof();
  const hasConflicts = wrapper.has_gcs_conflicting_constraints();
  const hasRedundant = wrapper.has_gcs_redundant_constraints();

  // Read solved point coordinates back per key.
  const solvedByKey = new Map<string, Vec2>();
  for (const [k, id] of pointIdByKey) {
    const pt = wrapper.sketch_index.get_sketch_point(id);
    solvedByKey.set(k, [pt.x, pt.y]);
  }
  const movePoint = (p: Vec2): Vec2 => solvedByKey.get(key(p)) ?? p;

  const updated: SketchEntity[] = entities.map((e) => {
    if (e.type === "line") return { ...e, a: movePoint(e.a), b: movePoint(e.b) };
    if (e.type === "circle") {
      const cid = circleIdByEntity.get(e.id);
      if (!cid) return e;
      const ci = wrapper.sketch_index.get_sketch_circle(cid);
      return { ...e, c: movePoint(e.c), r: ci.radius };
    }
    if (e.type === "arc" && arcIdByEntity.has(e.id)) {
      // Rebuild centre/radius/angles from the solved centre + endpoints (which
      // also carry any coincidence with connected geometry). Keep the sweep close
      // to the original so a minor arc never flips to its major complement.
      const ends = arcEnds(e);
      const c = movePoint(e.c);
      const sp = movePoint(ends.start);
      const ep = movePoint(ends.end);
      const r = (Math.hypot(sp[0] - c[0], sp[1] - c[1]) + Math.hypot(ep[0] - c[0], ep[1] - c[1])) / 2;
      const start = Math.atan2(sp[1] - c[1], sp[0] - c[0]);
      const origSweep = e.end - e.start;
      let sweep = Math.atan2(ep[1] - c[1], ep[0] - c[0]) - start;
      while (sweep - origSweep > Math.PI) sweep -= 2 * Math.PI;
      while (origSweep - sweep > Math.PI) sweep += 2 * Math.PI;
      return { ...e, c, r, start, end: start + sweep };
    }
    return e;
  });

  return { entities: updated, dof, ok: true, hasConflicts, hasRedundant, status };
}
