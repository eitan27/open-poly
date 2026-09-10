// Dimensions that keep following their variables.
//
// A dimension is typed as text — "40", "w", "wall * 2" — but the solver needs a
// number, so the constraint stores one. Storing ONLY the number is what made a
// dimension a one-time evaluation: type `w` while `w = 40` and the sketch is
// pinned at 40 forever, with nothing left in the document connecting it to `w`.
//
// So an expression-backed dimension keeps the text beside the number: `value` is
// still what the solver reads (and what every existing reader keeps reading, so
// old documents load unchanged), and `expr` is the link that lets the value be
// recomputed when the variables move.

import { evaluateExpression, type Scope } from "./expression";
import type { SketchConstraint } from "./types";

/** The constraints that carry a number a user typed — the ones a variable can
 *  drive. (The geometric ones — parallel, tangent, coincident… — have no value
 *  to link.) */
export type DimensionConstraint = Extract<SketchConstraint, { value: number }>;

export function isDimension(c: SketchConstraint): c is DimensionConstraint {
  return "value" in c && typeof (c as { value?: unknown }).value === "number";
}

/** Whether typed text is worth REMEMBERING as an expression: only text that
 *  names something. "40" and "12 * 2" evaluate the same forever, so storing
 *  them would put dead weight in every document and make every dimension look
 *  linked when none of them are. */
export function isVariableExpression(text: string): boolean {
  return /[A-Za-z_]/.test(text);
}

/** What a dimension of this kind is allowed to be. A variable that dips to 0
 *  (or is mid-retype, or gets deleted) must not be allowed to collapse or
 *  invert geometry — the last good value stays instead. Mirrors the checks the
 *  dimension input applies when the value is first entered. */
export function dimensionValueOk(c: DimensionConstraint, value: number): boolean {
  if (!Number.isFinite(value)) return false;
  return c.type === "angle" ? value >= 0 && value < 180 : value > 0;
}

/** The value an expression-backed constraint should have under `scope`, or null
 *  if it isn't expression-backed, doesn't evaluate, or would be out of range. */
export function relinkedValue(c: SketchConstraint, scope: Scope): number | null {
  if (!isDimension(c) || !c.expr) return null;
  let next: number;
  try {
    next = evaluateExpression(c.expr, scope);
  } catch {
    return null; // unknown/renamed/half-typed variable — keep the last good value
  }
  return dimensionValueOk(c, next) ? next : null;
}

/** Re-evaluate every expression-backed dimension against the current variables.
 *  Returns the updated constraint list, or **null when nothing moved** — the
 *  common case by far, and the signal callers use to skip an expensive re-solve
 *  (and to terminate: re-running this on its own output changes nothing). */
export function relinkDimensions(constraints: SketchConstraint[], scope: Scope): SketchConstraint[] | null {
  let changed = false;
  const next = constraints.map((c) => {
    const value = relinkedValue(c, scope);
    if (value === null || value === (c as DimensionConstraint).value) return c;
    changed = true;
    return { ...c, value };
  });
  return changed ? next : null;
}

/** Every sketch id whose dimensions would move under `scope` — what to re-solve
 *  after a variable edit, and nothing more. */
export function sketchesNeedingRelink(
  features: { id: string; type: string; constraints?: SketchConstraint[] }[],
  scope: Scope,
): string[] {
  return features
    .filter((f) => f.type === "sketch" && f.constraints && relinkDimensions(f.constraints, scope) !== null)
    .map((f) => f.id);
}
