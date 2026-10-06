// How circles and arcs are turned into polylines — in ONE place, for everybody.
//
// The kernel approximates round walls with polygons rather than analytic
// surfaces (this OCCT build can't boolean an analytic cylinder against a plane —
// see facetedCylinderShape). That is fine on its own. What is not fine is
// approximating the SAME circle twice, by two code paths, and getting two
// different polygons — a primitive cylinder as a 96-gon anchored at angle 0,
// say, while a sketch arc is cut into 48 equal pieces starting wherever the user
// happened to draw it. Sketch a semicircle on a cylinder's top face, extrude it,
// and the two walls that are meant to BE the same surface disagree by up to
// r·(1−cos(π/96)) — 0.016mm at r=30 — leaving a ribbon of hair-thin crescent
// faces up the whole joint. Measured on that shape: a clean fuse is 100 faces,
// a misaligned one 245. Those crescents are what OCCT then refuses to
// tessellate (holes you can see through), what shades as a streak, and what
// stops a chamfer meeting the rim cleanly.
//
// So: the discretisation of a circle is a pure function of its geometry, never
// of the code path, the drawing order, or the arc's span. Every station sits at
// an integer multiple of one fixed pitch, measured from the plane's own zero
// direction. Two independently built copies of a circle are then identical, and
// an arc's stations are a strict SUBSET of the full circle's — so a sketch arc
// concentric and coradial with a cylinder lands exactly on that cylinder's own
// vertices and the boolean has nothing to slice.
//
// The unavoidable residue: an arc's two endpoints are where they were drawn, not
// on stations, so a partial facet remains at each end. Two slivers instead of a
// hundred and forty-five, and no way around it — the arc really does end there.

/** Facets per full circle. Higher = smoother wall at more faces; 96 reads as
 *  round while staying polygonal (and so booleanable). Changing this changes the
 *  facet count of every round wall in every document. */
export const CIRCLE_FACETS = 96;

/** Angle between adjacent stations. */
export const FACET_PITCH = (2 * Math.PI) / CIRCLE_FACETS;

// Angles closer than this are the same station; keeps an endpoint that happens
// to land on one from being emitted twice as a zero-length segment.
const ANGLE_EPS = 1e-9;

/** The angles a circle is discretised at: every station, once round, starting at
 *  the plane's zero direction. Does NOT repeat the first angle at the end. */
export function circleStations(): number[] {
  return Array.from({ length: CIRCLE_FACETS }, (_, i) => i * FACET_PITCH);
}

/** The angles an arc from `start` to `end` is discretised at: both endpoints,
 *  plus every station strictly between them. Handles either sweep direction, and
 *  spans beyond 2π (a full circle passed as `start`→`start + 2π` yields exactly
 *  the circle's own stations plus the closing point). */
export function arcStations(start: number, end: number): number[] {
  if (!Number.isFinite(start) || !Number.isFinite(end)) return [start, end];
  const dir = end >= start ? 1 : -1;
  const out = [start];
  // The first station strictly past `start` in the direction of travel.
  let k = dir > 0 ? Math.floor(start / FACET_PITCH) + 1 : Math.ceil(start / FACET_PITCH) - 1;
  // The span can't exceed a full turn by construction, so the station count is
  // bounded; the guard is only there so a pathological input can't spin forever.
  for (let guard = 0; guard <= CIRCLE_FACETS + 2; guard++) {
    const a = k * FACET_PITCH;
    if (dir > 0 ? a >= end - ANGLE_EPS : a <= end + ANGLE_EPS) break;
    if (Math.abs(a - start) > ANGLE_EPS) out.push(a);
    k += dir;
  }
  if (Math.abs(end - out[out.length - 1]) > ANGLE_EPS) out.push(end);
  return out;
}
