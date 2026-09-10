// The shared core behind every dialog's numeric expression field (chamfer/fillet
// size + angle, Shell thickness, Extrude distance). Each feature keeps its own
// thin validator for its label and its own bounds; the parsing, the
// empty-is-errorless rule and the parser-message rewording live here once.

import { evaluateExpression, type Scope } from "./expression";

/** What a field validator reports: a human-readable `error` to show (or null),
 *  and the resolved `value` when it's a number worth sending to the kernel.
 *  `value` is null whenever we should NOT build. */
export interface FieldResult {
  error: string | null;
  value: number | null;
}

/** Evaluate an expression field. An empty field is intentionally errorless
 *  (value null, error null): the button is disabled but nothing is flagged as
 *  wrong. A parse failure keeps the parser's own message — with its specific
 *  token/character — but rewords "name" → "variable", which is what an unknown
 *  identifier means to a user. */
export function parseNumericField(text: string, scope: Scope): FieldResult {
  if (text.trim() === "") return { error: null, value: null };
  try {
    return { error: null, value: evaluateExpression(text, scope) };
  } catch (e) {
    const msg = String((e as Error)?.message ?? e).replace(/^Unknown name /, "Unknown variable ");
    return { error: msg, value: null };
  }
}

/** `parseNumericField` plus the "> 0" rule every length field shares, so a
 *  blank/garbage/degenerate value never reaches OCCT (which builds a collapsed
 *  or inverted shape happily, or throws a raw exception). `label` names the
 *  field in the message, e.g. "Distance must be greater than 0.". */
export function validatePositiveField(text: string, scope: Scope, label: string): FieldResult {
  const parsed = parseNumericField(text, scope);
  if (parsed.value === null) return parsed;
  if (!(parsed.value > 0)) return { error: `${label} must be greater than 0.`, value: null };
  return parsed;
}
