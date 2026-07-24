// Validation + error copy for the Shell thickness field. Split out of App.tsx
// so the per-scenario behavior can be unit-tested directly — mirrors
// dressUpValidation.ts for chamfer/fillet.

import { evaluateExpression, type Scope } from "./expression";

/** Synchronous, kernel-free validation of a Shell thickness field. Returns a
 *  human-readable `error` to show (or null) and the resolved `value` when it's
 *  a number worth sending to the kernel — `value` is null whenever we should
 *  NOT build (empty, unparseable, or ≤ 0), so a blank/garbage thickness never
 *  reaches OCCT. An empty field is intentionally errorless (value null, error
 *  null): the button is disabled but nothing is flagged as wrong. */
export function validateShellThickness(
  thickness: string,
  scope: Scope,
): { error: string | null; value: number | null } {
  if (thickness.trim() === "") return { error: null, value: null };
  let value: number;
  try {
    value = evaluateExpression(thickness, scope);
  } catch (e) {
    const msg = String((e as Error)?.message ?? e).replace(/^Unknown name /, "Unknown variable ");
    return { error: msg, value: null };
  }
  if (value <= 0) return { error: "Thickness must be greater than 0.", value: null };
  return { error: null, value };
}

/** Translate a kernel/OCCT build failure for a *valid positive* Shell
 *  thickness into actionable copy. A raw OCCT exception (a decoded type name +
 *  heap pointer) is meaningless to users; for a thickness that parsed fine,
 *  the failure is almost always that it's too thick for the body (walls would
 *  collide) or too thin for the picked faces' geometry. Already-readable
 *  (non-OCCT) messages pass through unchanged. */
export function mapShellKernelError(raw: string): string {
  if (/OutOfMemory/i.test(raw)) return "This operation ran out of memory — try a smaller thickness.";
  if (/OCCT|exception/i.test(raw)) {
    return "That thickness doesn't work for this body — the walls may collide or the picked faces may be too small. Try a smaller value.";
  }
  return raw;
}
