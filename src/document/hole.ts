// The Hole feature's document side: defaults, the standard sizes, and how a
// hole resolves into the half cross-section the kernel revolves.
//
// Everything that decides the hole's SHAPE lives here, as pure functions, so
// the dialog's 2D diagram, the readout and the kernel tool are all drawn from
// the same numbers — and so it is unit-testable in Node, which the kernel
// isn't.
import { evaluateExpression, type Scope } from "./expression";
import { frameOf, type PlaneFrameData } from "./planes";
import type { HoleFeature, HoleParams, HoleType, SketchFeature } from "./types";
import { METRIC, isMetricSize, type HoleFit } from "../geom/metricFasteners";
import { minorDiameter } from "../geom/thread";
import type { ResolvedFeature } from "../kernel/types";

export const HOLE_TYPE_LABELS: Record<HoleType, string> = {
  simple: "Simple",
  counterbore: "Counterbore",
  countersink: "Countersink",
  tapped: "Tapped",
};

export const HOLE_FIT_LABELS: Record<HoleFit, string> = {
  close: "Close",
  normal: "Normal",
  loose: "Loose",
};

/** Custom-size defaults: an M3-ish clearance hole, 10 deep with a drill point. */
export const DEFAULT_HOLE_PARAMS: HoleParams = {
  diameter: "3.4",
  depth: "10",
  counterboreDiameter: "6",
  counterboreDepth: "3.4",
  countersinkDiameter: "6.3",
  countersinkAngle: "90",
  tipAngle: "118",
  threadDepth: "8",
  clearance: "0.1",
};

export type HoleSettings = Pick<HoleFeature, "holeType" | "thread" | "size" | "fit" | "extent" | "flip"> & {
  params: HoleParams;
};

export const DEFAULT_HOLE_SETTINGS: HoleSettings = {
  holeType: "simple",
  // Cosmetic by default, like a screw: fast, and the tap drill is right for a
  // thread tapped after. Modelled is a toggle away.
  thread: "cosmetic",
  size: "M3",
  fit: "normal",
  extent: "throughAll",
  flip: false,
  params: DEFAULT_HOLE_PARAMS,
};

/** Every number the hole's shape needs, resolved (mm / degrees). Fields a
 *  hole type doesn't use are still present, so the diagram can lay out one
 *  shape per type without special-casing missing values. */
export interface HoleDims {
  holeType: HoleType;
  diameter: number;
  /** Bore depth (blind). Ignored for through-all. */
  depth: number;
  throughAll: boolean;
  counterboreDiameter: number;
  counterboreDepth: number;
  countersinkDiameter: number;
  countersinkAngle: number;
  /** 0 = flat bottom. Always 0 for through-all. */
  tipAngle: number;
  threadDepth: number;
  /** Tapped holes: the nominal (major) thread diameter, for the readout. */
  threadDiameter?: number;
  pitch?: number;
  /** Tapped, metric, modelled: the thread is built (and the drill is no wider
   *  than its minor diameter), its cavity grown by `clearance`. */
  modelledThread: boolean;
  clearance: number;
}

const num = (label: string, expr: string, scope: Scope): number => {
  try {
    return evaluateExpression(expr, scope);
  } catch (err) {
    throw new Error(`hole: ${label}: ${(err as Error).message}`);
  }
};

/** Resolve a hole's settings to numbers: the metric table for a standard size,
 *  its own expressions otherwise. Throws a readable "hole: …" message on
 *  anything that can't make a hole. */
export function holeDims(s: HoleSettings, scope: Scope): HoleDims {
  const p = s.params;
  const metric = isMetricSize(s.size) ? METRIC[s.size] : null;
  const tapped = s.holeType === "tapped";
  // Modelled threads need a pitch, so a metric size.
  const modelledThread = tapped && !!metric && s.thread === "modelled";
  const clearance = modelledThread ? num("clearance", p.clearance ?? "0", scope) : 0;
  let diameter = metric ? (tapped ? metric.tapDrill : metric.clearance[s.fit]) : num("diameter", p.diameter, scope);
  // A real tap drill can be a shade wider than the basic minor diameter (it
  // truncates the nut's crests); a modelled thread keeps its full crests.
  if (modelledThread) diameter = Math.min(diameter, minorDiameter(metric.d, metric.pitch) + 2 * clearance);
  const throughAll = s.extent === "throughAll";
  const dims: HoleDims = {
    holeType: s.holeType,
    diameter,
    depth: throughAll ? 0 : num("depth", p.depth, scope),
    throughAll,
    counterboreDiameter: metric
      ? metric.counterbore.diameter
      : num("counterbore diameter", p.counterboreDiameter, scope),
    counterboreDepth: metric ? metric.counterbore.depth : num("counterbore depth", p.counterboreDepth, scope),
    countersinkDiameter: metric
      ? metric.countersink.diameter
      : num("countersink diameter", p.countersinkDiameter, scope),
    countersinkAngle: metric ? metric.countersink.angle : num("countersink angle", p.countersinkAngle, scope),
    tipAngle: throughAll ? 0 : num("tip angle", p.tipAngle, scope),
    threadDepth: tapped ? num("thread depth", p.threadDepth, scope) : 0,
    ...(tapped && metric ? { threadDiameter: metric.d, pitch: metric.pitch } : {}),
    modelledThread,
    clearance,
  };
  validateHoleDims(dims);
  return dims;
}

function validateHoleDims(d: HoleDims): void {
  if (!(d.diameter > 0)) throw new Error("hole: diameter must be greater than 0");
  if (!d.throughAll && !(d.depth > 0)) throw new Error("hole: depth must be greater than 0");
  if (!(d.tipAngle >= 0 && d.tipAngle < 180)) throw new Error("hole: tip angle must be 0 (flat) or under 180°");
  if (d.holeType === "counterbore") {
    if (!(d.counterboreDiameter > d.diameter)) throw new Error("hole: the counterbore must be wider than the hole");
    if (!(d.counterboreDepth > 0)) throw new Error("hole: counterbore depth must be greater than 0");
    if (!d.throughAll && !(d.counterboreDepth < d.depth))
      throw new Error("hole: the counterbore must be shallower than the hole");
  }
  if (d.holeType === "countersink") {
    if (!(d.countersinkDiameter > d.diameter)) throw new Error("hole: the countersink must be wider than the hole");
    if (!(d.countersinkAngle > 0 && d.countersinkAngle < 180))
      throw new Error("hole: countersink angle must be between 0 and 180°");
    if (!d.throughAll && !(countersinkDepth(d) < d.depth))
      throw new Error("hole: the countersink reaches deeper than the hole");
  }
  if (d.holeType === "tapped") {
    if (!(d.threadDepth > 0)) throw new Error("hole: thread depth must be greater than 0");
    if (!d.throughAll && d.threadDepth > d.depth) throw new Error("hole: the thread can't run deeper than the hole");
    if (d.modelledThread && d.pitch) {
      if (!(d.clearance >= 0)) throw new Error("hole: clearance can't be negative");
      if (!(d.clearance <= 0.25 * d.pitch))
        throw new Error(`hole: clearance can be at most ${0.25 * d.pitch} for this size`);
      if (!(d.threadDepth > d.pitch)) throw new Error("hole: a modelled thread must be deeper than one pitch");
    }
  }
}

/** How deep the countersink cone reaches below the start plane. */
export function countersinkDepth(d: Pick<HoleDims, "countersinkDiameter" | "diameter" | "countersinkAngle">): number {
  return (d.countersinkDiameter - d.diameter) / 2 / Math.tan((d.countersinkAngle * Math.PI) / 360);
}

/** Depth of the drill point's cone below the bore (0 for a flat bottom). */
export function tipDepth(d: Pick<HoleDims, "diameter" | "tipAngle">): number {
  return d.tipAngle > 0 ? d.diameter / 2 / Math.tan((d.tipAngle * Math.PI) / 360) : 0;
}

/** The hole's half cross-section: (radius, depth) points from the start plane
 *  (depth 0) down to the axis (radius 0), depth never decreasing. `bottom` is
 *  the bore depth to use for a through-all hole; the resolver passes 0, and
 *  the kernel then pushes the LAST TWO points (the bore's bottom corner and
 *  its axis point) down by however far it has to reach. */
export function holeProfile(d: HoleDims, bottom = d.depth): [number, number][] {
  const r = d.diameter / 2;
  const pts: [number, number][] = [];
  if (d.holeType === "counterbore") {
    const rc = d.counterboreDiameter / 2;
    pts.push([rc, 0], [rc, d.counterboreDepth], [r, d.counterboreDepth]);
  } else if (d.holeType === "countersink") {
    pts.push([d.countersinkDiameter / 2, 0], [r, countersinkDepth(d)]);
  } else {
    pts.push([r, 0]);
  }
  // Through all: never shallower than the counterbore/countersink above it.
  const z = d.throughAll ? Math.max(bottom, pts[pts.length - 1][1]) : d.depth;
  pts.push([r, z]);
  const tip = tipDepth(d);
  pts.push([0, z + tip]);
  return pts;
}

/** Where the holes go: every point entity and every circle centre in the
 *  sketch, in sketch (u, v). Duplicates (a point on a circle's centre) count
 *  once. */
export function holeCenters(sketch: SketchFeature): [number, number][] {
  const out: [number, number][] = [];
  const seen = (p: [number, number]) => out.some((q) => Math.hypot(q[0] - p[0], q[1] - p[1]) < 1e-6);
  for (const e of sketch.entities) {
    const p = e.type === "point" ? e.p : e.type === "circle" ? e.c : null;
    if (p && !seen(p)) out.push([p[0], p[1]]);
  }
  return out;
}

/** The hole as the kernel builds it. `sketch` is the sketch with its derived
 *  geometry and entity expressions applied (the resolver's `dDoc` copy). */
export function resolveHole(
  f: HoleFeature,
  sketch: SketchFeature | undefined,
  scope: Scope,
  planeFrames: Map<string, PlaneFrameData>,
): ResolvedFeature {
  if (!sketch) throw new Error("hole: its sketch no longer exists — pick another");
  if (!f.targetId) throw new Error("hole: choose the body to drill");
  const centers = holeCenters(sketch);
  if (centers.length === 0)
    throw new Error("hole: the sketch has no points — add a point (or a circle) where each hole goes");
  const dims = holeDims(f, scope);
  return {
    id: f.id,
    type: "hole",
    targetId: f.targetId,
    frame: frameOf(sketch.plane, planeFrames),
    centers,
    profile: holeProfile(dims, 0),
    throughAll: dims.throughAll,
    flip: f.flip,
    ...(dims.modelledThread && dims.threadDiameter && dims.pitch
      ? {
          thread: {
            d: dims.threadDiameter,
            pitch: dims.pitch,
            offset: dims.clearance,
            // From just above the mouth, so the cavity doesn't share its face.
            z0: -Math.min(0.5, dims.pitch),
            z1: dims.threadDepth,
            tipChamfer: false,
          },
        }
      : {}),
  };
}

/** The one-line summary under the dialog's fields. */
export function holeReadout(d: HoleDims, size: string): string {
  const parts: string[] = [];
  if (d.holeType === "tapped" && d.threadDiameter) {
    parts.push(
      `${size}×${d.pitch} thread, ${d.throughAll ? "through" : `${fmt(d.threadDepth)} deep`} (${d.modelledThread ? `modelled, +${fmt(d.clearance)} clearance` : "cosmetic"})`,
    );
    parts.push(`${d.modelledThread ? "drill" : "tap drill"} Ø${fmt(d.diameter)}`);
  } else parts.push(`Ø${fmt(d.diameter)}`);
  if (d.holeType === "counterbore")
    parts.push(`counterbore Ø${fmt(d.counterboreDiameter)} × ${fmt(d.counterboreDepth)}`);
  if (d.holeType === "countersink")
    parts.push(`countersink Ø${fmt(d.countersinkDiameter)} at ${fmt(d.countersinkAngle)}°`);
  parts.push(d.throughAll ? "through all" : `${fmt(d.depth)} deep`);
  return parts.join(" · ");
}

const fmt = (n: number) => String(Math.round(n * 1000) / 1000);
