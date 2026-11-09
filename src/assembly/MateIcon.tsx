// The mate types' icons, drawn as one set in the shared line-icon style
// (ui/icons.tsx: 16 × 16, stroke = currentColor). Each shows the motion the
// mate leaves free, or for Fastened the lack of it, rather than a text glyph
// that renders at the mercy of the font.
import type { ReactNode } from "react";
import type { MateType } from "./types";

/** Arrowheads, as open chevrons, at the ends of a straight shaft. */
const head = (x: number, y: number, dx: number, dy: number) => {
  // A 2.4-long chevron pointing along (dx, dy).
  const px = -dy,
    py = dx;
  return `M${x - dx * 2.2 + px * 2} ${y - dy * 2.2 + py * 2}L${x} ${y}L${x - dx * 2.2 - px * 2} ${y - dy * 2.2 - py * 2}`;
};

const PATHS: Record<MateType, ReactNode> = {
  // Two plates held together by a bolt: nothing moves.
  fastened: (
    <>
      <rect x="2.5" y="4.5" width="11" height="3.5" rx="0.5" />
      <rect x="2.5" y="8" width="11" height="3.5" rx="0.5" />
      <path d="M8 2.5v11.5M6 2.5h4" />
    </>
  ),
  // Turns about a pin.
  revolute: (
    <>
      <circle cx="8" cy="8" r="1.2" />
      <path d="M13.2 8A5.2 5.2 0 1 1 11.7 4.3" />
      <path d={head(11.7, 4.3, 0.7, 0.7)} />
    </>
  ),
  // A block that slides along an axis.
  slider: (
    <>
      <rect x="5" y="6" width="6" height="4" rx="0.5" />
      <path d="M8 1.5V6M8 10v4.5" />
      <path d={head(8, 1.5, 0, -1)} />
      <path d={head(8, 14.5, 0, 1)} />
    </>
  ),
  // Slides along a shaft and turns about it.
  cylindrical: (
    <>
      <path d="M8 1.5v13" />
      <path d={head(8, 1.5, 0, -1)} />
      <path d={head(8, 14.5, 0, 1)} />
      <path d="M3 7.6C3.4 9.3 5.5 10.4 8 10.4s4.6-1.1 5-2.8" />
      <path d={head(13, 7.6, 0.82, -0.57)} />
    </>
  ),
  // A block that slides anywhere on a plane.
  planar: (
    <>
      <path d="M1.5 14 4.5 9.5h10l-3 4.5Z" />
      <rect x="6" y="7" width="4" height="4.5" rx="0.4" fill="currentColor" />
      <path d="M3.5 3.5h9" />
      <path d={head(3.5, 3.5, -1, 0)} />
      <path d={head(12.5, 3.5, 1, 0)} />
    </>
  ),
  // A ball in its socket.
  ball: (
    <>
      <circle cx="8" cy="9" r="2.8" />
      <path d="M2.8 9a5.2 5.2 0 0 0 10.4 0" />
      <path d="M8 6.2V1.5" />
    </>
  ),
  // A tab held midway between two walls.
  width: (
    <>
      <path d="M2 3v10M14 3v10" />
      <rect x="6" y="5" width="4" height="6" rx="0.5" />
      <path d="M2.8 8h2.4M10.8 8h2.4" strokeDasharray="1 1" />
    </>
  ),
};

export function MateIcon({ type, size = 14 }: { type: MateType; size?: number }) {
  return (
    <svg
      className="mate-icon"
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.3}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {PATHS[type]}
    </svg>
  );
}
