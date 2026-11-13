// Gears in an assembly: what a gear relation can learn from the parts it
// turns. A part made by a Gear feature knows its tooth count, whether it's a
// ring, and where its teeth point — so a relation between two gears can take
// its ratio and direction from them, and turn the driven gear so its teeth sit
// in the other's spaces ("Align teeth") instead of overlapping.
//
// The meshing condition, with both angles measured the same way round one
// common axis. External pair, F fixed and M to turn: when a tooth of F points
// straight at M, M has a space pointing straight back; turning F by δ turns M
// by −δ·Nf/Nm. So M's tooth angle must be
//     angle(F − M) + π/Nm − δF·Nf/Nm      (mod 2π/Nm)
// where δF is F's tooth offset from the line F→M. A pinion in a ring turns the
// same way as the ring, and the pinion's tooth sits in a ring SPACE (a ring's
// "tooth 0" is a space, see gearProfile.ts), both pointing out from the ring's
// centre. Backlash and profile shift are symmetric about each tooth, so they
// don't move these angles.
import { bakeGear } from "../document/gear";
import { resolveDocument } from "../document/document";
import { featureIdOfPart } from "../document/parts";
import type { Document } from "../document/types";
import { applyPoint, type Vec3 } from "./placement";
import { formatValue, isDriven, type Solution } from "./solve";
import type { AssemblyDoc, Dof, Mat4 } from "./types";

/** A gear part's geometry in its own document's coordinates. */
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

const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const scale = (a: Vec3, k: number): Vec3 => [a[0] * k, a[1] * k, a[2] * k];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const unit = (a: Vec3): Vec3 => scale(a, 1 / Math.hypot(...a));

/** The gear geometry of `partId` in `doc`, when a Gear feature made it and
 *  nothing has moved it since (an in-place Transform would; then null). Null
 *  too when the gear doesn't build. */
export function gearGeomOf(doc: Document, partId: string): GearGeom | null {
  const id = featureIdOfPart(partId);
  if (id !== partId) return null; // a second lump of something: not a gear
  const g = doc.features.find((f) => f.id === id);
  if (g?.type !== "gear") return null;
  if (doc.features.some((f) => f.type === "transform" && f.targetId === id && !f.suppressed)) return null;
  try {
    const { scope, planeFrames } = resolveDocument(doc);
    const b = bakeGear(doc, g, scope, planeFrames);
    const { origin, uAxis, vAxis } = b.frame;
    const at = (u: number, v: number): Vec3 => add(add(origin, scale(uAxis, u)), scale(vAxis, v));
    return {
      teeth: b.spec.teeth,
      module: b.spec.module,
      internal: g.gearType === "internal",
      center: at(b.center[0], b.center[1]),
      axis: unit(cross(uAxis, vAxis)),
      tooth: unit(add(scale(uAxis, Math.cos(b.rotation)), scale(vAxis, Math.sin(b.rotation)))),
    };
  } catch {
    return null;
  }
}

/** `g` placed by an instance transform. */
export function placeGear(g: GearGeom, m: Mat4): GearGeom {
  const o = applyPoint(m, [0, 0, 0]);
  const dir = (d: Vec3) => unit(sub(applyPoint(m, d), o));
  return { ...g, center: applyPoint(m, g.center), axis: dir(g.axis), tooth: dir(g.tooth) };
}

/** The ratio and direction a gear relation between two gears should have:
 *  driven turns per driver turn, as text ("12/24"), and Reverse. The ratio is
 *  the tooth counts'. The direction is NOT just "a pinion in a ring turns the
 *  same way": a relation relates the mates' angles, and a revolute whose axis
 *  points the other way (an upside-down part, a flipped connector) turns its
 *  gear the other way round for the same angle. So each mate is nudged a
 *  degree (`solveAt`) to see which way its gear turns in the world. Null when
 *  either end isn't a gear or the nudge says nothing. */
export function gearRelationValue(
  a: AssemblyDoc,
  ends: { driver: { mateId: string; dof: Dof } | null; driven: { mateId: string; dof: Dof } | null },
  gearOf: (instanceId: string) => GearGeom | null,
  solveAt: (a: AssemblyDoc) => Solution,
): { value: string; reverse: boolean } | null {
  const pair = relationGears(a, ends, gearOf);
  if (!pair || !ends.driver || !ends.driven) return null;
  const s0 = solveAt(a);
  const n = placed(s0, pair.driver)?.axis;
  if (!n) return null;
  const sDriver = turnPerDegree(a, s0, ends.driver, pair.driver, n, solveAt);
  const sDriven = turnPerDegree(a, s0, ends.driven, pair.driven, n, solveAt);
  if (!sDriver || !sDriven) return null;
  // World: an external pair turns opposite ways, a pinion and ring the same.
  const sameWay = pair.driver.geom.internal !== pair.driven.geom.internal;
  // A gear relation is driven = phase − ratio × driver; Reverse makes it +.
  const kPositive = sameWay === sDriver * sDriven > 0;
  return { value: `${pair.driver.geom.teeth}/${pair.driven.geom.teeth}`, reverse: kPositive };
}

type PlacedEnd = { instanceId: string; geom: GearGeom };
const placed = (s: Solution, g: PlacedEnd) => {
  const at = s.placements.get(g.instanceId);
  return at ? placeGear(g.geom, at) : null;
};

/** `a` with `mateId`'s `dof` set to `value` (a number, as text). */
function withValue(a: AssemblyDoc, mateId: string, dof: Dof, value: number): AssemblyDoc {
  return {
    ...a,
    mates: a.mates.map((m) =>
      m.id === mateId ? { ...m, values: { ...m.values, [dof]: formatValue(value, true) } } : m,
    ),
  };
}

/** Radians `g` turns about `n` per degree added to `mateId`'s stored `dof`
 *  (an expression is replaced by its solved value for the trial). 0 when it
 *  doesn't turn. */
function turnPerDegree(
  a: AssemblyDoc,
  s0: Solution,
  end: { mateId: string; dof: Dof },
  g: PlacedEnd,
  n: Vec3,
  solveAt: (a: AssemblyDoc) => Solution,
): number {
  const m = a.mates.find((x) => x.id === end.mateId);
  if (!m) return 0;
  const stored = isDriven(m, end.dof) ? (s0.values.get(m.id)?.[end.dof] ?? 0) : Number(m.values?.[end.dof] ?? 0);
  const before = placed(s0, g);
  const after = placed(solveAt(withValue(a, m.id, end.dof, stored + 1)), g);
  if (!before || !after) return 0;
  const t = turnAbout(n, before.tooth, after.tooth);
  return Math.abs(t) < 1e-6 ? 0 : t;
}

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

/** The gear a mate turns: the side of it whose part is a gear (`gearOf`),
 *  the moving side (b) first, never a grounded one. */
export function mateGear(
  a: AssemblyDoc,
  mateId: string,
  gearOf: (instanceId: string) => GearGeom | null,
): { instanceId: string; geom: GearGeom } | null {
  const m = a.mates.find((x) => x.id === mateId);
  if (!m) return null;
  for (const side of [m.b, m.a]) {
    const inst = a.instances.find((i) => i.id === side.instanceId);
    if (!inst || inst.grounded) continue;
    const geom = gearOf(inst.id);
    if (geom) return { instanceId: inst.id, geom };
  }
  return null;
}

/** The two gears a gear relation's ends turn, when both are gears (and not
 *  the same part). */
export function relationGears(
  a: AssemblyDoc,
  ends: { driver: { mateId: string } | null; driven: { mateId: string } | null },
  gearOf: (instanceId: string) => GearGeom | null,
): { driver: { instanceId: string; geom: GearGeom }; driven: { instanceId: string; geom: GearGeom } } | null {
  if (!ends.driver || !ends.driven) return null;
  const driver = mateGear(a, ends.driver.mateId, gearOf);
  const driven = mateGear(a, ends.driven.mateId, gearOf);
  return driver && driven && driver.instanceId !== driven.instanceId ? { driver, driven } : null;
}

/** `a` with gear relation `relId`'s phase turned so the driven gear's teeth
 *  sit in the driver's spaces where they are now — the least turn either way.
 *  `solveAt` solves an assembly (for the placements). The turn is found in the
 *  world and converted to the driven DOF by trying a one-degree nudge, which
 *  covers either mate direction and an upside-down part alike. A string when
 *  it can't: why. */
export function alignRelation(
  a: AssemblyDoc,
  relId: string,
  gearOf: (instanceId: string) => GearGeom | null,
  solveAt: (a: AssemblyDoc) => Solution,
): AssemblyDoc | string {
  const r = a.relations?.find((x) => x.id === relId);
  if (!r || r.type !== "gear" || r.suppressed) return a;
  const pair = relationGears(a, r, gearOf);
  if (!pair) return "Align teeth needs a gear feature's part on both mates.";
  const driven = a.mates.find((m) => m.id === r.driven.mateId)!;
  if (isDriven(driven, r.driven.dof)) return "The driven angle is an expression; align it by hand.";
  const phase = Number(driven.values?.[r.driven.dof] ?? 0);
  const withPhase = (p: number) => withValue(a, driven.id, r.driven.dof, p);
  const s0 = solveAt(a);
  const f = placed(s0, pair.driver);
  const m0 = placed(s0, pair.driven);
  if (!f || !m0) return "The gears aren't placed yet.";
  const turn = alignTurn(f, m0);
  if (typeof turn === "string") return turn;
  const perDegree = turnPerDegree(a, s0, r.driven, pair.driven, f.axis, solveAt);
  if (!perDegree) return "The driven gear doesn't turn with its mate's angle.";
  return Math.abs(turn) < 1e-9 ? a : withPhase(phase + turn / perDegree);
}
