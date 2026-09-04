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

/** A magnifying glass — the toolbars' "search all tools" button. Drawn rather
 *  than set as a glyph so it carries the same stroke weight as the other line
 *  icons instead of an emoji's colour and metrics. */
export function SearchIcon({ size = 14 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="7" cy="7" r="4.3" />
      <line x1="10.2" y1="10.2" x2="13.5" y2="13.5" />
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

/** A single horizontal line — used for the sketch Horizontal constraint. */
export function HorizontalIcon({ size = 16 }: { size?: number }) {
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
      <line x1="3" y1="8" x2="13" y2="8" />
    </svg>
  );
}

/** A single vertical line — used for the sketch Vertical constraint. */
export function VerticalIcon({ size = 16 }: { size?: number }) {
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
      <line x1="8" y1="3" x2="8" y2="13" />
    </svg>
  );
}

/** Two nested right angles (an inner L and a slightly larger, parallel outer L)
 *  — an edge and its offset copy. Used for the sketch Offset tool. */
export function OffsetIcon({ size = 16 }: { size?: number }) {
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
      {/* inner right angle (corner at bottom-left, opening up/right) */}
      <path d="M6 4.5 L6 10 L11.5 10" />
      {/* outer right angle, offset out & down, edges slightly longer */}
      <path d="M3 2.5 L3 13 L14 13" />
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
