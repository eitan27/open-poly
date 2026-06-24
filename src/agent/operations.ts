// Vendor-neutral command + read API for the agent layer (Phase 9, layer 1).
//
// This module owns the typed `Operation` union an agent can apply, the read
// queries it can run, the result shapes it gets back, and the **zod schemas**
// that validate everything. It knows nothing about MCP, WebSockets, or any LLM —
// the MCP server (Phase 9 L2) reuses these same schemas to validate tool args,
// so this file is the single source of truth for the API surface.
//
// Conventions (state these in every tool description): **millimetres**, world is
// **Z-up** (the XY / "Top" plane is the ground). Numeric inputs that map onto a
// document *expression* (distances, offsets, transforms, param values) accept a
// number or an expression string like "width/2" — both are stored as strings.
import { z } from "zod";
import { genId } from "../document/document";
import type { SketchEntity, Vec2 } from "../document/types";
import { rectangleCorners, rectangleFromCenter, regularPolygon } from "../document/sketchTools";
import type { BooleanOp, PrimitiveKind } from "../kernel/types";

// --- Small shared schemas -------------------------------------------------

const vec2 = z.tuple([z.number(), z.number()]);
const vec3 = z.tuple([z.number(), z.number(), z.number()]);

/** A value that becomes a document expression string. Accept a number (the
 *  common case) or a string expression ("width/2"); store as a string. */
const expr = z.union([z.number(), z.string()]).transform((v) => String(v));

// --- Reference specs (how the agent names geometry) -----------------------

/** Where a sketch or reference plane is placed. Datums are the three base
 *  planes; `planeId` is a reference-plane feature id; a body face is named by
 *  the body's feature id + the face's **persistent name** (from the summary). */
export const planeRefSchema = z.union([
  z.object({ datum: z.enum(["top", "front", "right"]) }),
  z.object({ planeId: z.string() }),
  z.object({ bodyId: z.string(), faceName: z.string() }),
]);
export type PlaneRefSpec = z.infer<typeof planeRefSchema>;

/** What an extrude pulls: a closed region of a sketch (omit `regionId` to use
 *  the sketch's sole region) or a planar body face by persistent name. */
export const profileSchema = z.union([
  z.object({ sketchId: z.string(), regionId: z.string().optional() }),
  z.object({ bodyId: z.string(), faceName: z.string() }),
]);
export type ProfileSpec = z.infer<typeof profileSchema>;

/** Sugar shapes (+ raw primitives) the agent places in a sketch's (u, v) plane
 *  coords, so it doesn't hand-place every line. Expanded to SketchEntity[] by
 *  `expandEntities`. */
// `construction: true` marks an entity as reference geometry — used for
// dimensions/snapping (and as a revolve **axis** line) but ignored when
// detecting profile regions and never extruded.
const construction = z.boolean().optional();
export const entitySchema = z.discriminatedUnion("shape", [
  z.object({ shape: z.literal("rect"), center: vec2.optional(), corner: vec2.optional(), w: z.number().positive(), h: z.number().positive(), construction }),
  z.object({ shape: z.literal("circle"), c: vec2, r: z.number().positive(), construction }),
  z.object({ shape: z.literal("polygon"), c: vec2, r: z.number().positive(), n: z.number().int().min(3), construction }),
  z.object({ shape: z.literal("line"), a: vec2, b: vec2, construction }),
  z.object({ shape: z.literal("arc"), c: vec2, r: z.number().positive(), start: z.number(), end: z.number(), construction }),
  // A smooth through-point spline (≥2 points). An open curve — used as a sweep
  // path, not a region boundary.
  z.object({ shape: z.literal("spline"), points: z.array(vec2).min(2), construction }),
  z.object({ shape: z.literal("point"), p: vec2, construction }),
]);
export type EntitySpec = z.infer<typeof entitySchema>;

// --- Selection refs (for the `select` op) ---------------------------------

const selectionSchema = z.union([
  z.object({ kind: z.literal("feature"), id: z.string() }),
  z.object({ kind: z.literal("face"), featureId: z.string(), faceId: z.number() }),
  z.object({ kind: z.literal("edge"), featureId: z.string(), edgeId: z.number() }),
  z.object({ kind: z.literal("vertex"), featureId: z.string(), point: vec3 }),
  z.object({ kind: z.literal("sketchEntity"), sketchId: z.string(), entityId: z.string() }),
  z.object({ kind: z.literal("sketchPoint"), sketchId: z.string(), point: vec2 }),
  z.object({ kind: z.literal("sketchFace"), sketchId: z.string(), regionId: z.string() }),
]);

// --- The Operation union --------------------------------------------------
// Discriminated on `op`. Each variant maps onto one pure document fn (see
// commands.ts). Sub-variants reuse the `kind` field for consistency.

const primitiveKind = z.enum(["box", "cylinder", "sphere"]);
const booleanKind = z.enum(["union", "subtract", "intersect"]);

export const operationSchema = z.discriminatedUnion("op", [
  z.object({
    op: z.literal("addPrimitive"),
    kind: primitiveKind,
    /** Override any of the kind's params (width/radius/x/…) with expressions. */
    params: z.record(z.string(), expr).optional(),
    name: z.string().optional(),
  }),
  z.object({
    op: z.literal("addSketch"),
    plane: planeRefSchema,
    entities: z.array(entitySchema),
    name: z.string().optional(),
  }),
  z.object({
    op: z.literal("addExtrude"),
    profile: profileSchema,
    distance: expr,
    flip: z.boolean().optional(),
    /** How far it reaches: blind = `distance` one way; symmetric = `distance`
     *  split evenly both ways (flip ignored); throughAll = clear through the
     *  target (**remove/cut only** — needs a targetId); upToFace = stop at the
     *  plane of `upTo` (distance/flip ignored — the face sets length+direction).
     *  Defaults to blind. */
    extent: z.enum(["blind", "symmetric", "throughAll", "upToFace"]).optional(),
    /** Required when extent is "upToFace": the planar target face to reach, by
     *  body (feature id) + persistent face name (from get_scene_summary). The
     *  face must not be parallel to the extrude direction. */
    upTo: z.object({ bodyId: z.string(), faceName: z.string() }).optional(),
    mode: z.enum(["new", "add", "remove"]).optional(),
    /** For add/remove: the body (feature id) to fuse into / cut from. */
    targetId: z.string().optional(),
    name: z.string().optional(),
  }),
  z.object({
    op: z.literal("addRevolve"),
    /** The closed sketch region to revolve (omit regionId for the sole region). */
    profile: z.object({ sketchId: z.string(), regionId: z.string().optional() }),
    /** The rotation axis: a **line** entity in the *same* sketch (its two
     *  endpoints define the axis). The profile must not cross it. Make the axis a
     *  `construction` line so it isn't part of the region. */
    axis: z.object({ sketchId: z.string(), entityId: z.string() }),
    /** Revolve angle in degrees (number or expression). Defaults to 360. */
    angle: expr.optional(),
    name: z.string().optional(),
  }),
  z.object({
    op: z.literal("addMirror"),
    /** The body (feature id) to mirror; the original is kept. */
    targetId: z.string(),
    /** The mirror plane (datum, reference plane, or a body face by name). */
    plane: planeRefSchema,
    name: z.string().optional(),
  }),
  z.object({
    op: z.literal("addSweep"),
    /** The closed region (cross-section) to sweep (omit regionId for the sole region). */
    profile: z.object({ sketchId: z.string(), regionId: z.string().optional() }),
    /** The path/spine: a single open entity (line, arc, or **spline**) in a
     *  sketch — get its entityId from get_scene_summary's sketch entities. May be
     *  in a different sketch from the profile; the profile is placed perpendicular
     *  to the path start. */
    path: z.object({ sketchId: z.string(), entityId: z.string() }),
    name: z.string().optional(),
  }),
  z.object({
    op: z.literal("addLoft"),
    /** Ordered closed sections to loft through (≥2), each a sketch region (omit
     *  regionId for a sketch's sole region). Put them on different planes. */
    profiles: z.array(z.object({ sketchId: z.string(), regionId: z.string().optional() })).min(2),
    name: z.string().optional(),
  }),
  z.object({
    op: z.literal("addPlane"),
    /** Placement method (default "offset"). */
    method: z.enum(["offset", "midplane", "angle", "through"]).optional(),
    /** offset/angle base, or the FIRST reference of a midplane. Omit for "through". */
    base: planeRefSchema.optional(),
    /** offset: signed distance along the base's normal. */
    offset: expr.optional(),
    /** midplane: the second reference (halfway between `base` and `refB`). */
    refB: planeRefSchema.optional(),
    /** angle: hinge on the base's `u` or `v` axis (default `u`), tilted by `angle` degrees. */
    angleAxis: z.enum(["u", "v"]).optional(),
    angle: expr.optional(),
    /** through: exactly 3 world points the plane passes through. */
    points: z.array(vec3).optional(),
    name: z.string().optional(),
  }),
  z.object({
    op: z.literal("transform"),
    targetId: z.string(),
    tx: expr.optional(),
    ty: expr.optional(),
    tz: expr.optional(),
    angle: expr.optional(),
    axis: z.enum(["x", "y", "z"]).optional(),
    /** Keep the original and emit a moved copy as a new body. */
    copy: z.boolean().optional(),
  }),
  z.object({
    op: z.literal("boolean"),
    kind: booleanKind,
    operands: z.array(z.string()).min(2),
  }),
  z.object({
    op: z.literal("dressUp"),
    kind: z.enum(["chamfer", "fillet"]),
    targetId: z.string(),
    /** Persistent edge names from the scene summary. */
    edges: z.array(z.string()).min(1),
    size: expr.optional(),
  }),
  z.object({
    op: z.literal("setParam"),
    featureId: z.string(),
    name: z.string(),
    value: expr,
  }),
  z.object({
    // Create-or-update a named variable by name (agent-friendly: variables are
    // keyed by name everywhere expressions reference them). The name must be
    // **letters only** (no digits, spaces, underscores, or other symbols), not a
    // reserved math name (pi, sin, cos, …), and unique — e.g. `wallThickness`
    // or `holeDia`, not `wall_thickness`, `r1`, or `hole2`. An invalid name is
    // rejected with an error.
    op: z.literal("setVariable"),
    name: z.string(),
    expression: expr,
  }),
  z.object({
    op: z.literal("setAppearance"),
    featureId: z.string(),
    color: z.number().int().optional(),
    opacity: z.number().min(0).max(1).optional(),
    hidden: z.boolean().optional(),
  }),
  z.object({ op: z.literal("rename"), featureId: z.string(), name: z.string() }),
  z.object({ op: z.literal("delete"), featureId: z.string() }),
  z.object({ op: z.literal("setRollback"), index: z.number().int().min(0) }),
  z.object({ op: z.literal("select"), refs: z.array(selectionSchema) }),
  z.object({ op: z.literal("importStep"), source: z.string(), name: z.string().optional() }),
]);

export type Operation = z.infer<typeof operationSchema>;

/** Every `op` name — advertised to the hub as the tab's capabilities. */
export const OPERATION_NAMES = operationSchema.options.map((o) => o.shape.op.value);

// --- Read queries ---------------------------------------------------------

export const readQuerySchema = z.discriminatedUnion("read", [
  z.object({ read: z.literal("document") }),
  z.object({ read: z.literal("sceneSummary") }),
  z.object({ read: z.literal("selection") }),
  z.object({
    read: z.literal("screenshot"),
    /** Snap the camera to a standard view before capturing. */
    view: z.enum(["front", "back", "left", "right", "top", "bottom", "iso"]).optional(),
  }),
]);
export type ReadQuery = z.infer<typeof readQuerySchema>;

/** Every `read` name — advertised to the hub as the tab's capabilities. */
export const READ_NAMES = readQuerySchema.options.map((o) => o.shape.read.value);

// --- Result shapes --------------------------------------------------------

export type ErrorKind = "not_found" | "invalid_op" | "kernel_error";

/** The result of applying one Operation. `createdId` is the new feature/variable
 *  id (so the agent can chain). `featureErrors` carries per-feature resolve
 *  errors detected synchronously after the edit (kernel/regen errors arrive once
 *  L3 wires the regen-await loop). */
export interface OpResult {
  ok: boolean;
  createdId?: string;
  error?: string;
  errorKind?: ErrorKind;
  featureErrors?: Record<string, string>;
}

/** Compact, LLM-first digest of the scene — the agent's primary planning input
 *  (see commands.ts#getSceneSummary). */
export interface SceneSummary {
  bodies: {
    id: string;
    name: string;
    kind: string;
    bbox?: { min: [number, number, number]; max: [number, number, number] };
    color?: number;
    hidden?: boolean;
    faces: string[];
    edges: string[];
  }[];
  sketches: {
    id: string;
    name: string;
    plane: string;
    entityCount: number;
    /** Entities by id + type (+ construction flag) so the agent can reference a
     *  specific one — e.g. a `line` entity as a revolve axis. */
    entities: { id: string; type: string; construction?: boolean }[];
    regions: { id: string; area: number }[];
  }[];
  planes: { id: string; name: string }[];
  variables: { name: string; expression: string; value?: number }[];
  rollbackIndex: number;
  featureCount: number;
  selection: unknown[];
  errors: Record<string, string>;
}

// --- Entity expansion -----------------------------------------------------

/** Expand the agent's sugar shapes into concrete SketchEntity objects (with
 *  fresh ids), in the sketch's (u, v) plane coords. Pure — unit-tested. */
export function expandEntities(specs: EntitySpec[]): SketchEntity[] {
  const out: SketchEntity[] = [];
  // Stamp the construction flag (only when true, to keep entities clean).
  const mark = <T extends SketchEntity>(e: T, c?: boolean): T => (c ? { ...e, construction: true } : e);
  const lineLoop = (pts: Vec2[], c?: boolean) => {
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i];
      const b = pts[(i + 1) % pts.length];
      out.push(mark({ type: "line", id: genId(), a, b }, c));
    }
  };
  for (const s of specs) {
    switch (s.shape) {
      case "rect": {
        const pts = s.center
          ? rectangleFromCenter(s.center, [s.center[0] + s.w / 2, s.center[1] + s.h / 2])
          : rectangleCorners(s.corner ?? [0, 0], [(s.corner?.[0] ?? 0) + s.w, (s.corner?.[1] ?? 0) + s.h]);
        lineLoop(pts, s.construction);
        break;
      }
      case "circle":
        out.push(mark({ type: "circle", id: genId(), c: s.c, r: s.r }, s.construction));
        break;
      case "polygon":
        lineLoop(regularPolygon(s.c, [s.c[0] + s.r, s.c[1]], s.n), s.construction);
        break;
      case "line":
        out.push(mark({ type: "line", id: genId(), a: s.a, b: s.b }, s.construction));
        break;
      case "arc":
        out.push(mark({ type: "arc", id: genId(), c: s.c, r: s.r, start: s.start, end: s.end }, s.construction));
        break;
      case "spline":
        out.push(mark({ type: "spline", id: genId(), points: s.points }, s.construction));
        break;
      case "point":
        out.push(mark({ type: "point", id: genId(), p: s.p }, s.construction));
        break;
    }
  }
  return out;
}

// Re-exports for downstream consumers that want the kernel-level unions.
export type { BooleanOp, PrimitiveKind };
