// Where two gears' teeth go, in pure geometry: the meshing condition both the
// Gear feature (placing a gear beside its partner, teeth in mesh) and gear
// relations in an assembly (Align teeth) use.
//
// With both angles measured the same way round one common axis. External
// pair, F fixed and M to turn: when a tooth of F points straight at M, M has a
// space pointing straight back; turning F by δ turns M by −δ·Nf/Nm. So M's
// tooth angle must be
//     angle(F − M) + π/Nm − δF·Nf/Nm      (mod 2π/Nm)
// where δF is F's tooth offset from the line F→M. A pinion in a ring turns the
// same way as the ring, and the pinion's tooth sits in a ring SPACE (a ring's
// "tooth 0" is a space, see gearProfile.ts), both pointing out from the ring's
// centre. Backlash and profile shift are symmetric about each tooth, so they
// don't move these angles.

export type Vec3 = [number, number, number];

/** A gear's geometry: where it is, which way it faces, where tooth 0 points. */
export interface GearGeom {
  teeth: number;
  module: number;
  internal: boolean;
  center: Vec3;
  /** The gear's axis (its plane's normal). */
  axis: Vec3;
  /** Unit direction of tooth 0 from the centre — a ring's space 0. */
  tooth: Vec3;
}

export const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const scale = (a: Vec3, k: number): Vec3 => [a[0] * k, a[1] * k, a[2] * k];
export const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
export const unit = (a: Vec3): Vec3 => scale(a, 1 / Math.hypot(...a));

/** Wrap `a` into [−p/2, p/2). */
const wrap = (a: number, p: number) => a - p * Math.floor(a / p + 0.5);

/** How far (radians, about `fixed`'s axis, counter-clockwise looking down it)
 *  `moving` must turn — the least turn either way — to put its teeth into
 *  `fixed`'s spaces. Both are placed in one space. A string when they can't
 *  mesh: axes not parallel, two rings, concentric, or not at meshing
 *  distance. */
export function alignTurn(fixed: GearGeom, moving: GearGeom): number | string {
  const n = fixed.axis;
  if (Math.abs(dot(n, moving.axis)) < 0.999) return "The gears' axes aren't parallel.";
  if (fixed.internal && moving.internal) return "Two ring gears can't mesh.";
  // Angles about n, in a basis of n's plane.
  const e1 = unit(Math.abs(n[0]) < 0.9 ? cross(n, [1, 0, 0]) : cross(n, [0, 1, 0]));
  const e2 = cross(n, e1);
  const ang = (v: Vec3) => Math.atan2(dot(v, e2), dot(v, e1));
  const d = sub(moving.center, fixed.center);
  const inPlane = sub(d, scale(n, dot(d, n)));
  const dist = Math.hypot(...inPlane);
  if (fixed.module !== moving.module) return "The gears have different modules, so they can't mesh.";
  const m = fixed.module;
  const ring = fixed.internal || moving.internal;
  const want = ring ? (m * Math.abs(fixed.teeth - moving.teeth)) / 2 : (m * (fixed.teeth + moving.teeth)) / 2;
  if (dist < 1e-6) return "The gears are on the same axis.";
  if (Math.abs(dist - want) > 0.25 * m)
    return `The gears' centres are ${round(dist)} mm apart; to mesh they need ${round(want)} mm.`;

  const Nf = fixed.teeth;
  const Nm = moving.teeth;
  const pf = (2 * Math.PI) / Nf;
  const pm = (2 * Math.PI) / Nm;
  const thetaF = ang(fixed.tooth);
  const thetaM = ang(moving.tooth);
  const toM = ang(inPlane); // fixed → moving
  const toF = toM + Math.PI; // moving → fixed
  let target: number;
  if (!ring) {
    const dF = wrap(thetaF - toM, pf);
    target = toF + Math.PI / Nm - (dF * Nf) / Nm;
  } else if (fixed.internal) {
    // F is the ring: its space offset from the line out to the pinion.
    const sF = wrap(thetaF - toM, pf);
    target = toM + (sF * Nf) / Nm;
  } else {
    // M is the ring, F the pinion inside it: the pinion's tooth pointing out
    // from the ring's centre sits in a ring space.
    const out = toF; // ring centre → pinion
    const dF = wrap(thetaF - out, pf);
    target = out + (dF * Nf) / Nm;
  }
  return wrap(target - thetaM, pm);
}

const round = (x: number) => Math.round(x * 100) / 100;

/** Signed angle (radians) from `a` to `b` about `axis`, counter-clockwise
 *  looking down it. */
export function turnAbout(axis: Vec3, a: Vec3, b: Vec3): number {
  return Math.atan2(dot(cross(a, b), axis), dot(a, b));
}
