// What the Move panel reads out: how far a world motion moved an instance,
// as the panel's own terms — a shift of the gizmo's pivot along world X, Y and
// Z (mm), and a turn about the gizmo's axis (degrees). Measured from the
// motion the solver actually gave the instance, not the drag, so a part its
// mates hold back reads what it really did.
import { applyPoint, type Vec3 } from "./placement";
import { logRot } from "./solve";
import type { Mat4 } from "./types";

export interface MoveReadout {
  tx: number;
  ty: number;
  tz: number;
  /** Degrees about `axisDir`. */
  angle: number;
}

export const NO_MOVE: MoveReadout = { tx: 0, ty: 0, tz: 0, angle: 0 };

export function moveReadout(motion: Mat4, pivot: Vec3, axisDir: Vec3): MoveReadout {
  const p = applyPoint(motion, pivot);
  const r = logRot(motion);
  const n = Math.hypot(axisDir[0], axisDir[1], axisDir[2]) || 1;
  const about = (r[0] * axisDir[0] + r[1] * axisDir[1] + r[2] * axisDir[2]) / n;
  return { tx: p[0] - pivot[0], ty: p[1] - pivot[1], tz: p[2] - pivot[2], angle: (about * 180) / Math.PI };
}

export const addMoves = (a: MoveReadout, b: MoveReadout): MoveReadout => ({
  tx: a.tx + b.tx,
  ty: a.ty + b.ty,
  tz: a.tz + b.tz,
  angle: a.angle + b.angle,
});
