// Resolve a text glyph outline into clean, fillable 2D polygons.
//
// Font glyph outlines are filled by the NON-ZERO WINDING rule, and real fonts
// (Inter included) ship glyphs whose strokes OVERLAP — drawn either as a single
// self-intersecting contour (e.g. the stem and arch of "h"/"n"/"m", the crossing
// strokes of "v"/"w"/"x"/"y", the bowl of "e") or as several same-winding
// contours that overlap (e.g. the "t" crossbar across its stem). OCCT's
// face-from-wire builder needs a SIMPLE (non-self-intersecting) wire and fills by
// even-odd, so handing it a raw self-overlapping outline drops the overlap
// regions — the letter doesn't fill where strokes cross. (That is the root cause
// of the "e/h/v/w/x/y and the corners of m/n aren't filled" bug.)
//
// So we resolve the outline in 2D first: flatten each contour to a polygon,
// separate contours by winding (outer fill rings vs. inner counter/hole rings),
// and compute `union(outer rings) − union(hole rings)` with a robust polygon
// clipper. The result is a set of simple polygons-with-holes that OCCT can face
// directly. (Curves become fine polylines — the trade for a watertight fill.)
import * as polygonClippingNs from "polygon-clipping";
import type { MultiPolygon, Ring } from "polygon-clipping";
import type { PathCommand } from "opentype.js";

export type { MultiPolygon, Ring };

// The ESM build exposes only a default export at runtime, while the .d.ts
// declares the functions as named — reconcile both (typed via the namespace).
const polygonClipping =
  (polygonClippingNs as unknown as { default?: typeof polygonClippingNs }).default ?? polygonClippingNs;

/** Signed area of a ring (shoelace). Sign encodes winding direction. */
export function ringArea(ring: Ring): number {
  let a = 0;
  for (let i = 0; i < ring.length; i++) {
    const [x1, y1] = ring[i];
    const [x2, y2] = ring[(i + 1) % ring.length];
    a += x1 * y2 - x2 * y1;
  }
  return a / 2;
}

function ringBBoxArea(ring: Ring): number {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of ring) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  return (maxX - minX) * (maxY - minY);
}

/** Subdivision count for a Bézier span, scaled by its control-polygon length so
 *  the chord error stays under ~`tol` regardless of glyph size. */
function bezierSegments(ctrlLen: number, tol: number): number {
  return Math.max(2, Math.min(16, Math.ceil(ctrlLen / Math.max(tol, 1e-6))));
}

const dist = (ax: number, ay: number, bx: number, by: number) => Math.hypot(bx - ax, by - ay);

/** Flatten an opentype glyph path into closed polygon rings, in the sketch's
 *  u,v convention (x unchanged, y flipped — opentype lays glyphs out y-down).
 *  One ring per M..Z contour; degenerate (<3 point) contours are dropped. */
export function glyphRings(commands: PathCommand[], tol = 0.1): Ring[] {
  const rings: Ring[] = [];
  let ring: Ring = [];
  let cx = 0, cy = 0;
  const flush = () => { if (ring.length >= 3) rings.push(ring); ring = []; };
  const push = (x: number, y: number) => {
    const last = ring[ring.length - 1];
    if (!last || Math.abs(last[0] - x) > 1e-9 || Math.abs(last[1] - y) > 1e-9) ring.push([x, -y]);
  };
  for (const c of commands) {
    if (c.type === "Z") { flush(); continue; }
    if (c.type === "M") { flush(); cx = c.x; cy = c.y; ring = [[cx, -cy]]; continue; }
    if (c.type === "L") { cx = c.x; cy = c.y; push(cx, cy); }
    else if (c.type === "Q") {
      const n = bezierSegments(dist(cx, cy, c.x1, c.y1) + dist(c.x1, c.y1, c.x, c.y), tol);
      for (let i = 1; i <= n; i++) {
        const t = i / n, m = 1 - t;
        push(m * m * cx + 2 * m * t * c.x1 + t * t * c.x, m * m * cy + 2 * m * t * c.y1 + t * t * c.y);
      }
      cx = c.x; cy = c.y;
    } else if (c.type === "C") {
      const n = bezierSegments(dist(cx, cy, c.x1, c.y1) + dist(c.x1, c.y1, c.x2, c.y2) + dist(c.x2, c.y2, c.x, c.y), tol);
      for (let i = 1; i <= n; i++) {
        const t = i / n, m = 1 - t;
        push(
          m * m * m * cx + 3 * m * m * t * c.x1 + 3 * m * t * t * c.x2 + t * t * t * c.x,
          m * m * m * cy + 3 * m * m * t * c.y1 + 3 * m * t * t * c.y2 + t * t * t * c.y,
        );
      }
      cx = c.x; cy = c.y;
    }
  }
  flush();
  return rings;
}

/** Resolve flattened glyph rings into simple, fillable polygons (outer ring +
 *  hole rings), removing self- and mutual stroke overlaps. Outer (fill) rings
 *  are the ones whose winding matches the largest contour's; the opposite
 *  winding are counters (holes). The result is `union(fills) − union(holes)`. */
export function resolveGlyphFill(rings: Ring[]): MultiPolygon {
  const valid = rings.filter((r) => r.length >= 3);
  if (valid.length === 0) return [];
  // The outermost (largest-bbox) contour defines the "fill" winding; this avoids
  // hard-coding a font's CW/CCW convention.
  let big = 0;
  for (let i = 1; i < valid.length; i++) {
    if (ringBBoxArea(valid[i]) > ringBBoxArea(valid[big])) big = i;
  }
  const fillSign = Math.sign(ringArea(valid[big])) || 1;
  const fills: MultiPolygon = [];
  const holes: MultiPolygon = [];
  for (const r of valid) {
    (Math.sign(ringArea(r)) === fillSign ? fills : holes).push([r]);
  }
  if (fills.length === 0) return [];
  // `union` cleans self-intersections and merges overlaps (one arg is fine).
  let result = polygonClipping.union(fills[0], ...fills.slice(1));
  if (holes.length > 0) result = polygonClipping.difference(result, holes[0], ...holes.slice(1));
  return result;
}

/** Convenience: opentype glyph path → fillable polygons. */
export function glyphFillPolygons(commands: PathCommand[], tol = 0.1): MultiPolygon {
  return resolveGlyphFill(glyphRings(commands, tol));
}
