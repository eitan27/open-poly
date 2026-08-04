export type Vec3 = [number, number, number];

/** Euclidean length, floored at 1 so callers can divide by it unconditionally. */
export function vlen(v: Vec3): number {
  return Math.hypot(v[0], v[1], v[2]) || 1;
}

/** Unit vector in the direction of `v`; the zero vector maps to itself. */
export function vunit(v: Vec3): Vec3 {
  const l = vlen(v);
  return [v[0] / l, v[1] / l, v[2] / l];
}

export function vcross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

export function vdot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}
