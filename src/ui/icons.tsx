// Shared monochrome line icons (stroke = currentColor) so the whole UI speaks
// one visual language alongside the geometric glyphs (▲ ▼ ✕).

/** An open eye — used for visibility toggles. Faded (lower opacity) = hidden. */
export function EyeIcon({ size = 14 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.4}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M1.5 8C3.5 2.8 12.5 2.8 14.5 8 12.5 13.2 3.5 13.2 1.5 8Z" />
      <circle cx="8" cy="8" r="2.3" />
    </svg>
  );
}

/** Two slanted parallel lines (the ∥ symbol), drawn with a comfortable gap so
 *  they don't read as a single line — used for the sketch Parallel constraint. */
export function ParallelIcon({ size = 16 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      aria-hidden="true"
    >
      <line x1="6" y1="3" x2="3.5" y2="13" />
      <line x1="12.5" y1="3" x2="10" y2="13" />
    </svg>
  );
}

/** A dashed diagonal line — used for the sketch Construction-geometry toggle. */
export function ConstructionIcon({ size = 16 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeDasharray="2.4 2.2"
      aria-hidden="true"
    >
      <line x1="3" y1="13" x2="13" y2="3" />
    </svg>
  );
}

/** A no-entry / disabled circle — used for "suppress" (exclude a feature from
 *  regen), which is stronger than hide. Faded = active; solid = suppressed. */
export function SuppressIcon({ size = 14 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.4}
      strokeLinecap="round"
      aria-hidden="true"
    >
      <circle cx="8" cy="8" r="6.2" />
      <line x1="3.6" y1="3.6" x2="12.4" y2="12.4" />
    </svg>
  );
}
