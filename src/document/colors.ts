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

// Settings ▸ "New body colour": null = keep picking at random (the default).
// Module-level rather than a parameter because the colour is chosen deep inside
// a dozen pure document builders that have no business knowing about user
// preferences — App pushes the choice here whenever it changes, and those
// builders keep their signatures. `newBodyColor` was already impure (it reads
// Math.random), so this doesn't cost them anything they had.
let preferredNewBodyColor: number | null = null;

export function setNewBodyColorPreference(color: number | null): void {
  preferredNewBodyColor = color;
}

/** The colour to give a body being created right now. Distinct from
 *  `randomSolidColor`, which stays random on purpose at the two call sites that
 *  aren't creation events: migrating colours onto older documents, and tinting
 *  a reference plane's widget (not a body at all). */
export function newBodyColor(): number {
  return preferredNewBodyColor ?? randomSolidColor();
}

/** The colour a feature's n-th part takes when nothing has overridden it.
 *
 *  A feature that comes out as several disjoint parts (see document/parts.ts)
 *  must not paint them all alike: to everyone but the timeline they are
 *  separate bodies, and three identically-coloured lumps from one extrude read
 *  as one object. Siblings therefore step on through the palette from the
 *  feature's own colour — deterministic, so a rebuild repaints them identically
 *  and no colour has to be stored to stay put.
 *
 *  A fixed "new body colour" preference wins: it means "make bodies THIS
 *  colour", and these are bodies. */
export function siblingBodyColor(featureColor: number, index: number): number {
  if (index === 0 || preferredNewBodyColor !== null) return featureColor;
  // A hand-picked colour that isn't in the palette still yields a stable,
  // distinct series — it just starts the walk at the top.
  const at = SOLID_COLORS.indexOf(featureColor);
  return SOLID_COLORS[((at === -1 ? 0 : at) + index) % SOLID_COLORS.length];
}

/** `0x66b5d6` ⇄ `"#66b5d6"` — the form `<input type="color">` and stored
 *  settings both speak. */
export const colorToHex = (color: number): string => `#${color.toString(16).padStart(6, "0")}`;

/** Parses `#rrggbb` (the only form we write). Null on anything else, so a
 *  hand-edited or stale settings value can't inject NaN into a document. */
export function hexToColor(hex: string): number | null {
  return /^#[0-9a-f]{6}$/i.test(hex) ? parseInt(hex.slice(1), 16) : null;
}
