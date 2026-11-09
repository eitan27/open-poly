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
// Everything a drag writes is mate values (rounded as they're stored) or
// placements, so a preview of the result is exactly what letting go commits.
import { evaluateVariables } from "../document/document";
import type { Scope } from "../document/expression";
import { keepPlacements, moveInstance, updateMate } from "./assembly";
import { multiply } from "./placement";
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
): { next: AssemblyDoc | null; error: string | null } {
  const before = (id: string) => solution.placements.get(id);
  const scope = evaluateVariables(assembly.variables).scope;
  let next: AssemblyDoc;

  // Inside a loop group: re-solve with a pull toward the drag. Every
  // placement is stored, so the next solve starts (and stays) there.
  const was = before(instanceId);
  if (was && solution.loops.some((l) => l.free.includes(instanceId))) {
    const s = solve(assembly, frameOf, scope, { goals: new Map([[instanceId, multiply(motion, was)]]) });
    return { next: keepPlacements(assembly, s.placements), error: null };
  }

  // The dragged instance: along its own mate, or freely when nothing drives it.
  const by = solution.drivenBy.get(instanceId);
  const own = by && assembly.mates.find((m) => m.id === by.mateId);
  if (by && own) {
    const fixed = expressionDof(own);
    if (fixed)
      return {
        next: null,
        error: `${own.name}'s ${fixed} is set by "${own.values![fixed]}", so dragging can't change it.`,
      };
    const pa = before(own.a.instanceId);
    const pb = before(own.b.instanceId);
    if (!pa || !pb) return { next: null, error: null };
    const ta = by.reversed ? multiply(motion, pa) : pa;
    const tb = by.reversed ? pb : multiply(motion, pb);
    const values = fitValues(own, frameOf, ta, tb, solution.values.get(own.id) ?? {}, scope);
    if (!values) return { next: null, error: null };
    next = updateMate(assembly, { ...own, values });
  } else {
    next = moveInstance(assembly, instanceId, motion);
  }

  // Where that leaves it — then each instance it drives keeps its place as
  // far as its mate allows.
  const moved = solve(next, frameOf).placements.get(instanceId);
  if (!moved) return { next, error: null };
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
    if (values) next = updateMate(next, { ...mate, values });
  }
  return { next, error: null };
}
