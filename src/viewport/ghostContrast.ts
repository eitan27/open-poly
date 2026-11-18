// A hidden ghost edge is dashed in the ghost's colour — which vanishes behind a
// body of nearly that colour. For those bodies only, the dashes take whichever
// of two alternates contrasts more with the body; everywhere else they keep
// the ghost's own colour, which says "new material" at a glance.

/** sRGB 0xRRGGBB → OKLab, the perceptual space colour distance is read in. */
function oklab(hex: number): [number, number, number] {
  const lin = (c: number) => {
    const v = c / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  const r = lin((hex >> 16) & 255);
  const g = lin((hex >> 8) & 255);
  const b = lin(hex & 255);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

/** Perceptual distance between two colours (OKLab ΔE; ~0.02 is just visible). */
export function colorDistance(a: number, b: number): number {
  const p = oklab(a);
  const q = oklab(b);
  return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
}

/** WCAG relative luminance, for picking the alternate with more contrast. */
function luminance(hex: number): number {
  const lin = (c: number) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin((hex >> 16) & 255) + 0.7152 * lin((hex >> 8) & 255) + 0.0722 * lin(hex & 255);
}
const contrast = (a: number, b: number) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

/** Bodies closer than this to the ghost's colour hide its dashes. */
export const GHOST_SIMILAR = 0.15;
const ALTERNATES = [0xf4f7fb, 0x102a4c];

/** The colour a ghost's hidden dashes take behind `occluders`: its own unless
 *  one of them is too close to it, then the alternate that stands out most
 *  against the closest one. */
export function hiddenDashColor(ghost: number, occluders: number[]): number {
  let closest: number | null = null;
  let best = GHOST_SIMILAR;
  for (const c of occluders) {
    const d = colorDistance(ghost, c);
    if (d < best) {
      best = d;
      closest = c;
    }
  }
  if (closest === null) return ghost;
  const body = closest;
  return ALTERNATES.reduce((p, q) => (contrast(q, body) > contrast(p, body) ? q : p));
}
