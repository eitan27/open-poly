// Pastel colors assigned to newly created solids (primitives now; extrude and
// other solid-producing features later — see featureDefs/document.ts). Chosen
// at moderate lightness/saturation so each body reads clearly against both a
// dark and a light viewport background without being neon-bright or muddy.
export const SOLID_COLORS: number[] = [
  0xd66679, // rose
  0xd68b66, // peach
  0xd6ba66, // gold
  0xbad666, // lime
  0x66d69e, // mint
  0x66d6cd, // turquoise
  0x66b5d6, // sky
  0x6688d6, // periwinkle
  0x9566d6, // lavender
  0xd666d6, // magenta
];

export function randomSolidColor(): number {
  return SOLID_COLORS[Math.floor(Math.random() * SOLID_COLORS.length)];
}

/** Fallback for a resolved body whose feature doesn't carry a color (shouldn't
 *  happen for primitives, which always set one at creation). */
export const DEFAULT_SOLID_COLOR = SOLID_COLORS[0];

// NOTE for Phase 4 (Boolean): a Boolean union's result should inherit the
// color of the first-selected operand rather than getting a new random color
// from this bank — only union needs this (cut/intersect keep the target
// body's identity too, so the same rule applies there). There is no Boolean
// feature yet to wire this into; whoever implements Phase 4 should set the
// resulting feature's `color` from the first operand instead of calling
// randomSolidColor().
