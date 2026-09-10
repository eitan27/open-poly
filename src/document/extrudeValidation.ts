// Validation for the Extrude distance field — mirrors dressUpValidation.ts and
// shellValidation.ts, over the shared numericField core.

import { type Scope } from "./expression";
import { validatePositiveField, type FieldResult } from "./numericField";
import type { ExtrudeExtent } from "./types";

/** Whether an extent actually uses the distance field. "Up to face"/"up to
 *  next" derive their own length from the target geometry and ignore it (the
 *  dialog hides the field for exactly these two); "through all" still falls
 *  back to the literal distance when there's no target to size against, so it
 *  counts as using it. */
export function extrudeUsesDistance(extent: ExtrudeExtent): boolean {
  return extent !== "upToFace" && extent !== "upToNext";
}

/** Synchronous, kernel-free validation of the Extrude distance field. Returns a
 *  human-readable `error` to show (or null) and the resolved `value` when it's a
 *  number worth sending to the kernel — `value` is null whenever we should NOT
 *  build (empty, unparseable, or ≤ 0), so a degenerate distance never reaches
 *  `MakePrism` (which surfaces it as a raw OCCT exception). An extent that
 *  ignores the distance validates as errorless with a null value. */
export function validateExtrudeDistance(distance: string, extent: ExtrudeExtent, scope: Scope): FieldResult {
  if (!extrudeUsesDistance(extent)) return { error: null, value: null };
  return validatePositiveField(distance, scope, "Distance");
}
