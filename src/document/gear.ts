// The Gear feature's document side: its defaults, how its expressions resolve
// (including taking module + pressure angle from a meshing partner), and how it
// bakes to the extrude the kernel actually builds.
//
// A gear is a 2D involute outline (src/geom/gearProfile.ts) extruded to a
// thickness. Lowering it to the kernel's existing extrude means the ghost, the
// face naming, booleans and STEP export are all the extrude's — the kernel has
// no gear code at all.
import { evaluateExpression, type Scope } from "./expression";
import { frameOf, type PlaneFrameData } from "./planes";
import type { Document, Feature, GearFeature, GearParams, GearType, HolePointRef } from "./types";
import { snapPoint } from "./hole";
import {
  centerDistance,
  gearOutline,
  minTeethWithoutUndercut,
  rackOutline,
  type GearDims,
  type GearOutline,
  type GearToothSpec,
  type RackDims,
  type RackOutline,
} from "../geom/gearProfile";
import type { ResolvedFeature } from "../kernel/types";
import { add, alignTurn, cross, dot, rackMesh, scale, sub, unit, type GearGeom, type Vec3 } from "../geom/gearAlign";

export const GEAR_TYPE_LABELS: Record<GearType, string> = {
  spur: "Spur gear",
  internal: "Internal (ring) gear",
  rack: "Rack",
};

/** The settings a new gear starts with: 20 teeth of module 2 — a Ø40 gear, big
 *  enough to read on screen at the default zoom. */
export const DEFAULT_GEAR_PARAMS: GearParams = {
  teeth: "20",
  module: "2",
  pitchDiameter: "40",
  thickness: "8",
  boreDiameter: "8",
  boreFlat: "7",
  rimWidth: "4",
  pressureAngle: "20",
  backlash: "0",
  profileShift: "0",
  rootFillet: "0.38",
  rotation: "0",
  centerX: "0",
  centerY: "0",
  placeAngle: "0",
  rackHeight: "12",
  endMargin: "0",
  slide: "0",
};

export type GearSettings = Pick<
  GearFeature,
  "gearType" | "sizeBy" | "meshWith" | "placeBeside" | "bore" | "extent" | "flip" | "center"
> & {
  params: GearParams;
};

export const DEFAULT_GEAR_SETTINGS: GearSettings = {
  gearType: "spur",
  sizeBy: "module",
  bore: "round",
  extent: "blind",
  flip: false,
  params: DEFAULT_GEAR_PARAMS,
};

/** Gears in the document a gear could mesh with: every other gear, except
 *  ones that (through their own partner) already lead back to this one — a
 *  loop has no gear to take the size from. Nothing meshes with a rack (a
 *  rack picks its pinion), and a rack meshes only with a spur gear. */
export function meshCandidates(doc: Document, selfId?: string, selfType: GearType = "spur"): GearFeature[] {
  return doc.features.filter(
    (f): f is GearFeature =>
      f.type === "gear" &&
      f.id !== selfId &&
      f.gearType !== "rack" &&
      !(selfType === "rack" && f.gearType === "internal") &&
      !(selfId && leadsTo(doc, f, selfId)),
  );
}

function leadsTo(doc: Document, from: GearFeature, target: string): boolean {
  const seen = new Set<string>();
  let g: Feature | undefined = from;
  while (g?.type === "gear" && g.meshWith && !seen.has(g.id)) {
    const next: string = g.meshWith;
    if (next === target) return true;
    seen.add(g.id);
    g = doc.features.find((f) => f.id === next);
  }
  return false;
}

const num = (label: string, expr: string | undefined, scope: Scope): number => {
  // A field cleared to type a new value: say so plainly, not as a parse error.
  if (!expr?.trim()) throw new Error(`gear: ${label}: enter a value`);
  let v: number;
  try {
    v = evaluateExpression(expr, scope);
  } catch (err) {
    throw new Error(`gear: ${label}: ${(err as Error).message}`);
  }
  return v;
};

/** The module and pressure angle a gear actually uses: its own, or — when it
 *  meshes with another — that gear's (followed through a chain, with a guard
 *  against a loop that an old or hand-edited document could still hold). */
export function gearSizing(
  doc: Document,
  g: Pick<GearFeature, "id" | "sizeBy" | "meshWith" | "params"> & Partial<Pick<GearFeature, "gearType">>,
  scope: Scope,
): { module: number; pressureAngle: number; teeth: number; from?: GearFeature } {
  const teeth = num("teeth", g.params.teeth, scope);
  const seen = new Set<string>([g.id]);
  let src: Pick<GearFeature, "sizeBy" | "meshWith" | "params"> = g;
  let from: GearFeature | undefined;
  while (src.meshWith) {
    const partner = doc.features.find((f) => f.id === src.meshWith);
    if (partner?.type !== "gear") throw new Error("gear: the gear it meshes with no longer exists — pick another");
    if (partner.gearType === "rack")
      throw new Error(`gear: ${partner.name} is a rack — a rack takes its size from its pinion, not the other way`);
    if (seen.has(partner.id)) throw new Error("gear: meshing gears form a loop — one of them needs its own module");
    if (!from && g.gearType === "rack" && partner.gearType === "internal")
      throw new Error(`gear: ${partner.name} is a ring gear — a rack meshes with a spur gear`);
    seen.add(partner.id);
    from ??= partner;
    src = partner;
  }
  const ownTeeth = src === g ? teeth : num("teeth", src.params.teeth, scope);
  // A rack has no pitch diameter: sized on its own, it's by module.
  const byPD = src.sizeBy === "pitchDiameter" && !(src === g && g.gearType === "rack");
  const module = byPD
    ? num("pitch diameter", src.params.pitchDiameter, scope) / ownTeeth
    : num("module", src.params.module, scope);
  const pressureAngle = num("pressure angle", src.params.pressureAngle, scope);
  return { module, pressureAngle, teeth, from };
}

export interface BakedGear {
  /** A rack's outline has `rack` (its sizes) where a gear's has `dims`. */
  outline: GearOutline | RackOutline;
  spec: GearToothSpec;
  frame: PlaneFrameData;
  thickness: number;
  /** The partner the size came from, if meshed. */
  from?: GearFeature;
  /** Where the gear's centre is on its plane (u, v), and how far tooth 0 (a
   *  ring's space 0) is turned from +u, radians: what meshing math needs. A
   *  rack's: the middle of its pitch line, and the direction it runs. */
  center: [number, number];
  rotation: number;
}

/** Evaluate every setting and build the outline (in the plane's u, v). Throws
 *  with a readable message — the same path the dialog's live readout uses. */
export function bakeGear(
  doc: Document,
  g: Pick<
    GearFeature,
    "id" | "gearType" | "plane" | "center" | "sizeBy" | "meshWith" | "placeBeside" | "bore" | "params"
  >,
  scope: Scope,
  planeFrames?: Map<string, PlaneFrameData>,
  /** Gears already being baked down a chain of placed partners (a guard). */
  seen: ReadonlySet<string> = new Set(),
): BakedGear {
  const p = g.params;
  const { module, pressureAngle, teeth, from } = gearSizing(doc, g, scope);
  const spec: GearToothSpec = {
    teeth,
    module,
    pressureAngle,
    profileShift: num("profile shift", p.profileShift, scope),
    backlash: num("backlash", p.backlash, scope),
    rootFillet: num("root fillet", p.rootFillet, scope) * module,
  };
  const thickness = num("thickness", p.thickness, scope);
  if (!(thickness > 0)) throw new Error("gear: thickness must be greater than 0");
  if (g.gearType === "rack") return bakeRack(doc, g, spec, thickness, from, scope, planeFrames, seen);
  const internal = g.gearType === "internal";
  const bore =
    internal || g.bore === "none"
      ? undefined
      : g.bore === "round"
        ? { kind: "round" as const, diameter: num("bore", p.boreDiameter, scope) }
        : {
            kind: "dflat" as const,
            diameter: num("bore", p.boreDiameter, scope),
            acrossFlat: num("D-flat", p.boreFlat, scope),
          };
  const located = g.center ? gearLocation(doc, g.center, g.plane, planeFrames) : null;
  const frame = located?.frame ?? frameOf(g.plane, planeFrames);
  let rotation = (num("rotation", p.rotation, scope) * Math.PI) / 180;
  let cx: number;
  let cy: number;
  if (g.placeBeside && g.meshWith && from) {
    const at = placeBesidePartner(doc, g, from, frame, spec, internal, scope, planeFrames, seen);
    [cx, cy] = at.center;
    rotation += at.rotation; // Rotation° is added to the meshing angle
  } else if (located) {
    [cx, cy] = located.center;
  } else {
    cx = num("center X", p.centerX, scope);
    cy = num("center Y", p.centerY, scope);
  }
  const outline = gearOutline(spec, {
    internal,
    rotation,
    bore,
    rimWidth: internal ? num("rim width", p.rimWidth, scope) : undefined,
  });
  // Move the outline to its centre on the plane.
  if (cx !== 0 || cy !== 0) {
    const shift = (pts: [number, number][]) => pts.map(([x, y]) => [x + cx, y + cy] as [number, number]);
    outline.outline = shift(outline.outline);
    outline.holes = outline.holes.map(shift);
  }
  return { outline, spec, frame, thickness, from, center: [cx, cy], rotation };
}

/** A picked location: the plane it puts the gear on, and its centre there. A
 *  sketch point is read live, on its sketch's own plane, so the gear follows
 *  the sketch; a spot on a face is fixed in the plane it was picked from. */
function gearLocation(
  doc: Document,
  ref: HolePointRef,
  plane: GearFeature["plane"],
  planeFrames: Map<string, PlaneFrameData> | undefined,
): { frame: PlaneFrameData; center: [number, number] } {
  if ("uv" in ref) return { frame: frameOf(ref.plane ?? plane, planeFrames), center: [ref.uv[0], ref.uv[1]] };
  const sk = doc.features.find((f) => f.id === ref.sketchId && f.type === "sketch");
  const e = sk?.type === "sketch" ? sk.entities.find((x) => x.id === ref.entityId) : undefined;
  const p = e && snapPoint(e, ref.at);
  if (sk?.type !== "sketch" || !p)
    throw new Error("gear: the sketch point it was placed on is gone — select its location again");
  return { frame: frameOf(sk.plane, planeFrames), center: p };
}

/** Where a gear placed beside its partner goes on its own plane, and the turn
 *  that meshes its teeth: its centre at the meshing distance from the
 *  partner's, toward `params.placeAngle`; its tooth 0 turned (from +u) so its
 *  teeth sit in the partner's spaces (geom/gearAlign.ts). The partner is baked
 *  first, so a chain of placed gears follows its first. */
function placeBesidePartner(
  doc: Document,
  g: Pick<GearFeature, "id" | "params">,
  partner: GearFeature,
  frame: PlaneFrameData,
  spec: GearToothSpec,
  internal: boolean,
  scope: Scope,
  planeFrames: Map<string, PlaneFrameData> | undefined,
  seen: ReadonlySet<string>,
): { center: [number, number]; rotation: number } {
  if (seen.has(partner.id)) throw new Error("gear: placed gears form a loop — one of them needs its own place");
  // Placing reads where the partner is MADE; a Transform moving it afterwards
  // would leave this gear beside where it used to be.
  const moved = doc.features.find(
    (f) => f.type === "transform" && f.targetId === partner.id && !f.copy && !f.suppressed,
  );
  if (moved)
    throw new Error(
      `gear: ${moved.name} moves ${partner.name} after it's made, so it can't be placed beside it — give ${partner.name} a location in its dialog instead, or untick Place beside`,
    );
  const pb = bakeGear(doc, partner, scope, planeFrames, new Set([...seen, g.id]));
  const pf = pb.frame;
  if (partner.gearType === "rack") throw new Error(`gear: ${partner.name} is a rack — place the rack beside the gear`);
  const at = (f: PlaneFrameData, u: number, v: number): Vec3 =>
    add(add(f.origin, scale(f.uAxis, u)), scale(f.vAxis, v));
  const n = unit(cross(frame.uAxis, frame.vAxis));
  const np = unit(cross(pf.uAxis, pf.vAxis));
  if (Math.abs(dot(n, np)) < 0.999)
    throw new Error(`gear: to place it beside ${partner.name}, put it on a plane parallel to ${partner.name}'s`);
  const partnerInternal = partner.gearType === "internal";
  if (internal && partnerInternal) throw new Error("gear: two ring gears can't mesh");
  const m = spec.module;
  const Np = pb.spec.teeth;
  const N = spec.teeth;
  const ring = internal || partnerInternal;
  const cd = ring ? (m * Math.abs(Np - N)) / 2 : (m * (Np + N)) / 2;
  if (ring && cd < 1e-9) throw new Error("gear: a ring and a pinion with the same teeth can't mesh");
  // The partner's centre in this gear's plane, then out along the angle.
  const pc = at(pf, pb.center[0], pb.center[1]);
  const d = sub(pc, frame.origin);
  const a = (num("place angle", g.params.placeAngle ?? "0", scope) * Math.PI) / 180;
  const center: [number, number] = [dot(d, frame.uAxis) + cd * Math.cos(a), dot(d, frame.vAxis) + cd * Math.sin(a)];
  const partnerGeom: GearGeom = {
    teeth: Np,
    module: m,
    internal: partnerInternal,
    center: pc,
    axis: np,
    tooth: unit(add(scale(pf.uAxis, Math.cos(pb.rotation)), scale(pf.vAxis, Math.sin(pb.rotation)))),
  };
  const selfGeom: GearGeom = {
    teeth: N,
    module: m,
    internal,
    center: at(frame, center[0], center[1]),
    axis: n,
    tooth: unit(frame.uAxis),
  };
  const turn = alignTurn(partnerGeom, selfGeom);
  if (typeof turn === "string") throw new Error(`gear: ${turn}`);
  // alignTurn turns about the partner's axis; this plane's may face the other way.
  return { center, rotation: dot(n, np) > 0 ? turn : -turn };
}

/** A rack: its outline on its plane, centred on the middle of its pitch line
 *  and running along `params.rotation` — or, placed beside its pinion, with
 *  its pitch line touching the pinion's pitch circle (pushed out by the
 *  pinion's profile shift) on the `placeAngle` side, teeth toward the pinion,
 *  slid along so a pinion tooth sits in a rack space, then `slide` tooth
 *  pitches further. A rack has no profile shift of its own. */
function bakeRack(
  doc: Document,
  g: Pick<GearFeature, "id" | "plane" | "center" | "meshWith" | "placeBeside" | "params">,
  toothSpec: GearToothSpec,
  thickness: number,
  from: GearFeature | undefined,
  scope: Scope,
  planeFrames: Map<string, PlaneFrameData> | undefined,
  seen: ReadonlySet<string>,
): BakedGear {
  const p = g.params;
  const spec: GearToothSpec = { ...toothSpec, profileShift: 0 };
  const height = num("height", p.rackHeight ?? DEFAULT_GEAR_PARAMS.rackHeight, scope);
  const endMargin = num("end margin", p.endMargin ?? "0", scope);
  const located = g.center ? gearLocation(doc, g.center, g.plane, planeFrames) : null;
  const frame = located?.frame ?? frameOf(g.plane, planeFrames);
  let rotation: number;
  let center: [number, number];
  if (g.placeBeside && g.meshWith && from) {
    ({ center, rotation } = placeRackBeside(doc, g, from, frame, spec, scope, planeFrames, seen));
  } else {
    rotation = (num("direction", p.rotation, scope) * Math.PI) / 180;
    center = located ? located.center : [num("center X", p.centerX, scope), num("center Y", p.centerY, scope)];
  }
  const outline = rackOutline(spec, { height, endMargin, rotation });
  const [cx, cy] = center;
  if (cx !== 0 || cy !== 0) outline.outline = outline.outline.map(([x, y]) => [x + cx, y + cy] as [number, number]);
  return { outline, spec, frame, thickness, from, center, rotation };
}

/** Where a rack placed beside its pinion goes on its own plane, and the
 *  direction it runs (see bakeRack). */
function placeRackBeside(
  doc: Document,
  g: Pick<GearFeature, "id" | "params">,
  partner: GearFeature,
  frame: PlaneFrameData,
  spec: GearToothSpec,
  scope: Scope,
  planeFrames: Map<string, PlaneFrameData> | undefined,
  seen: ReadonlySet<string>,
): { center: [number, number]; rotation: number } {
  if (seen.has(partner.id)) throw new Error("gear: placed gears form a loop — one of them needs its own place");
  const moved = doc.features.find(
    (f) => f.type === "transform" && f.targetId === partner.id && !f.copy && !f.suppressed,
  );
  if (moved)
    throw new Error(
      `gear: ${moved.name} moves ${partner.name} after it's made, so the rack can't be placed beside it — give ${partner.name} a location in its dialog instead, or untick Place beside`,
    );
  const pb = bakeGear(doc, partner, scope, planeFrames, new Set([...seen, g.id]));
  const pf = pb.frame;
  const n = unit(cross(frame.uAxis, frame.vAxis));
  const np = unit(cross(pf.uAxis, pf.vAxis));
  if (Math.abs(dot(n, np)) < 0.999)
    throw new Error(`gear: to place it beside ${partner.name}, put it on a plane parallel to ${partner.name}'s`);
  const m = spec.module;
  const r = (m * pb.spec.teeth) / 2;
  const toWorld = (u: number, v: number): Vec3 => add(add(frame.origin, scale(frame.uAxis, u)), scale(frame.vAxis, v));
  const toUV = (w: Vec3): [number, number] => [dot(w, frame.uAxis), dot(w, frame.vAxis)];
  const pc = add(add(pf.origin, scale(pf.uAxis, pb.center[0])), scale(pf.vAxis, pb.center[1]));
  const [pu, pv] = toUV(sub(pc, frame.origin));
  // Out from the pinion along the angle, to its pitch circle (plus its shift).
  const a = (num("place angle", g.params.placeAngle ?? "0", scope) * Math.PI) / 180;
  const dist = r + pb.spec.profileShift * m;
  let center: [number, number] = [pu + dist * Math.cos(a), pv + dist * Math.sin(a)];
  // Running 90° counter-clockwise of the way out, its teeth face the pinion.
  const rotation = a + Math.PI / 2;
  const run: [number, number] = [Math.cos(rotation), Math.sin(rotation)];
  const runW = unit(add(scale(frame.uAxis, run[0]), scale(frame.vAxis, run[1])));
  const pitch = Math.PI * m;
  const half = (spec.teeth * pitch) / 2;
  const rackGeom = (c: [number, number]): GearGeom => ({
    teeth: spec.teeth,
    module: m,
    internal: false,
    center: toWorld(c[0] - half * run[0], c[1] - half * run[1]),
    axis: n,
    tooth: unit(add(scale(frame.uAxis, -run[1]), scale(frame.vAxis, run[0]))),
    rack: { run: runW },
  });
  const pinionGeom: GearGeom = {
    teeth: pb.spec.teeth,
    module: m,
    internal: false,
    profileShift: pb.spec.profileShift,
    center: pc,
    axis: np,
    tooth: unit(add(scale(pf.uAxis, Math.cos(pb.rotation)), scale(pf.vAxis, Math.sin(pb.rotation)))),
  };
  const mesh = rackMesh(pinionGeom, rackGeom(center));
  if (typeof mesh === "string") throw new Error(`gear: ${mesh}`);
  // Slide it back by the misfit (least way), then the asked-for pitches.
  const slide = num("slide", g.params.slide ?? "0", scope);
  const [tu, tv] = toUV(mesh.t);
  center = [
    center[0] - mesh.misfit * tu + slide * pitch * run[0],
    center[1] - mesh.misfit * tv + slide * pitch * run[1],
  ];
  return { center, rotation };
}

/** The gear as the kernel builds it: a "new" extrude of its outline. */
export function resolveGear(
  doc: Document,
  g: GearFeature,
  scope: Scope,
  planeFrames: Map<string, PlaneFrameData>,
): ResolvedFeature {
  const baked = bakeGear(doc, g, scope, planeFrames);
  return {
    id: g.id,
    type: "extrude",
    profiles: [
      {
        kind: "sketchRegion",
        outline: baked.outline.outline,
        holes: baked.outline.holes,
        edgeNames: baked.outline.edgeNames,
        frame: baked.frame,
      },
    ],
    distance: baked.thickness,
    flip: g.flip,
    extent: g.extent,
    mode: "new",
  };
}

/** The params a meshed gear takes from its partner, so it keeps none of its
 *  own: a stored module would be a stale default that only comes into play,
 *  wrongly, once the link is gone. */
export const MESH_SHARED_PARAMS = ["module", "pitchDiameter", "pressureAngle"] as const;

/** A meshed gear's params without the ones its partner supplies. */
export function withoutSharedParams(params: GearParams): GearParams {
  const out = { ...params };
  for (const k of MESH_SHARED_PARAMS) delete out[k];
  return out;
}

/** A number as a param expression: short, but exact to the micron. */
const asParam = (v: number) => String(Number(v.toFixed(6)));

/** What a meshed gear becomes when its link to its partner ends — the user
 *  picks Module or Pitch diameter in its dialog, or the partner is deleted:
 *  the same gear, standing on its own. Its module, pitch diameter and
 *  pressure angle become its own values; placed beside the partner, its
 *  centre becomes a fixed spot and its tooth phase its own rotation, so
 *  nothing about it moves. Returns null for a gear that isn't meshed, or one
 *  that no longer resolves (nothing to keep — it keeps what it has). */
export function unlinkGear(
  doc: Document,
  g: GearFeature,
  scope: Scope,
  planeFrames: Map<string, PlaneFrameData> | undefined,
  sizeBy: GearFeature["sizeBy"] = g.sizeBy,
): Pick<GearFeature, "sizeBy" | "meshWith" | "placeBeside" | "center" | "params"> | null {
  if (!g.meshWith) return null;
  let baked: BakedGear;
  try {
    baked = bakeGear(doc, g, scope, planeFrames);
  } catch {
    return null;
  }
  const { module, pressureAngle, teeth } = baked.spec;
  const params: GearParams = {
    ...g.params,
    module: asParam(module),
    pitchDiameter: asParam(module * teeth),
    pressureAngle: asParam(pressureAngle),
  };
  let center = g.center;
  if (g.placeBeside) {
    // The plane its centre was worked out on: a picked sketch point's sketch,
    // a picked spot's plane, or its own.
    const ref = g.center;
    const sketch =
      ref && !("uv" in ref) ? doc.features.find((f) => f.id === ref.sketchId && f.type === "sketch") : undefined;
    const plane = sketch?.type === "sketch" ? sketch.plane : ref && "uv" in ref ? (ref.plane ?? g.plane) : g.plane;
    center = { uv: [Number(baked.center[0].toFixed(6)), Number(baked.center[1].toFixed(6))], plane };
    params.rotation = asParam((baked.rotation * 180) / Math.PI);
  }
  return { sizeBy, meshWith: undefined, placeBeside: undefined, center, params };
}

/** What the dialog shows under the fields: the circles (a rack's lengths),
 *  and the notes worth a line — undercut, and how far apart a meshing pair's
 *  centres go. */
export interface GearReadout {
  module: number;
  /** A gear's circles; null for a rack. */
  dims: GearDims | null;
  /** A rack's sizes; null for a gear. */
  rack: RackDims | null;
  notes: string[];
  /** With a partner: how far apart the two centres go to mesh (mm) — for a
   *  rack, from the pinion's centre to its pitch line. */
  centerDistance?: number;
  /** For the dialog's diagram: the outline (and bore) as built, recentred on
   *  the gear's own centre (a rack's: the middle of its pitch line, turned to
   *  run along +x), plus the tooth numbers it annotates. */
  shape: { outline: [number, number][]; holes: [number, number][][] };
  spec: GearToothSpec;
  internal: boolean;
}

export function gearReadout(
  doc: Document,
  g: Pick<
    GearFeature,
    "id" | "gearType" | "plane" | "center" | "sizeBy" | "meshWith" | "placeBeside" | "bore" | "params"
  >,
  scope: Scope,
  planeFrames?: Map<string, PlaneFrameData>,
): GearReadout {
  const baked = bakeGear(doc, g, scope, planeFrames);
  const notes: string[] = [];
  const { spec } = baked;
  const [cx, cy] = baked.center;
  if ("rack" in baked.outline) {
    // Back to the rack's own axes: pitch line along +x through the origin.
    const c = Math.cos(-baked.rotation);
    const sn = Math.sin(-baked.rotation);
    const local = (pts: [number, number][]) =>
      pts.map(([x, y]) => [(x - cx) * c - (y - cy) * sn, (x - cx) * sn + (y - cy) * c] as [number, number]);
    let pinionShift = 0;
    let pinionTeeth: number | null = null;
    if (baked.from) {
      try {
        pinionTeeth = evaluateExpression(baked.from.params.teeth, scope);
        pinionShift = evaluateExpression(baked.from.params.profileShift, scope);
      } catch {
        /* the partner's own error shows on its row */
      }
    }
    // A pinion with too few teeth for its shift meets the rack's tooth tips
    // below its base circle (a real one would be undercut there): say how
    // much shift clears it.
    if (pinionTeeth !== null && pinionTeeth < minTeethWithoutUndercut(spec.pressureAngle, pinionShift) - 1e-9) {
      const s2 = Math.sin((spec.pressureAngle * Math.PI) / 180) ** 2;
      const need = Math.ceil((1 - (pinionTeeth * s2) / 2) * 100) / 100;
      notes.push(
        `${baked.from!.name}'s ${pinionTeeth} teeth clash with the rack's tooth tips. Give ${baked.from!.name} a profile shift of at least ${need} (in its Advanced).`,
      );
    }
    return {
      module: spec.module,
      dims: null,
      rack: baked.outline.rack,
      shape: { outline: local(baked.outline.outline), holes: [] },
      spec,
      internal: false,
      notes,
      ...(pinionTeeth !== null ? { centerDistance: (spec.module * pinionTeeth) / 2 + pinionShift * spec.module } : {}),
    };
  }
  if (baked.outline.undercut) {
    const min = Math.ceil(minTeethWithoutUndercut(spec.pressureAngle, spec.profileShift));
    notes.push(
      `${spec.teeth} teeth undercut at this profile shift (${min}+ don't). Raise the profile shift in Advanced to strengthen the roots.`,
    );
  }
  let centerDist: number | undefined;
  if (baked.from) {
    let partnerTeeth: number | null = null;
    try {
      partnerTeeth = evaluateExpression(baked.from.params.teeth, scope);
    } catch {
      /* the partner's own error shows on its row */
    }
    if (partnerTeeth !== null) {
      const oneInternal = (g.gearType === "internal") !== (baked.from.gearType === "internal");
      centerDist = centerDistance(spec.module, spec.teeth, partnerTeeth, oneInternal);
    }
  }
  const recentre = (pts: [number, number][]) => pts.map(([x, y]) => [x - cx, y - cy] as [number, number]);
  return {
    module: spec.module,
    dims: baked.outline.dims,
    rack: null,
    shape: { outline: recentre(baked.outline.outline), holes: baked.outline.holes.map(recentre) },
    spec,
    internal: g.gearType === "internal",
    notes,
    ...(centerDist !== undefined ? { centerDistance: centerDist } : {}),
  };
}
