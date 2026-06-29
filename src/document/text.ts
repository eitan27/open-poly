// Sketch "Text" support: turns a string into 2D glyph-outline contours (in the
// sketch's u,v plane) for display, and loads the bundled font once for the
// browser. The actual extrudable solid is (will be) baked by the kernel; this
// module is the on-screen geometry + the shared font asset.
//
// Coordinate note: opentype lays glyphs out with y pointing DOWN from the
// baseline (screen convention), but sketch u,v has y pointing UP, so every
// glyph point is y-flipped here. The result is upright text whose baseline sits
// at the anchor and which grows upward.
import opentype from "opentype.js";
import type { Vec2 } from "./types";

/** Public URL of the bundled sketch font (served from `public/`). */
export const SKETCH_FONT_URL = `${import.meta.env.BASE_URL}fonts/Inter-Regular.ttf`;

let fontPromise: Promise<opentype.Font> | null = null;
let loadedFont: opentype.Font | null = null;

/** Load (once) and cache the bundled sketch font in the browser. Safe to call
 *  repeatedly; resolves to the same Font. */
export function loadSketchFont(): Promise<opentype.Font> {
  if (!fontPromise) {
    fontPromise = fetch(SKETCH_FONT_URL)
      .then((r) => r.arrayBuffer())
      .then((buf) => {
        const f = opentype.parse(buf);
        loadedFont = f;
        return f;
      });
  }
  return fontPromise;
}

/** The font if it has finished loading, else null (callers render nothing until
 *  it's ready, then re-render when `loadSketchFont()` resolves). */
export function getSketchFont(): opentype.Font | null {
  return loadedFont;
}

const SEGS_PER_CURVE = 8;

const quad = (p0: Vec2, c: Vec2, p1: Vec2, t: number): Vec2 => {
  const mt = 1 - t;
  return [
    mt * mt * p0[0] + 2 * mt * t * c[0] + t * t * p1[0],
    mt * mt * p0[1] + 2 * mt * t * c[1] + t * t * p1[1],
  ];
};

const cubic = (p0: Vec2, c1: Vec2, c2: Vec2, p1: Vec2, t: number): Vec2 => {
  const mt = 1 - t;
  const a = mt * mt * mt, b = 3 * mt * mt * t, c = 3 * mt * t * t, d = t * t * t;
  return [
    a * p0[0] + b * c1[0] + c * c2[0] + d * p1[0],
    a * p0[1] + b * c1[1] + c * c2[1] + d * p1[1],
  ];
};

/** Glyph outlines of `value` as closed contours in sketch u,v. `height` is the
 *  font (em) size in sketch units; the baseline-left of the first glyph sits at
 *  `anchor` and the text is rotated by `rotation` radians about it. Each contour
 *  is one sub-path (so glyph counters/holes — the inside of an "o", "A", "e" —
 *  come back as their own loops). Points are NOT closed (first ≠ last); callers
 *  close each loop. Returns [] for an empty string. */
export function textToContours(
  value: string,
  height: number,
  font: opentype.Font,
  opts: { anchor?: Vec2; rotation?: number } = {},
): Vec2[][] {
  if (!value) return [];
  const anchor = opts.anchor ?? [0, 0];
  const rot = opts.rotation ?? 0;
  const cosR = Math.cos(rot), sinR = Math.sin(rot);
  // Map a raw glyph point (x right, y down from baseline) into sketch u,v:
  // flip y, rotate, then translate to the anchor.
  const place = (x: number, y: number): Vec2 => {
    const lx = x, ly = -y; // y-flip: glyphs grow upward in u,v
    return [anchor[0] + lx * cosR - ly * sinR, anchor[1] + lx * sinR + ly * cosR];
  };

  const contours: Vec2[][] = [];
  let cur: Vec2[] = [];
  let pen: Vec2 = [0, 0]; // current point in raw glyph space

  const path = font.getPath(value, 0, 0, height);
  for (const cmd of path.commands) {
    if (cmd.type === "M") {
      if (cur.length) contours.push(cur);
      cur = [];
      pen = [cmd.x, cmd.y];
      cur.push(place(pen[0], pen[1]));
    } else if (cmd.type === "L") {
      pen = [cmd.x, cmd.y];
      cur.push(place(pen[0], pen[1]));
    } else if (cmd.type === "Q") {
      const c: Vec2 = [cmd.x1, cmd.y1];
      const end: Vec2 = [cmd.x, cmd.y];
      for (let s = 1; s <= SEGS_PER_CURVE; s++) {
        const p = quad(pen, c, end, s / SEGS_PER_CURVE);
        cur.push(place(p[0], p[1]));
      }
      pen = end;
    } else if (cmd.type === "C") {
      const c1: Vec2 = [cmd.x1, cmd.y1];
      const c2: Vec2 = [cmd.x2, cmd.y2];
      const end: Vec2 = [cmd.x, cmd.y];
      for (let s = 1; s <= SEGS_PER_CURVE; s++) {
        const p = cubic(pen, c1, c2, end, s / SEGS_PER_CURVE);
        cur.push(place(p[0], p[1]));
      }
      pen = end;
    } else if (cmd.type === "Z") {
      if (cur.length) contours.push(cur);
      cur = [];
    }
  }
  if (cur.length) contours.push(cur);
  return contours;
}
