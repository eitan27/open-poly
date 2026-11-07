// Placing instances from their mates: a kinematic tree, solved by composition
// (docs/ASSEMBLY-PLAN.md "Solver"). No numeric solving, no DOM, no kernel.
//
// Grounded instances are roots. Each mate places the instance at its far end
// from the one already placed:
//
//     T_b = T_a · C_a · M(values) · F · C_b⁻¹
//
// where C are the connector frames in part coordinates, M the mate's motion
// built from its free-DOF values, and F the default face-to-face turn (Z axes
// opposed) plus any quarter turns. A mate reached from its `b` side is just
// inverted. A mate whose both ends are already placed closes a loop: it is
// checked, not solved — the seam where a loop solver will plug in later.
import { evaluateExpression, type Scope } from "../document/expression";
import { multiply, type Vec3 } from "./placement";
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

export interface Solution {
  /** Every instance's placement — mated ones from the tree, the rest as stored. */
  placements: Map<string, Mat4>;
  /** Instances a mate positions, and which mate (`reversed`: reached from its
   *  `b` side, so the instance is the mate's `a`). */
  drivenBy: Map<string, { mateId: string; reversed: boolean }>;
  /** Mates that couldn't be applied, and why, in words. */
  problems: Map<string, string>;
  /** Each mate's evaluated, clamped values. */
  values: Map<string, Partial<Record<Dof, number>>>;
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

/** Positions agree: translations within `tol` mm, rotations within ~1e-5. */
function samePose(p: Mat4, q: Mat4, tol = 1e-4): boolean {
  for (let i = 0; i < 12; i++) if (Math.abs(p[i] - q[i]) > 1e-5) return false;
  for (let i = 12; i < 15; i++) if (Math.abs(p[i] - q[i]) > tol) return false;
  return true;
}

/** Solve the tree. `connectorFrame` returns a connector's frame in its part's
 *  coordinates, or a reason it can't be found. */
export function solve(
  assembly: AssemblyDoc,
  connectorFrame: (c: MateConnector) => Mat4 | string,
  scope: Scope = {},
): Solution {
  const placements = new Map<string, Mat4>();
  const drivenBy = new Map<string, { mateId: string; reversed: boolean }>();
  const problems = new Map<string, string>();
  const values = new Map<string, Partial<Record<Dof, number>>>();
  const byId = new Map(assembly.instances.map((i) => [i.id, i]));

  // Each usable mate's relative transform, worked out once.
  const usable: { mate: Mate; rel: Mat4 }[] = [];
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
    values.set(mate.id, v);
    usable.push({ mate, rel: mateRelative(mate, ca, cb, v) });
  }

  const edges = new Map<string, { mate: Mate; rel: Mat4 }[]>();
  for (const u of usable)
    for (const id of [u.mate.a.instanceId, u.mate.b.instanceId]) {
      const list = edges.get(id) ?? [];
      list.push(u);
      edges.set(id, list);
    }

  const done = new Set<string>(); // mates applied or checked
  const spread = (root: string) => {
    const queue = [root];
    while (queue.length) {
      const id = queue.shift()!;
      const t = placements.get(id)!;
      for (const { mate, rel } of edges.get(id) ?? []) {
        if (done.has(mate.id)) continue;
        done.add(mate.id);
        const reversed = mate.b.instanceId === id;
        const other = reversed ? mate.a.instanceId : mate.b.instanceId;
        const pose = multiply(t, reversed ? invertRigid(rel) : rel);
        const placed = placements.get(other);
        if (placed) {
          if (!samePose(placed, pose))
            problems.set(mate.id, "Over-constrained: this mate closes a loop, and loops aren't supported yet.");
          continue;
        }
        placements.set(other, pose);
        drivenBy.set(other, { mateId: mate.id, reversed });
        queue.push(other);
      }
    }
  };
  // Grounded instances first, then whatever is left, each group from its first
  // instance's stored placement (a mated group nothing grounds can still be
  // dragged about as a whole).
  // Every grounded one is placed before any spreads, so a mate between two of
  // them is checked rather than moving one.
  const grounded = assembly.instances.filter((i) => i.grounded);
  for (const inst of grounded) placements.set(inst.id, inst.transform);
  for (const inst of grounded) spread(inst.id);
  for (const inst of assembly.instances)
    if (!placements.has(inst.id)) {
      placements.set(inst.id, inst.transform);
      spread(inst.id);
    }
  return { placements, drivenBy, problems, values };
}
