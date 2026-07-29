// Validation + error copy for the chamfer/fillet (dress-up) size field. Split
// out of App.tsx so the per-scenario behavior can be unit-tested directly.

import { evaluateExpression, type Scope } from "./expression";

/** Synchronous, kernel-free validation of a chamfer/fillet size field. Returns a
 *  human-readable `error` to show (or null) and the resolved `value` when it's a
 *  number worth sending to the kernel — `value` is null whenever we should NOT
 *  build (empty, unparseable, or ≤ 0), so a blank/garbage size never reaches OCCT.
 *  An empty field is intentionally errorless (value null, error null): the button
 *  is disabled but nothing is flagged as wrong. */
export function validateDressUpSize(
  size: string,
  scope: Scope,
  op: "chamfer" | "fillet",
): { error: string | null; value: number | null } {
  const label = op === "chamfer" ? "Distance" : "Radius";
  if (size.trim() === "") return { error: null, value: null };
  let value: number;
  try {
    value = evaluateExpression(size, scope);
  } catch (e) {
    // Surface the parser's message, keeping its specific token/character, but
    // reword "name" → "variable" (what an unknown identifier means to a user).
    const msg = String((e as Error)?.message ?? e).replace(/^Unknown name /, "Unknown variable ");
    return { error: msg, value: null };
  }
  if (value <= 0) return { error: `${label} must be greater than 0.`, value: null };
  return { error: null, value };
}

/** Synchronous, kernel-free validation of the chamfer angle field (degrees from
 *  the reference face). Mirrors `validateDressUpSize`: an empty field is
 *  errorless with a null value (the button is disabled, nothing is built), and a
 *  parse failure keeps the parser's wording. OCCT can only build a bevel that
 *  actually leaves both faces, so the angle must be strictly between 0 and 90. */
export function validateDressUpAngle(angle: string, scope: Scope): { error: string | null; value: number | null } {
  if (angle.trim() === "") return { error: null, value: null };
  let value: number;
  try {
    value = evaluateExpression(angle, scope);
  } catch (e) {
    const msg = String((e as Error)?.message ?? e).replace(/^Unknown name /, "Unknown variable ");
    return { error: msg, value: null };
  }
  if (value <= 0 || value >= 90) return { error: "Angle must be between 0 and 90°.", value: null };
  return { error: null, value };
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
