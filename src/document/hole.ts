// The Hole feature's document side: defaults, the standard sizes, and how a
// hole resolves into the half cross-section the kernel revolves.
//
// Everything that decides the hole's SHAPE lives here, as pure functions, so
// the dialog's 2D diagram, the readout and the kernel tool are all drawn from
// the same numbers — and so it is unit-testable in Node, which the kernel
// isn't.
import { evaluateExpression, type Scope } from "./expression";
import { frameOf, uvToWorld, type PlaneFrameData } from "./planes";
import type {
  HoleFeature,
  HoleParams,
  HolePointAt,
  HolePointRef,
  HoleType,
  SketchEntity,
  SketchFeature,
} from "./types";
import { METRIC, clearanceHoleDiameter, isMetricSize, type HoleFit } from "../geom/metricFasteners";
import { minorDiameter } from "../geom/thread";
import type { ResolvedFeature } from "../kernel/types";

export const HOLE_TYPE_LABELS: Record<HoleType, string> = {
  simple: "Simple",
  counterbore: "Counterbore",
  countersink: "Countersink",
  tapped: "Tapped",
};

export const HOLE_FIT_LABELS: Record<HoleFit, string> = {
  exact: "Exact",
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

export type HoleSettings = Pick<
  HoleFeature,
  "holeType" | "thread" | "size" | "fit" | "extent" | "flip" | "points" | "plane" | "scope"
> & {
  params: HoleParams;
};

export const DEFAULT_HOLE_SETTINGS: HoleSettings = {
  holeType: "simple",
  // Cosmetic by default, like a screw: fast, and the tap drill is right for a
  // thread tapped after. Modelled is a toggle away.
  thread: "cosmetic",
  size: "M3",
  fit: "normal",
  // Blind, so the diagram shows the drill point a real drill leaves.
  extent: "blind",
  flip: false,
  params: DEFAULT_HOLE_PARAMS,
};

/** Every number the hole's shape needs, resolved (mm / degrees). Fields a
 *  hole type doesn't use are still present, so the diagram can lay out one
 *  shape per type without special-casing missing values. */
export interface HoleDims {
  holeType: HoleType;
  diameter: number;
  /** Bore depth (blind). Ignored for through-all and up-to-next. */
  depth: number;
  /** Open-ended: through all, or up to next — no depth, no drill point. */
  throughAll: boolean;
  /** Up to next: each hole stops where it breaks out of the first stretch of
   *  material it meets (the kernel finds it). */
  upToNext: boolean;
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
  let diameter = metric
    ? tapped
      ? metric.tapDrill
      : clearanceHoleDiameter(metric, s.fit)
    : num("diameter", p.diameter, scope);
  // A real tap drill can be a shade wider than the basic minor diameter (it
  // truncates the nut's crests); a modelled thread keeps its full crests.
  if (modelledThread) diameter = Math.min(diameter, minorDiameter(metric.d, metric.pitch) + 2 * clearance);
  // Up to next breaks through like through all: no depth, no drill point.
  const throughAll = s.extent !== "blind";
  const dims: HoleDims = {
    holeType: s.holeType,
    diameter,
    depth: throughAll ? 0 : num("depth", p.depth, scope),
    throughAll,
    upToNext: s.extent === "upToNext",
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
    // Only a modelled thread has a depth: a plain bore is just the tap drill.
    if (d.modelledThread && d.pitch) {
      if (!(d.threadDepth > 0)) throw new Error("hole: thread depth must be greater than 0");
      if (!d.throughAll && d.threadDepth > d.depth) throw new Error("hole: the thread can't run deeper than the hole");
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

/** A snap point of an entity, in sketch (u, v); null when the entity has
 *  no such point (a circle has no ends, a point no midpoint). */
export function snapPoint(e: SketchEntity, at: HolePointAt): [number, number] | null {
  const arcEnd = (a: number): [number, number] =>
    e.type === "arc" ? [e.c[0] + e.r * Math.cos(a), e.c[1] + e.r * Math.sin(a)] : [0, 0];
  switch (e.type) {
    case "point":
      return at === "point" ? [e.p[0], e.p[1]] : null;
    case "circle":
      return at === "center" ? [e.c[0], e.c[1]] : null;
    case "arc":
      return at === "center"
        ? [e.c[0], e.c[1]]
        : at === "start"
          ? arcEnd(e.start)
          : at === "end"
            ? arcEnd(e.end)
            : null;
    case "line":
      return at === "start"
        ? [e.a[0], e.a[1]]
        : at === "end"
          ? [e.b[0], e.b[1]]
          : at === "mid"
            ? [(e.a[0] + e.b[0]) / 2, (e.a[1] + e.b[1]) / 2]
            : null;
    default:
      return null;
  }
}

/** The points a hole takes by default: every point entity and circle
 *  centre, as an older hole (no `points`) still does. */
export function defaultHolePoints(sketch: SketchFeature): HolePointRef[] {
  const out: HolePointRef[] = [];
  for (const e of sketch.entities) {
    if (e.type === "point") out.push({ entityId: e.id, at: "point" });
    else if (e.type === "circle") out.push({ entityId: e.id, at: "center" });
  }
  return out;
}

/** The snap point a click on a whole entity means: a point is itself, a
 *  circle or arc its centre, a line its midpoint (its ends are picked as
 *  vertices). Null for what has no single point (a spline, text). */
export function entityHolePoint(e: SketchEntity): HolePointRef | null {
  const at: HolePointAt | null =
    e.type === "point"
      ? "point"
      : e.type === "circle" || e.type === "arc"
        ? "center"
        : e.type === "line"
          ? "mid"
          : null;
  return at ? { entityId: e.id, at } : null;
}

/** The snap point at a picked sketch vertex (u, v): a point entity there
 *  first, then a centre, then a line's or arc's end. */
export function holePointAt(sketch: SketchFeature, uv: [number, number], tol = 1e-6): HolePointRef | null {
  const order: HolePointAt[] = ["point", "center", "start", "end", "mid"];
  for (const at of order)
    for (const e of sketch.entities) {
      const p = snapPoint(e, at);
      if (p && Math.hypot(p[0] - uv[0], p[1] - uv[1]) <= tol) return { sketchId: sketch.id, entityId: e.id, at };
    }
  return null;
}

/** The same target: one entity's snap point, or two fixed spots within a
 *  micron on the same plane. */
export function sameHolePoint(a: HolePointRef, b: HolePointRef): boolean {
  if ("uv" in a || "uv" in b)
    return (
      "uv" in a &&
      "uv" in b &&
      Math.hypot(a.uv[0] - b.uv[0], a.uv[1] - b.uv[1]) < 1e-3 &&
      JSON.stringify(a.plane ?? null) === JSON.stringify(b.plane ?? null)
    );
  return a.entityId === b.entityId && a.at === b.at && (a.sketchId ?? null) === (b.sketchId ?? null);
}

/** Where the holes go, in sketch (u, v): `refs` when given, else every point
 *  entity and circle centre. Coincident points count once. Throws when a
 *  referenced entity is gone. */
export function holeCenters(sketch: SketchFeature, refs?: HolePointRef[]): [number, number][] {
  const out: [number, number][] = [];
  const seen = (p: [number, number]) => out.some((q) => Math.hypot(q[0] - p[0], q[1] - p[1]) < 1e-6);
  for (const ref of refs ?? defaultHolePoints(sketch)) {
    if ("uv" in ref) continue; // not a sketch point
    const e = sketch.entities.find((x) => x.id === ref.entityId);
    const p = e && snapPoint(e, ref.at);
    if (!p) throw new Error("hole: a point it was placed on is gone from the sketch — pick its points again");
    if (!seen(p)) out.push(p);
  }
  return out;
}

/** One hole's start: the plane it drills from (into it, against the normal)
 *  and its centre in that plane's (u, v). */
export interface HoleTarget {
  frame: PlaneFrameData;
  center: [number, number];
}

/** Where each hole goes, one per target, in the order given. Two targets on
 *  the same spot and plane count once. */
export interface HolePlacement {
  holes: HoleTarget[];
}

/** One target's plane and centre. A fixed spot is on its own plane (an
 *  older hole's: the feature's); a sketch point on its sketch's plane, or
 *  carried along the normal onto an older hole's one plane. */
export function holeTarget(
  f: Pick<HoleFeature, "plane" | "sketchId">,
  ref: HolePointRef,
  sketchOf: (id: string) => SketchFeature | undefined,
  planeFrames: Map<string, PlaneFrameData>,
): HoleTarget {
  const shared = f.plane ?? (f.sketchId ? sketchOf(f.sketchId)?.plane : undefined);
  if ("uv" in ref) {
    const planeRef = ref.plane ?? shared;
    if (!planeRef) throw new Error("hole: a target has no face to start from — pick it again");
    return { frame: frameOf(planeRef, planeFrames), center: [ref.uv[0], ref.uv[1]] };
  }
  const sk = sketchOf(ref.sketchId ?? f.sketchId ?? "");
  const e = sk?.entities.find((x) => x.id === ref.entityId);
  const p = e && snapPoint(e, ref.at);
  if (!sk || !p) throw new Error("hole: a sketch point it was placed on is gone — pick its points again");
  if (!f.plane) return { frame: frameOf(sk.plane, planeFrames), center: p };
  const frame = frameOf(f.plane, planeFrames);
  return { frame, center: carry(sk, p, frame, planeFrames) };
}

/** A hole's placement. `sketchOf` looks a sketch up with its derived
 *  geometry and expressions applied (the resolver's `dDoc`). Throws a
 *  readable "hole: …" message when it can't be placed. */
export function holePlacement(
  f: HoleFeature,
  sketchOf: (id: string) => SketchFeature | undefined,
  planeFrames: Map<string, PlaneFrameData>,
): HolePlacement {
  const own = f.sketchId ? sketchOf(f.sketchId) : undefined;
  if (f.sketchId && !own && !f.plane) throw new Error("hole: its sketch no longer exists — pick its points again");
  // An older hole without a point list: every point and circle centre.
  if (!f.points) {
    const planeRef = f.plane ?? own?.plane;
    if (!planeRef) throw new Error("hole: select where the holes go — click a face, an edge's point or a sketch point");
    const frame = frameOf(planeRef, planeFrames);
    const centers = own ? holeCenters(own) : [];
    if (centers.length === 0)
      throw new Error("hole: the sketch has no points — add a point (or a circle) where each hole goes");
    return {
      holes: centers.map((c) => ({
        frame,
        center: own && own.plane === planeRef ? c : carry(own!, c, frame, planeFrames),
      })),
    };
  }
  const holes: HoleTarget[] = [];
  for (const ref of f.points) {
    const h = holeTarget(f, ref, sketchOf, planeFrames);
    const w = uvToWorld(h.frame, h.center[0], h.center[1]);
    const dup = holes.some((q) => {
      const v = uvToWorld(q.frame, q.center[0], q.center[1]);
      const n = q.frame.normal;
      const m = h.frame.normal;
      return (
        Math.hypot(v[0] - w[0], v[1] - w[1], v[2] - w[2]) < 1e-6 && n[0] * m[0] + n[1] * m[1] + n[2] * m[2] > 1 - 1e-9
      );
    });
    if (!dup) holes.push(h);
  }
  if (holes.length === 0)
    throw new Error("hole: select where the holes go — click a face, an edge's point or a sketch point");
  return { holes };
}

/** A placement as the kernel takes it: the first hole's frame, every
 *  centre in its own frame's (u, v), and — only when they differ — each
 *  hole's frame. */
export function resolvedHoleFrames(p: HolePlacement): {
  frame: PlaneFrameData;
  centers: [number, number][];
  frames?: PlaneFrameData[];
} {
  const frame = p.holes[0].frame;
  const same = (a: PlaneFrameData) =>
    a === frame ||
    JSON.stringify([a.origin, a.uAxis, a.vAxis, a.normal]) ===
      JSON.stringify([frame.origin, frame.uAxis, frame.vAxis, frame.normal]);
  const one = p.holes.every((h) => same(h.frame));
  return {
    frame,
    centers: p.holes.map((h) => h.center),
    ...(one ? {} : { frames: p.holes.map((h) => h.frame) }),
  };
}

/** A sketch's (u, v) as (u, v) in `frame`: out to the world, then dropped
 *  onto the frame's plane along its normal. */
function carry(
  sketch: SketchFeature,
  p: [number, number],
  frame: PlaneFrameData,
  planeFrames: Map<string, PlaneFrameData>,
): [number, number] {
  const w = uvToWorld(frameOf(sketch.plane, planeFrames), p[0], p[1]);
  const d = [w[0] - frame.origin[0], w[1] - frame.origin[1], w[2] - frame.origin[2]];
  const dot = (a: number[]) => d[0] * a[0] + d[1] * a[1] + d[2] * a[2];
  return [dot(frame.uAxis), dot(frame.vAxis)];
}

/** The parts a hole cuts: its picked parts, an older hole's one body, or
 *  (undefined) every part it reaches. */
export function holeScope(f: HoleFeature): string[] | undefined {
  if (f.scope?.length) return f.scope;
  return f.targetId && !f.plane ? [f.targetId] : undefined;
}

/** The hole as the kernel builds it. */
export function resolveHole(
  f: HoleFeature,
  sketchOf: (id: string) => SketchFeature | undefined,
  scope: Scope,
  planeFrames: Map<string, PlaneFrameData>,
): ResolvedFeature {
  const placed = resolvedHoleFrames(holePlacement(f, sketchOf, planeFrames));
  const dims = holeDims(f, scope);
  return {
    id: f.id,
    type: "hole",
    targets: holeScope(f),
    ...placed,
    profile: holeProfile(dims, 0),
    throughAll: dims.throughAll,
    ...(dims.upToNext ? { upToNext: true } : {}),
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
