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
import type { Document, Feature, GearFeature, GearParams, GearType } from "./types";
import {
  centerDistance,
  gearOutline,
  minTeethWithoutUndercut,
  type GearDims,
  type GearOutline,
  type GearToothSpec,
} from "../geom/gearProfile";
import type { ResolvedFeature } from "../kernel/types";
import { add, alignTurn, cross, dot, scale, sub, unit, type GearGeom, type Vec3 } from "../geom/gearAlign";

export const GEAR_TYPE_LABELS: Record<GearType, string> = {
  spur: "Spur gear",
  internal: "Internal (ring) gear",
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
};

export type GearSettings = Pick<
  GearFeature,
  "gearType" | "sizeBy" | "meshWith" | "placeBeside" | "bore" | "extent" | "flip"
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
 *  loop has no gear to take the size from. */
export function meshCandidates(doc: Document, selfId?: string): GearFeature[] {
  return doc.features.filter(
    (f): f is GearFeature => f.type === "gear" && f.id !== selfId && !(selfId && leadsTo(doc, f, selfId)),
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

const num = (label: string, expr: string, scope: Scope): number => {
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
  g: Pick<GearFeature, "id" | "sizeBy" | "meshWith" | "params">,
  scope: Scope,
): { module: number; pressureAngle: number; teeth: number; from?: GearFeature } {
  const teeth = num("teeth", g.params.teeth, scope);
  const seen = new Set<string>([g.id]);
  let src: Pick<GearFeature, "sizeBy" | "meshWith" | "params"> = g;
  let from: GearFeature | undefined;
  while (src.meshWith) {
    const partner = doc.features.find((f) => f.id === src.meshWith);
    if (partner?.type !== "gear") throw new Error("gear: the gear it meshes with no longer exists — pick another");
    if (seen.has(partner.id)) throw new Error("gear: meshing gears form a loop — one of them needs its own module");
    seen.add(partner.id);
    from ??= partner;
    src = partner;
  }
  const ownTeeth = src === g ? teeth : num("teeth", src.params.teeth, scope);
  const module =
    src.sizeBy === "pitchDiameter"
      ? num("pitch diameter", src.params.pitchDiameter, scope) / ownTeeth
      : num("module", src.params.module, scope);
  const pressureAngle = num("pressure angle", src.params.pressureAngle, scope);
  return { module, pressureAngle, teeth, from };
}

export interface BakedGear {
  outline: GearOutline;
  spec: GearToothSpec;
  frame: PlaneFrameData;
  thickness: number;
  /** The partner the size came from, if meshed. */
  from?: GearFeature;
  /** Where the gear's centre is on its plane (u, v), and how far tooth 0 (a
   *  ring's space 0) is turned from +u, radians: what meshing math needs. */
  center: [number, number];
  rotation: number;
}

/** Evaluate every setting and build the outline (in the plane's u, v). Throws
 *  with a readable message — the same path the dialog's live readout uses. */
export function bakeGear(
  doc: Document,
  g: Pick<GearFeature, "id" | "gearType" | "plane" | "sizeBy" | "meshWith" | "placeBeside" | "bore" | "params">,
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
  const frame = frameOf(g.plane, planeFrames);
  let rotation = (num("rotation", p.rotation, scope) * Math.PI) / 180;
  let cx: number;
  let cy: number;
  if (g.placeBeside && g.meshWith && from) {
    const at = placeBesidePartner(doc, g, from, frame, spec, internal, scope, planeFrames, seen);
    [cx, cy] = at.center;
    rotation += at.rotation; // Rotation° is added to the meshing angle
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
      `gear: ${moved.name} moves ${partner.name} after it's made, so it can't be placed beside it — place ${partner.name} with its Centre X/Y instead, or untick Place beside`,
    );
  const pb = bakeGear(doc, partner, scope, planeFrames, new Set([...seen, g.id]));
  const pf = pb.frame;
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

/** What the dialog shows under the fields: the circles, and the notes worth a
 *  line — undercut, and how far apart a meshing pair's centres go. */
export interface GearReadout {
  module: number;
  dims: GearDims;
  notes: string[];
}

export function gearReadout(
  doc: Document,
  g: Pick<GearFeature, "id" | "gearType" | "plane" | "sizeBy" | "meshWith" | "bore" | "params">,
  scope: Scope,
  planeFrames?: Map<string, PlaneFrameData>,
): GearReadout {
  const baked = bakeGear(doc, g, scope, planeFrames);
  const notes: string[] = [];
  const { spec } = baked;
  if (baked.outline.undercut) {
    const min = Math.ceil(minTeethWithoutUndercut(spec.pressureAngle, spec.profileShift));
    notes.push(
      `${spec.teeth} teeth undercut at this profile shift (${min}+ don't). Raise the profile shift in Advanced to strengthen the roots.`,
    );
  }
  if (baked.from) {
    let partnerTeeth: number | null = null;
    try {
      partnerTeeth = evaluateExpression(baked.from.params.teeth, scope);
    } catch {
      /* the partner's own error shows on its row */
    }
    if (partnerTeeth !== null) {
      const oneInternal = (g.gearType === "internal") !== (baked.from.gearType === "internal");
      const cd = centerDistance(spec.module, spec.teeth, partnerTeeth, oneInternal);
      notes.push(`Centre distance to ${baked.from.name}: ${fmt(cd)} mm`);
    }
  }
  return { module: spec.module, dims: baked.outline.dims, notes };
}

const fmt = (n: number) => String(Math.round(n * 1000) / 1000);
