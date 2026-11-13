// Gears in an assembly: what a gear relation can learn from the parts it
// turns. A part made by a Gear feature knows its tooth count, whether it's a
// ring, and where its teeth point — so a relation between two gears can take
// its ratio and direction from them, and turn the driven gear so its teeth sit
// in the other's spaces ("Align teeth") instead of overlapping.
//
// The meshing condition itself is in geom/gearAlign.ts.
import { bakeGear } from "../document/gear";
import { resolveDocument } from "../document/document";
import { featureIdOfPart } from "../document/parts";
import type { Document } from "../document/types";
import { add, alignTurn, cross, dot, scale, sub, turnAbout, unit, type GearGeom, type Vec3 } from "../geom/gearAlign";
import { applyPoint } from "./placement";
import { formatValue, isDriven, type Solution } from "./solve";
import type { AssemblyDoc, Dof, Mat4 } from "./types";

/** The gear geometry of `partId` in `doc`, when a Gear feature made it:
 *  followed through any in-place Transforms after it, as the kernel applies
 *  them (scale about the pivot, turn about the axis, then move). Null when the
 *  part isn't a gear; `{ problem }` when it is one but its teeth can't be read
 *  (it doesn't build, or a Transform turns it about a body edge, which only
 *  the kernel can resolve). */
export function gearGeomOf(doc: Document, partId: string): GearGeom | { problem: string } | null {
  const id = featureIdOfPart(partId);
  if (id !== partId) return null; // a second lump of something: not a gear
  const g = doc.features.find((f) => f.id === id);
  if (g?.type !== "gear") return null;
  let resolved: ReturnType<typeof resolveDocument>;
  let geom: GearGeom;
  try {
    resolved = resolveDocument(doc);
    const b = bakeGear(doc, g, resolved.scope, resolved.planeFrames);
    const { origin, uAxis, vAxis } = b.frame;
    const at = (u: number, v: number): Vec3 => add(add(origin, scale(uAxis, u)), scale(vAxis, v));
    geom = {
      teeth: b.spec.teeth,
      module: b.spec.module,
      internal: g.gearType === "internal",
      center: at(b.center[0], b.center[1]),
      axis: unit(cross(uAxis, vAxis)),
      tooth: unit(add(scale(uAxis, Math.cos(b.rotation)), scale(vAxis, Math.sin(b.rotation)))),
    };
  } catch (e) {
    return { problem: `${g.name} doesn't build: ${(e as Error).message}` };
  }
  for (const t of resolved.features) {
    if (t.type !== "transform" || t.targetId !== id || t.copy) continue;
    const f = doc.features.find((x) => x.id === t.id);
    if (!f || f.suppressed) continue;
    if (!t.axisOrigin || !t.axisDir)
      return { problem: `${f.name} turns ${g.name} about a body edge, so its teeth can't be read here.` };
    geom = transformGear(geom, t.scale, t.pivot, t.axisOrigin, t.axisDir, (t.angle * Math.PI) / 180, [
      t.tx,
      t.ty,
      t.tz,
    ]);
  }
  return geom;
}

/** `g` through a Transform feature: scaled about `pivot`, turned `angle`
 *  (radians, right-handed) about the line through `o` along `dir`, then moved. */
function transformGear(g: GearGeom, k: number, pivot: Vec3, o: Vec3, dir: Vec3, angle: number, move: Vec3): GearGeom {
  const d = unit(dir);
  const c = Math.cos(angle);
  const sn = Math.sin(angle);
  // Rodrigues: v cosθ + (d × v) sinθ + d (d·v)(1 − cosθ).
  const turnV = (v: Vec3): Vec3 => add(add(scale(v, c), scale(cross(d, v), sn)), scale(d, dot(d, v) * (1 - c)));
  const point = (p: Vec3): Vec3 => {
    const scaled = add(pivot, scale(sub(p, pivot), k));
    return add(add(o, turnV(sub(scaled, o))), move);
  };
  return {
    ...g,
    module: g.module * k,
    center: point(g.center),
    axis: unit(turnV(g.axis)),
    tooth: unit(turnV(g.tooth)),
  };
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

export { alignTurn, turnAbout, type GearGeom };
