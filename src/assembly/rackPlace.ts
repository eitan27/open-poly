// Rack and pinion in an assembly, beyond what a relation itself does:
//
// - Placing the rack: mates put a rack wherever its connectors say, which is
//   rarely the pinion's pitch distance. `placeRack` moves it there by shifting
//   the offset of one connector of the mate that holds the rack — so it works
//   for any mate (a slider, a planar…), whichever side the solver moves.
//   How an offset moves the rack is MEASURED (nudge each offset axis a
//   millimetre, solve, see where the rack goes), not worked out from the
//   mate's frames, for the same reason Reverse is measured (gearMesh.ts).
// - Travel limits: `rackTravelLimits` bounds the relation's driver so the
//   pinion stays on the rack's teeth — at least one tooth pitch in from
//   either end.
import { dot, rackFrame, scale, sub, type GearGeom, type Vec3 } from "../geom/gearAlign";
import { placeGear, relationRack } from "./gearMesh";
import { formatValue, isRotation, type Solution } from "./solve";
import type { AssemblyDoc, Dof, MateConnector } from "./types";

type End = { mateId: string; dof: Dof };
type Ends = { driver: End | null; driven: End | null };
type GearOf = (instanceId: string) => GearGeom | null;
type SolveAt = (a: AssemblyDoc) => Solution;

/** Closer than this (mm) to its pitch distance, a rack needs no placing. */
export const RACK_PLACED_TOL = 0.01;

/** Where the rack is against the pinion: how far its pitch line is from
 *  where it should be (mm; + = too far out), or why it can't be placed. Null
 *  when the ends aren't a pinion and a rack. */
export function rackOffBy(a: AssemblyDoc, ends: Ends, gearOf: GearOf, solveAt: SolveAt): number | string | null {
  const pair = relationRack(a, ends, gearOf);
  if (!pair) return null;
  const s = solveAt(a);
  const at = (instanceId: string, g: GearGeom) => {
    const m = s.placements.get(instanceId);
    return m ? placeGear(g, m) : null;
  };
  const p = at(pair.pinion.instanceId, pair.pinion.geom);
  const r = at(pair.rack.instanceId, pair.rack.geom);
  if (!p || !r) return "The gear and the rack aren't placed yet.";
  if (Math.abs(dot(p.axis, r.axis)) < 0.999)
    return "The rack isn't in the gear's plane: turn it to lie flat beside the gear.";
  const f = rackFrame(p, r);
  if (dot(r.tooth, f.d) > -0.5) return "The rack's teeth face away from the gear: turn the rack round first.";
  return f.distance - pitchDistance(p);
}

const pitchDistance = (p: GearGeom) => (p.module * p.teeth) / 2 + (p.profileShift ?? 0) * p.module;

/** `a` with the rack moved (by a connector offset of the mate that holds it)
 *  so its pitch line is at the pinion's pitch distance. A string when it
 *  can't: why. Unchanged when it's already there. */
export function placeRack(a: AssemblyDoc, ends: Ends, gearOf: GearOf, solveAt: SolveAt): AssemblyDoc | string {
  const pair = relationRack(a, ends, gearOf);
  if (!pair) return "Placing needs a gear's part on the turning mate and a rack's on the sliding one.";
  const off = rackOffBy(a, ends, gearOf, solveAt);
  if (typeof off !== "number") return off ?? "Placing needs a gear and a rack.";
  if (Math.abs(off) < RACK_PLACED_TOL) return a;
  const mate = a.mates.find((m) => m.id === pair.rack.end.mateId);
  if (!mate) return "The rack's mate is gone.";
  const s0 = solveAt(a);
  const rackAt = (s: Solution) => {
    const m = s.placements.get(pair.rack.instanceId);
    return m ? placeGear(pair.rack.geom, m) : null;
  };
  const r0 = rackAt(s0)!;
  const p0 = placeGear(pair.pinion.geom, s0.placements.get(pair.pinion.instanceId)!);
  // The move it needs: along d (pinion → its pitch line), by −off.
  const want = scale(rackFrame(p0, r0).d, -off);

  // Shift the connector on the OTHER part first (the rack moves with it as a
  // whole), then the rack's own if that doesn't take.
  const sides: ("a" | "b")[] = mate.a.instanceId === pair.rack.instanceId ? ["b", "a"] : ["a", "b"];
  for (const side of sides) {
    const withOffset = (o: Record<"x" | "y" | "z", number>): AssemblyDoc => ({
      ...a,
      mates: a.mates.map((m) => (m.id === mate.id ? { ...m, [side]: { ...m[side], offset: asOffset(o) } } : m)),
    });
    const base = offsetOf(mate[side]);
    if (!base) continue; // an offset that doesn't evaluate: leave it alone
    // How each offset axis moves the rack (mm per mm, in the world).
    const cols: Vec3[] = (["x", "y", "z"] as const).map((k) => {
      const r = rackAt(solveAt(withOffset({ ...base, [k]: base[k] + 1 })));
      return r ? sub(r.center, r0.center) : [0, 0, 0];
    });
    const step = leastSquares(cols, want);
    if (!step) continue;
    const next = withOffset({ x: base.x + step[0], y: base.y + step[1], z: base.z + step[2] });
    const after = rackOffBy(next, ends, gearOf, solveAt);
    if (typeof after === "number" && Math.abs(after) < RACK_PLACED_TOL) return next;
  }
  return "Couldn't move the rack by its mate's connectors: move it by hand, or mate it so it can reach the gear.";
}

/** A connector's offset as numbers (absent = 0); null if one doesn't
 *  evaluate as a plain number (an expression naming a variable, say). */
function offsetOf(c: MateConnector): Record<"x" | "y" | "z", number> | null {
  const o = c.offset ?? {};
  const v = (t: string | undefined) => (t === undefined || t.trim() === "" ? 0 : Number(t));
  const r = { x: v(o.x), y: v(o.y), z: v(o.z) };
  return Number.isFinite(r.x) && Number.isFinite(r.y) && Number.isFinite(r.z) ? r : null;
}

function asOffset(o: Record<"x" | "y" | "z", number>): MateConnector["offset"] {
  const out: Partial<Record<"x" | "y" | "z", string>> = {};
  for (const k of ["x", "y", "z"] as const) if (Math.abs(o[k]) > 1e-9) out[k] = formatValue(o[k], false);
  return Object.keys(out).length ? out : undefined;
}

/** The δ that best makes Σ δ_i·cols_i = want (least squares, a little
 *  damped so an axis that moves nothing stays put). Null when nothing moves. */
function leastSquares(cols: Vec3[], want: Vec3): [number, number, number] | null {
  const A = cols.map((ci) => cols.map((cj) => dot(ci, cj)));
  const b = cols.map((c) => dot(c, want));
  if (A.every((row, i) => row[i] < 1e-12)) return null;
  for (let i = 0; i < 3; i++) A[i][i] += 1e-9;
  // Gaussian elimination, 3×3.
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < 3; c++) {
    let piv = c;
    for (let r = c + 1; r < 3; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
    [M[c], M[piv]] = [M[piv], M[c]];
    if (Math.abs(M[c][c]) < 1e-12) continue;
    for (let r = 0; r < 3; r++) {
      if (r === c) continue;
      const f = M[r][c] / M[c][c];
      for (let k = c; k < 4; k++) M[r][k] -= f * M[c][k];
    }
  }
  const x = M.map((row, i) => (Math.abs(row[i]) < 1e-12 ? 0 : row[3] / row[i]));
  return [x[0], x[1], x[2]];
}

/** Limits for the relation's driver that keep the pinion on the rack's
 *  teeth, at least one tooth pitch in from either end, from where they are
 *  now. `a` has the relation in it. A string when it can't: why. */
export function rackTravelLimits(
  a: AssemblyDoc,
  relId: string,
  gearOf: GearOf,
  solveAt: SolveAt,
): { mateId: string; dof: Dof; min: number; max: number } | string {
  const rel = a.relations?.find((r) => r.id === relId);
  if (!rel || rel.type !== "rack") return "Not a rack relation.";
  const pair = relationRack(a, rel, gearOf);
  if (!pair) return "Limits need a gear's part on the turning mate and a rack's on the sliding one.";
  const s0 = solveAt(a);
  const place = (s: Solution, g: { instanceId: string; geom: GearGeom }) => {
    const m = s.placements.get(g.instanceId);
    return m ? placeGear(g.geom, m) : null;
  };
  const p = place(s0, pair.pinion);
  const r = place(s0, pair.rack);
  if (!p || !r || !r.rack) return "The gear and the rack aren't placed yet.";
  const run = r.rack.run;
  const pitch = Math.PI * r.module;
  const L = r.teeth * pitch;
  if (L < 2 * pitch + 1e-9) return "The rack is too short to travel: give it more teeth.";
  // Where along the rack the pinion meets it (from its −x end).
  const u = dot(sub(rackFrame(p, r).foot, r.center), run);
  // The rack moving δ along `run` moves that point by −δ: keep it in [p, L−p].
  const lo = u - (L - pitch);
  const hi = u - pitch;
  // Driver units → rack movement along `run`: a nudge of the driver.
  const driverMate = a.mates.find((m) => m.id === rel.driver.mateId);
  if (!driverMate) return "The driver's mate is gone.";
  const cur = s0.values.get(driverMate.id)?.[rel.driver.dof] ?? 0;
  const nudged: AssemblyDoc = {
    ...a,
    mates: a.mates.map((m) =>
      m.id === driverMate.id
        ? { ...m, values: { ...m.values, [rel.driver.dof]: formatValue(cur + 1, isRotation(rel.driver.dof)) } }
        : m,
    ),
  };
  const r1 = place(solveAt(nudged), pair.rack);
  if (!r1) return "The rack doesn't move with the driver.";
  const perUnit = dot(sub(r1.center, r.center), run);
  if (Math.abs(perUnit) < 1e-9) return "The rack doesn't move with the driver.";
  const ends = [cur + lo / perUnit, cur + hi / perUnit].sort((x, y) => x - y);
  const rot = isRotation(rel.driver.dof);
  // Rounded inward, so the limits never let it past.
  const q = rot ? 10 : 100;
  return {
    mateId: driverMate.id,
    dof: rel.driver.dof,
    min: Math.ceil(ends[0] * q) / q,
    max: Math.floor(ends[1] * q) / q,
  };
}

/** `a` with those limits on the driver (replacing any it had on that DOF). */
export function withTravelLimits(
  a: AssemblyDoc,
  lim: { mateId: string; dof: Dof; min: number; max: number },
): AssemblyDoc {
  const rot = isRotation(lim.dof);
  return {
    ...a,
    mates: a.mates.map((m) =>
      m.id === lim.mateId
        ? {
            ...m,
            limits: {
              ...m.limits,
              [lim.dof]: { min: formatValue(lim.min, rot), max: formatValue(lim.max, rot) },
            },
          }
        : m,
    ),
  };
}
