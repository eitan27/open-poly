/** Constrain `v` to the closed range [min, max]. */
export function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}
