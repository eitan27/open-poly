/** Format a number for a dimension label: at most 2 decimals, no trailing 0s. */
export const fmtDim = (n: number) => String(Math.round(n * 100) / 100);
