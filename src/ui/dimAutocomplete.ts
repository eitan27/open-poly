// Variable-name autocomplete for the dimension value field: what identifier is
// being typed, which variables could complete it, and how to splice one in.
//
// Beside `DimValueInput.tsx` rather than inside it because a file that exports both
// a component and plain functions loses Fast Refresh for the whole module — the
// same split `viewport/types.ts` got, for the same reason. These were already the
// only tested part of that file.
import type { VarOption } from "./DimValueInput";

/** The identifier being typed at the end of `value` (what we'd complete
 *  against). Empty for a bare number or a trailing operator/space. */
export function trailingToken(value: string): string {
  return value.match(/[A-Za-z_][A-Za-z0-9_]*$/)?.[0] ?? "";
}

/** Variables whose name starts with the trailing identifier in `value` (and
 *  isn't already fully typed), best-first, capped for the dropdown. */
export function matchVariables(value: string, variables: VarOption[]): VarOption[] {
  const token = trailingToken(value);
  if (!token) return [];
  const lower = token.toLowerCase();
  return variables.filter((v) => v.name.toLowerCase().startsWith(lower) && v.name !== token).slice(0, 6);
}

/** Replace the trailing identifier in `value` with `name`. */
export function completeWith(value: string, name: string): string {
  return value.slice(0, value.length - trailingToken(value).length) + name;
}
