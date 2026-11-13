// What dragging an instance does to a mated assembly, as a pure function of
// the assembly, its current solution and the drag (a world motion).
//
// The rule is Onshape's: the dragged instance moves as its own mate allows,
// and each instance mated to it stays where it is wherever ITS mate allows —
// only the motion that mate forbids carries it along. So dragging a part along
// the plane of a planar mate slides it under its neighbour, while pushing it
// off the plane takes the neighbour with it. Instances further along the tree
// keep their mates' values, so they follow their own neighbour.
//
// A part inside a loop group (solve.ts) has no one mate to move along: the
// group is re-solved with the part pulled toward the drag and every other part
// of the group held, softly, where it was. So a four-bar's coupler drags the
// crank and rocker round as far as their mates let it, and moves them as
// little as it can.
//
// A DOF a relation drives (a gear, a rack) isn't written: its driver is, by
// what puts the driven DOF where the drag took it (routeToDriver), so turning
// either of two meshed gears turns both.
//
// Everything a drag writes is mate values (rounded as they're stored) or
// placements, so a preview of the result is exactly what letting go commits.
import { evaluateVariables } from "../document/document";
import type { Scope } from "../document/expression";
import { keepPlacements, moveInstance, updateMate } from "./assembly";
import { multiply } from "./placement";
import { clearExpressions, clearMessage, standingExpressions } from "./loopInput";
import { relationDriving, routeToDriver } from "./relations";
import { formatValue, isDriven, isRotation, MATE_DOFS, mateValues, solve, valuesForPose, type Solution } from "./solve";
import type { AssemblyDoc, Dof, Mat4, Mate, MateConnector } from "./types";

export { formatValue };

type FrameOf = (c: MateConnector) => Mat4 | string;

/** The first free DOF of `mate` whose value is an expression: the user's, which
 *  a drag doesn't overwrite. */
const expressionDof = (mate: Mate): Dof | undefined => MATE_DOFS[mate.type].find((d) => isDriven(mate, d));

/** `mate`'s values that put its `b` side at `tb` against `a` at `ta`, projected
 *  onto its free DOFs, clamped to its limits and rounded as stored. Null when
 *  they can't be written. */
function fitValues(
  mate: Mate,
  frameOf: FrameOf,
  ta: Mat4,
  tb: Mat4,
  previous: Partial<Record<Dof, number>>,
  scope: Scope,
): Partial<Record<Dof, string>> | null {
  const ca = frameOf(mate.a);
  const cb = frameOf(mate.b);
  if (typeof ca === "string" || typeof cb === "string") return null;
  const dofs = MATE_DOFS[mate.type];
  const got = valuesForPose(mate, ca, cb, ta, tb, previous);
  let clamped: Partial<Record<Dof, number>>;
  try {
    // Limits may name the assembly's variables.
    clamped = mateValues({ ...mate, values: Object.fromEntries(dofs.map((d) => [d, String(got[d] ?? 0)])) }, scope);
  } catch {
    return null;
  }
  const values: Partial<Record<Dof, string>> = {};
  for (const d of dofs) values[d] = formatValue(clamped[d] ?? 0, isRotation(d));
  return values;
}

/** The assembly after dragging `instanceId` by the world motion `motion`, or
 *  an error saying why the drag can't be written (its mate's value is an
 *  expression). `next` is null when nothing can be written. */
export function dragAssembly(
  assembly: AssemblyDoc,
  solution: Solution,
  frameOf: FrameOf,
  instanceId: string,
  motion: Mat4,
): DragResult {
  const before = (id: string) => solution.placements.get(id);
  const scope = evaluateVariables(assembly.variables).scope;
  const name = assembly.instances.find((i) => i.id === instanceId)?.name ?? "it";
  let next: AssemblyDoc;

  // Inside a loop group: re-solve with a pull toward the drag. Every
  // placement is stored, so the next solve starts (and stays) there.
  const was = before(instanceId);
  const group = was ? solution.loops.find((l) => l.free.includes(instanceId)) : undefined;
  if (was && group) {
    const target = multiply(motion, was);
    const goals = new Map([[instanceId, target]]);
    const kept = solve(assembly, frameOf, scope, { goals });
    // An expression in the group may hold the part back: if clearing them
    // lets it go noticeably closer to the drag, that's the drag — with the
    // expressions that had to change named, for the user to confirm.
    const standing = standingExpressions(assembly, new Set(group.mateIds));
    const miss = (s: Solution) => poseGap(s.placements.get(instanceId), target);
    if (standing.length && miss(kept) > NEAR) {
      const free = clearExpressions(assembly, standing, solution);
      const s = solve(free, frameOf, scope, { goals });
      if (miss(s) < miss(kept) - NEAR) {
        const moved = standing.filter(
          (c) => Math.abs((s.values.get(c.mateId)?.[c.dof] ?? 0) - (kept.values.get(c.mateId)?.[c.dof] ?? 0)) > 1e-3,
        );
        const clears = moved.length ? moved : standing;
        const nextFree = clearExpressions(assembly, clears, solution);
        const s2 = clears === standing ? s : solve(nextFree, frameOf, scope, { goals });
        return {
          next: keepPlacements(nextFree, s2.placements),
          error: null,
          confirm: clearMessage(assembly, `move ${name} there`, clears),
        };
      }
    }
    return { next: keepPlacements(assembly, kept.placements), error: null };
  }

  // The dragged instance: along its own mate, or freely when nothing drives it.
  const by = solution.drivenBy.get(instanceId);
  let own = by && assembly.mates.find((m) => m.id === by.mateId);
  let confirm: string | undefined;
  if (by && own) {
    // Its own mate's expressions are standing inputs the drag overrides:
    // cleared, once the user confirms.
    const exprs = standingExpressions(assembly, new Set([own.id]));
    if (exprs.length) {
      confirm = clearMessage(assembly, `move ${name} there`, exprs);
      assembly = clearExpressions(assembly, exprs, solution);
      own = assembly.mates.find((m) => m.id === by.mateId)!;
    }
    const pa = before(own.a.instanceId);
    const pb = before(own.b.instanceId);
    if (!pa || !pb) return { next: null, error: null };
    const ta = by.reversed ? multiply(motion, pa) : pa;
    const tb = by.reversed ? pb : multiply(motion, pb);
    const values = fitValues(own, frameOf, ta, tb, solution.values.get(own.id) ?? {}, scope);
    if (!values) return { next: null, error: null };
    const routed = throughDrivers(assembly, own, values, solution.values.get(own.id) ?? {}, scope);
    if ("error" in routed) return { next: null, error: routed.error };
    next = routed.next;
  } else {
    next = moveInstance(assembly, instanceId, motion);
  }

  // Where that leaves it — then each instance it drives keeps its place as
  // far as its mate allows.
  const moved = solve(next, frameOf).placements.get(instanceId);
  if (!moved) return { next, error: null, ...(confirm ? { confirm } : {}) };
  for (const [childId, cb] of solution.drivenBy) {
    if (childId === instanceId) continue;
    const mate = next.mates.find((m) => m.id === cb.mateId);
    if (!mate || MATE_DOFS[mate.type].length === 0 || expressionDof(mate)) continue;
    const parent = cb.reversed ? mate.b.instanceId : mate.a.instanceId;
    const stay = before(childId);
    if (parent !== instanceId || !stay) continue;
    const values = fitValues(
      mate,
      frameOf,
      cb.reversed ? stay : moved,
      cb.reversed ? moved : stay,
      solution.values.get(mate.id) ?? {},
      scope,
    );
    if (!values) continue;
    // What a relation drives follows its driver, not the drag.
    for (const d of MATE_DOFS[mate.type])
      if (relationDriving(next, mate.id, d)) {
        if (mate.values?.[d] !== undefined) values[d] = mate.values[d];
        else delete values[d];
      }
    next = updateMate(next, { ...mate, values });
  }
  return { next, error: null, ...(confirm ? { confirm } : {}) };
}

/** What a drag leads to: the assembly to commit (null: nothing to write), why
 *  it can't be, and — when it clears an expression to get there — what to ask
 *  the user before committing. */
export interface DragResult {
  next: AssemblyDoc | null;
  error: string | null;
  confirm?: string;
}

/** How far (mm, plus the turn as mm at a 10 mm radius) a drag's pose is from
 *  its target. */
const NEAR = 0.01;
function poseGap(p: Mat4 | undefined, q: Mat4): number {
  if (!p) return Infinity;
  const t = Math.hypot(p[12] - q[12], p[13] - q[13], p[14] - q[14]);
  let r = 0;
  for (const i of [0, 1, 2, 4, 5, 6, 8, 9, 10]) r = Math.max(r, Math.abs(p[i] - q[i]));
  return t + 10 * r;
}

/** `a` with `mate` set to `values` — except that a DOF a relation drives keeps
 *  its own value (its phase), and if the drag moved it (from `current`, where
 *  it is now), its driver, followed back to the root of a gear train, is set
 *  to what puts it at the new value instead. A screw within one cylindrical
 *  mate turns when it's turned, as its slide didn't change. */
function throughDrivers(
  a: AssemblyDoc,
  mate: Mate,
  values: Partial<Record<Dof, string>>,
  current: Partial<Record<Dof, number>>,
  scope: Scope,
): { next: AssemblyDoc } | { error: string } {
  const own: Partial<Record<Dof, string>> = { ...values };
  const roots: { mateId: string; dof: Dof; value: number }[] = [];
  for (const d of MATE_DOFS[mate.type]) {
    if (!relationDriving(a, mate.id, d)) continue;
    const want = Number(values[d] ?? 0);
    const moved = Math.abs(want - (current[d] ?? 0)) > (isRotation(d) ? 0.005 : 0.0005);
    if (mate.values?.[d] !== undefined) own[d] = mate.values[d];
    else delete own[d];
    if (!moved) continue;
    const r = routeToDriver(a, mate.id, d, want, scope);
    if ("error" in r) return r;
    roots.push(r);
  }
  let next = updateMate(a, { ...mate, values: own });
  for (const r of roots) {
    const m = next.mates.find((x) => x.id === r.mateId);
    if (m) next = updateMate(next, { ...m, values: { ...m.values, [r.dof]: formatValue(r.value, isRotation(r.dof)) } });
  }
  return { next };
}
