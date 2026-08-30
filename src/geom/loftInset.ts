// The 2D half of hollowing a freeform LOFTED solid.
//
// OCCT cannot offset a loft's surface inward — every solid-level route is a
// proven dead end (see `shellNamed`), so Shell builds the cavity one section at
// a time instead: each of the loft's sections is inset in 2D by the wall
// thickness, and the inset sections are re-lofted into the body that gets
// subtracted. This module is that inset, and nothing else: pure 2D, no OCCT,
// unit-testable in Node.
//
// The inset is the morphological EROSION of the section — `region` minus the
// Minkowski dilation of its boundary by a disc of radius `distance` — not the
// naive "push every vertex along its averaged normal". The naive version
// self-intersects the moment a concave corner is deeper than the wall, and
// silently produces an inside-out ring that lofts into a cavity poking through
// the wall. Building the dilation explicitly (a rectangle per edge, a round
// join per corner) and subtracting it with a robust clipper gets concavity,
// pinch-off and self-touching right by construction.
//
// OPEN EDGES are how an opening in the loft's side wall is expressed. An edge
// left open contributes no wall — it is skipped when the dilation band is
// built, so the cavity runs right up to the section boundary there — and the
// result is then pushed OUT past that edge by `overshoot`, so the subtraction
// crosses the outer surface transversally instead of meeting it face-to-face.
// Edge `i` here is edge `i` of the loft's `<id>/side{i}` naming: it runs from
// `outline[i]` to `outline[i + 1]`, wrapping at the end.
import * as polygonClippingNs from "polygon-clipping";
import type { MultiPolygon, Polygon, Ring } from "polygon-clipping";

// The ESM build exposes only a default export at runtime while the .d.ts
// declares the functions as named — reconcile both, as glyphFill.ts does.
const polygonClipping =
  (polygonClippingNs as unknown as { default?: typeof polygonClippingNs }).default ?? polygonClippingNs;

export type Vec2 = [number, number];

/** Turns flatter than this (cos of the angle between the two outward
 *  directions, ~0.25°) get no corner wedge: the two extension quads already
 *  overlap, and the wedge would be a degenerate sliver. */
const WEDGE_COS = 0.99999;

/** Rings smaller than this fraction of the source section are treated as debris
 *  from a clip rather than a cavity. */
const MIN_AREA_FRACTION = 1e-4;

/** Signed area of a ring (shoelace); positive is counter-clockwise. Exported
 *  for tests and for the orientation fix-up below. */
export function ringSignedArea(ring: readonly Vec2[]): number {
  let a = 0;
  for (let i = 0; i < ring.length; i++) {
    const [x1, y1] = ring[i];
    const [x2, y2] = ring[(i + 1) % ring.length];
    a += x1 * y2 - x2 * y1;
  }
  return a / 2;
}

/** Drop a duplicated closing point, if the caller's ring carries one.
 *
 *  Interior duplicates are deliberately KEPT: dropping one would shift every
 *  later edge index, and those indices are how a picked `<id>/side{i}` face is
 *  matched to an edge here. A zero-length edge simply contributes nothing. */
function openRing(outline: readonly Vec2[]): Vec2[] {
  const pts = outline.map((p) => [p[0], p[1]] as Vec2);
  const first = pts[0];
  const last = pts[pts.length - 1];
  if (pts.length > 1 && first[0] === last[0] && first[1] === last[1]) pts.pop();
  return pts;
}

/** The rectangle swept by a segment offset `d` to BOTH sides and lengthened by
 *  `capBack`/`capFwd` past its ends.
 *
 *  Both sides, because the band is the dilation of the boundary — the half
 *  outside the section is clipped away by the subtraction, and covering it
 *  costs nothing while sparing us a winding test per edge.
 *
 *  The end caps are what make consecutive bands overlap, and they replace the
 *  round joins this used to place at corners. A SQUARE cap of depth `d`
 *  contains the round one of radius `d`, so the band still covers the whole
 *  true dilation and the wall is never thinner than asked; the excess sits
 *  where the neighbouring edge (or the outside of the section) already is, so
 *  in practice it costs nothing. Round joins were worse on both counts: they
 *  overlap so heavily that the clipper threw outright on coarse sections, and
 *  placing them only at reflex corners — where they are geometrically needed —
 *  left slivers at convex ones that survived the erosion as a second polygon,
 *  on inputs as ordinary as a 96-sided circle offset by 2. */
function edgeBand(p0: Vec2, p1: Vec2, d: number, capBack: number, capFwd: number): Polygon | null {
  const dx = p1[0] - p0[0];
  const dy = p1[1] - p0[1];
  const len = Math.hypot(dx, dy);
  if (len < 1e-12) return null;
  const nx = (-dy / len) * d;
  const ny = (dx / len) * d;
  const a: Vec2 = [p0[0] - (dx / len) * capBack, p0[1] - (dy / len) * capBack];
  const b: Vec2 = [p1[0] + (dx / len) * capFwd, p1[1] + (dy / len) * capFwd];
  const ring: Ring = [
    [a[0] + nx, a[1] + ny],
    [b[0] + nx, b[1] + ny],
    [b[0] - nx, b[1] - ny],
    [a[0] - nx, a[1] - ny],
  ];
  ring.push(ring[0]);
  return [ring];
}

/** The quad that carries the cavity `overshoot` past an open edge, so the cut
 *  crosses the outer surface instead of being coincident with it. Outward is
 *  away from the section's interior — the sections this runs on are CCW
 *  (`detectSketchRegions` orients them so), so it is the right-hand normal. */
function overshootQuad(p0: Vec2, p1: Vec2, out: number, ccw: boolean): Polygon | null {
  const dx = p1[0] - p0[0];
  const dy = p1[1] - p0[1];
  const len = Math.hypot(dx, dy);
  if (len < 1e-12 || out <= 0) return null;
  const s = ccw ? 1 : -1;
  const nx = ((s * dy) / len) * out;
  const ny = ((-s * dx) / len) * out;
  const ring: Ring = [
    [p0[0], p0[1]],
    [p1[0], p1[1]],
    [p1[0] + nx, p1[1] + ny],
    [p0[0] + nx, p0[1] + ny],
  ];
  ring.push(ring[0]);
  return [ring];
}

/** Does `ring` reach outside `outline` anywhere?
 *
 *  This is how an opening is confirmed to be real. Asking for one doesn't
 *  guarantee getting one: the walls either side of an opened edge carry on down
 *  past the lip, and if the edge is narrower than twice the wall they meet in
 *  the middle and close it over again — which is right, but indistinguishable
 *  from a sealed shell unless someone checks. A single chord of a tessellated
 *  circle is exactly that case. */
export function ringEscapes(ring: readonly Vec2[], outline: readonly Vec2[]): boolean {
  const poly = openRing(outline);
  const n = poly.length;
  if (n < 3) return false;
  for (const [x, y] of ring) {
    let inside = false;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const [xi, yi] = poly[i];
      const [xj, yj] = poly[j];
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
    if (!inside) return true;
  }
  return false;
}

/** Insert points on a ring's longest edges until it has exactly `target` of
 *  them. Splitting an edge at its midpoint doesn't move the outline at all, so
 *  this changes the description and not the shape.
 *
 *  `BRepOffsetAPI_ThruSections` has to reconcile the sections it is given
 *  against each other, and it refuses outright — Standard_ConstructionError,
 *  with nothing more to say — on some perfectly clean sets whose point counts
 *  merely differ. An opening does exactly that to the cavity's sections: it
 *  adds a lip to each one, and not the same number of points to each. Handing
 *  them over already matched avoids the question. */
export function padOutline(outline: readonly Vec2[], target: number): Vec2[] {
  const ring = outline.map((p) => [p[0], p[1]] as Vec2);
  while (ring.length < target) {
    let at = 0;
    let best = -1;
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i];
      const b = ring[(i + 1) % ring.length];
      const len = (b[0] - a[0]) ** 2 + (b[1] - a[1]) ** 2;
      if (len > best) {
        best = len;
        at = i;
      }
    }
    const a = ring[at];
    const b = ring[(at + 1) % ring.length];
    ring.splice(at + 1, 0, [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]);
  }
  return ring;
}

export interface InsetOptions {
  /** Edge indices left OPEN: no wall there, and the result crosses the section
   *  boundary by `overshoot`. Edge `i` runs `outline[i] → outline[i + 1]`. */
  openEdges?: ReadonlySet<number>;
  /** How far past an open edge the result reaches. Ignored without openEdges. */
  overshoot?: number;
}

/** Inset a loft section by `distance`, as a single closed ring in the same
 *  winding and with a start point near the source's — both matter, because
 *  `BRepOffsetAPI_ThruSections` pairs the sections it is given by traversal
 *  order and will twist the cavity's side walls if they disagree.
 *
 *  Returns null when the result is not a single hole-free ring — the wall is
 *  too thick for the section and the cavity has pinched into pieces, vanished,
 *  or grown an island. That is a refusal, not a repair: a loft can only be
 *  built from one wire per station, and quietly lofting the largest piece would
 *  hand back a body with a wall thickness nobody asked for. */
export function insetOutline(outline: readonly Vec2[], distance: number, opts: InsetOptions = {}): Vec2[] | null {
  if (!(distance > 0)) return null;
  const pts = openRing(outline);
  const n = pts.length;
  if (n < 3) return null;
  const area = ringSignedArea(pts);
  if (Math.abs(area) < 1e-12) return null;
  const ccw = area > 0;
  const open = opts.openEdges ?? new Set<number>();
  const overshoot = opts.overshoot ?? 0;

  const region: Polygon = [[...pts.map((p) => [p[0], p[1]] as Vec2), [pts[0][0], pts[0][1]]]];

  // The section itself, carried past every open edge. The erosion runs on THIS,
  // not on the bare section: a wall next to an opening has to keep its full
  // thickness right down to the lip, which it only does if both the material
  // and the wall it is measured from reach past the opening together.
  const quads: Polygon[] = [];
  const outward = (i: number): Vec2 | null => {
    const a = pts[i];
    const b = pts[(i + 1) % n];
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const len = Math.hypot(dx, dy);
    if (len < 1e-12) return null;
    const sgn = ccw ? 1 : -1;
    return [((sgn * dy) / len) * overshoot, ((-sgn * dx) / len) * overshoot];
  };
  for (const i of open) {
    if (!Number.isInteger(i) || i < 0 || i >= n) continue;
    const q = overshootQuad(pts[i], pts[(i + 1) % n], overshoot, ccw);
    if (q) quads.push(q);
    // Where an opening turns a CORNER, the two edges' quads leave the wedge
    // between them empty, and the notch that leaves pinches the erosion into
    // something that isn't one ring. Fill it with the triangle the two outward
    // directions span. (On a concave turn the quads already overlap there, and
    // the triangle is redundant rather than wrong.)
    const j = (i + 1) % n;
    if (!open.has(j) || overshoot <= 0) continue;
    const oi = outward(i);
    const oj = outward(j);
    if (!oi || !oj) continue;
    // Only where the opening actually TURNS. On a finely tessellated section
    // consecutive outward directions are nearly parallel, the wedge degenerates
    // to a sliver, and a run of those slivers is what the clipper chokes on —
    // while the two quads already overlap there, so the wedge buys nothing.
    const li = Math.hypot(oi[0], oi[1]);
    const lj = Math.hypot(oj[0], oj[1]);
    if (li < 1e-12 || lj < 1e-12) continue;
    const cos = (oi[0] * oj[0] + oi[1] * oj[1]) / (li * lj);
    if (cos > WEDGE_COS) continue;
    const v = pts[j];
    // The wedge is the SECTOR the two outward directions sweep, sampled as a
    // fan. Not the parallelogram on oi and oj: for the shallow turns of a
    // tessellated section those are nearly parallel, and their sum lands at
    // twice the overshoot — a spike, not a corner, and one the erosion can't
    // resolve. Not a bare triangle either, once the turn is sharp enough for
    // its chord to cut inside the extension.
    const a0 = Math.atan2(oi[1], oi[0]);
    const sweep = Math.atan2(oi[0] * oj[1] - oi[1] * oj[0], oi[0] * oj[0] + oi[1] * oj[1]);
    const steps = Math.max(1, Math.ceil(Math.abs(sweep) / (Math.PI / 12)));
    const wedge: Ring = [[v[0], v[1]]];
    for (let t = 0; t <= steps; t++) {
      const ang = a0 + (sweep * t) / steps;
      wedge.push([v[0] + overshoot * Math.cos(ang), v[1] + overshoot * Math.sin(ang)]);
    }
    wedge.push(wedge[0]);
    quads.push([wedge]);
  }

  // The dilation band, from the CLOSED edges only. Every band is capped by
  // `distance` at both ends so consecutive ones overlap — including where a
  // wall runs into an opening, where the RAIL below is what actually holds the
  // wall's thickness down to the lip. (A round cap there is the textbook
  // answer, and it was tried: it changes nothing any test or harness can see,
  // because the rail already covers the same ground.)
  const band: Polygon[] = [];
  for (let i = 0; i < n; i++) {
    if (open.has(i)) continue;
    const q = edgeBand(pts[i], pts[(i + 1) % n], distance, distance, distance);
    if (q) band.push(q);
  }
  // The RAILS: where a wall meets an opening, the wall carries on down the side
  // of the extension quad, so the cavity doesn't widen into it below the lip.
  // That continuation runs along the OPENED edge's outward normal — the
  // direction the section was carried out in — not along the wall's own
  // direction. Lengthening the neighbouring wall instead only coincides with
  // this when the two are perpendicular, as on a box; on a smooth section the
  // neighbour is nearly tangent to the opening, so lengthening it ran the wall
  // straight ACROSS the opening and sealed it over again.
  for (const i of open) {
    if (!Number.isInteger(i) || i < 0 || i >= n) continue;
    const a = pts[i];
    const b = pts[(i + 1) % n];
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const len = Math.hypot(dx, dy);
    if (len < 1e-12 || overshoot <= 0) continue;
    const sgn = ccw ? 1 : -1;
    const ox = ((sgn * dy) / len) * overshoot;
    const oy = ((-sgn * dx) / len) * overshoot;
    // Only where a wall actually ends: between two open edges there is none.
    // A rail starts exactly AT the lip and runs outward: capping it backward
    // would push it into the section, where it walls off the very cavity it is
    // meant to bound — enough, at a corner, to cut the cavity in two.
    if (!open.has((i - 1 + n) % n)) {
      const q = edgeBand(a, [a[0] + ox, a[1] + oy], distance, 0, distance);
      if (q) band.push(q);
    }
    if (!open.has((i + 1) % n)) {
      const q = edgeBand(b, [b[0] + ox, b[1] + oy], distance, 0, distance);
      if (q) band.push(q);
    }
  }
  if (band.length === 0) return null; // every edge open — there is no wall to build

  let result: MultiPolygon;
  try {
    result = [region];
    for (const q of quads) result = polygonClipping.union(result, q);
    // Subtract the band ONE PIECE AT A TIME, never unioning the band first.
    // Merging heavily-overlapping rectangles is exactly what this clipper is
    // worst at: unioning even sixteen of them either throws ("Unable to
    // complete output ring") or, when it doesn't, silently leaves gaps — a wall
    // asked to be 2.5 measured 1.44 thick in places. Subtracting them
    // separately was exact at every section size tried (16…360 points), and it
    // sheds emptied area as it goes, so a too-thick wall bails early.
    for (const piece of band) {
      if (result.length === 0) break;
      result = polygonClipping.difference(result, piece);
    }
  } catch {
    // The clipper throws on inputs it cannot resolve rather than returning a
    // wrong answer. Treat that the same as "no usable cavity".
    return null;
  }

  if (result.length !== 1) return null; // pinched into pieces (or vanished)
  const polygon = result[0];
  if (polygon.length !== 1) return null; // grew an island the loft can't carry
  // Drop points the clipper left coincident with their neighbour. They cost
  // nothing here but become ZERO-LENGTH EDGES in the wire the cavity is lofted
  // from, and `BRepOffsetAPI_ThruSections` rejects that outright with a
  // Standard_ConstructionError — an opening on a plain square section was
  // enough to produce one.
  // Scaled to the WALL, because that is the size of the thing being built: a
  // half-percent of it is far below anything a model cares about, and well
  // above the hair-width edges the clipper leaves where a lip cap's arc meets
  // the straight run it is tangent to. Those cost nothing here, but they make
  // the cavity's sections differ in point count and stud them with edges
  // `BRepOffsetAPI_ThruSections` then refuses to loft through, with nothing to
  // say but Standard_ConstructionError.
  const scale = Math.max(...pts.map((p) => Math.abs(p[0])), ...pts.map((p) => Math.abs(p[1])), 1);
  const eps = Math.max(scale * 1e-6, distance * 5e-3);
  const ring: Vec2[] = [];
  for (const p of openRing(polygon[0] as Vec2[])) {
    const q = ring[ring.length - 1];
    if (!q || Math.hypot(p[0] - q[0], p[1] - q[1]) > eps) ring.push(p);
  }
  while (ring.length > 1) {
    const a = ring[0];
    const b = ring[ring.length - 1];
    if (Math.hypot(a[0] - b[0], a[1] - b[1]) > eps) break;
    ring.pop();
  }
  if (ring.length < 3) return null;
  const insetArea = ringSignedArea(ring);
  if (Math.abs(insetArea) < Math.abs(area) * MIN_AREA_FRACTION) return null;

  // Match the source's winding, then start where the source starts, so every
  // station of the cavity is traversed the same way the outer loft's are.
  const oriented = insetArea > 0 === ccw ? ring : ring.reverse();
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < oriented.length; i++) {
    const d = (oriented[i][0] - pts[0][0]) ** 2 + (oriented[i][1] - pts[0][1]) ** 2;
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return [...oriented.slice(best), ...oriented.slice(0, best)];
}
