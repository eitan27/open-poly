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
import type { ResolvedFeature } from "../kernel/types";

export const SCREW_HEAD_LABELS: Record<ScrewHead, string> = {
  socket: "Socket",
  button: "Button",
  flat: "Countersunk",
  hex: "Hex",
};

export const DEFAULT_SCREW_PARAMS: ScrewParams = { length: "12", centerX: "0", centerY: "0" };

export type ScrewSettings = Pick<ScrewFeature, "head" | "size" | "holeId" | "flip"> & { params: ScrewParams };

export const DEFAULT_SCREW_SETTINGS: ScrewSettings = {
  head: "socket",
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
  }
  if (!(length > 0)) throw new Error("screw: length must be greater than 0");
  if (head === "flat" && !(length > dims.coneDepth))
    throw new Error("screw: a countersunk screw must be longer than its head");
  return dims;
}

/** The screw's half cross-section, (radius, depth) from the top of the head on
 *  the axis to the tip on the axis. A hex head's prism is separate (its
 *  revolved part is just the shank, started inside the prism so they fuse). */
export function screwProfile(d: ScrewDims): [number, number][] {
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
      dome[0] = [0, -d.headHeight];
      return [...dome, [R, 0], [r, 0], ...tip];
    }
    case "flat":
      return [[0, 0], [R, 0], [r, d.coneDepth], ...tip];
    case "hex":
      return [[0, -d.headHeight / 2], [r, -d.headHeight / 2], ...tip];
  }
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
  const profile = screwProfile(dims).map(([r, z]) => [r, z + seat] as [number, number]);
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
  };
}

/** How deep the hex socket goes. */
export function socketDepth(d: ScrewDims): number {
  return d.head === "flat" ? d.coneDepth * 0.7 : d.headHeight * (d.head === "button" ? 0.55 : 0.6);
}
