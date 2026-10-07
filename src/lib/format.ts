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

/** The older compact formatter: round to 3 decimals, then stringify.
 *
 *  Kept distinct from `formatNumber` because they are **not** interchangeable at an
 *  exact half. `Math.round` always goes up (1.0005 → "1.001"); `toFixed(3)` follows
 *  the float, and 1.0005 is stored a hair below the half, so it goes down
 *  ("1"). The difference is one part in a thousand and invisible on screen, but this
 *  one's output is written back into the document as a transform's expression
 *  string, so switching it is a behaviour change rather than a tidy-up. Unify
 *  deliberately, with that in mind — see `format.test.ts`. */
export function formatRounded3(v: number): string {
  return String(Math.round(v * 1000) / 1000);
}
