// Vendor-neutral command + read API for the agent layer.
//
// This module owns the typed `Operation` union an agent can apply, the read
// queries it can run, the result shapes it gets back, and the **zod schemas**
// that validate everything. It knows nothing about MCP, WebSockets, or any LLM —
// the MCP server reuses these same schemas to validate tool args,
// so this file is the single source of truth for the API surface.
//
// Conventions (state these in every tool description): **millimetres**, world is
// **Z-up** (the XY / "Top" plane is the ground). Numeric inputs that map onto a
// document *expression* (distances, offsets, transforms, param values) accept a
// number or an expression string like "width/2" — both are stored as strings.
import { z } from "zod";
import { genId } from "../document/document";
import { evaluateExpression, type Scope } from "../document/expression";
import type { EntityExprs, SketchEntity, Vec2 } from "../document/types";
import type { BooleanOp, PrimitiveKind } from "../kernel/types";

// --- Small shared schemas -------------------------------------------------

const vec2 = z.tuple([z.number(), z.number()]);
const vec3 = z.tuple([z.number(), z.number(), z.number()]);

/** A value that becomes a document expression string. Accept a number (the
 *  common case) or a string expression ("width/2"); store as a string. */
const expr = z.union([z.number(), z.string()]).transform((v) => String(v));

/** A sketch coordinate/scalar input: a number literal, or an expression string
 *  ("innerRad + clearance") that tracks the document's variables. Unlike `expr`
 *  it is NOT coerced to a string — expandEntities needs to tell a literal from
 *  an expression to build the entity's `exprs` overlay. */
const sketchNum = z.union([z.number(), z.string()]);
const sketchVec2 = z.tuple([sketchNum, sketchNum]);

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
 *  the sketch's sole region), a planar body face by persistent name, or a `text`
 *  entity in a sketch (the kernel bakes its glyph wires — counters/holes and
 *  all — at build time). The text form is tried first (it requires `textId`), so
 *  a plain `{sketchId}` still resolves to a region. */
export const profileSchema = z.union([
  z.object({ sketchId: z.string(), textId: z.string() }),
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
// Sketch coordinates, radii and angles accept a number OR a variable expression
// ("innerRad + clearance"); the sketch reflows when the variable changes. Angles
// (arc start/end, text rotation) are in DEGREES. `w`/`h`/`r`/`height` must stay
// positive, but an expression can't be range-checked up front, so a string is
// allowed through and validated at evaluation.
const construction = z.boolean().optional();
const posNum = z.union([z.number().positive(), z.string()]);
export const entitySchema = z.discriminatedUnion("shape", [
  z.object({
    shape: z.literal("rect"),
    center: sketchVec2.optional(),
    corner: sketchVec2.optional(),
    w: posNum,
    h: posNum,
    construction,
  }),
  z.object({ shape: z.literal("circle"), c: sketchVec2, r: posNum, construction }),
  z.object({ shape: z.literal("polygon"), c: sketchVec2, r: posNum, n: z.number().int().min(3), construction }),
  z.object({ shape: z.literal("line"), a: sketchVec2, b: sketchVec2, construction }),
  // `start`/`end` are in DEGREES (converted to the internal radians on expand).
  z.object({ shape: z.literal("arc"), c: sketchVec2, r: posNum, start: sketchNum, end: sketchNum, construction }),
  // A smooth through-point spline (≥2 points). An open curve — used as a sweep
  // path, not a region boundary.
  z.object({ shape: z.literal("spline"), points: z.array(sketchVec2).min(2), construction }),
  z.object({ shape: z.literal("point"), p: sketchVec2, construction }),
  // A run of text placed at baseline-left anchor `p`, `height` ems tall (sketch
  // units), optionally rotated `rotation` DEGREES. Extrude it with add_extrude
  // using a `{sketchId, textId}` profile — the kernel bakes the glyphs.
  z.object({
    shape: z.literal("text"),
    p: sketchVec2,
    value: z.string().min(1),
    height: posNum,
    rotation: sketchNum.optional(),
    construction,
  }),
]);
export type EntitySpec = z.infer<typeof entitySchema>;

// --- Sketch constraints & dimensions (planegcs) ---------------------------

/** A specific point in a sketch a constraint can pin: a named vertex of an
 *  entity (line/arc "a"/"b" end; circle/arc/point "c" centre), or the sketch
 *  origin. Entity ids come from get_scene_summary's sketch entities. */
const pointRefSpec = z.union([
  z.object({ entityId: z.string(), at: z.enum(["a", "b", "c"]) }),
  z.object({ origin: z.literal(true) }),
]);

/** One side of a distance dimension — mirrors what you'd pick in the UI: an
 *  exact `point`, the perpendicular distance to a `line`, or the nearest `rim`
 *  of a circle/arc (its centre distance ∓ radius). */
const distanceRefSpec = z.union([
  z.object({ on: z.literal("point"), point: pointRefSpec }),
  z.object({ on: z.literal("line"), entity: z.string() }),
  z.object({ on: z.literal("rim"), entity: z.string() }),
]);

/** A geometric (non-dimensional) constraint over sketch entities, by id. Pairs
 *  (`a`/`b`) must be compatible: parallel/perpendicular/angle need two lines;
 *  equal needs two lines OR two circles/arcs; tangent a line+circle/arc or two
 *  circles/arcs. */
const constraintSpec = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("horizontal"), entity: z.string() }),
  z.object({ kind: z.literal("vertical"), entity: z.string() }),
  z.object({ kind: z.literal("parallel"), a: z.string(), b: z.string() }),
  z.object({ kind: z.literal("perpendicular"), a: z.string(), b: z.string() }),
  z.object({ kind: z.literal("equal"), a: z.string(), b: z.string() }),
  z.object({ kind: z.literal("tangent"), a: z.string(), b: z.string() }),
  z.object({ kind: z.literal("coincident"), a: pointRefSpec, b: pointRefSpec }),
  z.object({ kind: z.literal("pointOnLine"), point: pointRefSpec, line: z.string() }),
  z.object({ kind: z.literal("midpoint"), point: pointRefSpec, target: z.string() }),
]);
export type ConstraintSpec = z.infer<typeof constraintSpec>;

/** A dimensional constraint. `value` accepts a number OR a variable expression
 *  ("width/2") — evaluated against the document's variables and, when the text
 *  names one, kept so the dimension follows that variable (like the UI; see
 *  document/dimensionExpr.ts). Lengths/radii/diameters/distances must be > 0;
 *  angles are in DEGREES, 0–180. A circle takes `radius` OR `diameter` — the
 *  same size stated either way. */
const dimensionSpec = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("length"), entity: z.string(), value: sketchNum }),
  z.object({ kind: z.literal("radius"), entity: z.string(), value: sketchNum }),
  z.object({ kind: z.literal("diameter"), entity: z.string(), value: sketchNum }),
  z.object({ kind: z.literal("angle"), a: z.string(), b: z.string(), value: sketchNum }),
  z.object({ kind: z.literal("distance"), a: distanceRefSpec, b: distanceRefSpec, value: sketchNum }),
]);
export type DimensionSpec = z.infer<typeof dimensionSpec>;

// --- Selection refs (for the `select` op) ---------------------------------

/** One side of an assembly mate: a face, an edge, or a vertex (an end of a
 *  named edge) of an instance's part, by the names get_scene_summary lists
 *  under that part. Exactly one of face/edge/vertex. */
const connectorSpecSchema = z.object({
  instanceId: z.string(),
  face: z.string().optional(),
  edge: z.string().optional(),
  vertex: z.object({ edge: z.string(), end: z.enum(["start", "end"]) }).optional(),
  /** A width mate's second face on the same part. */
  face2: z.string().optional(),
  /** Where on the entity: center (default), or a round wall's start/end. */
  anchor: z.enum(["center", "start", "end"]).optional(),
  /** Move the connector within its own frame, mm (number or expression). */
  offset: z.object({ x: expr.optional(), y: expr.optional(), z: expr.optional() }).optional(),
});
export type ConnectorSpec = z.infer<typeof connectorSpecSchema>;

const dofSchema = z.enum(["tx", "ty", "tz", "rx", "ry", "rz"]);

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
     *  plane of `upTo` (distance/flip ignored — the face sets length+direction);
     *  upToNext = stop at the nearest face of the model ahead in the flip-adjusted
     *  direction (distance ignored; `flip` reverses the direction; errors if
     *  nothing lies ahead that way, OR if the next face only PARTIALLY covers the
     *  profile — it must fully block the extrude). Both upToFace and upToNext
     *  CONFORM to the target face — a tilted target gives an angled top, not a
     *  flat cut. Defaults to blind. */
    extent: z.enum(["blind", "symmetric", "throughAll", "upToFace", "upToNext"]).optional(),
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
    /** What to spin: a closed sketch region (omit regionId for the sole region),
     *  or a **planar** face of an existing body `{bodyId, faceName}` — a curved
     *  face has no plane to revolve and is rejected. Text profiles aren't
     *  revolvable. */
    profile: z.union([
      z.object({ sketchId: z.string(), regionId: z.string().optional() }),
      z.object({ bodyId: z.string(), faceName: z.string() }),
    ]),
    /** The rotation axis — one of:
     *  - a sketch **line** entity `{sketchId, entityId}` in the profile's sketch
     *    (its endpoints define the axis; make it a `construction` line so it
     *    isn't part of the region, and the region must not cross it);
     *  - a **plane** `{plane: <datum|planeId|bodyFace>}` — the axis is the line
     *    where that plane meets the profile's plane;
     *  - a body **face** `{bodyId, faceName}` — a planar face uses that same
     *    plane-intersection rule; a cylindrical/conical face uses its own
     *    central axis (e.g. "revolve around this cylinder");
     *  - a straight body **edge** `{bodyId, edgeName}` — the edge IS the axis
     *    line (a curved edge is rejected). */
    axis: z.union([
      z.object({ sketchId: z.string(), entityId: z.string() }),
      z.object({ plane: planeRefSchema }),
      z.object({ bodyId: z.string(), faceName: z.string() }),
      z.object({ bodyId: z.string(), edgeName: z.string() }),
    ]),
    /** Revolve angle in degrees (number or expression). Defaults to 360 (full). */
    angle: expr.optional(),
    /** Revolve evenly to BOTH sides of the profile plane (spans ±angle/2)
     *  instead of one direction. Ignored at a full 360. Defaults to false. */
    symmetric: z.boolean().optional(),
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
     *  in a different sketch from the profile; the profile is swept from where it
     *  was drawn, so draw it at the path start. */
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
    // Associative OFFSET of a single connected chain of sketch edges (lines/arcs,
    // or one circle) by a signed distance. The new edges track their sources and
    // are driven (non-editable) — like Onshape's offset. Output edges appear
    // tagged `derived` in the scene summary; a closed offset makes a region you
    // can extrude.
    op: z.literal("addOffset"),
    sketchId: z.string(),
    /** The source chain's entity ids (lines/arcs forming one chain, or a single
     *  circle). Must be a single connected chain. */
    sourceIds: z.array(z.string()).min(1),
    /** Signed offset distance (number or expression). Positive offsets to the
     *  right of the chain's travel (outward for a CCW loop); negative the other. */
    distance: expr,
    /** Make the offset edges construction (reference-only). */
    construction: z.boolean().optional(),
    name: z.string().optional(),
  }),
  z.object({
    // Associative 2D MIRROR of sketch entities across a sketch line. The copies
    // track their sources and are driven. Distinct from `addMirror`, which
    // mirrors a whole 3D body across a plane.
    op: z.literal("addSketchMirror"),
    sketchId: z.string(),
    /** The mirror axis: a **line** entity id in the same sketch. */
    axisId: z.string(),
    /** The entity ids to reflect across the axis. */
    sourceIds: z.array(z.string()).min(1),
    name: z.string().optional(),
  }),
  z.object({
    // Associative 2D PATTERN of sketch entities: a linear run (count × step) or
    // a circular ring (count about a center). The copies track their sources
    // and are driven, like offset/mirror. Counts INCLUDE the seed (≥2).
    op: z.literal("addSketchPattern"),
    sketchId: z.string(),
    /** The entity ids to repeat. */
    sourceIds: z.array(z.string()).min(1),
    kind: z.enum(["linear", "circular"]),
    /** TOTAL instances including the seed (number or expression, ≥2). */
    count: expr,
    /** linear: the per-step translation in sketch (u,v) mm. */
    dx: expr.optional(),
    dy: expr.optional(),
    /** circular: the rotation center — a raw [u,v], or an entity point
     *  {entityId, at} (at "a"/"b" = line/arc ends, "c" = circle/arc center or a
     *  point entity; default "c"). There is NO radius input: instances are
     *  rotations of the seed about the center, so the radius is wherever the
     *  seed already sits. */
    center: z
      .union([
        z.tuple([z.number(), z.number()]),
        z.object({ entityId: z.string(), at: z.enum(["a", "b", "c"]).optional() }),
      ])
      .optional(),
    /** circular: TOTAL sweep in degrees (default 360 = full circle, equal
     *  360/count steps). Any other sweep spreads the instances
     *  endpoints-inclusive across it. */
    angle: expr.optional(),
    /** circular, non-360 only: spread ±angle/2 to both sides of the seed. */
    symmetric: z.boolean().optional(),
    name: z.string().optional(),
  }),
  z.object({
    // Repeat a BODY as rigid copies — a linear run/grid or a circular ring. The
    // copies land in ONE new compound body keyed by the pattern; the seed body
    // is kept (like add_mirror). Counts INCLUDE the seed (≥2).
    op: z.literal("addPattern"),
    /** The body (feature id) to repeat. */
    targetId: z.string(),
    kind: z.enum(["linear", "circular"]),
    /** linear: first direction — a world axis {world:"x"|"y"|"z"} or a sketch
     *  line {sketchId, entityId}. */
    dir1: z
      .union([z.object({ world: z.enum(["x", "y", "z"]) }), z.object({ sketchId: z.string(), entityId: z.string() })])
      .optional(),
    /** linear: TOTAL instances along dir1 including the seed (≥2). */
    count1: expr.optional(),
    /** linear: instance-to-instance spacing along dir1 (mm). */
    spacing1: expr.optional(),
    flip1: z.boolean().optional(),
    /** linear: optional second direction ⇒ a count1×count2 grid. */
    dir2: z
      .union([z.object({ world: z.enum(["x", "y", "z"]) }), z.object({ sketchId: z.string(), entityId: z.string() })])
      .optional(),
    count2: expr.optional(),
    spacing2: expr.optional(),
    flip2: z.boolean().optional(),
    /** circular: the rotation axis — a world axis through the origin, a sketch
     *  line, or a body face {bodyId, faceName} (must be cylindrical/conical —
     *  its own central axis is used; planar faces are rejected). There is NO
     *  radius input: instances are rotations of the seed about the axis. */
    axis: z
      .union([
        z.object({ world: z.enum(["x", "y", "z"]) }),
        z.object({ sketchId: z.string(), entityId: z.string() }),
        z.object({ bodyId: z.string(), faceName: z.string() }),
      ])
      .optional(),
    /** circular: TOTAL instances including the seed (≥2). */
    count: expr.optional(),
    /** circular: TOTAL sweep in degrees (default 360 = full circle). */
    angle: expr.optional(),
    /** circular, non-360 only: spread ±angle/2 to both sides of the seed. */
    symmetric: z.boolean().optional(),
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
    /** What the rotation turns about. Defaults to world "z". One of:
     *  - a world axis `"x"|"y"|"z"` — through the body's own centre, so the body
     *    spins on the spot;
     *  - a sketch **line** entity `{sketchId, entityId}`;
     *  - a straight body **edge** `{bodyId, edgeName}` (a curved edge is
     *    rejected) — the edge IS the axis, so the body HINGES around it rather
     *    than spinning in place. That is how you fold a lid or a bracket. */
    axis: z
      .union([
        z.enum(["x", "y", "z"]),
        z.object({ sketchId: z.string(), entityId: z.string() }),
        z.object({ bodyId: z.string(), edgeName: z.string() }),
      ])
      .optional(),
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
    /** Persistent edge names from the scene summary. May be empty when `faces`
     *  is given. */
    edges: z.array(z.string()),
    /** Persistent FACE names from the scene summary. Each stands for all the
     *  boundary edges of the smooth surface it belongs to — the practical way
     *  to round a circular rim (name the cylinder's flat top instead of its 96
     *  rim chords). Combines freely with `edges`. */
    faces: z.array(z.string()).optional(),
    size: expr.optional(),
    /** Chamfer only: bevel angle in degrees (0 < angle < 90), measured from the
     *  reference face that `size` runs along. Defaults to 45 (symmetric). */
    angle: expr.optional(),
    /** Chamfer only: measure `size`/`angle` from the edge's OTHER adjacent
     *  face. No effect at 45°. */
    flip: z.boolean().optional(),
  }),
  z.object({
    op: z.literal("shell"),
    targetId: z.string(),
    /** Persistent face names from the scene summary — the faces to remove
     *  (open up). Omit/empty for a fully sealed hollow shell (no opening). */
    faces: z.array(z.string()).optional(),
    /** Wall thickness; the wall grows inward from the kept faces. */
    thickness: expr.optional(),
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
  z.object({
    // Add a geometric constraint to a sketch (planegcs), then re-solve. Rejected
    // (with an error) if it conflicts with / is already implied by the existing
    // constraints, or collapses the geometry — the sketch is left unchanged.
    // Entity ids come from get_scene_summary's sketch entities; derived
    // (offset/mirror/project) entities and `text` aren't constrainable.
    op: z.literal("addConstraint"),
    sketchId: z.string(),
    constraint: constraintSpec,
  }),
  z.object({
    // Add a dimensional constraint (length/radius/angle/distance) to a sketch,
    // then re-solve. Same rejection guardrails as add_constraint. For a
    // parametric model, pass `value` as a variable name/expression (define it
    // first with set_variable) — it's evaluated to a number at apply time.
    op: z.literal("addDimension"),
    sketchId: z.string(),
    dimension: dimensionSpec,
  }),
  z.object({
    // Remove a sketch constraint/dimension by id (from get_scene_summary's
    // sketch constraints) — e.g. to resolve an over-constraint before adding a
    // different one.
    op: z.literal("removeConstraint"),
    sketchId: z.string(),
    constraintId: z.string(),
  }),
  z.object({ op: z.literal("rename"), featureId: z.string(), name: z.string() }),
  z.object({ op: z.literal("delete"), featureId: z.string() }),
  z.object({ op: z.literal("setRollback"), index: z.number().int().min(0) }),
  z.object({ op: z.literal("select"), refs: z.array(selectionSchema) }),
  // View-only cross-section —
  // like `select`, mutates viewport state, not the document (no undo, no
  // regen). `plane` defaults to the current section plane (Front datum on the
  // very first use); omit `offset`/`flip` to leave them as they are. The
  // paired `screenshot` op renders through it, so the agent can actually
  // inspect an interior instead of only ever seeing exteriors.
  z.object({
    op: z.literal("setSectionView"),
    enabled: z.boolean(),
    plane: planeRefSchema.optional(),
    offset: z.number().optional(),
    flip: z.boolean().optional(),
  }),
  z.object({ op: z.literal("importStep"), source: z.string(), name: z.string().optional() }),
  // Import a DXF drawing as an editable sketch (unlike importStep, which brings
  // in an opaque body). `source` is the DXF file text; `plane` places the sketch
  // (datum / reference-plane id / body face); `scale` multiplies all coordinates
  // (DXF is unitless — use 25.4 if the drawing is in inches, else 1 = mm).
  // Unsupported entity types (HATCH, DIMENSION, ellipses, blocks …) are skipped
  // and reported as a warning; the resulting geometry is free (unconstrained).
  z.object({
    op: z.literal("importDxf"),
    source: z.string(),
    plane: planeRefSchema,
    scale: z.number().positive().optional(),
    name: z.string().optional(),
  }),
  // --- Multi-document ops. These act on the WORKSPACE, not the
  // model: opening/creating/duplicating switches the working document (undo
  // history resets — a document boundary). Ids come from list_documents.
  z.object({ op: z.literal("openDocument"), id: z.string() }),
  /** Trim the piece of a sketch edge that lies under `at` — the span between
   *  where that edge crosses other edges. An edge nothing crosses is removed
   *  whole. `at` is a point in the sketch's own u/v, and only has to be near the
   *  edge: it's projected onto it, the way a click is. */
  z.object({
    op: z.literal("trimEntity"),
    sketchId: z.string(),
    entityId: z.string(),
    at: z.tuple([z.number(), z.number()]),
  }),
  /** Grow a sketch edge from the end nearest `at` until it meets another edge,
   *  and record that meeting as a constraint so it survives later solves.
   *  Errors when nothing lies ahead of that end. */
  z.object({
    op: z.literal("extendEntity"),
    sketchId: z.string(),
    entityId: z.string(),
    at: z.tuple([z.number(), z.number()]),
  }),
  /** kind defaults to "part"; an assembly places parts of other documents. */
  z.object({
    op: z.literal("newDocument"),
    name: z.string().optional(),
    kind: z.enum(["part", "assembly"]).optional(),
  }),
  /** id defaults to the active document. Rename is not an undoable model edit. */
  z.object({ op: z.literal("renameDocument"), id: z.string().optional(), name: z.string().min(1) }),
  /** id defaults to the active document; the copy opens as the working doc. */
  z.object({ op: z.literal("duplicateDocument"), id: z.string().optional() }),
  // --- Assembly ops: only while an assembly is open. Instance and connector
  // names come from get_scene_summary's `instances` and `parts`.
  /** Place a part document's parts (all, or `partIds`) into the open
   *  assembly: beside what's there, or with its origin at `position`. The
   *  assembly's first instance is grounded. */
  z.object({
    op: z.literal("insertInstance"),
    documentId: z.string(),
    partIds: z.array(z.string()).min(1).optional(),
    /** How many of each part (default 1): copies are laid out in a grid. */
    count: z.number().int().min(1).max(100).optional(),
    position: z.tuple([z.number(), z.number(), z.number()]).optional(),
    name: z.string().optional(),
  }),
  /** Copies of instances (count each, default 1), in a grid beside each
   *  original: turned as it is, in its colour, with no mates, not grounded. */
  z.object({
    op: z.literal("duplicateInstance"),
    instanceIds: z.array(z.string()).min(1),
    count: z.number().int().min(1).max(100).optional(),
  }),
  /** Fix an instance where it is (grounded: true, the default) or free it. */
  z.object({ op: z.literal("groundInstance"), instanceId: z.string(), grounded: z.boolean().optional() }),
  /** Join two instances with a mate. b moves to a: by default the two
   *  connectors' Z axes face each other (two faces touching); flip points
   *  them the same way; turns rotates b in quarter turns about Z. values set
   *  the free DOFs (mm / degrees, numbers or expressions). */
  z.object({
    op: z.literal("addMate"),
    type: z.enum(["fastened", "revolute", "slider", "cylindrical", "planar", "ball", "width"]),
    a: connectorSpecSchema,
    b: connectorSpecSchema,
    name: z.string().optional(),
    flip: z.boolean().optional(),
    turns: z.number().int().min(0).max(3).optional(),
    values: z.partialRecord(dofSchema, expr).optional(),
    limits: z.partialRecord(dofSchema, z.object({ min: expr.optional(), max: expr.optional() })).optional(),
  }),
  /** Set one free DOF of a mate (mm / degrees, a number or an expression; ""
   *  resets it to 0). A DOF a relation drives sets its driver instead, to
   *  what puts it there (a number only). */
  z.object({
    op: z.literal("setMateValue"),
    mateId: z.string(),
    dof: dofSchema,
    value: expr,
    /** Inside a loop group, consent to clear the expressions the value needs
     *  out of its way (they become plain numbers). Without it such a value is
     *  refused, naming them. */
    clearExpressions: z.boolean().optional(),
  }),
  /** Drive one mate's DOF from another's. gear: rotation → rotation, value =
   *  ratio (driven turns per driver turn; meshed gears turn opposite ways);
   *  rack: rotation ↔ translation, value = pinion radius (mm); screw:
   *  rotation ↔ translation, value = pitch (mm per turn) — a cylindrical
   *  mate's own rz → tz is a screw. reverse flips the direction. */
  /** Change a mate, keeping its id, name and the relations that use it: only
   *  the fields given change. a/b replace that side's connector (same form as
   *  addMate). values merge in ("" clears one); limits merge in per DOF (null
   *  clears one). A new type drops the values and limits of DOFs it doesn't
   *  have (width needs a and b given again, with face2). */
  z.object({
    op: z.literal("editMate"),
    mateId: z.string(),
    type: z.enum(["fastened", "revolute", "slider", "cylindrical", "planar", "ball", "width"]).optional(),
    a: connectorSpecSchema.optional(),
    b: connectorSpecSchema.optional(),
    name: z.string().min(1).optional(),
    flip: z.boolean().optional(),
    turns: z.number().int().min(0).max(3).optional(),
    values: z.partialRecord(dofSchema, expr).optional(),
    limits: z
      .partialRecord(dofSchema, z.union([z.object({ min: expr.optional(), max: expr.optional() }), z.null()]))
      .optional(),
  }),
  /** Leave a mate or relation out of the solve, keeping it (suppressed: true,
   *  the default), or bring it back. Parts it held stay where they are. */
  z.object({ op: z.literal("setSuppressed"), id: z.string(), suppressed: z.boolean().optional() }),
  /** Change a relation: only the fields given change. */
  z.object({
    op: z.literal("editRelation"),
    relationId: z.string(),
    type: z.enum(["gear", "rack", "screw"]).optional(),
    driver: z.object({ mateId: z.string(), dof: dofSchema }).optional(),
    driven: z.object({ mateId: z.string(), dof: dofSchema }).optional(),
    value: expr.optional(),
    reverse: z.boolean().optional(),
    name: z.string().min(1).optional(),
  }),
  z.object({
    op: z.literal("addRelation"),
    type: z.enum(["gear", "rack", "screw"]),
    driver: z.object({ mateId: z.string(), dof: dofSchema }),
    driven: z.object({ mateId: z.string(), dof: dofSchema }),
    value: expr,
    reverse: z.boolean().optional(),
    name: z.string().optional(),
  }),
]);

export type Operation = z.infer<typeof operationSchema>;

/** Every `op` name — advertised to the hub as the tab's capabilities. */
export const OPERATION_NAMES = operationSchema.options.map((o) => o.shape.op.value);

// --- Read queries ---------------------------------------------------------

export const readQuerySchema = z.discriminatedUnion("read", [
  z.object({ read: z.literal("document") }),
  z.object({ read: z.literal("sceneSummary") }),
  z.object({ read: z.literal("selection") }),
  /** All stored documents (metadata only), most-recently-edited first. */
  z.object({ read: z.literal("documents") }),
  z.object({
    read: z.literal("screenshot"),
    /** Snap the camera to a standard view before capturing. */
    view: z.enum(["front", "back", "left", "right", "top", "bottom", "iso"]).optional(),
  }),
  /** ASSEMBLY only: sweep one free DOF of a mate from `from` to `to` and
   *  screenshot it at `frames` evenly spaced values — the Animate dialog's
   *  motion, as stills. Nothing is written to the document. from/to default
   *  as the dialog's: between the DOF's limits, else a full turn (a rotation)
   *  or 20 mm (a translation) from where it is. */
  z.object({
    read: z.literal("animateMate"),
    mateId: z.string(),
    dof: dofSchema.optional(),
    from: z.number().optional(),
    to: z.number().optional(),
    frames: z.number().int().min(2).max(8).optional(),
    view: z.enum(["front", "back", "left", "right", "top", "bottom", "iso"]).optional(),
  }),
]);
export type ReadQuery = z.infer<typeof readQuerySchema>;

/** Every `read` name — advertised to the hub as the tab's capabilities. */
export const READ_NAMES = readQuerySchema.options.map((o) => o.shape.read.value);

// --- Result shapes --------------------------------------------------------

/** What animateMate returns: each frame's DOF value, PNG data URL, and any
 *  mate that frame leaves unsatisfied (where the motion jams). */
export interface AnimationFrames {
  mateId: string;
  dof: string;
  from: number;
  to: number;
  frames: { value: number; image: string; problem?: string }[];
}

export type ErrorKind = "not_found" | "invalid_op" | "kernel_error";

/** The result of applying one Operation. `createdId` is the new feature/variable
 *  id (so the agent can chain). `featureErrors` carries per-feature resolve
 *  errors detected synchronously after the edit; kernel/regen errors arrive
 *  through the host's regen-await loop. `warnings` carries non-fatal per-feature
 *  notices from the regen — a topological reference (face/edge name) that had
 *  to be re-matched after an upstream edit, or a dress-up that lost some of its
 *  edges. The op succeeded, but the agent should verify the re-match landed on
 *  the intended geometry (get_scene_summary / screenshot). */
export interface OpResult {
  ok: boolean;
  createdId?: string;
  /** Every id an op created, when it made several (insertInstance). */
  createdIds?: string[];
  error?: string;
  errorKind?: ErrorKind;
  featureErrors?: Record<string, string>;
  warnings?: Record<string, string>;
}

/** One stored document, as returned by the `documents` read. */
export interface DocumentListing {
  id: string;
  name: string;
  updatedAt: number;
  kind: "part" | "assembly";
  featureCount: number;
  partCount: number;
  /** Assemblies only: how many part instances it places, and mates join them. */
  instanceCount?: number;
  mateCount?: number;
  /** True for the document currently open in the tab. */
  active: boolean;
}

/** Compact, LLM-first digest of the scene — the agent's primary planning input
 *  (see commands.ts#getSceneSummary). */
export interface SceneSummary {
  /** WHICH document this summary describes — check before assuming context. */
  documentId: string;
  documentName: string;
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
     *  specific one — e.g. a `line` entity as a revolve axis. `derived` marks
     *  driven offset/mirror/project output (don't edit/constrain it directly). */
    entities: { id: string; type: string; construction?: boolean; derived?: boolean }[];
    regions: { id: string; area: number }[];
    /** Constraints/dimensions on the sketch, by id + kind, with the entity ids
     *  each touches (a point ref shows as its entity id, or "origin"). Use the
     *  ids with remove_constraint. `value` is present on dimensions. */
    constraints: { id: string; type: string; refs: string[]; value?: number }[];
  }[];
  planes: { id: string; name: string }[];
  variables: { name: string; expression: string; value?: number }[];
  rollbackIndex: number;
  featureCount: number;
  selection: unknown[];
  errors: Record<string, string>;
  /** Present when some face/edge names are folded runs: how to read them. */
  nameNote?: string;
}

/** The scene summary of an open ASSEMBLY (see agent/assemblySummary.ts):
 *  what's placed, how it's joined, and what can still move. `kind` tells it
 *  from a part's SceneSummary. */
export interface AssemblySummary {
  kind: "assembly";
  /** Present when some face/edge names are folded runs: how to read them. */
  nameNote?: string;
  documentId: string;
  documentName: string;
  /** The parts instances are made from, each once: `key` is what an instance's
   *  `part` names. `faces`/`edges` are the names a mate's connector can use
   *  (a vertex is an end of a named edge). Absent while its document loads or
   *  when it can't be read (`problem`). */
  parts: {
    key: string;
    documentId: string;
    documentName?: string;
    partId: string;
    name?: string;
    faces?: string[];
    edges?: string[];
    problem?: string;
  }[];
  instances: {
    id: string;
    name: string;
    /** A `parts[].key`. */
    part: string;
    grounded?: boolean;
    hidden?: boolean;
    /** Placed by a mate (else by its own stored placement). */
    mated?: boolean;
    /** World-space bounds where it's placed now. */
    bbox?: { min: [number, number, number]; max: [number, number, number] };
  }[];
  mates: {
    id: string;
    name: string;
    type: string;
    a: AssemblyConnectorSummary;
    b: AssemblyConnectorSummary;
    flip?: boolean;
    /** Quarter turns of b about the mate's Z. */
    turns?: number;
    /** What the mate leaves free, with where each is now. `expression` when its
     *  value is one (it drives); `drivenBy` a relation id when one sets it. */
    free: {
      dof: string;
      label: string;
      value: number;
      expression?: string;
      drivenBy?: string;
      min?: string;
      max?: string;
    }[];
    suppressed?: boolean;
    /** Why it couldn't be applied. */
    problem?: string;
    /** It applies, but a connector was re-found by fingerprint: check it. */
    warning?: string;
  }[];
  relations: {
    id: string;
    name: string;
    type: string;
    driver: { mateId: string; dof: string };
    driven: { mateId: string; dof: string };
    value: string;
    reverse?: boolean;
    suppressed?: boolean;
    problem?: string;
  }[];
  /** Groups of instances solved together (a closed loop of mates, or two mates
   *  between one pair): their plain-number mate values only report. */
  loops: { instanceIds: string[]; mateIds: string[] }[];
  variables: { name: string; expression: string; value?: number }[];
  /** Selected instance ids. */
  selection: string[];
}

/** One side of a mate, as the assembly summary shows it. */
export interface AssemblyConnectorSummary {
  instanceId: string;
  /** "face" | "edge" | "vertex" — a vertex is the end of `name` nearest where it was picked. */
  kind: string;
  /** The face or edge name on the instance's part. */
  name: string;
  /** A width mate's second face. */
  name2?: string;
  /** Where on the entity the connector sits: center, or an edge's start/end. */
  anchor: string;
  offset?: Partial<Record<"x" | "y" | "z", string>>;
}

// --- Expression-aware coordinate arithmetic -------------------------------
// Sketch coordinates accept a number OR a variable expression. To stay
// associative (reflow when a variable changes), expandEntities carries each
// value as a `Num`: its evaluated number, plus — when it came from (or was
// computed from) a variable expression — the source expression string. Sugar
// shapes compose these (a centred rect corner is `center − w/2`, a polygon
// vertex is `c + r·cosθ`), so even generated line endpoints track their
// variables. The composed expressions become the entity's `exprs` overlay.

type Num = { n: number; e?: string };
type Pt = { x: Num; y: Num };

/** A purely numeric expression ("5", "10/2") never changes, so it needs no
 *  overlay; only expressions that name something (a variable/const/function) do. */
const namesSomething = (s: string) => /[A-Za-z]/.test(s);
const tok = (a: Num): string => a.e ?? String(a.n);

function toNum(v: number | string, scope: Scope): Num {
  if (typeof v === "number") return { n: v };
  let n = 0;
  try {
    n = evaluateExpression(v, scope);
  } catch {
    n = 0; // unknown var at author time — the overlay re-evaluates on regen
  }
  return namesSomething(v) ? { n, e: v } : { n };
}
const toPt = (v: [number | string, number | string], scope: Scope): Pt => ({
  x: toNum(v[0], scope),
  y: toNum(v[1], scope),
});

const addN = (a: Num, b: Num): Num => ({ n: a.n + b.n, ...(a.e || b.e ? { e: `(${tok(a)})+(${tok(b)})` } : {}) });
const subN = (a: Num, b: Num): Num => ({ n: a.n - b.n, ...(a.e || b.e ? { e: `(${tok(a)})-(${tok(b)})` } : {}) });
/** Multiply by a constant factor (a literal number, never an expression). */
const mulK = (a: Num, k: number): Num => ({ n: a.n * k, ...(a.e ? { e: `(${tok(a)})*${k}` } : {}) });
/** Degrees → radians (the internal arc/rotation unit), preserving any overlay. */
const degToRad = (a: Num): Num => ({ n: (a.n * Math.PI) / 180, ...(a.e ? { e: `rad(${tok(a)})` } : {}) });

/** Collect an `exprs` overlay from labelled Nums — only those carrying an
 *  expression contribute, so plain numeric entities stay overlay-free. */
function collectExprs(fields: Record<string, Num>): EntityExprs | undefined {
  const exprs: EntityExprs = {};
  for (const [k, v] of Object.entries(fields)) if (v.e) exprs[k] = v.e;
  return Object.keys(exprs).length ? exprs : undefined;
}

// --- Entity expansion -----------------------------------------------------

/** Expand the agent's sugar shapes into concrete SketchEntity objects (with
 *  fresh ids), in the sketch's (u, v) plane coords. Coordinates/radii/angles may
 *  be variable expressions, evaluated against `scope` for the stored numbers and
 *  recorded as an `exprs` overlay so the sketch reflows when a variable changes;
 *  angles (arc start/end, text rotation) are DEGREES and stored as radians.
 *  Pure — unit-tested. */
export function expandEntities(specs: EntitySpec[], scope: Scope = {}): SketchEntity[] {
  const out: SketchEntity[] = [];
  // Stamp the construction flag / exprs overlay only when set, to keep entities clean.
  const mark = <T extends SketchEntity>(e: T, c?: boolean): T => (c ? { ...e, construction: true } : e);
  const withExprs = <T extends SketchEntity>(e: T, ex?: EntityExprs): T => (ex ? { ...e, exprs: ex } : e);
  // Emit a closed loop of lines through Pts; each line carries its endpoints' overlays.
  const ptLoop = (pts: Pt[], c?: boolean) => {
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i];
      const b = pts[(i + 1) % pts.length];
      const e = mark({ type: "line" as const, id: genId(), a: [a.x.n, a.y.n] as Vec2, b: [b.x.n, b.y.n] as Vec2 }, c);
      out.push(withExprs(e, collectExprs({ "a.0": a.x, "a.1": a.y, "b.0": b.x, "b.1": b.y })));
    }
  };
  for (const s of specs) {
    switch (s.shape) {
      case "rect": {
        // Corners from center±half or corner+size, as Num arithmetic so a
        // variable width/center reflows all four generated lines.
        const w = toNum(s.w, scope);
        const h = toNum(s.h, scope);
        let corners: Pt[];
        if (s.center) {
          const c = toPt(s.center, scope);
          const hw = mulK(w, 0.5);
          const hh = mulK(h, 0.5);
          corners = [
            { x: subN(c.x, hw), y: subN(c.y, hh) },
            { x: addN(c.x, hw), y: subN(c.y, hh) },
            { x: addN(c.x, hw), y: addN(c.y, hh) },
            { x: subN(c.x, hw), y: addN(c.y, hh) },
          ];
        } else {
          const c = s.corner ? toPt(s.corner, scope) : { x: { n: 0 }, y: { n: 0 } };
          corners = [
            { x: c.x, y: c.y },
            { x: addN(c.x, w), y: c.y },
            { x: addN(c.x, w), y: addN(c.y, h) },
            { x: c.x, y: addN(c.y, h) },
          ];
        }
        ptLoop(corners, s.construction);
        break;
      }
      case "circle": {
        const c = toPt(s.c, scope);
        const r = toNum(s.r, scope);
        const e = mark({ type: "circle" as const, id: genId(), c: [c.x.n, c.y.n] as Vec2, r: r.n }, s.construction);
        out.push(withExprs(e, collectExprs({ "c.0": c.x, "c.1": c.y, r })));
        break;
      }
      case "polygon": {
        const c = toPt(s.c, scope);
        const r = toNum(s.r, scope);
        const verts: Pt[] = [];
        for (let k = 0; k < s.n; k++) {
          const th = (2 * Math.PI * k) / s.n;
          verts.push({ x: addN(c.x, mulK(r, Math.cos(th))), y: addN(c.y, mulK(r, Math.sin(th))) });
        }
        ptLoop(verts, s.construction);
        break;
      }
      case "line": {
        const a = toPt(s.a, scope);
        const b = toPt(s.b, scope);
        const e = mark(
          { type: "line" as const, id: genId(), a: [a.x.n, a.y.n] as Vec2, b: [b.x.n, b.y.n] as Vec2 },
          s.construction,
        );
        out.push(withExprs(e, collectExprs({ "a.0": a.x, "a.1": a.y, "b.0": b.x, "b.1": b.y })));
        break;
      }
      case "arc": {
        // Agent angles are DEGREES; store radians (the internal unit).
        const c = toPt(s.c, scope);
        const r = toNum(s.r, scope);
        const start = degToRad(toNum(s.start, scope));
        const end = degToRad(toNum(s.end, scope));
        const e = mark(
          { type: "arc" as const, id: genId(), c: [c.x.n, c.y.n] as Vec2, r: r.n, start: start.n, end: end.n },
          s.construction,
        );
        out.push(withExprs(e, collectExprs({ "c.0": c.x, "c.1": c.y, r, start, end })));
        break;
      }
      case "spline": {
        const pts = s.points.map((p) => toPt(p, scope));
        const e = mark(
          { type: "spline" as const, id: genId(), points: pts.map((p) => [p.x.n, p.y.n] as Vec2) },
          s.construction,
        );
        const fields: Record<string, Num> = {};
        pts.forEach((p, i) => {
          fields[`points.${i}.0`] = p.x;
          fields[`points.${i}.1`] = p.y;
        });
        out.push(withExprs(e, collectExprs(fields)));
        break;
      }
      case "point": {
        const p = toPt(s.p, scope);
        const e = mark({ type: "point" as const, id: genId(), p: [p.x.n, p.y.n] as Vec2 }, s.construction);
        out.push(withExprs(e, collectExprs({ "p.0": p.x, "p.1": p.y })));
        break;
      }
      case "text": {
        const p = toPt(s.p, scope);
        const height = toNum(s.height, scope);
        const rot = s.rotation !== undefined ? degToRad(toNum(s.rotation, scope)) : undefined;
        const e = mark(
          {
            type: "text" as const,
            id: genId(),
            p: [p.x.n, p.y.n] as Vec2,
            value: s.value,
            height: height.n,
            ...(rot ? { rotation: rot.n } : {}),
          },
          s.construction,
        );
        const fields: Record<string, Num> = { "p.0": p.x, "p.1": p.y, height };
        if (rot) fields.rotation = rot;
        out.push(withExprs(e, collectExprs(fields)));
        break;
      }
    }
  }
  return out;
}

// Re-exports for downstream consumers that want the kernel-level unions.
export type { BooleanOp, PrimitiveKind };
