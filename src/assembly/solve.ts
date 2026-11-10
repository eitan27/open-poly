// Placing instances from their mates (docs/ASSEMBLY-PLAN.md "Solver"). No
// DOM, no kernel.
//
// A hybrid. Plain open chains — one mate between each pair, no loops — are a
// kinematic tree, solved exactly by composition. Grounded instances are roots,
// and each mate places the instance at its far end from the one already placed:
//
//     T_b = T_a · C_a · M(values) · F · C_b⁻¹
//
// where C are the connector frames in part coordinates, M the mate's motion
// built from its free-DOF values, and F the default face-to-face turn (Z axes
// opposed) plus any quarter turns. A mate reached from its `b` side is just
// inverted.
//
// Where mates close a loop (a four-bar linkage), or two or more mates join the
// same pair of parts (Width with a Planar, three Planars into a corner), those
// parts are solved together numerically: each mate becomes residuals that
// vanish when it holds, and Levenberg–Marquardt (lm.ts) finds poses that zero
// them, starting from where the parts are so a linkage doesn't flip to its
// other solution. Inside such a group a mate's plain-number values only report
// where it is; an expression drives it.
import { evaluateVariables } from "../document/document";
import { evaluateExpression, type Scope } from "../document/expression";
import { levenbergMarquardt } from "./lm";
import { applyPoint, multiply, type Vec3 } from "./placement";
import type { AssemblyDoc, Dof, Mat4, Mate, MateConnector, MateType } from "./types";

/** Each mate type's free DOFs, in the order a dialog lists them. */
export const MATE_DOFS: Record<MateType, Dof[]> = {
  fastened: [],
  revolute: ["rz"],
  slider: ["tz"],
  cylindrical: ["tz", "rz"],
  planar: ["tx", "ty", "rz"],
  ball: ["rx", "ry", "rz"],
  width: ["tx", "ty", "rz"],
};

export const isRotation = (d: Dof) => d[0] === "r";

const DEG = Math.PI / 180;

/** Inverse of a rigid (rotation + translation) placement. */
export function invertRigid(m: Mat4): Mat4 {
  // Rᵀ and −Rᵀt.
  const r = [m[0], m[4], m[8], m[1], m[5], m[9], m[2], m[6], m[10]];
  const t = [m[12], m[13], m[14]];
  return [
    r[0],
    r[1],
    r[2],
    0,
    r[3],
    r[4],
    r[5],
    0,
    r[6],
    r[7],
    r[8],
    0,
    -(r[0] * t[0] + r[3] * t[1] + r[6] * t[2]),
    -(r[1] * t[0] + r[4] * t[1] + r[7] * t[2]),
    -(r[2] * t[0] + r[5] * t[1] + r[8] * t[2]),
    1,
  ];
}

export function rotZ(rad: number): Mat4 {
  const c = Math.cos(rad),
    s = Math.sin(rad);
  return [c, s, 0, 0, -s, c, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
}

/** Rotation by a rotation vector (axis × angle, radians) — Rodrigues. Ball
 *  mates use this rather than Euler angles so motion through them can't
 *  gimbal-lock. */
export function rotVec(v: Vec3): Mat4 {
  const th = Math.hypot(v[0], v[1], v[2]);
  if (th < 1e-12) return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  const [x, y, z] = [v[0] / th, v[1] / th, v[2] / th];
  const c = Math.cos(th),
    s = Math.sin(th),
    k = 1 - c;
  return [
    c + x * x * k,
    y * x * k + z * s,
    z * x * k - y * s,
    0,
    x * y * k - z * s,
    c + y * y * k,
    z * y * k + x * s,
    0,
    x * z * k + y * s,
    y * z * k - x * s,
    c + z * z * k,
    0,
    0,
    0,
    0,
    1,
  ];
}

/** The rotation vector of a rotation matrix (inverse of rotVec). */
export function logRot(m: Mat4): Vec3 {
  const tr = m[0] + m[5] + m[10];
  const cos = Math.min(1, Math.max(-1, (tr - 1) / 2));
  const th = Math.acos(cos);
  if (th < 1e-9) return [0, 0, 0];
  if (Math.PI - th < 1e-6) {
    // Near a half turn sin θ vanishes: read the axis off the diagonal.
    const x = Math.sqrt(Math.max(0, (m[0] + 1) / 2));
    const y = Math.sqrt(Math.max(0, (m[5] + 1) / 2)) * (m[4] + m[1] >= 0 ? 1 : -1);
    const z = Math.sqrt(Math.max(0, (m[10] + 1) / 2)) * (m[8] + m[2] >= 0 ? 1 : -1);
    const n = Math.hypot(x, y, z) || 1;
    return [(x / n) * th, (y / n) * th, (z / n) * th];
  }
  const f = th / (2 * Math.sin(th));
  return [(m[6] - m[9]) * f, (m[8] - m[2]) * f, (m[1] - m[4]) * f];
}

const translate = (x: number, y: number, z: number): Mat4 => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1];
/** Half a turn about X: the frame's Z reversed, X kept. */
const FLIP: Mat4 = [1, 0, 0, 0, 0, -1, 0, 0, 0, 0, -1, 0, 0, 0, 0, 1];

/** A mate's motion from its DOF values (mm, degrees). */
export function mateMotion(type: MateType, v: Partial<Record<Dof, number>>): Mat4 {
  const g = (d: Dof) => v[d] ?? 0;
  switch (type) {
    case "fastened":
      return translate(0, 0, 0);
    case "revolute":
      return rotZ(g("rz") * DEG);
    case "slider":
      return translate(0, 0, g("tz"));
    case "cylindrical":
      return multiply(translate(0, 0, g("tz")), rotZ(g("rz") * DEG));
    case "planar":
    case "width":
      return multiply(translate(g("tx"), g("ty"), 0), rotZ(g("rz") * DEG));
    case "ball":
      return rotVec([g("rx") * DEG, g("ry") * DEG, g("rz") * DEG]);
  }
}

/** The fixed part of a mate after its motion: face-to-face unless flipped,
 *  then its quarter turns about Z. A width mate's mid-planes start aligned
 *  instead: a tab sits in its slot the way up both were modelled. */
function mateTwist(mate: Pick<Mate, "type" | "flip" | "turns">): Mat4 {
  const q = rotZ((((mate.turns ?? 0) % 4) * Math.PI) / 2);
  const aligned = mate.type === "width" ? !mate.flip : !!mate.flip;
  return aligned ? q : multiply(FLIP, q);
}

/** `b`'s part coordinates → `a`'s part coordinates. */
export function mateRelative(
  mate: Pick<Mate, "type" | "flip" | "turns">,
  ca: Mat4,
  cb: Mat4,
  values: Partial<Record<Dof, number>>,
): Mat4 {
  return multiply(multiply(ca, mateMotion(mate.type, values)), multiply(mateTwist(mate), invertRigid(cb)));
}

/** Wrap an angle (degrees) to the turn nearest `near`, so a dragged hinge
 *  counts on past 180° instead of jumping back to −180°. */
function unwrap(deg: number, near: number): number {
  return deg + 360 * Math.round((near - deg) / 360);
}

/** The DOF values that put `b` at `tb` given `a` at `ta` — what a drag writes.
 *  Only the mate's free DOFs come out; the rest of the motion is the part the
 *  mate doesn't allow, and is dropped (the drag is projected onto the mate). */
export function valuesForPose(
  mate: Pick<Mate, "type" | "flip" | "turns">,
  ca: Mat4,
  cb: Mat4,
  ta: Mat4,
  tb: Mat4,
  previous: Partial<Record<Dof, number>> = {},
): Partial<Record<Dof, number>> {
  const m = multiply(multiply(invertRigid(multiply(ta, ca)), tb), multiply(cb, invertRigid(mateTwist(mate))));
  const angleZ = () => unwrap(Math.atan2(m[1], m[0]) / DEG, previous.rz ?? 0);
  switch (mate.type) {
    case "fastened":
      return {};
    case "revolute":
      return { rz: angleZ() };
    case "slider":
      return { tz: m[14] };
    case "cylindrical":
      return { tz: m[14], rz: angleZ() };
    case "planar":
    case "width":
      return { tx: m[12], ty: m[13], rz: angleZ() };
    case "ball": {
      const r = logRot(m);
      return { rx: r[0] / DEG, ry: r[1] / DEG, rz: r[2] / DEG };
    }
  }
}

export interface Loop {
  /** The instance it was solved against (null: the grounded ones). */
  anchor: string | null;
  /** The instances the numeric solver placed (not the one it was anchored to,
   *  nor grounded ones). */
  free: string[];
  /** The mates it solved. */
  mateIds: string[];
}

export interface Solution {
  /** Every instance's placement — mated ones from the solver, the rest as stored. */
  placements: Map<string, Mat4>;
  /** Instances a tree mate positions, and which mate (`reversed`: reached from
   *  its `b` side, so the instance is the mate's `a`). Instances in a loop
   *  group aren't here; see `loops`. */
  drivenBy: Map<string, { mateId: string; reversed: boolean }>;
  /** Mates that couldn't be applied, and why, in words. */
  problems: Map<string, string>;
  /** Each mate's values: a tree mate's evaluated and clamped, a loop mate's
   *  read back from where the solver put its parts. */
  values: Map<string, Partial<Record<Dof, number>>>;
  /** Groups of parts solved numerically, together: joined by a loop of mates,
   *  or by more than one mate between the same two parts. */
  loops: Loop[];
  /** Every instance a mate positions, in the tree or in a loop. */
  mated: Set<string>;
}

export interface SolveOptions {
  /** Soft targets for instances in a loop group. Each is pulled toward its
   *  pose as far as the group's mates allow, while the rest of the group moves
   *  as little as it can — what dragging a part inside a loop does. */
  goals?: ReadonlyMap<string, Mat4>;
  /** One free DOF of one mate set to `value` for this solve only, and driving
   *  it as an expression would: inside a loop the group follows it (what
   *  animating a mate does). Limits don't clamp it. */
  drive?: { mateId: string; dof: Dof; value: number };
}

/** A free DOF whose value is an expression (a variable, a formula) rather than
 *  a plain number. It's the user's: a drag doesn't overwrite it, and inside a
 *  loop it drives the loop, where a plain number just reports where it is. */
export function isDriven(mate: Pick<Mate, "values">, d: Dof): boolean {
  const t = mate.values?.[d]?.trim();
  return !!t && !Number.isFinite(Number(t));
}

/** A dragged or solved value as text: 3 decimals for mm, 2 for degrees, no
 *  trailing zeros. */
export function formatValue(v: number, rotation: boolean): string {
  const s = v.toFixed(rotation ? 2 : 3);
  return String(Number(s) === 0 ? 0 : Number(s));
}

/** Evaluate a mate's values, clamped to its limits. Throws on a bad expression. */
export function mateValues(mate: Mate, scope: Scope = {}): Partial<Record<Dof, number>> {
  const out: Partial<Record<Dof, number>> = {};
  for (const d of MATE_DOFS[mate.type]) {
    const text = mate.values?.[d];
    let v = text && text.trim() ? evaluateExpression(text, scope) : 0;
    const lim = mate.limits?.[d];
    if (lim?.min?.trim()) v = Math.max(v, evaluateExpression(lim.min, scope));
    if (lim?.max?.trim()) v = Math.min(v, evaluateExpression(lim.max, scope));
    out[d] = v;
  }
  return out;
}

/** A mate the solver can use: its connector frames, values and relative
 *  transform worked out once. */
interface Usable {
  mate: Mate;
  ca: Mat4;
  cb: Mat4;
  v: Partial<Record<Dof, number>>;
  rel: Mat4;
  /** The DOF SolveOptions.drive sets, on that mate. */
  drive?: Dof;
}

/** An edge of the mate graph: a mate, or (no `usable`) an instance's
 *  grounding, which ties it to WORLD. */
interface Edge {
  u: string;
  w: string;
  usable?: Usable;
}

/** The node grounded instances hang from, so that two grounded instances
 *  joined by mates form a loop like any other. */
const WORLD = "\u0000world";

/** Solve the assembly. `connectorFrame` returns a connector's frame in its
 *  part's coordinates, or a reason it can't be found. Mate values and limits
 *  are evaluated against `scope`: by default the assembly's own variables.
 *
 *  The mate graph (with grounded instances tied to one WORLD node) is split
 *  into its biconnected blocks. A block that is one mate is a tree edge and is
 *  composed exactly; a block with more (a loop, or two mates between the same
 *  pair) is solved numerically, anchored at the instance it was reached from.
 *  So a mechanism with one four-bar in it solves only the four-bar
 *  numerically, and everything hanging off it is composed as before. */
export function solve(
  assembly: AssemblyDoc,
  connectorFrame: (c: MateConnector) => Mat4 | string,
  scope: Scope = evaluateVariables(assembly.variables).scope,
  opts: SolveOptions = {},
): Solution {
  const placements = new Map<string, Mat4>();
  const drivenBy = new Map<string, { mateId: string; reversed: boolean }>();
  const problems = new Map<string, string>();
  const values = new Map<string, Partial<Record<Dof, number>>>();
  const loops: Loop[] = [];
  const byId = new Map(assembly.instances.map((i) => [i.id, i]));

  const usable: Usable[] = [];
  for (const mate of assembly.mates) {
    if (mate.suppressed) continue;
    if (!byId.has(mate.a.instanceId) || !byId.has(mate.b.instanceId)) {
      problems.set(mate.id, "One of its instances was removed.");
      continue;
    }
    if (mate.a.instanceId === mate.b.instanceId) {
      problems.set(mate.id, "Both ends are on the same instance.");
      continue;
    }
    const ca = connectorFrame(mate.a);
    const cb = connectorFrame(mate.b);
    if (typeof ca === "string" || typeof cb === "string") {
      problems.set(mate.id, typeof ca === "string" ? (ca as string) : (cb as string));
      continue;
    }
    let v: Partial<Record<Dof, number>>;
    try {
      v = mateValues(mate, scope);
    } catch (e) {
      problems.set(mate.id, `Bad value: ${(e as Error).message}`);
      continue;
    }
    const drive = opts.drive?.mateId === mate.id && MATE_DOFS[mate.type].includes(opts.drive.dof) ? opts.drive : null;
    if (drive) v = { ...v, [drive.dof]: drive.value };
    values.set(mate.id, v);
    usable.push({ mate, ca, cb, v, rel: mateRelative(mate, ca, cb, v), drive: drive?.dof });
  }

  const edges: Edge[] = [];
  for (const i of assembly.instances) if (i.grounded) edges.push({ u: WORLD, w: i.id });
  for (const u of usable) edges.push({ u: u.mate.a.instanceId, w: u.mate.b.instanceId, usable: u });
  const adj = new Map<string, Edge[]>();
  for (const e of edges)
    for (const n of [e.u, e.w]) {
      const list = adj.get(n) ?? [];
      list.push(e);
      adj.set(n, list);
    }
  const nodes = [WORLD, ...assembly.instances.map((i) => i.id)];
  const blocks = blocksOf(nodes, adj);
  const blocksAt = new Map<string, number[]>();
  blocks.forEach((b, k) => {
    for (const n of new Set(b.flatMap((e) => [e.u, e.w]))) {
      const list = blocksAt.get(n) ?? [];
      list.push(k);
      blocksAt.set(n, list);
    }
  });

  const mateOrder = new Map(assembly.mates.map((m, k) => [m.id, k]));
  const done = new Set<number>();
  /** Instances placed from their own stored transform, with nothing holding
   *  them: the first of each ungrounded group. */
  const roots = new Set<string>();
  const expand = (start: string) => {
    const queue = [start];
    while (queue.length) {
      const id = queue.shift()!;
      for (const k of blocksAt.get(id) ?? []) {
        if (done.has(k)) continue;
        done.add(k);
        const block = blocks[k];
        if (block.length === 1) {
          const e = block[0];
          const other = e.u === id ? e.w : e.u;
          if (other === WORLD) continue;
          if (!e.usable) placements.set(other, byId.get(other)!.transform);
          else {
            const { mate, rel } = e.usable;
            const reversed = mate.b.instanceId === id;
            placements.set(other, multiply(placements.get(id)!, reversed ? invertRigid(rel) : rel));
            drivenBy.set(other, { mateId: mate.id, reversed });
          }
          queue.push(other);
          continue;
        }

        // A loop group, anchored at `id`.
        const members = [...new Set(block.flatMap((e) => [e.u, e.w]))].filter((n) => n !== WORLD);
        // While a part of the group is dragged, an anchor that nothing holds
        // (not grounded, and not placed by a mate further back) moves too, so
        // dragging either of two locked-together parts moves both — the same
        // as dragging the anchor itself does.
        const loose =
          id !== WORLD && roots.has(id) && !!opts.goals && members.some((n) => n !== id && opts.goals!.has(n));
        const fixed = new Map<string, Mat4>();
        if (id !== WORLD && !loose) fixed.set(id, placements.get(id)!);
        for (const n of members) if (byId.get(n)!.grounded && !fixed.has(n)) fixed.set(n, byId.get(n)!.transform);
        const free = members.filter((n) => !fixed.has(n));
        // Start from the stored placements, carried along with the anchor.
        const carry = id === WORLD ? null : multiply(placements.get(id)!, invertRigid(byId.get(id)!.transform));
        const seed = new Map(
          free.map((n) => [
            n,
            n === id ? placements.get(id)! : carry ? multiply(carry, byId.get(n)!.transform) : byId.get(n)!.transform,
          ]),
        );
        const group = block
          .filter((e) => e.usable)
          .map((e) => e.usable!)
          .sort((p, q) => mateOrder.get(p.mate.id)! - mateOrder.get(q.mate.id)!);
        const r = solveGroup(group, fixed, free, seed, scope, opts.goals);
        for (const [n, p] of fixed) placements.set(n, p);
        for (const [n, p] of r.poses) placements.set(n, p);
        for (const [m, why] of r.blamed) problems.set(m, why);
        for (const [m, v] of r.values) values.set(m, v);
        loops.push({
          anchor: id === WORLD ? null : id,
          free: free.filter((n) => n !== id),
          mateIds: group.map((u) => u.mate.id),
        });
        for (const n of members) if (n !== id) queue.push(n);
      }
    }
  };
  // Grounded instances first (through WORLD), then whatever is left, each
  // group from its first instance's stored placement (a mated group nothing
  // grounds can still be dragged about as a whole).
  if (assembly.instances.some((i) => i.grounded)) expand(WORLD);
  for (const inst of assembly.instances)
    if (!placements.has(inst.id)) {
      placements.set(inst.id, inst.transform);
      roots.add(inst.id);
      expand(inst.id);
    }
  const mated = new Set<string>(drivenBy.keys());
  for (const l of loops) for (const n of [...l.free, ...(l.anchor ? [l.anchor] : [])]) mated.add(n);
  return { placements, drivenBy, problems, values, loops, mated };
}

/** The biconnected blocks of a multigraph, as lists of edges (Tarjan). Two
 *  edges between the same pair of nodes make a block of their own; a block of
 *  one edge is a bridge. */
function blocksOf(nodes: string[], adj: Map<string, Edge[]>): Edge[][] {
  const disc = new Map<string, number>();
  const low = new Map<string, number>();
  const stack: Edge[] = [];
  const out: Edge[][] = [];
  let time = 0;
  const visit = (u: string, via: Edge | null) => {
    disc.set(u, time);
    low.set(u, time);
    time++;
    for (const e of adj.get(u) ?? []) {
      if (e === via) continue;
      const w = e.u === u ? e.w : e.u;
      if (!disc.has(w)) {
        stack.push(e);
        visit(w, e);
        low.set(u, Math.min(low.get(u)!, low.get(w)!));
        if (low.get(w)! >= disc.get(u)!) {
          const block: Edge[] = [];
          let top: Edge;
          do {
            top = stack.pop()!;
            block.push(top);
          } while (top !== e);
          out.push(block);
        }
      } else if (disc.get(w)! < disc.get(u)!) {
        // A back edge (seen once, from its lower end).
        stack.push(e);
        low.set(u, Math.min(low.get(u)!, disc.get(w)!));
      }
    }
  };
  for (const n of nodes) if (!disc.has(n)) visit(n, null);
  return out;
}

// ---------------------------------------------------------------------------
// Loop groups: every mate becomes residuals between its two parts' poses —
// zero exactly when the mate holds — and Levenberg–Marquardt finds poses that
// zero them all, starting from where the parts are (lm.ts).

/** A mate is satisfied when every residual is under this (mm; rotations are
 *  scaled to mm at the group's size). */
const SATISFIED = 1e-6;
/** Weights of the soft pulls while dragging: toward the drag, and each other
 *  part toward where it was. Small against the mates' 1. */
const GOAL_WEIGHT = 1e-2;
const STAY_WEIGHT = 1e-4;

/** `T` moved by a small motion: a turn `w` (rotation vector, radians) about
 *  `pivot`, then a shift `t` (mm). */
function moved(T: Mat4, pivot: Vec3, d: ArrayLike<number>, k: number): Mat4 {
  const r = rotVec([d[k], d[k + 1], d[k + 2]]);
  const [px, py, pz] = pivot;
  // translate(pivot + t) · r · translate(−pivot)
  const tx = px + d[k + 3] - (r[0] * px + r[4] * py + r[8] * pz);
  const ty = py + d[k + 4] - (r[1] * px + r[5] * py + r[9] * pz);
  const tz = pz + d[k + 5] - (r[2] * px + r[6] * py + r[10] * pz);
  r[12] = tx;
  r[13] = ty;
  r[14] = tz;
  return multiply(r, T);
}

/** Which parts of a mate's relative motion must vanish: translation indices
 *  (into the matrix) and how much of the rotation is held. */
const HELD: Record<MateType, { t: number[]; rot: "all" | "axis" | "none" }> = {
  fastened: { t: [12, 13, 14], rot: "all" },
  revolute: { t: [12, 13, 14], rot: "axis" },
  slider: { t: [12, 13], rot: "all" },
  cylindrical: { t: [12, 13], rot: "axis" },
  planar: { t: [14], rot: "axis" },
  width: { t: [14], rot: "axis" },
  ball: { t: [12, 13, 14], rot: "none" },
};

interface GroupMate extends Usable {
  /** b's connector with the mate's twist taken off. */
  cbt: Mat4;
  /** Free DOFs held at a value: driven ones, and limits that are crossed. */
  driven: { d: Dof; value: number }[];
  limits: { d: Dof; min?: number; max?: number }[];
}

function solveGroup(
  group: Usable[],
  fixed: ReadonlyMap<string, Mat4>,
  free: string[],
  seed: ReadonlyMap<string, Mat4>,
  scope: Scope,
  goals: ReadonlyMap<string, Mat4> | undefined,
): {
  poses: Map<string, Mat4>;
  blamed: Map<string, string>;
  values: Map<string, Partial<Record<Dof, number>>>;
} {
  const all: GroupMate[] = group.map((u) => {
    const driven: GroupMate["driven"] = [];
    const limits: GroupMate["limits"] = [];
    for (const d of MATE_DOFS[u.mate.type]) {
      if (u.drive === d || isDriven(u.mate, d)) {
        driven.push({ d, value: u.v[d] ?? 0 });
        continue;
      }
      const lim = u.mate.limits?.[d];
      const num = (t?: string) => {
        if (!t?.trim()) return undefined;
        try {
          return evaluateExpression(t, scope);
        } catch {
          return undefined;
        }
      };
      const min = num(lim?.min);
      const max = num(lim?.max);
      if (min !== undefined || max !== undefined) limits.push({ d, min, max });
    }
    return { ...u, cbt: multiply(u.cb, invertRigid(mateTwist(u.mate))), driven, limits };
  });

  const index = new Map(free.map((n, k) => [n, k]));
  const poseIn = (start: ReadonlyMap<string, Mat4>) => (n: string) => fixed.get(n) ?? start.get(n)!;

  // The group's size, to weigh rotations against distances.
  let size = 10;
  {
    const pts: Vec3[] = [];
    const at = poseIn(seed);
    for (const g of all)
      for (const [n, c] of [
        [g.mate.a.instanceId, g.ca],
        [g.mate.b.instanceId, g.cb],
      ] as const) {
        const f = multiply(at(n), c);
        pts.push([f[12], f[13], f[14]]);
      }
    for (const p of pts) for (const q of pts) size = Math.max(size, Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]));
  }
  const L = size;

  const residuals = (out: number[], mates: GroupMate[], pose: (n: string) => Mat4) => {
    for (const g of mates) {
      const ta = pose(g.mate.a.instanceId);
      const tb = pose(g.mate.b.instanceId);
      const m = multiply(invertRigid(multiply(ta, g.ca)), multiply(tb, g.cbt));
      const held = HELD[g.mate.type];
      for (const i of held.t) out.push(m[i]);
      if (held.rot === "all") out.push(L * (m[0] - 1), L * m[1], L * m[2], L * m[4], L * (m[5] - 1), L * m[6]);
      else if (held.rot === "axis") out.push(L * m[8], L * m[9], L * (m[10] - 1));
      if (g.driven.length || g.limits.length) {
        const prev: Partial<Record<Dof, number>> = { ...g.v };
        for (const { d, value } of g.driven) prev[d] = value;
        const got = valuesForPose(g.mate, g.ca, g.cb, ta, tb, prev);
        const scale = (d: Dof) => (isRotation(d) ? DEG * L : 1);
        for (const { d, value } of g.driven) out.push(((got[d] ?? 0) - value) * scale(d));
        for (const { d, min, max } of g.limits) {
          const x = got[d] ?? 0;
          out.push((min !== undefined && x < min ? x - min : max !== undefined && x > max ? x - max : 0) * scale(d));
        }
      }
    }
  };

  // Pull toward `target` at a part's pivot, plus its turn, weighted.
  const pull = (out: number[], T: Mat4, target: Mat4, local: Vec3, w: number) => {
    const p = applyPoint(T, local);
    const q = applyPoint(target, local);
    out.push(w * (p[0] - q[0]), w * (p[1] - q[1]), w * (p[2] - q[2]));
    for (const i of [0, 1, 2, 4, 5, 6]) out.push(w * L * (T[i] - target[i]));
  };

  /** Solve `mates` from `start`; the poses and the largest mate residual. */
  const attempt = (mates: GroupMate[], start: ReadonlyMap<string, Mat4>, pulls: boolean) => {
    const run = (from: ReadonlyMap<string, Mat4>, withPulls: boolean) => {
      // Each free part turns about the middle of its connectors.
      const pivots = new Map<string, Vec3>();
      for (const n of free) {
        let sx = 0,
          sy = 0,
          sz = 0,
          c = 0;
        for (const g of mates)
          for (const [id, cf] of [
            [g.mate.a.instanceId, g.ca],
            [g.mate.b.instanceId, g.cb],
          ] as const)
            if (id === n) {
              const f = multiply(from.get(n)!, cf);
              sx += f[12];
              sy += f[13];
              sz += f[14];
              c++;
            }
        pivots.set(n, c ? [sx / c, sy / c, sz / c] : [from.get(n)![12], from.get(n)![13], from.get(n)![14]]);
      }
      const poseAt = (x: ArrayLike<number>) => (n: string) => {
        const f = fixed.get(n);
        if (f) return f;
        return moved(from.get(n)!, pivots.get(n)!, x, index.get(n)! * 6);
      };
      const f = (x: number[]) => {
        const out: number[] = [];
        const pose = poseAt(x);
        residuals(out, mates, pose);
        if (withPulls)
          for (const n of free) {
            const goal = goals?.get(n);
            const local = applyPoint(invertRigid(from.get(n)!), pivots.get(n)!);
            pull(out, pose(n), goal ?? seed.get(n)!, local, goal ? GOAL_WEIGHT : STAY_WEIGHT);
          }
        return out;
      };
      const r = levenbergMarquardt(f, new Array(free.length * 6).fill(0), {
        tol: withPulls ? 0 : SATISFIED * 1e-3,
        maxIterations: withPulls ? 40 : 100,
      });
      const pose = poseAt(r.x);
      return new Map(free.map((n) => [n, pose(n)]));
    };
    const poses = run(pulls ? run(start, true) : start, false);
    const out: number[] = [];
    residuals(out, mates, poseIn(poses));
    return { poses, worst: out.reduce((s, v) => Math.max(s, Math.abs(v)), 0) };
  };

  // A second start, in case the stored one is far off: the group composed as
  // a tree from its fixed parts, using the mates' stored values.
  const treeSeed = (mates: GroupMate[]) => {
    const out = new Map<string, Mat4>();
    const placed = new Map(fixed);
    const queue = [...fixed.keys()];
    while (queue.length) {
      const id = queue.shift()!;
      for (const g of mates) {
        const reversed = g.mate.b.instanceId === id;
        if (!reversed && g.mate.a.instanceId !== id) continue;
        const other = reversed ? g.mate.a.instanceId : g.mate.b.instanceId;
        if (placed.has(other)) continue;
        const p = multiply(placed.get(id)!, reversed ? invertRigid(g.rel) : g.rel);
        placed.set(other, p);
        out.set(other, p);
        queue.push(other);
      }
    }
    for (const n of free) if (!out.has(n)) out.set(n, seed.get(n)!);
    return out;
  };

  const pulling = !!goals && free.some((n) => goals.has(n));
  const best = (mates: GroupMate[], tries = 2) => {
    const first = attempt(mates, seed, pulling);
    if (first.worst < SATISFIED || tries < 2) return first;
    const second = attempt(mates, treeSeed(mates), pulling);
    return second.worst < first.worst ? second : first;
  };

  let result = best(all);
  const blamed = new Map<string, string>();
  let used = all;
  if (result.worst >= SATISFIED) {
    // Conflicting mates. Blame the latest one whose removal lets the rest
    // hold — usually the one just added.
    let found = false;
    for (let k = all.length - 1; k >= 0 && !found; k--) {
      const rest = all.filter((_, j) => j !== k);
      // One start each: this runs on every solve while the conflict stands.
      const r = best(rest, 1);
      if (r.worst < SATISFIED) {
        result = r;
        used = rest;
        blamed.set(all[k].mate.id, "Over-constrained: this mate conflicts with the other mates holding these parts.");
        found = true;
      }
    }
    if (!found) {
      const pose = poseIn(result.poses);
      for (const g of all) {
        const out: number[] = [];
        residuals(out, [g], pose);
        if (out.some((v) => Math.abs(v) >= SATISFIED))
          blamed.set(g.mate.id, "Over-constrained: these mates can't all hold at once.");
      }
    }
  }

  const values = new Map<string, Partial<Record<Dof, number>>>();
  const pose = poseIn(result.poses);
  for (const g of used) {
    const got = valuesForPose(g.mate, g.ca, g.cb, pose(g.mate.a.instanceId), pose(g.mate.b.instanceId), g.v);
    values.set(g.mate.id, got);
  }
  return { poses: result.poses, blamed, values };
}
