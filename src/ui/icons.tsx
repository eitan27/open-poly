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

/** The electrical ground symbol: a stem down into three bars, each shorter
 *  than the one above. An assembly instance's ground toggle. */
export function GroundIcon({ size = 14 }: { size?: number }) {
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
      <path d="M8 1.5V7M2.5 7h11M4.75 10h6.5M6.75 13h2.5" />
    </svg>
  );
}

/** A spur gear's outline (8 teeth) around its bore — the Gear tool. Drawn
 *  because the ⚙ glyph is too small at toolbar size for its teeth to read. */
const GEAR_PATH = (() => {
  const n = 8;
  const [tip, root] = [7.3, 5.2];
  const pt = (r: number, a: number) => `${(8 + r * Math.cos(a)).toFixed(2)} ${(8 + r * Math.sin(a)).toFixed(2)}`;
  const parts: string[] = [];
  for (let i = 0; i < n; i++) {
    const c = (i * 2 * Math.PI) / n - Math.PI / 2;
    const [ht, hr] = [(Math.PI / n) * 0.38, (Math.PI / n) * 0.62];
    parts.push(
      `${i ? "L" : "M"}${pt(root, c - hr)}`,
      `L${pt(tip, c - ht)}`,
      `L${pt(tip, c + ht)}`,
      `L${pt(root, c + hr)}`,
    );
    parts.push(`A${root} ${root} 0 0 1 ${pt(root, c + (2 * Math.PI) / n - hr)}`);
  }
  return parts.join(" ") + "Z";
})();

export function GearIcon({ size = 14 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.3}
      strokeLinejoin="round"
      className="tool-svg-icon"
      aria-hidden="true"
    >
      <path d={GEAR_PATH} />
      <circle cx="8" cy="8" r="2.1" />
    </svg>
  );
}

/** A screw side-on: its head, and a threaded shank to a point — the Screw
 *  tool. */
export function ScrewIcon({ size = 14 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.3}
      strokeLinecap="round"
      strokeLinejoin="round"
      className="tool-svg-icon"
      aria-hidden="true"
    >
      <path d="M4 4.6V2.9Q4 1.5 5.4 1.5H10.6Q12 1.5 12 2.9V4.6Z" />
      <path d="M6.2 4.6V12.4L8 14.6 9.8 12.4V4.6" />
      <path d="M6.2 7 9.8 5.9M6.2 9.4 9.8 8.3M6.2 11.8 9.8 10.7" />
    </svg>
  );
}

/** A threaded rod side-on: saw-tooth flanks, the crests running across it on
 *  the slant of the helix — the Thread tool (a thread cut on a round face). */
export function ThreadIcon({ size = 14 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.3}
      strokeLinecap="round"
      strokeLinejoin="round"
      className="tool-svg-icon"
      aria-hidden="true"
    >
      <path d="M5.2 1.8V2.6L3.4 4.4 5.2 6.2 3.4 8 5.2 9.8 3.4 11.6 5.2 13.4V14.2" />
      <path d="M10.8 1.8V4.4L12.6 6.2 10.8 8 12.6 9.8 10.8 11.6 12.6 13.4 10.8 14.2" />
      <path d="M5.2 1.8H10.8M5.2 14.2H10.8" />
      <path d="M3.4 4.4 12.6 6.2M3.4 8 12.6 9.8M3.4 11.6 12.6 13.4" />
    </svg>
  );
}
