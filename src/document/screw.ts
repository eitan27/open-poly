// The Screw feature's document side: defaults, how a screw's shape comes out
// of the ISO table (geom/metricFasteners), and where it goes — on a plane, or
// in each hole of a Hole feature.
//
// Like hole.ts, every number that decides the SHAPE is computed here, purely,
// so the dialog's side-view diagram and the kernel body agree and the shape is
// unit-testable in Node.
import { evaluateExpression, type Scope } from "./expression";
import { frameOf, type PlaneFrameData } from "./planes";
import { holeCenters, holeDims } from "./hole";
import type { Document, HoleFeature, ScrewFeature, ScrewHead, ScrewParams, SketchFeature } from "./types";
import { METRIC, isMetricSize, type MetricSize } from "../geom/metricFasteners";
import { maxSocketInThread } from "../geom/screwMesh";
import type { ResolvedFeature, ThreadResolved } from "../kernel/types";

export const SCREW_HEAD_LABELS: Record<ScrewHead, string> = {
  socket: "Socket",
  button: "Button",
  flat: "Countersunk",
  hex: "Hex",
  set: "Set screw",
  none: "No head",
};

export const DEFAULT_SCREW_PARAMS: ScrewParams = { length: "12", centerX: "0", centerY: "0", clearance: "0.1" };

export type ScrewSettings = Pick<ScrewFeature, "head" | "thread" | "size" | "holeId" | "flip"> & {
  params: ScrewParams;
};

export const DEFAULT_SCREW_SETTINGS: ScrewSettings = {
  head: "socket",
  // Cosmetic by default: it builds in a blink, and a modelled thread at
  // these sizes is too fine to print anyway — the Thread feature's printable
  // profile is the route for printed fasteners.
  thread: "cosmetic",
  size: "M3",
  flip: false,
  params: DEFAULT_SCREW_PARAMS,
};

/** The screw's numbers, resolved. Depths are along the drilling direction
 *  from the seat plane: the head sits at negative depth (above), the shank at
 *  positive (in). */
export interface ScrewDims {
  head: ScrewHead;
  size: MetricSize;
  d: number;
  pitch: number;
  length: number;
  /** Head: diameter across (round heads) or across flats (hex). */
  headDiameter: number;
  /** How far the head stands above the seat (0 for a countersunk head, which
   *  sits in its cone below it). */
  headHeight: number;
  /** Countersunk: depth of the head's cone below the seat. */
  coneDepth: number;
  /** Hex key across flats for the socket, 0 for a hex head. */
  key: number;
}

const num = (label: string, expr: string, scope: Scope): number => {
  try {
    return evaluateExpression(expr, scope);
  } catch (err) {
    throw new Error(`screw: ${label}: ${(err as Error).message}`);
  }
};

export function screwDims(head: ScrewHead, size: string, length: number): ScrewDims {
  if (!isMetricSize(size)) throw new Error(`screw: unknown size "${size}"`);
  const m = METRIC[size];
  const base = { head, size, d: m.d, pitch: m.pitch, length };
  let dims: ScrewDims;
  switch (head) {
    case "socket":
      dims = {
        ...base,
        headDiameter: m.socketHead.dk,
        headHeight: m.socketHead.k,
        coneDepth: 0,
        key: m.socketHead.key,
      };
      break;
    case "button":
      dims = {
        ...base,
        headDiameter: m.buttonHead.dk,
        headHeight: m.buttonHead.k,
        coneDepth: 0,
        key: m.buttonHead.key,
      };
      break;
    case "flat":
      dims = {
        ...base,
        headDiameter: m.flatHead.dk,
        headHeight: 0,
        coneDepth: (m.flatHead.dk - m.d) / 2, // 90° included
        key: m.flatHead.key,
      };
      break;
    case "hex":
      dims = { ...base, headDiameter: m.hexHead.s, headHeight: m.hexHead.k, coneDepth: 0, key: 0 };
      break;
    case "set":
      dims = { ...base, headDiameter: m.d, headHeight: 0, coneDepth: 0, key: m.setScrewKey };
      break;
    case "none":
      dims = { ...base, headDiameter: m.d, headHeight: 0, coneDepth: 0, key: 0 };
      break;
  }
  if (!(length > 0)) throw new Error("screw: length must be greater than 0");
  if (head === "flat" && !(length > dims.coneDepth))
    throw new Error("screw: a countersunk screw must be longer than its head");
  return dims;
}

/** The screw's half cross-section, (radius, depth) from the top of the head on
 *  the axis to the tip on the axis. A hex head's prism is separate (its
 *  revolved part is just the shank, started inside the prism so they fuse).
 *  `headOnly`: a modelled thread replaces the shank, so the profile closes
 *  back to the axis under the head (and is empty for a hex head). */
export function screwProfile(d: ScrewDims, headOnly = false): [number, number][] {
  if (headOnly) {
    if (!hasHead(d.head)) return [];
    const full = screwProfile(d);
    if (d.head === "hex") return [];
    const bottom = headBottom(d);
    const head = full.slice(0, full.findIndex(([, z]) => z >= bottom - 1e-9) + 1);
    return [...head, [0, bottom]];
  }
  const r = d.d / 2;
  // Tip chamfer, roughly the thread depth.
  const c = Math.min(d.pitch * 0.6, r * 0.5);
  // ISO lengths run from the seat: under a round/hex head, and from the top
  // of a countersunk head — which here is the seat too, so one rule.
  const shankEnd = d.length;
  const tip: [number, number][] = [
    [r, shankEnd - c],
    [r - c, shankEnd],
    [0, shankEnd],
  ];
  const R = d.headDiameter / 2;
  switch (d.head) {
    case "socket": {
      // A small chamfer on the head's top edge.
      const e = Math.min(d.headHeight * 0.1, R * 0.1);
      return [[0, -d.headHeight], [R - e, -d.headHeight], [R, -d.headHeight + e], [R, 0], [r, 0], ...tip];
    }
    case "button": {
      // A domed head: a quarter ellipse from the axis top down to the rim,
      // with a short vertical rim at the seat.
      const rim = d.headHeight * 0.18;
      const dome: [number, number][] = [];
      const steps = 10;
      for (let i = 0; i <= steps; i++) {
        const t = (Math.PI / 2) * (1 - i / steps); // π/2 → 0
        dome.push([R * Math.cos(t), -rim - (d.headHeight - rim) * Math.sin(t)]);
      }
      // Flat across the top where the socket goes (as ISO 7380 heads are),
      // so the socket is a hole in a flat face.
      const flatR = d.key / Math.sqrt(3) + Math.max(0.25, R * 0.1);
      const i = Math.max(
        1,
        dome.findIndex(([x]) => x >= flatR),
      );
      return [[0, dome[i][1]], ...dome.slice(i), [R, 0], [r, 0], ...tip];
    }
    case "flat":
      return [[0, 0], [R, 0], [r, d.coneDepth], ...tip];
    case "hex":
      return [[0, -d.headHeight / 2], [r, -d.headHeight / 2], ...tip];
    case "set":
    case "none":
      return [[0, 0], [r, 0], ...tip];
  }
}

/** Whether a head of this kind stands proud of the thread at all. */
export function hasHead(head: ScrewHead): boolean {
  return head !== "set" && head !== "none";
}

/** Depth where the head ends and the shank begins: the seat, or the bottom of
 *  a countersunk head's cone. */
export function headBottom(d: ScrewDims): number {
  return d.head === "flat" ? d.coneDepth : 0;
}

/** A modelled thread's run: from where the head ends (it is stitched onto the
 *  head's underside there, geom/screwMesh.ts) to the tip, with a lead-in
 *  chamfer there. */
export function screwThread(d: ScrewDims, clearance: number): ThreadResolved {
  if (!(clearance >= 0)) throw new Error("screw: clearance can't be negative");
  if (!(clearance <= 0.25 * d.pitch))
    throw new Error(`screw: clearance can be at most ${0.25 * d.pitch} for ${d.size}`);
  if (d.key > 0 && !hasHead(d.head)) {
    const fits = maxSocketInThread(d.d, d.pitch, -clearance);
    if (d.key > fits) throw new Error(`screw: a ${d.size} set screw's thread is too fine for its ${d.key} mm socket`);
  }
  return { d: d.d, pitch: d.pitch, offset: -clearance, z0: headBottom(d), z1: d.length, tipChamfer: true };
}

/** Where a screw in a hole sits: on the counterbore's floor, flush at the
 *  top of a countersink (its cone sits in the hole's), else on the surface. */
export function seatDepth(hole: HoleFeature, scope: Scope): number {
  const d = holeDims(hole, scope);
  return d.holeType === "counterbore" ? d.counterboreDepth : 0;
}

/** The size a screw actually is: a metric hole's when it sits in one. */
export function screwSize(doc: Document, s: Pick<ScrewFeature, "size" | "holeId">): string {
  const hole = s.holeId ? doc.features.find((f) => f.id === s.holeId) : undefined;
  return hole?.type === "hole" && isMetricSize(hole.size) ? hole.size : s.size;
}

export function resolveScrew(
  doc: Document,
  f: ScrewFeature,
  scope: Scope,
  planeFrames: Map<string, PlaneFrameData>,
): ResolvedFeature {
  const dims = screwDims(f.head, screwSize(doc, f), num("length", f.params.length, scope));
  let frame: PlaneFrameData;
  let centers: [number, number][];
  let flip = f.flip;
  let seat = 0;
  if (f.holeId) {
    const hole = doc.features.find((x) => x.id === f.holeId);
    if (hole?.type !== "hole")
      throw new Error("screw: its hole no longer exists — pick another, or place it on a plane");
    const sketch = doc.features.find((x) => x.id === hole.sketchId) as SketchFeature | undefined;
    if (sketch?.type !== "sketch") throw new Error("screw: the hole's sketch no longer exists");
    frame = frameOf(sketch.plane, planeFrames);
    centers = holeCenters(sketch);
    flip = hole.flip !== f.flip;
    seat = seatDepth(hole, scope);
  } else {
    frame = frameOf(f.plane, planeFrames);
    centers = [[num("center X", f.params.centerX, scope), num("center Y", f.params.centerY, scope)]];
  }
  const thread =
    f.thread === "modelled" ? screwThread(dims, num("clearance", f.params.clearance ?? "0", scope)) : undefined;
  const profile = screwProfile(dims, !!thread).map(([r, z]) => [r, z + seat] as [number, number]);
  const top = (dims.head === "flat" ? 0 : -dims.headHeight) + seat;
  return {
    id: f.id,
    type: "screw",
    frame,
    centers,
    flip,
    profile,
    ...(dims.head === "hex" ? { hexHead: { across: dims.headDiameter, z0: top, z1: seat } } : {}),
    ...(dims.key > 0 ? { socket: { across: dims.key, z0: top, z1: top + socketDepth(dims) } } : {}),
    ...(thread ? { thread: { ...thread, z0: thread.z0 + seat, z1: thread.z1 + seat } } : {}),
  };
}

/** How deep the hex socket goes. */
export function socketDepth(d: ScrewDims): number {
  if (d.head === "set") return Math.min(0.6 * d.d, 0.5 * d.length);
  return d.head === "flat" ? d.coneDepth * 0.7 : d.headHeight * (d.head === "button" ? 0.55 : 0.6);
}
