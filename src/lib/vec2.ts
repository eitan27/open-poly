export type Vec2 = [number, number];

/** Distance between two points. */
export function dist2(a: Vec2, b: Vec2): number {
  return Math.hypot(b[0] - a[0], b[1] - a[1]);
}

/** Magnitude of a vector. */
export function mag2(v: Vec2): number {
  return Math.hypot(v[0], v[1]);
}

/** Whether two points are within `eps` of each other. */
export function approxEqual2(a: Vec2, b: Vec2, eps: number): boolean {
  return dist2(a, b) <= eps;
}

/** Direction from `from` to `to`, in radians. */
export function angleOf2(from: Vec2, to: Vec2): number {
  return Math.atan2(to[1] - from[1], to[0] - from[0]);
}
