// Validation + error copy for the chamfer/fillet (dress-up) size field. Split
// out of App.tsx so the per-scenario behavior can be unit-tested directly.

import { type Scope } from "./expression";
import { parseNumericField, validatePositiveField, type FieldResult } from "./numericField";

/** Synchronous, kernel-free validation of a chamfer/fillet size field. Returns a
 *  human-readable `error` to show (or null) and the resolved `value` when it's a
 *  number worth sending to the kernel — `value` is null whenever we should NOT
 *  build (empty, unparseable, or ≤ 0), so a blank/garbage size never reaches OCCT.
 *  An empty field is intentionally errorless (value null, error null): the button
 *  is disabled but nothing is flagged as wrong. */
export function validateDressUpSize(size: string, scope: Scope, op: "chamfer" | "fillet"): FieldResult {
  return validatePositiveField(size, scope, op === "chamfer" ? "Distance" : "Radius");
}

/** Synchronous, kernel-free validation of the chamfer angle field (degrees from
 *  the reference face). Mirrors `validateDressUpSize`: an empty field is
 *  errorless with a null value (the button is disabled, nothing is built), and a
 *  parse failure keeps the parser's wording. OCCT can only build a bevel that
 *  actually leaves both faces, so the angle must be strictly between 0 and 90. */
export function validateDressUpAngle(angle: string, scope: Scope): FieldResult {
  const parsed = parseNumericField(angle, scope);
  if (parsed.value === null) return parsed;
  if (parsed.value <= 0 || parsed.value >= 90) return { error: "Angle must be between 0 and 90°.", value: null };
  return parsed;
}

/** Translate a kernel/OCCT build failure for a *valid positive* chamfer/fillet
 *  size into actionable copy. A raw OCCT exception (a decoded type name + heap
 *  pointer) is meaningless to users; for a size that parsed fine, the failure is
 *  almost always that it doesn't fit the picked edges. Already-readable
 *  (non-OCCT) messages pass through unchanged. */
export function mapDressUpKernelError(raw: string, op: "chamfer" | "fillet"): string {
  const label = op === "chamfer" ? "distance" : "radius";
  if (/OutOfMemory/i.test(raw)) return "This operation ran out of memory — try a smaller value.";
  if (/OCCT|exception/i.test(raw)) {
    return `That ${label} is too large for the selected edge(s) — try a smaller value.`;
  }
  return raw;
}

/** Both fields a dress-up dialog can get wrong, checked in the order the dialog
 *  shows them: the size first, then (chamfer only) the bevel angle — a fillet has
 *  no bevel to tilt. Returns the first failure, else the size's own result, so
 *  callers get a usable `value` when everything passes.
 *
 *  Shared by the commit and by the live-validate effect, so the dialog cannot
 *  commit something its own preview refused. */
export function validateDressUpDialog(
  d: { op: "chamfer" | "fillet"; size: string; angle: string },
  scope: Scope,
): FieldResult {
  const size = validateDressUpSize(d.size, scope, d.op);
  if (size.value === null || d.op !== "chamfer") return size;
  const angle = validateDressUpAngle(d.angle, scope);
  return angle.value === null ? angle : size;
}
