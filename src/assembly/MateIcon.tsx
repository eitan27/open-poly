// The mate types' icons, drawn as one set in the shared line-icon style
// (ui/icons.tsx: 16 × 16, stroke = currentColor). Each shows the motion the
// mate leaves free, or for Fastened the lack of it, rather than a text glyph
// that renders at the mercy of the font.
import type { ReactNode } from "react";
import type { MateType } from "./types";

/** How far back from its tip an arrowhead's arms reach. */
const HEAD_BACK = 2.2;

/** An arrowhead, as an open chevron, its tip at (x, y). */
const head = (x: number, y: number, dx: number, dy: number) => {
  // A chevron pointing along the unit vector (dx, dy): arms reaching
  // HEAD_BACK behind the tip and 2 to either side.
  const px = -dy,
    py = dx;
  return `M${x - dx * HEAD_BACK + px * 2} ${y - dy * HEAD_BACK + py * 2}L${x} ${y}L${x - dx * HEAD_BACK - px * 2} ${y - dy * HEAD_BACK - py * 2}`;
};

/** The cylindrical icon's ring: the front half of an ellipse about the shaft,
 *  from its left end round under the shaft and up the right, ending in an
 *  arrowhead that rises at 50°.
 *
 *  An arrowhead on a curve has to point along the curve over its own length —
 *  the chord from the arc point HEAD_BACK behind the tip to the tip — not
 *  along the tangent at the tip: near the end of an ellipse the arc bends
 *  away from that tangent within the arrowhead, into one of its arms, and the
 *  tip looks off the arc. So the arc's end is found where that chord rises at
 *  50°, and the arrowhead points along it, its tip exactly on the arc's end. */
const RING = (() => {
  const [cx, cy, rx, ry] = [8, 7.6, 5, 2.8];
  // A point at parameter t (screen y down; the front half is 0 < t < π).
  const at = (t: number): [number, number] => [cx + rx * Math.cos(t), cy + ry * Math.sin(t)];
  /** The point HEAD_BACK along the arc behind the one at t. */
  const behind = (t: number) => {
    let [p, u, s] = [at(t), t, 0];
    while (s < HEAD_BACK) {
      const q = at((u += 0.001));
      s += Math.hypot(q[0] - p[0], q[1] - p[1]);
      p = q;
    }
    return p;
  };
  const rise = (t: number) => {
    const [e, b] = [at(t), behind(t)];
    return Math.atan2(b[1] - e[1], e[0] - b[0]); // up is positive
  };
  // The rise falls as the end moves round from the side towards the bottom.
  let t = 0;
  while (rise(t) > (50 * Math.PI) / 180) t += 0.001;
  const end = at(t);
  const b = behind(t);
  const n = Math.hypot(end[0] - b[0], end[1] - b[1]);
  const r = (v: number) => Math.round(v * 1000) / 1000;
  return {
    // Large-arc 0 (it spans under 180°), sweep 0: left, then down under the
    // shaft, then up the right — anticlockwise on screen.
    arc: `M${cx - rx} ${cy}A${rx} ${ry} 0 0 0 ${r(end[0])} ${r(end[1])}`,
    end: [r(end[0]), r(end[1])] as [number, number],
    dir: [(end[0] - b[0]) / n, (end[1] - b[1]) / n] as [number, number],
  };
})();

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
  // Slides along a shaft and turns about it: the shaft's arrows, and the front
  // of a ring about it ending in an arrowhead (see RING).
  cylindrical: (
    <>
      <path d="M8 1.5v13" />
      <path d={head(8, 1.5, 0, -1)} />
      <path d={head(8, 14.5, 0, 1)} />
      <path d={RING.arc} />
      <path d={head(RING.end[0], RING.end[1], RING.dir[0], RING.dir[1])} />
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
