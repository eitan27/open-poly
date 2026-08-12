/** Format a number for display: fixed to 3 decimals, trailing zeros (and a
 *  bare trailing dot) trimmed, integers shown with no decimal point.
 *
 *  A value that rounds away to nothing renders as "0", never "-0": a
 *  measurement or dimension a hair below zero from float error (-1e-7) would
 *  otherwise read "-0", which looks like a bug to the user. The predecessors
 *  this replaced went via Math.round(v * 1000) / 1000, whose -0 stringifies to
 *  "0", so normalising here keeps the displayed value identical to before. */
export function formatNumber(v: number): string {
  const s = Number.isInteger(v) ? String(v) : v.toFixed(3).replace(/\.?0+$/, "");
  return s === "-0" ? "0" : s;
}
