// The Thread feature's document side: defaults, validation, the numbers the
// dialog's diagram draws, and how it resolves for the kernel.
//
// Where the Screw and Hole features follow the ISO metric tables, this is the
// free-form one — any diameter, any pitch, three tooth shapes, several starts,
// either hand — because a printed thread wants a pitch the tables don't have:
// an FDM nozzle can't resolve an M5's 0.8 mm teeth, but prints a 2 mm pitch,
// 45° thread cleanly and without supports.
import { evaluateExpression, type Scope } from "./expression";
import { frameOf, type PlaneFrameData } from "./planes";
import { holeCenters } from "./hole";
import type { SketchFeature, ThreadFeature, ThreadParams } from "./types";
import { threadDepth, type ThreadProfile } from "../geom/thread";
import type { ResolvedFeature } from "../kernel/types";

export const THREAD_PROFILE_LABELS: Record<ThreadProfile, string> = {
  printable: "Printable",
  iso: "ISO 60°",
  trapezoid: "Trapezoid",
};

/** What each profile is for, for tooltips. */
export const THREAD_PROFILE_HINTS: Record<ThreadProfile, string> = {
  printable: "45° flanks and wide flats: prints upright with no supports, and survives a printer's rounding",
  iso: "The ISO metric 60° form — for parts that meet bought nuts and bolts",
  trapezoid: "≈15° flanks (like ISO Tr): lead screws and anything carrying load",
};

export const DEFAULT_THREAD_PARAMS: ThreadParams = {
  diameter: "10",
  pitch: "2",
  length: "12",
  // Per part, so a printed pair has 0.3 mm radially between them.
  clearance: "0.15",
  starts: "1",
};

export type ThreadSettings = Pick<ThreadFeature, "side" | "profile" | "leftHand" | "leadIn" | "flip"> & {
  params: ThreadParams;
};

export const DEFAULT_THREAD_SETTINGS: ThreadSettings = {
  side: "external",
  profile: "printable",
  leftHand: false,
  leadIn: true,
  flip: false,
  params: DEFAULT_THREAD_PARAMS,
};

/** The thread's numbers, resolved and checked. Radii are AS BUILT (the
 *  clearance applied: an external thread's shrunk, an internal one's grown). */
export interface ThreadDims {
  side: ThreadFeature["side"];
  profile: ThreadProfile;
  d: number;
  pitch: number;
  length: number;
  clearance: number;
  starts: number;
  leftHand: boolean;
  leadIn: boolean;
  /** Crest-to-root radial depth. */
  depth: number;
  crestRadius: number;
  rootRadius: number;
}

const num = (label: string, expr: string, scope: Scope): number => {
  try {
    return evaluateExpression(expr, scope);
  } catch (err) {
    throw new Error(`thread: ${label}: ${(err as Error).message}`);
  }
};

export function threadDims(s: ThreadSettings, scope: Scope): ThreadDims {
  const d = num("diameter", s.params.diameter, scope);
  const pitch = num("pitch", s.params.pitch, scope);
  const length = num("length", s.params.length, scope);
  const clearance = num("clearance", s.params.clearance, scope);
  const starts = num("starts", s.params.starts, scope);
  if (!(d > 0)) throw new Error("thread: diameter must be greater than 0");
  if (!(pitch > 0)) throw new Error("thread: pitch must be greater than 0");
  if (!Number.isInteger(starts) || starts < 1 || starts > 8) throw new Error("thread: starts must be 1 to 8");
  if (!(length > pitch)) throw new Error("thread: length must be more than one pitch");
  if (!(clearance >= 0)) throw new Error("thread: clearance can't be negative");
  if (!(clearance <= 0.25 * pitch)) throw new Error(`thread: clearance can be at most a quarter pitch (${pitch / 4})`);
  const depth = threadDepth(pitch, s.profile);
  const sign = s.side === "external" ? -1 : 1;
  const crestRadius = d / 2 + sign * clearance;
  const rootRadius = crestRadius - depth;
  if (!(rootRadius > 0.2 * crestRadius))
    throw new Error("thread: the pitch is too coarse for this diameter — the teeth would eat the core");
  return {
    side: s.side,
    profile: s.profile,
    d,
    pitch,
    length,
    clearance,
    starts,
    leftHand: s.leftHand,
    leadIn: s.leadIn,
    depth,
    crestRadius,
    rootRadius,
  };
}

const fmt = (x: number) => String(Math.round(x * 100) / 100);

/** One line for the dialog: the size, the cut it makes, and the lead. */
export function threadReadout(t: ThreadDims): string {
  const lead = t.pitch * t.starts;
  const parts = [
    `Ø${fmt(t.d)} × ${fmt(t.pitch)}${t.starts > 1 ? ` (${t.starts} starts, lead ${fmt(lead)})` : ""}`,
    `${fmt(t.depth)} deep`,
    `≈${fmt(t.length / lead)} turns`,
  ];
  if (t.leftHand) parts.push("left-hand");
  return parts.join(" · ");
}

export function resolveThread(
  f: ThreadFeature,
  sketch: SketchFeature | undefined,
  scope: Scope,
  planeFrames: Map<string, PlaneFrameData>,
): ResolvedFeature {
  const dims = threadDims(f, scope);
  if (!sketch) throw new Error("thread: its sketch no longer exists");
  const centers = holeCenters(sketch);
  if (!centers.length) throw new Error("thread: the sketch has no point or circle to put a thread on");
  const internal = f.side === "internal";
  if (internal && !f.targetId) throw new Error("thread: pick the body to cut the internal thread into");
  const frame = frameOf(sketch.plane, planeFrames);
  // External: out of the plane, along its normal. Internal: into the body,
  // against it — like a hole. Flip reverses either.
  const out = internal === f.flip ? 1 : -1;
  const down: [number, number, number] = [frame.normal[0] * out, frame.normal[1] * out, frame.normal[2] * out];
  const common = {
    d: dims.d,
    pitch: dims.pitch,
    profile: dims.profile,
    starts: dims.starts,
    leftHand: dims.leftHand,
  };
  return {
    id: f.id,
    type: "thread",
    frame,
    centers,
    down,
    internal,
    ...(internal ? { targetId: f.targetId } : {}),
    thread: internal
      ? // Starts a little outside the body so the cut opens cleanly. The
        // lead-in here is a 45° countersink at the mouth (the kernel cuts it
        // after the thread), so `startChamfer` means that, not a clamp.
        {
          ...common,
          offset: dims.clearance,
          z0: -Math.min(0.5, dims.pitch),
          z1: dims.length,
          tipChamfer: false,
          startChamfer: dims.leadIn,
        }
      : { ...common, offset: -dims.clearance, z0: 0, z1: dims.length, tipChamfer: dims.leadIn },
  };
}
