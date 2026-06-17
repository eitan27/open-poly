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
