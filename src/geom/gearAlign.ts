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
  /** Unit direction of tooth 0 from the centre — a ring's space 0. A rack's:
   *  the way its teeth point. */
  tooth: Vec3;
  /** Set for a rack. Then `center` is a point on its pitch line in the
   *  middle of a tooth space (its −x end), and `run` the unit direction it
   *  runs along; its spaces repeat every π × module along `run`. */
  rack?: { run: Vec3 };
  /** Profile shift coefficient (× module): a shifted pinion sits that much
   *  further from a rack's pitch line. */
  profileShift?: number;
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
  if (fixed.rack || moving.rack) return "A rack meshes with a gear through a Rack relation.";
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
    return `The gears' centers are ${round(dist)} mm apart; to mesh they need ${round(want)} mm.`;

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

/** A pinion and a rack: where the rack's pitch line is from the pinion, and
 *  how far out of mesh they are. `misfit` is how far (mm, along `t`) the
 *  rack's nearest space sits from where the pinion's nearest tooth rolls to
 *  on the rack's pitch line, wrapped to half a tooth pitch either way: moving
 *  the rack −misfit along `t`, or turning the pinion +misfit / r about its
 *  axis, meshes them. `t` = axis × d is the way the pinion's pitch point moves
 *  when it turns counter-clockwise (looking down its axis), d the unit
 *  direction from its centre to the rack's pitch line. A string when they
 *  can't mesh: why. */
export function rackMesh(
  pinion: GearGeom,
  rack: GearGeom,
): { misfit: number; t: Vec3; d: Vec3; distance: number } | string {
  if (!rack.rack) return "That isn't a rack.";
  if (pinion.rack) return "Two racks can't mesh.";
  if (pinion.internal) return "A rack meshes with a spur gear, not a ring gear.";
  const n = pinion.axis;
  if (Math.abs(dot(n, rack.axis)) < 0.999) return "The rack isn't in the gear's plane.";
  if (pinion.module !== rack.module) return "The gear and the rack have different modules, so they can't mesh.";
  const m = pinion.module;
  const { foot, d, t, distance } = rackFrame(pinion, rack);
  const r = (m * pinion.teeth) / 2;
  const want = r + (pinion.profileShift ?? 0) * m;
  if (distance < 1e-6) return "The gear's center is on the rack's pitch line.";
  if (dot(rack.tooth, d) > -0.5) return "The rack's teeth face away from the gear.";
  if (Math.abs(distance - want) > 0.25 * m)
    return `The gear's center is ${round(distance)} mm from the rack's pitch line; to mesh it needs ${round(want)} mm.`;
  // The pinion's tooth nearest the rack, as an angle from d (CCW about n).
  const delta = wrap(turnAbout(n, d, pinion.tooth), (2 * Math.PI) / pinion.teeth);
  // That tooth rolls to foot + r·δ·t; the rack's spaces are center + k·p·run.
  const p = Math.PI * m;
  const misfit = wrap(dot(sub(rack.center, foot), t) - r * delta, p);
  return { misfit, t, d, distance };
}

/** Where a rack's pitch line is from a pinion, unchecked: the foot of the
 *  pinion's centre on it, the unit direction d to it in the pinion's plane,
 *  t = axis × d (the way the pinion's pitch point moves turning
 *  counter-clockwise), and the distance. */
export function rackFrame(pinion: GearGeom, rack: GearGeom): { foot: Vec3; d: Vec3; t: Vec3; distance: number } {
  const n = pinion.axis;
  const run = rack.rack?.run ?? [1, 0, 0];
  const off = sub(pinion.center, rack.center);
  const foot = add(rack.center, scale(run, dot(off, run)));
  const toFoot = sub(foot, pinion.center);
  const inPlane = sub(toFoot, scale(n, dot(toFoot, n)));
  const distance = Math.hypot(...inPlane);
  // On the line (no direction to it): fall back to the way the teeth point,
  // reversed, so t is still defined.
  const d = distance > 1e-9 ? scale(inPlane, 1 / distance) : scale(rack.tooth, -1);
  return { foot, d, t: cross(n, d), distance };
}
