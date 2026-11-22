// The Thread feature's document side: defaults, validation, the numbers the
// dialog's diagram draws, the size it suggests for a face, matching another
// thread, and how it resolves for the kernel.
//
// Where the Screw and Hole features follow the ISO metric tables, this is the
// free-form one — any diameter, any pitch, three tooth shapes, several starts,
// either hand — because a printed thread wants a pitch the tables don't have:
// an FDM nozzle can't resolve an M5's 0.8 mm teeth, but prints a 2 mm pitch,
// 45° thread cleanly and without supports.
//
// It's always a cut on a round face: a rod's side has the grooves cut in, a
// hole's wall has them cut outward. Which side the face is, the kernel reads
// off the geometry; the dialog and the agent read it off the tessellation
// (geom/roundWall.ts) to show and suggest the right numbers.
import { evaluateExpression, type Scope } from "./expression";
import { featureIdOfPart } from "./parts";
import { screwSize } from "./screw";
import type { Document, Feature, ThreadFeature, ThreadParams } from "./types";
import { threadDepth, type ThreadProfile } from "../geom/thread";
import { METRIC, METRIC_SIZES, isMetricSize } from "../geom/metricFasteners";
import type { RoundWall } from "../geom/roundWall";
import type { ResolvedFeature } from "../kernel/types";

export type ThreadSide = "external" | "internal";

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

export type ThreadSettings = Pick<ThreadFeature, "profile" | "leftHand" | "leadIn" | "flip" | "fullLength"> & {
  params: ThreadParams;
};

export const DEFAULT_THREAD_SETTINGS: ThreadSettings = {
  profile: "printable",
  leftHand: false,
  leadIn: true,
  flip: false,
  fullLength: true,
  params: DEFAULT_THREAD_PARAMS,
};

/** The thread's numbers, resolved and checked. Radii are AS BUILT (the
 *  clearance applied: a rod's shrunk, a hole's grown). */
export interface ThreadDims {
  side: ThreadSide;
  profile: ThreadProfile;
  d: number;
  pitch: number;
  /** Null for the whole face (its length is the kernel's to measure). */
  length: number | null;
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

/** `side` is the face's, when it's known (the dialog has read it); the checks
 *  hold for either. */
export function threadDims(s: ThreadSettings, scope: Scope, side: ThreadSide = "external"): ThreadDims {
  const d = num("diameter", s.params.diameter, scope);
  const pitch = num("pitch", s.params.pitch, scope);
  const length = s.fullLength ? null : num("length", s.params.length, scope);
  const clearance = num("clearance", s.params.clearance, scope);
  const starts = num("starts", s.params.starts, scope);
  if (!(d > 0)) throw new Error("thread: diameter must be greater than 0");
  if (!(pitch > 0)) throw new Error("thread: pitch must be greater than 0");
  if (!Number.isInteger(starts) || starts < 1 || starts > 8) throw new Error("thread: starts must be 1 to 8");
  if (length !== null && !(length > pitch)) throw new Error("thread: length must be more than one pitch");
  if (!(clearance >= 0)) throw new Error("thread: clearance can't be negative");
  if (!(clearance <= 0.25 * pitch)) throw new Error(`thread: clearance can be at most a quarter pitch (${pitch / 4})`);
  const depth = threadDepth(pitch, s.profile);
  // The rod's root is the thinnest the core gets, whichever side this is.
  if (!(d / 2 - clearance - depth > 0.2 * (d / 2 - clearance)))
    throw new Error("thread: the pitch is too coarse for this diameter — the teeth would eat the core");
  const sign = side === "external" ? -1 : 1;
  const crestRadius = d / 2 + sign * clearance;
  return {
    side,
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
    rootRadius: crestRadius - depth,
  };
}

const fmt = (x: number) => String(Math.round(x * 100) / 100);

/** One line for the dialog: the size, the cut it makes, and the lead. */
export function threadReadout(t: ThreadDims): string {
  const lead = t.pitch * t.starts;
  const parts = [
    `Ø${fmt(t.d)} × ${fmt(t.pitch)}${t.starts > 1 ? ` (${t.starts} starts, lead ${fmt(lead)})` : ""}`,
    `${fmt(t.depth)} deep`,
  ];
  if (t.length !== null) parts.push(`≈${fmt(t.length / lead)} turns`);
  if (t.leftHand) parts.push("left-hand");
  return parts.join(" · ");
}

/** A pitch in proportion to a diameter, for the profiles the tables don't
 *  cover: fine enough that the teeth leave a small rod most of its core (a
 *  2 mm pitch takes half an M3's shank), coarse enough to print. */
export function suggestedPitch(d: number, profile: ThreadProfile): number {
  if (profile === "trapezoid") return d < 6 ? 1 : d < 10 ? 1.5 : d < 16 ? 2 : 3;
  return d < 5 ? 1 : d < 8 ? 1.5 : 2;
}

/** The thread a round face is ready for, so the cut is exact: on a rod, its
 *  own diameter (rounded down, so the crests are whole); in a hole, the size
 *  whose minor diameter is the bore (rounded up, so they're whole there too).
 *  The pitch is in proportion to the size (see suggestedPitch) unless
 *  `keepPitch`, when the current one stays and a hole's size follows it. For
 *  the ISO profile, a metric size close enough wins, with its coarse pitch — a
 *  Ø6 rod is an M6, a Ø5 hole is an M6's tap drill. */
export function suggestThread(
  wall: Pick<RoundWall, "radius" | "internal">,
  s: ThreadSettings,
  scope: Scope,
  keepPitch = false,
): Pick<ThreadParams, "diameter" | "pitch"> {
  const across = 2 * wall.radius;
  if (s.profile === "iso" && !keepPitch) {
    const m = METRIC_SIZES.map((k) => METRIC[k]).find((m) =>
      wall.internal ? Math.abs(m.tapDrill - across) <= 0.25 : Math.abs(m.d - across) <= 0.2,
    );
    if (m) return { diameter: fmt(m.d), pitch: fmt(m.pitch) };
  }
  let pitch = NaN;
  if (keepPitch) {
    try {
      pitch = evaluateExpression(s.params.pitch, scope);
    } catch {
      /* half-typed: suggest one */
    }
  }
  const keep = pitch > 0;
  if (!wall.internal) {
    const d = Math.floor(across * 10 + 1e-3) / 10;
    return { diameter: fmt(d), pitch: keep ? s.params.pitch : fmt(suggestedPitch(d, s.profile)) };
  }
  // A hole's size depends on the pitch and the pitch on the size: size it for
  // the pitch the bore itself suggests.
  if (!keep) pitch = suggestedPitch(across, s.profile);
  const d = across + 2 * threadDepth(pitch, s.profile);
  return { diameter: fmt(Math.ceil(d * 10 - 1e-3) / 10), pitch: keep ? s.params.pitch : fmt(pitch) };
}

/** What a thread to match copies: everything that has to agree for two
 *  threads to screw together. The clearance stays each part's own. */
export type ThreadMatch = {
  label: string;
  patch: Partial<Omit<ThreadSettings, "params">> & { params: Partial<ThreadParams> };
};

const metricMatch = (name: string, size: string): ThreadMatch => {
  const m = METRIC[size as keyof typeof METRIC];
  return {
    label: `${name} (${size} × ${fmt(m.pitch)})`,
    patch: { profile: "iso", leftHand: false, params: { diameter: fmt(m.d), pitch: fmt(m.pitch), starts: "1" } },
  };
};

/** The thread on a picked face, to match: a Thread feature's, a tapped Hole's
 *  or a Screw's — found by the feature the face's name starts with (a cut's
 *  faces carry the cutting feature's id), the part the face is on, or a Thread
 *  cut on that part (the newest — its faces are the part's, and mostly
 *  unnamed). A plain round face with no thread on it gets the thread it's
 *  ready for (`suggestThread`). Null when the face is neither. */
export function matchThread(
  doc: Document,
  pick: { partId: string; faceName?: string },
  wall: Pick<RoundWall, "radius" | "internal"> | null,
  current: ThreadSettings,
  scope: Scope,
  self?: string,
): ThreadMatch | null {
  const partFeature = featureIdOfPart(pick.partId);
  // Threads cut on the part: Thread features, and tapped Holes that cut it
  // (or every part they reach), newest first.
  const onPart = (id: string | undefined) => id === pick.partId || id === partFeature;
  const cutOnPart = doc.features
    .filter(
      (f) =>
        !f.suppressed &&
        ((f.type === "thread" && onPart(f.face?.featureId)) ||
          (f.type === "hole" &&
            f.holeType === "tapped" &&
            (f.scope ? f.scope.some(onPart) : f.targetId ? onPart(f.targetId) : true))),
    )
    .map((f) => f.id)
    .reverse();
  const ids = [pick.faceName?.split("/")[0], partFeature, ...cutOnPart].filter((x): x is string => !!x);
  for (const id of ids) {
    if (id === self) continue;
    const f: Feature | undefined = doc.features.find((x) => x.id === id);
    if (f?.type === "thread") {
      return {
        label: f.name,
        patch: {
          profile: f.profile,
          leftHand: f.leftHand,
          params: { diameter: f.params.diameter, pitch: f.params.pitch, starts: f.params.starts },
        },
      };
    }
    if (f?.type === "hole" && f.holeType === "tapped" && isMetricSize(f.size)) return metricMatch(f.name, f.size);
    if (f?.type === "screw") {
      const size = screwSize(doc, f);
      if (isMetricSize(size)) return metricMatch(f.name, size);
    }
  }
  if (!wall) return null;
  const s = suggestThread(wall, current, scope);
  return {
    label: `a Ø${fmt(2 * wall.radius)} ${wall.internal ? "hole" : "rod"}`,
    patch: { params: s },
  };
}

export function resolveThread(f: ThreadFeature, scope: Scope): ResolvedFeature {
  if (!f.face) throw new Error("thread: pick the round face to cut it on");
  const dims = threadDims(f, scope, f.side);
  return {
    id: f.id,
    type: "thread",
    face: { sourceId: f.face.featureId, faceName: f.face.faceName, center: f.face.center, normal: f.face.normal },
    flip: f.flip,
    ...(dims.length !== null ? { length: dims.length } : {}),
    clearance: dims.clearance,
    leadIn: dims.leadIn,
    thread: { d: dims.d, pitch: dims.pitch, profile: dims.profile, starts: dims.starts, leftHand: dims.leftHand },
  };
}
