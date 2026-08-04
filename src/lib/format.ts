/** Format a number for display: fixed to 3 decimals, trailing zeros (and a
 *  bare trailing dot) trimmed, integers shown with no decimal point. */
export function formatNumber(v: number): string {
  return Number.isInteger(v) ? String(v) : v.toFixed(3).replace(/\.?0+$/, "");
}
