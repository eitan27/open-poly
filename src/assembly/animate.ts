// Animating a mate: one free DOF swept from a value to another over a time,
// once, looping or bouncing. Pure, so the timing and the per-frame solve are
// testable; useMateAnimation runs it on requestAnimationFrame.
//
// Nothing here writes the document. Each frame is a solve with the DOF set
// through SolveOptions.drive, which drives a loop group as an expression would,
// so animating a four-bar's crank turns the whole linkage. Each frame starts
// from the one before (its placements are the next solve's seed), so a loop
// follows the branch it's on instead of flipping to another.
import { keepPlacements } from "./assembly";
import { formatValue, isRotation, MATE_DOFS, solve, type Solution } from "./solve";
import type { AssemblyDoc, Dof, Mat4, Mate, MateConnector } from "./types";
import type { Scope } from "../document/expression";
import { evaluateExpression } from "../document/expression";

export type AnimateMode = "once" | "loop" | "bounce";

export interface AnimateSpec {
  mateId: string;
  dof: Dof;
  from: number;
  to: number;
  /** One sweep from `from` to `to`. */
  seconds: number;
  mode: AnimateMode;
}

/** How far through the sweep `t` seconds in is, 0–1, and whether a "once"
 *  animation has finished. Loop restarts from `from`; bounce comes back. */
export function phase(t: number, seconds: number, mode: AnimateMode): { u: number; done: boolean } {
  if (!(seconds > 0)) return { u: 1, done: mode === "once" };
  const k = Math.max(0, t) / seconds;
  if (mode === "once") return k >= 1 ? { u: 1, done: true } : { u: k, done: false };
  if (mode === "loop") return { u: k - Math.floor(k), done: false };
  const b = k % 2;
  return { u: b <= 1 ? b : 2 - b, done: false };
}

/** The DOF's value `t` seconds in. */
export function valueAt(spec: AnimateSpec, t: number): { value: number; done: boolean } {
  const { u, done } = phase(t, spec.seconds, spec.mode);
  return { value: spec.from + (spec.to - spec.from) * u, done };
}

/** The sweep the Animate dialog starts with for `dof`: between its limits when
 *  both are set, else from where it is now a full turn (a rotation, looping) or
 *  20 mm (a translation, bouncing). */
export function defaultSpec(mate: Mate, dof: Dof, current: number, scope: Scope): AnimateSpec {
  const lim = mate.limits?.[dof];
  const num = (t?: string) => {
    if (!t?.trim()) return undefined;
    try {
      return evaluateExpression(t, scope);
    } catch {
      return undefined;
    }
  };
  const min = num(lim?.min);
  const max = num(lim?.max);
  const rot = isRotation(dof);
  const round = (v: number) => Number(formatValue(v, rot));
  if (min !== undefined && max !== undefined && min < max)
    return { mateId: mate.id, dof, from: min, to: max, seconds: 2, mode: "bounce" };
  return rot
    ? { mateId: mate.id, dof, from: round(current), to: round(current + 360), seconds: 4, mode: "loop" }
    : { mateId: mate.id, dof, from: round(current), to: round(current + 20), seconds: 2, mode: "bounce" };
}

/** The DOFs of `mate` an animation can sweep: all its free ones. */
export const animatableDofs = (mate: Mate): Dof[] => MATE_DOFS[mate.type];

/** Steps an animation frame by frame: each `at(value)` solves the assembly with
 *  the DOF at `value`, seeded from the previous frame. Connector frames are
 *  worked out once, on the first frame that needs them: nothing that moves
 *  them changes while an animation runs. */
export function animator(
  assembly: AssemblyDoc,
  frameOf: (c: MateConnector) => Mat4 | string,
  spec: Pick<AnimateSpec, "mateId" | "dof">,
  scope?: Scope,
): { at(value: number): Solution } {
  const frames = new Map<string, Mat4 | string>();
  const key = (c: MateConnector) => JSON.stringify(c);
  const cached = (c: MateConnector) => {
    const k = key(c);
    let f = frames.get(k);
    if (f === undefined) frames.set(k, (f = frameOf(c)));
    return f;
  };
  let seed = assembly;
  return {
    at(value) {
      const s = solve(seed, cached, scope, { drive: { mateId: spec.mateId, dof: spec.dof, value } });
      seed = keepPlacements(seed, s.placements);
      return s;
    },
  };
}
