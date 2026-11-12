// A value typed into a mate inside a loop group (docs/ASSEMBLY-PLAN.md,
// Solver). There a plain number only reports where its parts are, so typing
// one would change nothing. Instead the typed value drives one solve, with
// every other part of the group held softly where it is: the group moves as
// little as it can, so an earlier entry is overridden only when the loop
// forces it. The result is kept as plain numbers, so the next drag or entry
// can move the group again.
//
// An expression elsewhere in the group is a standing input, applied on every
// solve, and may leave the typed value nowhere to go. Then the fewest
// expressions that must go are named, and the edit waits for the user's (or
// the agent's) consent to replace them with plain numbers. A relation driving
// a DOF in the group is part of how the mechanism is built: it's never
// cleared, and a value it blocks is refused. So is one the group can't reach
// even with every expression cleared.
import { keepSolved } from "./assembly";
import { dofLabel } from "./mateTypes";
import { relationDriving } from "./relations";
import { formatValue, isDriven, isRotation, MATE_DOFS, solve, type Drive, type Solution } from "./solve";
import type { AssemblyDoc, Dof, Mat4, Mate, MateConnector } from "./types";
import type { Scope } from "../document/expression";

/** One value typed: `text` as the user gave it ("" resets to 0). */
export interface LoopEntry {
  mateId: string;
  dof: Dof;
  text: string;
}

/** An expression the input needs cleared: where it is, and what it said. */
export interface ClearedExpression {
  mateId: string;
  dof: Dof;
  expression: string;
}

export type LoopInputPlan =
  /** Apply `next`. */
  | { next: AssemblyDoc }
  /** Apply `next` only with consent: it clears these expressions. */
  | { next: AssemblyDoc; clears: ClearedExpression[]; message: string }
  | { error: string };

const plain = (t: string) => !t.trim() || Number.isFinite(Number(t));

/** The loop group a mate is in, if any. */
export function loopOf(solution: Pick<Solution, "loops">, mateId: string) {
  return solution.loops.find((l) => l.mateIds.includes(mateId));
}

/** "the Angle of Revolute 1 (Crank ↔ Ground)". */
export function whereIs(a: AssemblyDoc, mateId: string, dof: Dof): string {
  const m = a.mates.find((x) => x.id === mateId);
  if (!m) return `${dof} of a removed mate`;
  const name = (id: string) => a.instances.find((i) => i.id === id)?.name ?? "?";
  const label = dofLabel(m.type, dof).replace(/ \(.*\)$/, "");
  return `the ${label} of ${m.name} (${name(m.a.instanceId)} ↔ ${name(m.b.instanceId)})`;
}

const withValue = (a: AssemblyDoc, mateId: string, dof: Dof, text: string): AssemblyDoc => ({
  ...a,
  mates: a.mates.map((m) => {
    if (m.id !== mateId) return m;
    const values = { ...m.values };
    if (text.trim()) values[dof] = text;
    else delete values[dof];
    const { values: _v, ...rest } = m;
    return (Object.keys(values).length ? { ...rest, values } : rest) as Mate;
  }),
});

/** Plan typed values on mates inside a loop group. `assembly` is as it is
 *  now (its placements the solved ones: start from keepSolved), `solution`
 *  its solve. Null when no entry's mate is in a loop group, or one is driven
 *  by a relation: the caller sets those as it would anywhere. */
export function planLoopInput(
  assembly: AssemblyDoc,
  solution: Solution,
  frameOf: (c: MateConnector) => Mat4 | string,
  scope: Scope,
  entries: LoopEntry[],
): LoopInputPlan | null {
  const loop = entries.map((e) => loopOf(solution, e.mateId)).find((l) => l);
  if (!loop || entries.some((e) => relationDriving(assembly, e.mateId, e.dof))) return null;
  for (const e of entries) {
    const m = assembly.mates.find((x) => x.id === e.mateId);
    if (!m) return { error: `No mate "${e.mateId}".` };
    if (!MATE_DOFS[m.type].includes(e.dof))
      return { error: `${m.name} is ${m.type}: it leaves ${MATE_DOFS[m.type].join(", ")} free, not ${e.dof}.` };
  }

  let typed = assembly;
  for (const e of entries) typed = withValue(typed, e.mateId, e.dof, e.text);
  // A plain number drives this solve only; an expression drives every solve.
  const drives: Drive[] = [];
  for (const e of entries)
    if (plain(e.text)) drives.push({ mateId: e.mateId, dof: e.dof, value: e.text.trim() ? Number(e.text) : 0 });

  const groupMates = new Set(loop.mateIds);
  const run = (a: AssemblyDoc) => {
    const s = solve(a, frameOf, scope, { drive: drives, hold: true });
    const bad = [...s.problems].find(([id]) => groupMates.has(id) && !solution.problems.has(id));
    return { s, bad: bad?.[1] };
  };
  const first = run(typed);
  if (!first.bad) return { next: keepSolved(typed, first.s) };

  // Standing inputs elsewhere in the group: its expressions, but not the
  // values being typed, and never a relation's.
  const typedKey = new Set(entries.map((e) => `${e.mateId}:${e.dof}`));
  const standing = standingExpressions(typed, groupMates).filter((c) => !typedKey.has(`${c.mateId}:${c.dof}`));
  const cleared = (list: ClearedExpression[]) => clearExpressions(typed, list, solution);
  const what = entries
    .map((e) => `${whereIs(assembly, e.mateId, e.dof)} to ${e.text.trim() || "0"}${isRotation(e.dof) ? "°" : " mm"}`)
    .join(" and ");

  // Out of reach even with every expression gone: nothing to ask about.
  const all = run(cleared(standing));
  if (all.bad) return { error: `Can't set ${what}: ${all.bad}` };

  // The fewest to clear: one, if one will do; else all of them.
  let clears = standing;
  let result = all;
  for (const c of standing) {
    const r = run(cleared([c]));
    if (!r.bad) {
      clears = [c];
      result = r;
      break;
    }
  }
  return {
    next: keepSolved(cleared(clears), result.s),
    clears,
    message: clearMessage(assembly, `set ${what}`, clears),
  };
}

/** `a` with each expression in `list` replaced by the plain number it's at
 *  now (in `solution`). */
export function clearExpressions(
  a: AssemblyDoc,
  list: readonly ClearedExpression[],
  solution: Pick<Solution, "values">,
): AssemblyDoc {
  let out = a;
  for (const c of list) {
    const now = solution.values.get(c.mateId)?.[c.dof] ?? 0;
    out = withValue(out, c.mateId, c.dof, formatValue(now, isRotation(c.dof)));
  }
  return out;
}

/** The expressions on `mates` (ids): standing inputs, which a typed value or
 *  a drag may need cleared. */
export function standingExpressions(a: AssemblyDoc, mates: ReadonlySet<string>): ClearedExpression[] {
  const out: ClearedExpression[] = [];
  for (const m of a.mates) {
    if (!mates.has(m.id) || m.suppressed) continue;
    for (const d of MATE_DOFS[m.type])
      if (isDriven(m, d) && !relationDriving(a, m.id, d))
        out.push({ mateId: m.id, dof: d, expression: m.values![d]!.trim() });
  }
  return out;
}

/** "To <doing>, the expression `angle` on the Angle of Revolute 1 (Crank ↔
 *  Ground) will be cleared: it becomes a plain number." */
export function clearMessage(a: AssemblyDoc, doing: string, clears: readonly ClearedExpression[]): string {
  const named = clears.map((c) => `the expression \`${c.expression}\` on ${whereIs(a, c.mateId, c.dof)}`);
  return (
    `To ${doing}, ${named.join(" and ")} will be cleared: ` +
    `${clears.length > 1 ? "they become plain numbers" : "it becomes a plain number"}.`
  );
}
