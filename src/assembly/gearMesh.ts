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
import {
  add,
  alignTurn,
  cross,
  dot,
  rackFrame,
  rackMesh,
  scale,
  sub,
  turnAbout,
  unit,
  type GearGeom,
  type Vec3,
} from "../geom/gearAlign";
import { applyPoint } from "./placement";
import { formatValue, isDriven, isRotation, type Solution } from "./solve";
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
    const dir = (a: number) => unit(add(scale(uAxis, Math.cos(a)), scale(vAxis, Math.sin(a))));
    if (g.gearType === "rack") {
      // Its space 0 is at the −x end of its pitch line; teeth 90° CCW of its run.
      const half = (b.spec.teeth * Math.PI * b.spec.module) / 2;
      geom = {
        teeth: b.spec.teeth,
        module: b.spec.module,
        internal: false,
        center: at(b.center[0] - half * Math.cos(b.rotation), b.center[1] - half * Math.sin(b.rotation)),
        axis: unit(cross(uAxis, vAxis)),
        tooth: dir(b.rotation + Math.PI / 2),
        rack: { run: dir(b.rotation) },
      };
    } else
      geom = {
        teeth: b.spec.teeth,
        module: b.spec.module,
        internal: g.gearType === "internal",
        profileShift: b.spec.profileShift,
        center: at(b.center[0], b.center[1]),
        axis: unit(cross(uAxis, vAxis)),
        tooth: dir(b.rotation),
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
    ...(g.rack ? { rack: { run: unit(turnV(g.rack.run)) } } : {}),
  };
}

/** `g` placed by an instance transform. */
export function placeGear(g: GearGeom, m: Mat4): GearGeom {
  const o = applyPoint(m, [0, 0, 0]);
  const dir = (d: Vec3) => unit(sub(applyPoint(m, d), o));
  return {
    ...g,
    center: applyPoint(m, g.center),
    axis: dir(g.axis),
    tooth: dir(g.tooth),
    ...(g.rack ? { rack: { run: dir(g.rack.run) } } : {}),
  };
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
      m.id === mateId ? { ...m, values: { ...m.values, [dof]: formatValue(value, isRotation(dof)) } } : m,
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
  if (driver?.geom.rack || driven?.geom.rack) return null; // a rack goes in a Rack relation
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
  if (r?.type === "rack" && !r.suppressed) return alignRackRelation(a, relId, gearOf, solveAt);
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

// ---- Rack and pinion ------------------------------------------------------

type End = { mateId: string; dof: Dof };

/** The pinion and the rack a rack relation's ends move: the end whose DOF
 *  turns must turn a spur gear's part, the one that slides a rack's. Null
 *  when they don't. */
export function relationRack(
  a: AssemblyDoc,
  ends: { driver: End | null; driven: End | null },
  gearOf: (instanceId: string) => GearGeom | null,
): { pinion: PlacedEnd & { end: End }; rack: PlacedEnd & { end: End } } | null {
  if (!ends.driver || !ends.driven) return null;
  if (isRotation(ends.driver.dof) === isRotation(ends.driven.dof)) return null;
  const [turnEnd, slideEnd] = isRotation(ends.driver.dof) ? [ends.driver, ends.driven] : [ends.driven, ends.driver];
  const pinion = mateGear(a, turnEnd.mateId, gearOf);
  const rack = mateGear(a, slideEnd.mateId, gearOf);
  if (!pinion || !rack || pinion.geom.rack || pinion.geom.internal || !rack.geom.rack) return null;
  if (pinion.instanceId === rack.instanceId) return null;
  return { pinion: { ...pinion, end: turnEnd }, rack: { ...rack, end: slideEnd } };
}

/** Millimetres `g` moves along `dir` per unit added to `end`'s stored DOF. */
function movePerUnit(
  a: AssemblyDoc,
  s0: Solution,
  end: End,
  g: PlacedEnd,
  dir: Vec3,
  solveAt: (a: AssemblyDoc) => Solution,
): number {
  const m = a.mates.find((x) => x.id === end.mateId);
  if (!m) return 0;
  const stored = isDriven(m, end.dof) ? (s0.values.get(m.id)?.[end.dof] ?? 0) : Number(m.values?.[end.dof] ?? 0);
  const before = placed(s0, g);
  const after = placed(solveAt(withValue(a, m.id, end.dof, stored + 1)), g);
  if (!before || !after) return 0;
  const v = dot(sub(after.center, before.center), dir);
  return Math.abs(v) < 1e-6 ? 0 : v;
}

/** The radius and direction a rack relation between a pinion and a rack
 *  should have: the pinion's pitch radius, and Reverse measured as for gears
 *  — each mate nudged to see which way its part goes in the world. Null when
 *  the ends aren't a pinion and a rack, or the nudge says nothing. */
export function rackRelationValue(
  a: AssemblyDoc,
  ends: { driver: End | null; driven: End | null },
  gearOf: (instanceId: string) => GearGeom | null,
  solveAt: (a: AssemblyDoc) => Solution,
): { value: string; reverse: boolean } | null {
  const pair = relationRack(a, ends, gearOf);
  if (!pair) return null;
  const s0 = solveAt(a);
  const p = placed(s0, pair.pinion);
  const r = placed(s0, pair.rack);
  if (!p || !r) return null;
  const { t } = rackFrame(p, r);
  const sTurn = turnPerDegree(a, s0, pair.pinion.end, pair.pinion, p.axis, solveAt);
  const sMove = movePerUnit(a, s0, pair.rack.end, pair.rack, t, solveAt);
  if (!sTurn || !sMove) return null;
  // The rack moves r·θ along t as the pinion turns θ counter-clockwise; a
  // rack relation's k is +r·π/180 unless reversed.
  const radius = (p.module * p.teeth) / 2;
  return { value: String(Number(radius.toFixed(6))), reverse: sTurn * sMove < 0 };
}

/** `a` with rack relation `relId`'s phase changed so the rack's teeth sit in
 *  mesh with the pinion's where they are now — the driven end (the rack
 *  sliding, or the pinion turning) moved the least way. A string when it
 *  can't: why. */
export function alignRackRelation(
  a: AssemblyDoc,
  relId: string,
  gearOf: (instanceId: string) => GearGeom | null,
  solveAt: (a: AssemblyDoc) => Solution,
): AssemblyDoc | string {
  const rel = a.relations?.find((x) => x.id === relId);
  if (!rel || rel.type !== "rack" || rel.suppressed) return a;
  const pair = relationRack(a, rel, gearOf);
  if (!pair) return "Align teeth needs a gear's part on the turning mate and a rack's on the sliding one.";
  const driven = a.mates.find((m) => m.id === rel.driven.mateId)!;
  if (isDriven(driven, rel.driven.dof)) return "The driven value is an expression; align it by hand.";
  const s0 = solveAt(a);
  const p = placed(s0, pair.pinion);
  const r = placed(s0, pair.rack);
  if (!p || !r) return "The gear and the rack aren't placed yet.";
  const mesh = rackMesh(p, r);
  if (typeof mesh === "string") return mesh;
  if (Math.abs(mesh.misfit) < 1e-9) return a;
  const phase = Number(driven.values?.[rel.driven.dof] ?? 0);
  let delta: number;
  if (isRotation(rel.driven.dof)) {
    // Turn the pinion +misfit/r about its axis.
    const perDegree = turnPerDegree(a, s0, rel.driven, pair.pinion, p.axis, solveAt);
    if (!perDegree) return "The gear doesn't turn with its mate's angle.";
    delta = mesh.misfit / ((p.module * p.teeth) / 2) / perDegree;
  } else {
    // Slide the rack −misfit along t.
    const perUnit = movePerUnit(a, s0, rel.driven, pair.rack, mesh.t, solveAt);
    if (!perUnit) return "The rack doesn't move with its mate's slide.";
    delta = -mesh.misfit / perUnit;
  }
  return withValue(a, driven.id, rel.driven.dof, phase + delta);
}

export { alignTurn, rackMesh, turnAbout, type GearGeom };
