// Validation + error copy for the Pattern dialog. Split out of App.tsx so the
// per-scenario behavior can be unit-tested directly — mirrors shellValidation.ts
// and dressUpValidation.ts.

import { resolvePatternCount } from "./derived";
import { evaluateExpression, type Scope } from "./expression";

/** Only the fields the validation reads, so this module does not depend on the
 *  dialog's own state type (which lives in the hook that owns it). */
export interface PatternDraft {
  kind: "linear" | "circular";
  targetId: string | null;
  count1: string;
  spacing1: string;
  dir2on: boolean;
  dir2: unknown | null;
  count2: string;
  spacing2: string;
  count: string;
  mode: "full" | "angle";
  angle: string;
}

/** A spacing or angle has to be a real, non-zero number: zero spacing stacks every
 *  copy on the original, and a zero sweep puts them all in one place. */
const nonZero = (expr: string, scope: Scope): boolean => {
  let v: number;
  try {
    v = evaluateExpression(expr, scope);
  } catch {
    return false;
  }
  return Number.isFinite(v) && Math.abs(v) > 1e-9;
};

/** Why this pattern cannot be built yet, as something to show the user — or null
 *  when it can. The dialog's primary button and its live-edit preview both stand
 *  down while this is set, so a half-filled dialog neither builds nor nags. */
export function patternDialogWarning(d: PatternDraft | null, scope: Scope): string | null {
  if (!d) return null;
  if (!d.targetId) return "Pick a body to pattern.";
  const badCount = (expr: string) => resolvePatternCount(expr, scope) === null;

  if (d.kind === "linear") {
    if (badCount(d.count1)) return "Count must be 2 or more.";
    if (!nonZero(d.spacing1, scope)) return "Spacing must be a non-zero number.";
    if (d.dir2on) {
      if (!d.dir2) return "Pick the second direction (or collapse it).";
      if (badCount(d.count2)) return "The second count must be 2 or more.";
      if (!nonZero(d.spacing2, scope)) return "The second spacing must be a non-zero number.";
    }
    return null;
  }

  if (badCount(d.count)) return "Count must be 2 or more.";
  // A full turn always sweeps 360°, so only an explicit angle can be degenerate.
  if (d.mode === "angle" && !nonZero(d.angle, scope)) return "Angle must be a non-zero number.";
  return null;
}
