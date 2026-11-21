// The Screw feature's document side: defaults, how a screw's shape comes out
// of the ISO table (geom/metricFasteners), and where it goes — on a plane, or
// in each hole of a Hole feature.
//
// Like hole.ts, every number that decides the SHAPE is computed here, purely,
// so the dialog's side-view diagram and the kernel body agree and the shape is
// unit-testable in Node.
import { evaluateExpression, type Scope } from "./expression";
import { frameOf, offsetFrame, uvToWorld, type PlaneFrameData, type SketchPlaneRef } from "./planes";
import { holeDims, holePlacement, holeTarget } from "./hole";
import type {
  Document,
  HoleFeature,
  HolePointRef,
  ScrewFeature,
  ScrewHead,
  ScrewParams,
  SketchFeature,
} from "./types";
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

export const DEFAULT_SCREW_PARAMS: ScrewParams = { length: "12", clearance: "0.1" };

/** What the dialog edits. `size` is always there (the Size control shows
 *  one); it is saved only when it isn't following a metric hole's. */
export type ScrewSettings = Pick<ScrewFeature, "head" | "thread" | "holeId" | "skipHoles" | "points" | "flip"> & {
  size: string;
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

/** The metric hole a screw follows the size of, if any. */
function metricHole(doc: Document, holeId: string | undefined): HoleFeature | undefined {
  const hole = holeId ? doc.features.find((f) => f.id === holeId) : undefined;
  return hole?.type === "hole" && isMetricSize(hole.size) ? hole : undefined;
}

/** The size a screw actually is: a metric hole's when it sits in one. */
export function screwSize(doc: Document, s: Pick<ScrewFeature, "size" | "holeId">): string {
  return metricHole(doc, s.holeId)?.size ?? s.size ?? DEFAULT_SCREW_SETTINGS.size;
}

/** The settings as saved: no size while a metric hole decides it, no empty
 *  point list. */
export function screwToSave(doc: Document, s: ScrewSettings): Omit<ScrewSettings, "size"> & { size?: string } {
  const { size, points, skipHoles, ...rest } = s;
  return {
    ...rest,
    ...(metricHole(doc, s.holeId) ? {} : { size }),
    ...(s.holeId && skipHoles?.length ? { skipHoles } : {}),
    ...(points?.length ? { points } : {}),
  };
}

const TOP: SketchPlaneRef = { kind: "datum", id: "plane-top" };

/** One screw's seat: a frame whose origin is where the head's underside
 *  meets the axis and whose normal points out of the hole, away from the
 *  shank — so every screw is built the same way (unflipped) whichever way
 *  its own hole drills. */
export type ScrewSeat = PlaneFrameData;

/** A frame turned over: the normal reversed (and v, so it stays a rotation). */
const turned = (f: PlaneFrameData): PlaneFrameData => ({
  ...f,
  vAxis: [-f.vAxis[0], -f.vAxis[1], -f.vAxis[2]],
  normal: [-f.normal[0], -f.normal[1], -f.normal[2]],
});

/** A seat at (u, v) of `frame`, going in against its normal (or along it,
 *  `along`), `depth` below the surface. */
function seatAt(frame: PlaneFrameData, [u, v]: [number, number], along: boolean, depth: number): ScrewSeat {
  const w = uvToWorld(frame, u, v);
  const f = along ? turned(frame) : frame;
  return offsetFrame({ ...f, origin: [w[0], w[1], w[2]] }, -depth);
}

/** Where each of a screw's screws sits: one per hole of its Hole (seated as
 *  that hole is, going in along it), then one per picked spot, going into
 *  the face or plane it was picked on — or, with neither, one at the Top
 *  plane's origin. Spots on top of each other count once. Throws a
 *  readable "screw: …" message when a location can't be found. */
export function screwSeats(
  doc: Document,
  f: Pick<ScrewFeature, "holeId" | "skipHoles" | "points" | "flip">,
  scope: Scope,
  planeFrames: Map<string, PlaneFrameData>,
): ScrewSeat[] {
  const sketchOf = (id: string) => doc.features.find((x): x is SketchFeature => x.id === id && x.type === "sketch");
  const seats: ScrewSeat[] = [];
  const add = (s: ScrewSeat) => {
    const dup = seats.some(
      (q) =>
        Math.hypot(q.origin[0] - s.origin[0], q.origin[1] - s.origin[1], q.origin[2] - s.origin[2]) < 1e-6 &&
        q.normal[0] * s.normal[0] + q.normal[1] * s.normal[1] + q.normal[2] * s.normal[2] > 1 - 1e-9,
    );
    if (!dup) seats.push(s);
  };
  if (f.holeId) {
    const hole = doc.features.find((x) => x.id === f.holeId);
    if (hole?.type !== "hole") throw new Error("screw: its hole no longer exists — select its locations again");
    let holes;
    try {
      ({ holes } = holePlacement(hole, sketchOf, planeFrames));
    } catch (err) {
      throw new Error(`screw: its hole can't be placed — ${(err as Error).message.replace(/^hole: /, "")}`);
    }
    const depth = seatDepth(hole, scope);
    holes.forEach((h, i) => {
      if (!f.skipHoles?.includes(i)) add(seatAt(h.frame, h.center, hole.flip !== f.flip, depth));
    });
  }
  for (const ref of f.points ?? []) {
    let t;
    try {
      t = holeTarget({}, ref, sketchOf, planeFrames);
    } catch (err) {
      throw new Error(
        `screw: ${(err as Error).message.replace(/^hole: /, "").replace(/pick its points/, "select it")}`,
      );
    }
    add(seatAt(t.frame, t.center, f.flip, 0));
  }
  if (!f.holeId && !f.points?.length) add(seatAt(frameOf(TOP), [0, 0], f.flip, 0));
  if (!seats.length) throw new Error("screw: every screw is removed — select where they go");
  return seats;
}

/** A screw in `holeId`'s holes taken out of it, staying exactly where it is:
 *  each screw becomes a fixed spot on its own seat,
 *  and a size it followed is kept as its own. Null when it isn't in that
 *  hole, or the hole can't be placed. */
export function unlinkScrew(
  doc: Document,
  f: ScrewFeature,
  holeId: string,
  scope: Scope,
  planeFrames: Map<string, PlaneFrameData>,
): ScrewFeature | null {
  if (f.holeId !== holeId) return null;
  let seats: ScrewSeat[];
  try {
    seats = screwSeats(doc, { holeId, skipHoles: f.skipHoles, flip: f.flip }, scope, planeFrames);
  } catch {
    return null;
  }
  // The body the holes were drilled into names the spots' face: the first
  // face a target (or the hole's sketch) was on, else a part it cut.
  const hole = doc.features.find((x): x is HoleFeature => x.id === holeId && x.type === "hole");
  const sketch = doc.features.find((x) => x.id === hole?.sketchId);
  const host =
    [
      ...(hole?.points ?? []).map((p) => ("uv" in p ? p.plane : undefined)),
      hole?.plane,
      sketch?.type === "sketch" ? sketch.plane : undefined,
    ]
      .map((p) => (p?.kind === "face" ? p.featureId : undefined))
      .find(Boolean) ??
    hole?.scope?.[0] ??
    hole?.targetId ??
    holeId;
  // Each seat already points its screw the way it goes; a spot is turned
  // over again by the feature's own Flip, so a flipped one is stored turned.
  const spots: HolePointRef[] = seats.map((s) => ({
    uv: [0, 0],
    plane: { kind: "face", featureId: host, frame: f.flip ? turned(s) : s },
  }));
  const { holeId: _h, skipHoles: _s, ...rest } = f;
  return { ...rest, size: screwSize(doc, f), points: [...spots, ...(f.points ?? [])] };
}

export function resolveScrew(
  doc: Document,
  f: ScrewFeature,
  scope: Scope,
  planeFrames: Map<string, PlaneFrameData>,
): ResolvedFeature {
  const dims = screwDims(f.head, screwSize(doc, f), num("length", f.params.length, scope));
  const seats = screwSeats(doc, f, scope, planeFrames);
  const thread =
    f.thread === "modelled" ? screwThread(dims, num("clearance", f.params.clearance ?? "0", scope)) : undefined;
  const top = dims.head === "flat" ? 0 : -dims.headHeight;
  return {
    id: f.id,
    type: "screw",
    // Each screw at its seat's origin, built unflipped (the seats already
    // point the way each goes).
    frame: seats[0],
    centers: seats.map(() => [0, 0] as [number, number]),
    ...(seats.length > 1 ? { frames: seats } : {}),
    flip: false,
    profile: screwProfile(dims, !!thread),
    ...(dims.head === "hex" ? { hexHead: { across: dims.headDiameter, z0: top, z1: 0 } } : {}),
    ...(dims.key > 0 ? { socket: { across: dims.key, z0: top, z1: top + socketDepth(dims) } } : {}),
    ...(thread ? { thread } : {}),
  };
}

/** How deep the hex socket goes. */
export function socketDepth(d: ScrewDims): number {
  if (d.head === "set") return Math.min(0.6 * d.d, 0.5 * d.length);
  return d.head === "flat" ? d.coneDepth * 0.7 : d.headHeight * (d.head === "button" ? 0.55 : 0.6);
}
