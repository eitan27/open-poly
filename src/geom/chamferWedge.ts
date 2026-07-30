// The geometry of a chamfer's cross-section, as pure functions.
//
// A chamfer on a straight edge between two perpendicular flat faces is built as a
// boolean rather than by BRepFilletAPI (see the kernel's chamferWedgeFor for why:
// BRepFilletAPI's size is capped by the wall's facet width, a boolean's isn't).
// The decisions that shape the wedge — which way is "into" each face, whether the
// edge is convex or concave, how long each leg is, whether it fits — are plain
// vector arithmetic with no kernel in them. They live here so they can be tested
// in Node, because the kernel needs OCCT/wasm and cannot be.
//
// That split matters more than tidiness. These are exactly the parts most easily
// got subtly wrong: a sign flip in the convexity test turns a chamfer into a
// gouge, and a missing fit check lets a boolean cut a 999mm wedge out of a 40mm
// box and report success.

export type V3 = [number, number, number];

export const dot = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a: V3, b: V3): V3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
export const length = (a: V3): number => Math.hypot(a[0], a[1], a[2]);
export const unit = (a: V3): V3 | null => {
  const L = length(a);
  return L < 1e-12 ? null : [a[0] / L, a[1] / L, a[2] / L];
};
export const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const scaleAdd = (p: V3, d: V3, k: number): V3 => [p[0] + d[0] * k, p[1] + d[1] * k, p[2] + d[2] * k];

/** Two faces meet at a right angle when their normals are perpendicular. Only
 *  right angles are handled: away from 90° the cross-section's legs no longer
 *  follow from size and angle by simple trigonometry. */
export function isRightAngle(n1: V3, n2: V3): boolean {
  return Math.abs(dot(n1, n2)) <= 1e-6;
}

/** The direction to travel INSIDE a face, away from one of its edges.
 *
 *  `along × normal` is tangent to the face and perpendicular to the edge, which
 *  leaves only the sign; that is settled by which side of the edge the face's own
 *  centre lies on. Null when the edge runs along the normal (no tangent exists). */
export function inFaceDirection(along: V3, normal: V3, edgeMid: V3, faceCentre: V3): V3 | null {
  const t = unit(cross(along, normal));
  if (!t) return null;
  if (dot(t, sub(faceCentre, edgeMid)) >= 0) return t;
  // `-0` is numerically zero but compares and prints as its own value; keep it out
  // of geometry that gets logged, serialised or compared downstream.
  const flip = (v: number) => (v === 0 ? 0 : -v);
  return [flip(t[0]), flip(t[1]), flip(t[2])];
}

/** Whether the material sits OUTSIDE the corner (convex, so a chamfer cuts it
 *  away) or inside it (concave, so a chamfer fills it in).
 *
 *  Face 1 falling away BEHIND face 2's plane is convex; rising in front of it is
 *  concave. A box's top/front edge: into-the-top is +y, the front's normal is −y,
 *  dot < 0 ⇒ convex. A wall standing on a top face: into-the-wall is +z and the
 *  top's normal is +z, dot > 0 ⇒ concave. */
export function isConvexEdge(inFace1: V3, normal2: V3): boolean {
  return dot(inFace1, normal2) < 0;
}

/** The two legs of the cross-section triangle. `size` is measured on the
 *  reference face and the bevel leaves it at `angleDeg`, so the other leg is
 *  size·tan(angle) — 45° giving the symmetric chamfer.
 *
 *  The angle has to be checked as an ANGLE, not by testing the result for
 *  finiteness: `Math.tan(90°)` in floating point is 1.6e16, which is finite, so a
 *  90° chamfer sailed through an isFinite guard and produced a leg of 3.3e16 mm.
 *  A bevel only means anything strictly between 0° and 90°. */
export function chamferLegs(size: number, angleDeg: number): { ref: number; other: number } | null {
  if (!(size > 1e-9) || !Number.isFinite(size)) return null;
  if (!Number.isFinite(angleDeg) || angleDeg <= 1e-9 || angleDeg >= 90 - 1e-9) return null;
  const other = size * Math.tan((angleDeg * Math.PI) / 180);
  if (!(other > 1e-9) || !Number.isFinite(other)) return null;
  return { ref: size, other };
}

/** A leg has to fit on the face it runs along. A boolean cannot tell that a
 *  chamfer is too big — it would cut a 999mm wedge out of a 40mm box and report
 *  success — so an over-large one must be refused here and left to the kernel,
 *  which rejects it with a message worth showing. `reach` is how far the face
 *  extends from the edge in that direction. */
export function legFits(leg: number, reach: number): boolean {
  return leg < reach - 1e-9;
}

/** The corners of the cross-section triangle: the edge itself, then `ref` along
 *  the reference face and `other` along the opposite one. Swept along the edge,
 *  this is the solid the chamfer removes (convex) or adds (concave). */
export function chamferTriangle(
  onEdge: V3,
  towardRef: V3,
  towardOther: V3,
  legs: { ref: number; other: number },
): [V3, V3, V3] {
  return [onEdge, scaleAdd(onEdge, towardRef, legs.ref), scaleAdd(onEdge, towardOther, legs.other)];
}
