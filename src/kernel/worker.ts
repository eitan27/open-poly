// The kernel Web Worker: hosts the heavy OCCT WASM module and replicad so the
// UI thread never blocks on geometry regeneration. It builds each feature in a
// document and returns tessellated meshes (or a per-feature error).

import opencascade from "replicad-opencascadejs/src/replicad_single.js";
import opencascadeWasm from "replicad-opencascadejs/src/replicad_single.wasm?url";
import {
  setOC, makeBaseBox, makeCylinder, makeSphere, draw, drawPointsInterpolation, Plane,
  cast, getOC, Vector, HASH_CODE_MAX, exportSTEP, measureVolume, loadFont,
  Blueprint, BlueprintSketcher, CompoundBlueprint,
} from "replicad";
import type { Shape3D, Face, Edge, Sketch } from "replicad";
import type { Font as OpentypeFont } from "opentype.js";
import { glyphFillPolygons } from "./glyphFill";

import type { KernelRequest, KernelResponse } from "./protocol";
import type {
  BooleanOp,
  ExportFormat,
  ExtrudeExtent,
  MeshedEdges,
  MeshedFaces,
  RegenFeatureResult,
  ResolvedEdgeRef,
  ResolvedFeature,
  ResolvedFrame,
  ResolvedProfile,
} from "./types";
import { matchEdges, matchFace, type EdgeCandidate, type FaceCandidate } from "./topoMatch";

const ctx = self as unknown as DedicatedWorkerGlobalScope;

let ocReady: Promise<void> | null = null;
function ensureOC(): Promise<void> {
  if (!ocReady) {
    // The emscripten factory accepts a `locateFile` override (not in its .d.ts).
    const init = opencascade as unknown as (opts: {
      locateFile: () => string;
    }) => Promise<unknown>;
    ocReady = init({ locateFile: () => opencascadeWasm }).then((OC) => {
      setOC(OC as Parameters<typeof setOC>[0]);
    });
  }
  return ocReady;
}

// The bundled sketch font, loaded into replicad's text system once (lazily, only
// when a document actually extrudes text). Same asset the UI renders glyph
// previews from (`src/document/text.ts`), so the solid matches the preview.
const FONT_URL = `${import.meta.env.BASE_URL}fonts/Inter-Regular.ttf`;
let sketchFont: OpentypeFont | null = null;
let fontReady: Promise<void> | null = null;
function ensureFont(): Promise<void> {
  if (!fontReady) {
    fontReady = fetch(FONT_URL)
      .then((r) => r.arrayBuffer())
      .then((buf) => loadFont(buf))
      .then((font) => {
        sketchFont = font;
      });
  }
  return fontReady;
}

const MESH_OPTS = { tolerance: 0.05, angularTolerance: 30 };

// Fuzzy tolerance (mm) applied to every boolean. OCCT booleans on thin-walled
// B-spline swept solids (this chute's tube∪scoop) are pathologically slow
// because near-tangent surface intersections are computed at machine precision;
// a small fuzzy value coalesces them and roughly HALVES each boolean's time.
// Must stay well below the smallest real feature. Measured on the chute doc:
//   0     -> booleans 9294/2923/1888ms  (baseline)
//   0.01  -> 4888/1253/998ms, geometry identical  ← chosen
//   0.05  -> BREAKS the ChuteWithScoop subtract (fuzzy > the thin ScoopInner
//            wall gap, so the cut degenerates)
// So 0.01 is the sweet spot: ~45% faster, no geometry change. Don't raise it
// without re-checking every boolean result.
const BOOL_FUZZY = 0.01;

// --- Topological naming (N2: OCCT construction history) ---
// A body carries a name map (face hashCode -> persistent name) built at creation
// and PROPAGATED through every operation via OCCT history (Generated/Modified/
// IsDeleted), so a face keeps its identity across rebuilds and edits. hashCodes
// are only build-local handles; the names are the stable identity.
//
// All geometry is authored directly in millimetres (no unit conversion) since
// that is OpenCascade's default working unit; STEP export declares "mm".
type NamedShape = { shape: Shape3D; names: Map<number, string> };
// `key` is a content hash of everything that produced this body (its feature's
// resolved params + the keys of the bodies it consumed). Two regens yield the
// same key for a body iff its geometry is identical — so it drives the mesh
// cache (skip re-tessellating unchanged bodies).
type Body = NamedShape & { id: string; key: string };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Topo = any; // a raw OCCT TopoDS_Shape (opencascade.js binding)
const hashOf = (t: Topo): number => t.HashCode(HASH_CODE_MAX);

/** Drain a TopTools_ListOfShape into an array (destructive; safe to consume). */
function drainList(list: Topo): Topo[] {
  const out: Topo[] = [];
  while (list.Size() > 0) {
    out.push(list.First_1());
    list.RemoveFirst();
  }
  return out;
}

/** Canonical name for an axis-aligned planar face (box faces): its outward
 *  normal direction, e.g. "+z". Stable across rebuilds and parameter changes. */
function axisFaceName(f: Face): string | null {
  if (f.geomType !== "PLANE") return null;
  const [x, y, z] = f.normalAt().normalized().toTuple();
  const axes: [string, number][] = [["x", x], ["y", y], ["z", z]];
  const dom = axes.reduce((a, b) => (Math.abs(b[1]) > Math.abs(a[1]) ? b : a));
  if (Math.abs(dom[1]) < 0.999) return null;
  return (dom[1] >= 0 ? "+" : "-") + dom[0];
}

/** Build a primitive solid and name its (axis-aligned) faces, scoped by id. */
function buildPrimitive(feature: Extract<ResolvedFeature, { type: "primitive" }>): NamedShape {
  const p = feature.params;
  let shape: Shape3D;
  switch (feature.kind) {
    case "box": shape = makeBaseBox(p.width, p.depth, p.height); break;
    case "cylinder": shape = makeCylinder(p.radius, p.height); break;
    case "sphere": shape = makeSphere(p.radius); break;
    default: throw new Error(`Unknown feature kind: ${(feature as { kind: string }).kind}`);
  }
  // NB: replicad's 3D translate() deletes the original and returns a new shape.
  shape = shape.translate(p.x ?? 0, p.y ?? 0, p.z ?? 0) as Shape3D;
  // EVERY face gets a name: axis-aligned planar faces a directional one, the
  // rest a stable index (`f0`…). Naming all faces matters because an edge is
  // only referenceable when BOTH its faces are named — without this a cylinder's
  // side face was unnamed, so its rim edges couldn't be chamfered/filleted.
  const names = new Map<number, string>();
  const used = new Set<string>();
  let extra = 0;
  for (const f of shape.faces) {
    const dir = axisFaceName(f);
    const axis = dir ? `${feature.id}/${dir}` : null;
    const nm = axis && !used.has(axis) ? axis : `${feature.id}/f${extra++}`;
    used.add(nm);
    names.set(f.hashCode, nm);
  }
  return { shape, names };
}

/** Parse a STEP file's text into a body, seeding face names so downstream
 *  extrude-on-face / chamfer / the agent can reference them: axis-aligned planar
 *  faces get an axis name (`id/+z`), the rest a stable index name (`id/fN`).
 *  Names are kept unique within the body. (Sync — writes the text straight to
 *  OCCT's in-memory FS, no Blob round-trip.) */
function importStepNamed(source: string, id: string): NamedShape {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const oc = getOC() as any;
  const fileName = `${id}.step`;
  oc.FS.writeFile(`/${fileName}`, new TextEncoder().encode(source));
  const reader = new oc.STEPControl_Reader_1();
  let shape: Shape3D;
  try {
    if (!reader.ReadFile(fileName)) throw new Error("Could not read STEP file");
    const progress = new oc.Message_ProgressRange_1();
    reader.TransferRoots(progress);
    progress.delete();
    shape = cast(reader.OneShape()) as Shape3D;
  } finally {
    oc.FS.unlink("/" + fileName);
    reader.delete();
  }
  const names = new Map<number, string>();
  const used = new Set<string>();
  shape.faces.forEach((f, i) => {
    const dir = axisFaceName(f);
    const axis = dir ? `${id}/${dir}` : null;
    const nm = axis && !used.has(axis) ? axis : `${id}/f${i}`;
    used.add(nm);
    names.set(f.hashCode, nm);
  });
  return { shape, names };
}

/** Combine several disjoint named solids into one body as an OCCT compound — no
 *  boolean (so it stays cheap for dozens of glyph lumps). Face hashCodes are
 *  preserved when added to a compound, so the merged name map stays valid. */
function compoundOf(pieces: NamedShape[]): NamedShape {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const oc = getOC() as any;
  const comp = new oc.TopoDS_Compound();
  const builder = new oc.TopoDS_Builder();
  builder.MakeCompound(comp);
  const names = new Map<number, string>();
  for (const p of pieces) {
    builder.Add(comp, p.shape.wrapped);
    for (const [h, n] of p.names) names.set(h, n);
  }
  return { shape: cast(comp) as Shape3D, names };
}

/** Extrude a profile face along `dir` and name the result from MakePrism's
 *  history: the two caps (start/end) and one side face per profile edge. */
function prismFromFace(profileFace: Face, dir: Vector, signedDist: number, id: string): NamedShape {
  const oc = getOC();
  const vec = dir.normalized().multiply(signedDist);
  const builder = new oc.BRepPrimAPI_MakePrism_1(profileFace.wrapped, vec.wrapped, false, true);
  const shape = cast(builder.Shape()) as Shape3D;

  const capHashes = new Map<number, string>();
  capHashes.set(hashOf(builder.FirstShape_1()), `${id}/start`);
  capHashes.set(hashOf(builder.LastShape_1()), `${id}/end`);
  const sideByHash = new Map<number, string>();
  profileFace.edges.forEach((e, i) => {
    for (const g of drainList(builder.Generated(e.wrapped))) sideByHash.set(hashOf(g), `${id}/side${i}`);
  });

  // namesFromHistory gives any face history missed a stable `f{n}` fallback so
  // every face (and therefore every edge) stays referenceable.
  const { names } = namesFromHistory(shape, id, capHashes, sideByHash);
  builder.delete();
  return { shape, names };
}

/** Revolve a profile face around an axis by `angleRad`, naming the result from
 *  MakeRevol's history: the swept side faces (one per profile edge) and, for a
 *  partial revolve, the two caps. */
function revolveFromFace(
  profileFace: Face,
  axisOrigin: number[],
  axisDir: number[],
  angleRad: number,
  symmetric: boolean,
  id: string,
): NamedShape {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const oc = getOC() as any;
  const pnt = new oc.gp_Pnt_3(axisOrigin[0], axisOrigin[1], axisOrigin[2]);
  const dir = new oc.gp_Dir_4(axisDir[0], axisDir[1], axisDir[2]);
  const ax1 = new oc.gp_Ax1_2(pnt, dir);

  // For a symmetric revolve, pre-rotate the profile by −angle/2 about the axis,
  // then sweep +angle, so the solid straddles the profile plane (it spans
  // −angle/2 .. +angle/2 instead of 0 .. +angle). We rebind `face` to the
  // rotated face so the side-naming below keys off the edges that are actually
  // revolved — the transform produces fresh TopoDS_Edges, but the rigid rotation
  // preserves the wire's edge order, so `side{i}` indices stay consistent with
  // the non-symmetric case.
  let face = profileFace;
  let rotated: Face | null = null;
  if (symmetric) {
    const trsf = new oc.gp_Trsf_1();
    trsf.SetRotation_1(ax1, -angleRad / 2);
    const xf = new oc.BRepBuilderAPI_Transform_2(profileFace.wrapped, trsf, true);
    rotated = cast(xf.Shape()) as Face;
    face = rotated;
    xf.delete();
    trsf.delete();
  }

  const builder = new oc.BRepPrimAPI_MakeRevol_1(face.wrapped, ax1, angleRad, false);
  const shape = cast(builder.Shape()) as Shape3D;

  const capHashes = new Map<number, string>();
  try { capHashes.set(hashOf(builder.FirstShape_1()), `${id}/start`); } catch { /* full revolve: no caps */ }
  try { capHashes.set(hashOf(builder.LastShape_1()), `${id}/end`); } catch { /* full revolve: no caps */ }
  const sideByHash = new Map<number, string>();
  face.edges.forEach((e, i) => {
    for (const g of drainList(builder.Generated(e.wrapped))) sideByHash.set(hashOf(g), `${id}/side${i}`);
  });

  // namesFromHistory gives any face NOT reported by Generated a stable `f{n}`
  // fallback. This matters for a full 360° revolve: OCCT's Generated() reports
  // the swept cylindrical/conical faces but NOT the planar ones (disks/annuli
  // swept by radial profile edges), so without a fallback those faces stay
  // unnamed — and an edge is only nameable when BOTH its faces are named, so
  // their circular edges couldn't be chamfered/filleted.
  const { names } = namesFromHistory(shape, id, capHashes, sideByHash);
  builder.delete();
  ax1.delete();
  dir.delete();
  pnt.delete();
  rotated?.delete();
  return { shape, names };
}

/** Build a face from a baked sketch outline and revolve it around an axis. */
function revolveSketchRegion(
  profile: Extract<ResolvedFeature, { type: "revolve" }>["profile"] & { kind: "sketchRegion" },
  axisOrigin: number[],
  axisDir: number[],
  angleRad: number,
  symmetric: boolean,
  id: string,
): NamedShape {
  const { outline, frame } = profile;
  if (outline.length < 3) throw new Error("revolve: profile needs at least 3 points");
  const plane = planeOf(frame);
  let pen = draw().movePointerTo(outline[0]);
  for (let i = 1; i < outline.length; i++) pen = pen.lineTo(outline[i]);
  const face = (pen.close().sketchOnPlane(plane) as { face(): Face }).face();
  return revolveFromFace(face, axisOrigin, axisDir, angleRad, symmetric, id);
}

type RegionProfile = Extract<ResolvedProfile, { kind: "sketchRegion" }>;

type V3 = [number, number, number];
const vlen = (v: V3) => Math.hypot(v[0], v[1], v[2]) || 1;
const vunit = (v: V3): V3 => { const L = vlen(v); return [v[0] / L, v[1] / L, v[2] / L]; };
const vcross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
/** Map a frame-local (u,v) point to world. */
function frameToWorld(f: ResolvedFrame, p: [number, number]): [number, number, number] {
  return [
    f.origin[0] + p[0] * f.uAxis[0] + p[1] * f.vAxis[0],
    f.origin[1] + p[0] * f.uAxis[1] + p[1] * f.vAxis[1],
    f.origin[2] + p[0] * f.uAxis[2] + p[1] * f.vAxis[2],
  ];
}

/** Build a replicad Plane whose (x, y) basis is EXACTLY the frame's
 *  (uAxis, vAxis). replicad derives the plane's y as `normal × xDir`, so we pass
 *  `normal = uAxis × vAxis` to guarantee y === vAxis. This matters because the
 *  "front" datum frame is left-handed (its normal = −(uAxis × vAxis)), so passing
 *  `frame.normal` would mirror all built geometry in v relative to how the sketch
 *  renders (`uvToWorld` uses the frame's own uAxis/vAxis). */
function planeOf(f: ResolvedFrame): Plane {
  return new Plane(f.origin, f.uAxis, vcross(f.uAxis as V3, f.vAxis as V3));
}

/** Build a closed profile Drawing for a region. Prefers the exact curve
 *  `segments` (true lines + arcs → a smooth circular/arc cross-section) and
 *  falls back to the faceted polyline `outline`. */
function profileDrawing(profile: RegionProfile) {
  if (profile.segments && profile.segmentStart) {
    let pen = draw().movePointerTo(profile.segmentStart);
    for (const s of profile.segments) {
      pen = s.kind === "line" ? pen.lineTo(s.to) : pen.threePointsArcTo(s.to, s.mid);
    }
    return pen.close();
  }
  const outline = profile.outline;
  if (outline.length < 3) throw new Error("profile needs at least 3 points");
  let pen = draw().movePointerTo(outline[0]);
  for (let i = 1; i < outline.length; i++) pen = pen.lineTo(outline[i]);
  return pen.close();
}

/** Resolve `shape`'s faces to a name map, given hash→name maps for the swept
 *  side faces and the start/end caps; anything unmapped gets a stable `f{n}`. */
function namesFromHistory(shape: Shape3D, id: string, caps: Map<number, string>, sides: Map<number, string>): NamedShape {
  const names = new Map<number, string>();
  let extra = 0;
  for (const f of shape.faces) {
    const h = f.hashCode;
    if (caps.has(h)) names.set(h, caps.get(h)!);
    else if (sides.has(h)) names.set(h, sides.get(h)!);
    else names.set(h, `${id}/f${extra++}`);
  }
  return { shape, names };
}

/** Sweep a profile region along a path (a wire built from baked 2D points: a
 *  B-spline when `smooth`, else a polyline). Built on raw OCCT
 *  `BRepOffsetAPI_MakePipeShell` so the result's faces are named from history:
 *  one side face per profile edge (`Generated`) + the two caps. */
function sweepBody(profile: RegionProfile, path: Extract<ResolvedFeature, { type: "sweep" }>["path"], id: string): NamedShape {
  if (path.points.length < 2) throw new Error("sweep: path needs at least 2 points");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const oc = getOC() as any;
  // Spine wire from the path (open drawing → wire). A spline path is rebuilt
  // from its exact cubic-Bézier spans, so the spine is geometrically identical
  // to the curve the sketch shows. An arc fits ONE continuous interpolating
  // spline through its samples (chaining per-segment `smoothSplineTo` has no
  // global view and collapses to a near-polyline). A line stays a polyline.
  const pathPlane = planeOf(path.frame);
  let spineDrawing;
  if (path.beziers && path.beziers.length) {
    let pen = draw().movePointerTo(path.points[0]);
    for (const b of path.beziers) pen = pen.cubicBezierCurveTo(b.end, b.c1, b.c2);
    spineDrawing = pen.done();
  } else if (path.smooth && path.points.length >= 3) {
    spineDrawing = drawPointsInterpolation(path.points);
  } else {
    let pen = draw().movePointerTo(path.points[0]);
    for (let i = 1; i < path.points.length; i++) pen = pen.lineTo(path.points[i]);
    spineDrawing = pen.done();
  }
  const spineWire = (spineDrawing.sketchOnPlane(pathPlane) as unknown as Sketch).wire;

  // Place the profile at the spine start, perpendicular to the start tangent
  // (a frame with normal = tangent), then sweep it along the spine.
  const start = frameToWorld(path.frame, path.points[0]);
  const next = frameToWorld(path.frame, path.points[1]);
  const tangent = vunit([next[0] - start[0], next[1] - start[1], next[2] - start[2]]);
  const ref: V3 = Math.abs(tangent[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
  const uAxis = vunit(vcross(ref, tangent));
  // MakePipeShell sweeps a profile WIRE (then MakeSolid caps it).
  const profileWire = (profileDrawing(profile).sketchOnPlane(new Plane(start, uAxis, tangent)) as unknown as Sketch).wire;

  const builder = new oc.BRepOffsetAPI_MakePipeShell(spineWire.wrapped);
  builder.Add_1(profileWire.wrapped, false, true);
  const progress = new oc.Message_ProgressRange_1();
  builder.Build(progress);
  builder.MakeSolid();
  const shape = cast(builder.Shape()) as Shape3D;

  const sides = new Map<number, string>();
  profileWire.edges.forEach((e, i) => {
    for (const g of drainList(builder.Generated(e.wrapped))) sides.set(hashOf(g), `${id}/side${i}`);
  });
  const caps = new Map<number, string>();
  try { caps.set(hashOf(builder.FirstShape()), `${id}/start`); } catch { /* no start cap */ }
  try { caps.set(hashOf(builder.LastShape()), `${id}/end`); } catch { /* no end cap */ }

  const res = namesFromHistory(shape, id, caps, sides);
  progress.delete();
  builder.delete();
  return res;
}

/** Loft through 2+ profile regions (in order) into a solid. Built on raw OCCT
 *  `BRepOffsetAPI_ThruSections` so faces are named from history: one lateral
 *  face per section edge (`GeneratedFace`) + the start/end caps. */
function loftBody(profiles: RegionProfile[], id: string): NamedShape {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const oc = getOC() as any;
  const wires = profiles.map(
    (p) => (profileDrawing(p).sketchOnPlane(planeOf(p.frame)) as unknown as Sketch).wire,
  );
  const builder = new oc.BRepOffsetAPI_ThruSections(true, false, 1e-6); // solid, smooth
  for (const w of wires) builder.AddWire(w.wrapped);
  const progress = new oc.Message_ProgressRange_1();
  builder.Build(progress);
  const shape = cast(builder.Shape()) as Shape3D;

  // Lateral faces: each edge of the first section generates one side face strip.
  const sides = new Map<number, string>();
  wires[0].edges.forEach((e, i) => {
    const gf = builder.GeneratedFace(e.wrapped);
    if (gf && !gf.IsNull()) sides.set(hashOf(gf), `${id}/side${i}`);
  });
  const caps = new Map<number, string>();
  try { caps.set(hashOf(builder.FirstShape()), `${id}/start`); } catch { /* no start cap */ }
  try { caps.set(hashOf(builder.LastShape()), `${id}/end`); } catch { /* no end cap */ }

  const res = namesFromHistory(shape, id, caps, sides);
  progress.delete();
  builder.delete();
  return res;
}

/** Resolve a sketch-region profile to the OCCT face it extrudes and the
 *  outward direction (its frame normal). */
function sketchRegionFace(
  profile: Extract<ResolvedFeature, { type: "extrude" }>["profile"] & { kind: "sketchRegion" },
): { face: Face; normal: Vector } {
  const { outline, frame } = profile;
  if (outline.length < 3) throw new Error("extrude: profile needs at least 3 points");
  const plane = planeOf(frame);
  let pen = draw().movePointerTo(outline[0]);
  for (let i = 1; i < outline.length; i++) pen = pen.lineTo(outline[i]);
  const face = (pen.close().sketchOnPlane(plane) as { face(): Face }).face();
  return { face, normal: new Vector(frame.normal) };
}

/** Build a closed 2D blueprint from a flattened polygon ring (already in the
 *  sketch's u,v convention), dropping the clipper's duplicated closing point. */
function ringToBlueprint(ring: [number, number][]): Blueprint {
  const closed =
    ring.length > 1 &&
    ring[0][0] === ring[ring.length - 1][0] &&
    ring[0][1] === ring[ring.length - 1][1];
  const pts = closed ? ring.slice(0, -1) : ring;
  const sk = new BlueprintSketcher();
  sk.movePointerTo(pts[0]);
  for (let i = 1; i < pts.length; i++) sk.lineTo(pts[i]);
  return sk.close();
}

/** Bake a text profile to OCCT faces — one per fillable glyph polygon, each
 *  carrying its counters as inner hole wires — plus the sketch-plane normal.
 *  The glyph outlines are resolved in 2D first (`glyphFillPolygons`) so that
 *  overlapping / self-intersecting strokes fill correctly (the stem∩arch of
 *  h/m/n, the crossing strokes of v/w/x/y, the bowl of e, the t crossbar; see
 *  src/kernel/glyphFill.ts for the root cause). Curves become fine polylines.
 *  Each polygon is built at the origin baseline-left, then rotated (CCW about
 *  the anchor) and translated to the entity's u,v anchor — matching the
 *  on-screen preview. Requires `ensureFont()` to have resolved first. */
function sketchTextFaces(
  profile: Extract<ResolvedFeature, { type: "extrude" }>["profile"] & { kind: "sketchText" },
): { faces: Face[]; normal: Vector } {
  const { value, height, rotation, anchor, frame } = profile;
  if (!sketchFont) throw new Error("extrude: text font not loaded");
  const path = sketchFont.getPath(value, 0, 0, height);
  // Flatten tolerance scales with text height so facets stay small but the face
  // count stays modest (a denser flatten makes the per-glyph extrude/mesh slow).
  const polygons = glyphFillPolygons(path.commands, Math.max(0.1, height * 0.04));
  const rotationDeg = (rotation * 180) / Math.PI;
  const plane = planeOf(frame);
  const faces: Face[] = [];
  for (const polygon of polygons) {
    const rings = polygon.filter((r) => r.length >= 3); // [outer, ...holes]
    if (rings.length === 0) continue;
    let bps = rings.map(ringToBlueprint);
    if (rotation) bps = bps.map((b) => b.rotate(rotationDeg, [0, 0]));
    bps = bps.map((b) => b.translate(anchor[0], anchor[1]));
    const sketch = bps.length > 1
      ? new CompoundBlueprint(bps).sketchOnPlane(plane)
      : bps[0].sketchOnPlane(plane);
    faces.push(sketch.face());
  }
  if (faces.length === 0) throw new Error("extrude: text produced no glyphs");
  return { faces, normal: new Vector(frame.normal) };
}

/** Characteristic size of a shape: its bounding-box diagonal. Geometric
 *  re-matching judges distances relative to this. */
function bboxDiagonal(shape: Shape3D): number {
  const [min, max] = shape.boundingBox.bounds;
  return Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]);
}

/** A non-fatal, per-feature notice (reference re-matched / partially lost),
 *  surfaced in the timeline next to the feature. */
type Warn = (msg: string) => void;

/** Resolve a face reference to its OCCT face and outward normal.
 *  Resolution order (the topological-naming strategy):
 *  1. the persistent name (survives most edits via construction history);
 *  2. if the name is gone (an upstream edit split/merged/renamed topology),
 *     a SCORED geometric match against the stored fingerprint (centroid +
 *     normal), rejected when nothing is plausibly the same face — a warning
 *     is emitted on success, a descriptive error thrown on rejection;
 *  3. a legacy ref with no name at all keeps the old unconditional
 *     nearest-centroid behaviour (no fingerprint to judge plausibility by). */
function bodyProfileFace(
  src: Body,
  faceName: string | undefined,
  center: [number, number, number],
  refNormal?: [number, number, number],
  warn?: Warn,
  what = "face",
): { face: Face; normal: Vector } {
  const faces = src.shape.faces;
  if (faces.length === 0) throw new Error(`${what}: source body has no faces`);
  if (faceName) {
    for (const f of faces) {
      if (src.names.get(f.hashCode) === faceName) return { face: f, normal: f.normalAt() };
    }
    // Name gone — geometric fallback with a plausibility threshold.
    const candidates: FaceCandidate[] = faces.map((f) => ({
      center: f.center.toTuple() as [number, number, number],
      normal: f.geomType === "PLANE" ? (f.normalAt().normalized().toTuple() as [number, number, number]) : undefined,
    }));
    const m = matchFace({ center, normal: refNormal }, candidates, bboxDiagonal(src.shape));
    if (!m) {
      throw new Error(
        `${what} "${faceName}" no longer exists on the body and nothing similar was found — edit the feature to re-pick it`,
      );
    }
    const face = faces[m.index];
    const nowName = src.names.get(face.hashCode);
    warn?.(
      `${what} "${faceName}" was renamed by an upstream edit; re-matched geometrically${nowName ? ` (now "${nowName}")` : ""}`,
    );
    return { face, normal: face.normalAt() };
  }
  // Legacy centre-only reference: nearest centroid, as before.
  let best: Face = faces[0];
  let bestDist = Infinity;
  for (const f of faces) {
    const c = f.center.toTuple();
    const d = (c[0] - center[0]) ** 2 + (c[1] - center[1]) ** 2 + (c[2] - center[2]) ** 2;
    if (d < bestDist) { bestDist = d; best = f; }
  }
  return { face: best, normal: best.normalAt() };
}

/** The line two planes (each `origin` + `normal`) share, or null if parallel —
 *  same math as `planeIntersectionLine` in document/planes.ts. `origin` is the
 *  foot of the perpendicular from the world origin onto that line. */
function intersectPlanes(
  o1: V3, n1: V3, o2: V3, n2: V3,
): { origin: V3; dir: V3 } | null {
  const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const dir = cross(n1, n2);
  const denom = dot(dir, dir);
  if (denom < 1e-12) return null;
  const d1 = dot(n1, o1), d2 = dot(n2, o2);
  const t1 = cross(n2, dir), t2 = cross(dir, n1);
  const origin: V3 = [
    (d1 * t1[0] + d2 * t2[0]) / denom,
    (d1 * t1[1] + d2 * t2[1]) / denom,
    (d1 * t1[2] + d2 * t2[2]) / denom,
  ];
  return { origin, dir };
}

/** Resolve a body face armed as a revolve axis to a world line (origin + dir):
 *  a planar face → the line where its plane meets the profile plane; a
 *  cylindrical/conical face → that surface's own central axis. */
function faceRevolveAxis(
  body: Body,
  faceName: string | undefined,
  center: V3,
  profileFrame: RegionProfile["frame"],
  refNormal?: V3,
  warn?: Warn,
): { origin: V3; dir: V3 } {
  const { face } = bodyProfileFace(body, faceName, center, refNormal, warn, "revolve axis face");
  const gt = face.geomType;
  if (gt === "CYLINDRE" || gt === "CONE") {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const oc = getOC() as any;
    const ad = new oc.BRepAdaptor_Surface_2(face.wrapped, false);
    const ax1 = gt === "CYLINDRE" ? ad.Cylinder().Axis() : ad.Cone().Axis();
    const loc = ax1.Location();
    const d = ax1.Direction();
    const out = { origin: [loc.X(), loc.Y(), loc.Z()] as V3, dir: [d.X(), d.Y(), d.Z()] as V3 };
    ad.delete();
    return out;
  }
  // Planar (or any other) face: intersect its plane with the profile plane.
  const line = intersectPlanes(
    face.center.toTuple(), face.normalAt().toTuple(),
    profileFrame.origin, profileFrame.normal,
  );
  if (!line) throw new Error("revolve: axis face is parallel to the profile plane (no intersection line)");
  return line;
}

/** A prism length, starting anywhere on `face`, guaranteed to clear past every
 *  point of `target` regardless of direction: the distance between the two
 *  shapes' bounding-box centers plus both boxes' half-diagonals, plus a
 *  small margin. Generous on purpose — the boolean op that follows (fuse/cut)
 *  clips the result to the target's actual shape either way, so all this
 *  needs to guarantee is "long enough to fully pass through". */
function throughAllLength(face: Face, target: Shape3D): number {
  const halfDiagonal = (bounds: [[number, number, number], [number, number, number]]) => {
    const [min, max] = bounds;
    return Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]) / 2;
  };
  const fb = face.boundingBox;
  const tb = target.boundingBox;
  const centerDist = Math.hypot(
    fb.center[0] - tb.center[0],
    fb.center[1] - tb.center[1],
    fb.center[2] - tb.center[2],
  );
  return centerDist + halfDiagonal(fb.bounds) + halfDiagonal(tb.bounds) + 1;
}

/** The signed prism length that carries `profileFace` from its plane up to the
 *  plane of `targetFace`, measured along the extrude direction `dir`. Positive
 *  or negative — the target face decides the direction, so "up to face" ignores
 *  the Flip toggle. Throws when the direction is parallel to the target (never
 *  reaches it) or the target passes through the profile (zero travel). */
function upToFaceLength(profileFace: Face, dir: Vector, targetFace: Face, targetNormal: Vector): number {
  const p = profileFace.center.toTuple();
  const q = targetFace.center.toTuple();
  const n = dir.normalized().toTuple();
  const m = targetNormal.normalized().toTuple();
  const denom = n[0] * m[0] + n[1] * m[1] + n[2] * m[2];
  if (Math.abs(denom) < 1e-7) {
    throw new Error("up to face: the extrude direction is parallel to the target face");
  }
  const t = ((q[0] - p[0]) * m[0] + (q[1] - p[1]) * m[1] + (q[2] - p[2]) * m[2]) / denom;
  if (Math.abs(t) < 1e-6) {
    throw new Error("up to face: the target face passes through the profile");
  }
  return t;
}

/** The signed prism length(s) to build for a given extent — one length for
 *  "blind"/"throughAll", two (equal and opposite) for "symmetric" whose union
 *  is fused into the final tool. "throughAll" only has a target to size
 *  against for add/remove; with no target (or "new") it falls back to the
 *  literal blind distance. */
function extrudeLengths(extent: ExtrudeExtent, distance: number, face: Face, targets: Body[]): number[] {
  if (extent === "symmetric") return [distance / 2, -distance / 2];
  if (extent === "throughAll" && targets.length > 0) {
    return [Math.max(...targets.map((t) => throughAllLength(face, t.shape)))];
  }
  return [distance];
}

/** Fuse, cut, or intersect (common) two named shapes, propagating face names
 *  through the boolean's history: a result face inherits its source face's name
 *  (Modified images, or the unchanged passthrough); collisions get a #n suffix. */
function booleanNamed(op: "fuse" | "cut" | "common", base: NamedShape, tool: NamedShape): NamedShape {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const oc = getOC() as any;
  const progress = new oc.Message_ProgressRange_1();
  // Low-level construction (empty ctor + SetArguments/SetTools) so we can set a
  // fuzzy value before Build — the (S1,S2,PR) ctor performs the op immediately,
  // leaving no window to configure it. args = base, tools = tool (for cut this
  // is base − tool).
  const builder =
    op === "fuse" ? new oc.BRepAlgoAPI_Fuse_1()
    : op === "cut" ? new oc.BRepAlgoAPI_Cut_1()
    : new oc.BRepAlgoAPI_Common_1();
  const args = new oc.TopTools_ListOfShape_1();
  args.Append_1(base.shape.wrapped);
  const tools = new oc.TopTools_ListOfShape_1();
  tools.Append_1(tool.shape.wrapped);
  builder.SetArguments(args);
  builder.SetTools(tools);
  if (BOOL_FUZZY > 0) builder.SetFuzzyValue(BOOL_FUZZY);
  builder.Build(progress);
  const shape = cast(builder.Shape()) as Shape3D;

  const names = new Map<number, string>();
  const used = new Map<string, number>();
  const assign = (h: number, name: string) => {
    const c = used.get(name) ?? 0;
    used.set(name, c + 1);
    names.set(h, c === 0 ? name : `${name}#${c}`);
  };
  for (const input of [base, tool]) {
    for (const f of input.shape.faces) {
      const nm = input.names.get(f.hashCode);
      if (!nm) continue;
      if (builder.IsDeleted(f.wrapped)) continue;
      const images = drainList(builder.Modified(f.wrapped));
      if (images.length === 0) names.set(f.hashCode, nm); // unchanged passthrough
      else for (const img of images) assign(hashOf(img), nm);
    }
  }
  builder.delete();
  args.delete();
  tools.delete();
  progress.delete();
  return { shape, names };
}

function requireBody(bodies: Body[], id: string): Body {
  const b = bodies.find((x) => x.id === id);
  if (!b) throw new Error("source body not found");
  return b;
}

/** Edge names are DERIVED from face names: an edge is the intersection of two
 *  faces, so its name is the sorted pair of their names (e.g. "id/+x∩id/+z").
 *  Stable wherever both adjacent faces are named. Returns hashCode -> name. */
function edgeNamesFrom(shape: Shape3D, faceNames: Map<number, string>): Map<number, string> {
  const adj = new Map<number, string[]>();
  for (const f of shape.faces) {
    const fn = faceNames.get(f.hashCode);
    if (!fn) continue;
    for (const e of f.edges) {
      const arr = adj.get(e.hashCode) ?? [];
      arr.push(fn);
      adj.set(e.hashCode, arr);
    }
  }
  const names = new Map<number, string>();
  const used = new Map<string, number>();
  for (const [h, fns] of adj) {
    if (fns.length < 2) continue; // need both adjacent faces named
    const base = [...fns].sort().join("∩");
    const c = used.get(base) ?? 0;
    used.set(base, c + 1);
    names.set(h, c === 0 ? base : `${base}#${c}`);
  }
  return names;
}

/** Re-resolve a dress-up's stored edge references against the body's current
 *  edges: exact persistent name first; when names churned (an upstream edit
 *  split/merged faces), a suffix-insensitive base-name match, then a geometric
 *  match on the stored fingerprint (bbox-centre + length). Emits a warning for
 *  every re-matched or lost edge; only outright-lost edges are dropped. */
function resolveDressUpEdges(
  target: Body,
  edgeNames: string[],
  edgeRefs: ResolvedEdgeRef[] | undefined,
  warn: Warn | undefined,
): { hits: Edge[]; lost: string[] } {
  const targetEdgeNames = edgeNamesFrom(target.shape, target.names);
  const edges = target.shape.edges;

  // Fast path: every requested name still exists — no fingerprinting needed.
  const byName = new Map<string, number>();
  edges.forEach((e, i) => {
    const nm = targetEdgeNames.get(e.hashCode);
    if (nm !== undefined && !byName.has(nm)) byName.set(nm, i);
  });
  if (edgeNames.every((nm) => byName.has(nm))) {
    return { hits: edgeNames.map((nm) => edges[byName.get(nm)!]), lost: [] };
  }

  // Slow path: build geometric candidates and match all refs one-to-one.
  const candidates: EdgeCandidate[] = edges.map((e) => {
    let length = 0;
    try { length = e.length; } catch { /* degenerate edge — mid still matches */ }
    return {
      name: targetEdgeNames.get(e.hashCode),
      mid: e.boundingBox.center as [number, number, number],
      length,
    };
  });
  const refs = edgeNames.map((nm, i) => ({
    name: nm,
    mid: edgeRefs?.[i]?.mid,
    length: edgeRefs?.[i]?.length,
  }));
  const matches = matchEdges(refs, candidates, bboxDiagonal(target.shape));

  const hits: Edge[] = [];
  const lost: string[] = [];
  matches.forEach((m, i) => {
    if (m.kind === "lost") {
      lost.push(edgeNames[i]);
      return;
    }
    hits.push(edges[m.index]);
    if (m.kind !== "name") {
      const nowName = candidates[m.index].name;
      warn?.(
        `edge "${edgeNames[i]}" was renamed by an upstream edit; re-matched ` +
          `${m.kind === "base" ? "by base name" : "geometrically"}${nowName ? ` (now "${nowName}")` : ""}`,
      );
    }
  });
  return { hits, lost };
}

/** Chamfer or fillet the named edges of a body, propagating face names through
 *  the operation's history (modified faces keep their names; the new bevel/round
 *  faces are named after the feature). Modifies geometry; returns a NamedShape. */
function dressUpNamed(
  op: "chamfer" | "fillet",
  target: Body,
  edgeNames: string[],
  edgeRefs: ResolvedEdgeRef[] | undefined,
  size: number,
  id: string,
  warn?: Warn,
): NamedShape {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const oc = getOC() as any;
  const { hits, lost } = resolveDressUpEdges(target, edgeNames, edgeRefs, warn);
  if (hits.length === 0) {
    throw new Error(
      `${op}: none of the edges could be re-found on the body (an upstream edit changed its shape) — edit the feature to re-pick them`,
    );
  }
  if (lost.length > 0) {
    warn?.(
      `${lost.length} of ${edgeNames.length} edges could not be re-found and were skipped: ${lost.join(", ")} — edit the feature to re-pick them`,
    );
  }
  const builder =
    op === "fillet"
      ? new oc.BRepFilletAPI_MakeFillet(target.shape.wrapped, oc.ChFi3d_FilletShape.ChFi3d_Rational)
      : new oc.BRepFilletAPI_MakeChamfer(target.shape.wrapped);

  const dressed: Topo[] = [];
  for (const e of hits) {
    builder.Add_2(size, e.wrapped);
    dressed.push(e.wrapped);
  }
  const progress = new oc.Message_ProgressRange_1();
  builder.Build(progress);
  const shape = cast(builder.Shape()) as Shape3D;

  const names = new Map<number, string>();
  const used = new Map<string, number>();
  const assign = (h: number, name: string) => {
    const c = used.get(name) ?? 0;
    used.set(name, c + 1);
    names.set(h, c === 0 ? name : `${name}#${c}`);
  };
  for (const f of target.shape.faces) {
    const nm = target.names.get(f.hashCode);
    if (!nm || builder.IsDeleted(f.wrapped)) continue;
    const images = drainList(builder.Modified(f.wrapped));
    if (images.length === 0) names.set(f.hashCode, nm);
    else for (const img of images) assign(hashOf(img), nm);
  }
  // The new bevel/round faces, generated from each dressed edge.
  for (const e of dressed) {
    for (const g of drainList(builder.Generated(e))) assign(hashOf(g), `${id}/${op}`);
  }
  builder.delete();
  return { shape, names };
}

const AXIS_DIR: Record<"x" | "y" | "z", [number, number, number]> = {
  x: [1, 0, 0],
  y: [0, 1, 0],
  z: [0, 0, 1],
};

/** Apply a single rigid gp_Trsf to a named shape, propagating face names through
 *  the transform's ModifiedShape map. A rigid motion preserves topology 1:1 —
 *  only hashCodes change — so we re-key the name map by each face's image. */
function applyTrsf(target: NamedShape, trsf: Topo): NamedShape {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const oc = getOC() as any;
  const builder = new oc.BRepBuilderAPI_Transform_2(target.shape.wrapped, trsf, true);
  const shape = cast(builder.ModifiedShape(target.shape.wrapped)) as Shape3D;
  const names = new Map<number, string>();
  for (const f of target.shape.faces) {
    const nm = target.names.get(f.hashCode);
    if (!nm) continue;
    names.set(hashOf(builder.ModifiedShape(f.wrapped)), nm);
  }
  builder.delete();
  return { shape, names };
}

/** Translate + rotate a body in place (rotation about pivot/axis first, then
 *  translation). Returns a FRESH NamedShape distinct from `target` (the caller
 *  disposes the original); names pass through unchanged since topology doesn't. */
function transformNamed(
  target: Body,
  t: Extract<ResolvedFeature, { type: "transform" }>,
): NamedShape {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const oc = getOC() as any;
  let cur: NamedShape = target;
  let owned = false; // cur.shape is our allocation (not the target's original)
  const step = (trsf: Topo) => {
    const next = applyTrsf(cur, trsf);
    if (owned) cur.shape.delete();
    cur = next;
    owned = true;
    trsf.delete();
  };

  if (t.angle !== 0) {
    const [dx, dy, dz] = AXIS_DIR[t.axis];
    const origin = new oc.gp_Pnt_3(t.pivot[0], t.pivot[1], t.pivot[2]);
    const dir = new oc.gp_Dir_4(dx, dy, dz);
    const ax1 = new oc.gp_Ax1_2(origin, dir);
    const rot = new oc.gp_Trsf_1();
    rot.SetRotation_1(ax1, (t.angle * Math.PI) / 180);
    step(rot);
    ax1.delete();
    dir.delete();
    origin.delete();
  }

  // The translation step ALWAYS runs (even at zero) so the result is a fresh
  // shape the caller can swap in before deleting the original target.
  const vec = new oc.gp_Vec_4(t.tx, t.ty, t.tz);
  const tr = new oc.gp_Trsf_1();
  tr.SetTranslation_1(vec);
  step(tr);
  vec.delete();

  return cur; // owned is always true here (translation step ran)
}

/** Repeat a named shape as rigid copies — translations (`offsets`) or rotations
 *  (`angles` about the axis line) — compounded into ONE new body; the seed is
 *  left untouched for the caller. Each copy's face names re-key 1:1 through
 *  applyTrsf and gain a per-instance `~p{i}` suffix, so the compound's name map
 *  stays collision-free and downstream picks (chamfer/up-to-face/boolean) stay
 *  unambiguous — patterns multiply topology, and this is what keeps it named. */
function patternNamed(
  target: NamedShape,
  f: Extract<ResolvedFeature, { type: "pattern" }>,
  axisOrigin?: number[],
  axisDir?: number[],
): NamedShape {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const oc = getOC() as any;
  const copies: NamedShape[] = [];
  const suffixed = (s: NamedShape, i: number): NamedShape => ({
    shape: s.shape,
    names: new Map([...s.names].map(([h, n]) => [h, `${n}~p${i}`])),
  });
  if (f.offsets && f.offsets.length > 0) {
    f.offsets.forEach((o, i) => {
      const vec = new oc.gp_Vec_4(o[0], o[1], o[2]);
      const trsf = new oc.gp_Trsf_1();
      trsf.SetTranslation_1(vec);
      copies.push(suffixed(applyTrsf(target, trsf), i + 1));
      trsf.delete();
      vec.delete();
    });
  } else if (f.angles && f.angles.length > 0) {
    if (!axisOrigin || !axisDir) throw new Error("pattern: missing axis");
    const pnt = new oc.gp_Pnt_3(axisOrigin[0], axisOrigin[1], axisOrigin[2]);
    const dir = new oc.gp_Dir_4(axisDir[0], axisDir[1], axisDir[2]);
    const ax1 = new oc.gp_Ax1_2(pnt, dir);
    f.angles.forEach((a, i) => {
      const trsf = new oc.gp_Trsf_1();
      trsf.SetRotation_1(ax1, a);
      copies.push(suffixed(applyTrsf(target, trsf), i + 1));
      trsf.delete();
    });
    ax1.delete();
    dir.delete();
    pnt.delete();
  } else {
    throw new Error("pattern: no instances (count must be 2 or more)");
  }
  return compoundOf(copies);
}

/** Resolve a body face armed as a circular-pattern axis: a cylindrical/conical
 *  face → that surface's own central axis. Planar faces are rejected — unlike
 *  revolve there is no profile plane to intersect with. */
function facePatternAxis(
  body: Body,
  faceName: string | undefined,
  center: V3,
  refNormal?: V3,
  warn?: Warn,
): { origin: V3; dir: V3 } {
  const { face } = bodyProfileFace(body, faceName, center, refNormal, warn, "pattern axis face");
  const gt = face.geomType;
  if (gt !== "CYLINDRE" && gt !== "CONE") {
    throw new Error("pattern: the axis face must be cylindrical or conical (its own axis is the pattern axis)");
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const oc = getOC() as any;
  const ad = new oc.BRepAdaptor_Surface_2(face.wrapped, false);
  const ax1 = gt === "CYLINDRE" ? ad.Cylinder().Axis() : ad.Cone().Axis();
  const loc = ax1.Location();
  const d = ax1.Direction();
  const out = { origin: [loc.X(), loc.Y(), loc.Z()] as V3, dir: [d.X(), d.Y(), d.Z()] as V3 };
  ad.delete();
  return out;
}

/** Mirror a named shape across the plane through `origin` with `normal`. A
 *  reflection is a rigid (topology-preserving) gp_Trsf, so face names re-key 1:1
 *  through applyTrsf, like a transform. */
function mirrorNamed(target: NamedShape, origin: number[], normal: number[], _id: string): NamedShape {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const oc = getOC() as any;
  const pnt = new oc.gp_Pnt_3(origin[0], origin[1], origin[2]);
  const dir = new oc.gp_Dir_4(normal[0], normal[1], normal[2]);
  const ax2 = new oc.gp_Ax2_3(pnt, dir); // its XY-plane is the mirror plane
  const trsf = new oc.gp_Trsf_1();
  trsf.SetMirror_3(ax2);
  const res = applyTrsf(target, trsf);
  trsf.delete();
  ax2.delete();
  dir.delete();
  pnt.delete();
  return res;
}

// Relative epsilon (vs. the larger operand's volume) for "did this boolean
// actually do anything" — non-overlapping solids that OCCT happily combines
// into a degenerate result are caught and reported instead.
const VOLUME_EPS_REL = 1e-6;
const BOOL_OCC: Record<BooleanOp, "fuse" | "cut" | "common"> = {
  union: "fuse",
  subtract: "cut",
  intersect: "common",
};

/** Number of solids in a shape. A successful union of two bodies — whether they
 *  overlap OR merely touch along a shared face — yields a single connected
 *  solid; two solids that don't meet at all stay as two solids in a compound.
 *  Counting solids therefore distinguishes "joined" from "disjoint" where volume
 *  can't (touching bodies share no volume, so union volume == the sum either way). */
function countSolids(shape: Shape3D): number {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const oc = getOC() as any;
  const exp = new oc.TopExp_Explorer_2(
    shape.wrapped,
    oc.TopAbs_ShapeEnum.TopAbs_SOLID,
    oc.TopAbs_ShapeEnum.TopAbs_SHAPE,
  );
  let n = 0;
  while (exp.More()) { n++; exp.Next(); }
  exp.delete();
  return n;
}

/** Combine operand bodies left-to-right with name propagation, validating that
 *  the solids actually overlap. Returns a fresh NamedShape; the operand bodies'
 *  shapes are left for the caller to dispose (after removing them from the set). */
function combineBodies(op: BooleanOp, operandIds: string[], bodies: Body[]): NamedShape {
  const ops = operandIds.map((id) => requireBody(bodies, id));
  if (ops.length < 2) throw new Error("A boolean needs at least two operands.");
  let acc: NamedShape = { shape: ops[0].shape, names: ops[0].names };
  // Volume integration (BRepGProp) is expensive on complex solids; a UNION's
  // validity uses countSolids, not volume, so compute volumes lazily and only
  // for subtract/intersect. `accVol` tracks the running result's volume there.
  let accVol = op === "union" ? 0 : measureVolume(acc.shape);
  let accIsIntermediate = false;
  for (let i = 1; i < ops.length; i++) {
    const next = booleanNamed(BOOL_OCC[op], acc, ops[i]);
    // A union is valid when it actually joins the bodies into fewer solids —
    // true for overlapping AND merely-touching (shared-face) bodies, which have
    // no shared volume and so can't be told apart from disjoint by volume alone.
    // Subtract/intersect still go by volume (nothing removed / no common volume).
    let bad: string | false;
    if (op === "union") {
      bad =
        countSolids(next.shape) >= countSolids(acc.shape) + countSolids(ops[i].shape) &&
        "Solids don't touch — union needs bodies that overlap or share a face.";
    } else {
      const toolVol = measureVolume(ops[i].shape);
      const nextVol = measureVolume(next.shape);
      const eps = VOLUME_EPS_REL * Math.max(accVol, toolVol, 1);
      bad =
        op === "subtract"
          ? nextVol >= accVol - eps && "Solids don't overlap — nothing to subtract."
          : nextVol <= eps && "Solids don't overlap — no common volume.";
      accVol = nextVol;
    }
    if (bad) {
      next.shape.delete();
      if (accIsIntermediate) acc.shape.delete();
      throw new Error(bad);
    }
    if (accIsIntermediate) acc.shape.delete();
    acc = next;
    accIsIntermediate = true;
  }
  return acc;
}

// --- Incremental regen caches (persist across regenerate calls) ---
// The worker is long-lived, so we keep two caches keyed by content hashes:
//  • builderCache — the canonical OCCT shape of each PURE builder (sweep/loft/
//    revolve/primitive/import; they read only their own resolved params, never
//    other bodies). Rebuilding these (solving a pipe-shell, lofting sections) is
//    the dominant cost; on a cache hit we hand the fold a cheap BRepBuilderAPI_
//    Copy instead of re-solving. The canonical is cache-owned and NEVER given to
//    the fold, so the fold's existing consume/delete logic can't corrupt it.
//  • meshCache — the tessellation of each surviving body, keyed by its content
//    key, so an unchanged body isn't re-meshed.
// Both are swept after each regenerate: entries whose key wasn't used this run
// are disposed (bounded memory; nothing lingers for deleted/edited features).
const builderCache = new Map<string, NamedShape>();
const meshCache = new Map<string, { faces: MeshedFaces; edges: MeshedEdges }>();

// --- Regen profiling (dev): per-feature build ms + per-body mesh ms, logged
// once per regen. `hit` = the pure-builder canonical was already cached. Set
// REGEN_PROFILE=false to silence. ---
const REGEN_PROFILE = false;
type FeatureTiming = { id: string; type: string; ms: number };

/** cyrb53 — a fast, well-distributed 53-bit string hash. Used to keep content
 *  keys short and bounded (combining keys down a long feature chain would grow
 *  without a hash). Collisions are astronomically unlikely at our scale. */
function hashKey(str: string): string {
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

/** A pure builder's content key: just its resolved feature (no body inputs). */
const builderKey = (feature: ResolvedFeature) => hashKey(JSON.stringify(feature));
/** A derived body's content key: its feature plus the keys of the bodies it read. */
const contentKey = (feature: ResolvedFeature, inputKeys: string[]) =>
  hashKey(JSON.stringify(feature) + "|" + inputKeys.join("|"));

/** Duplicate a named shape (geometry + topology) without re-solving it, by
 *  applying an IDENTITY rigid transform with copy=true — the single OCCT build
 *  doesn't bind BRepBuilderAPI_Copy, but an identity Transform copies all the
 *  same (and re-keys the name map through its history, exactly like applyTrsf).
 *  Cheap relative to rebuilding a swept/lofted body from scratch. */
function copyNamed(src: NamedShape): NamedShape {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const oc = getOC() as any;
  const trsf = new oc.gp_Trsf_1(); // identity
  const res = applyTrsf(src, trsf);
  trsf.delete();
  return res;
}

/** Build a pure builder's shape, reusing the cached canonical when its inputs
 *  are unchanged. Always returns a fresh COPY for the fold to own/consume; the
 *  canonical stays in the cache. `used` collects hit keys for post-run eviction. */
function buildCached(key: string, used: Set<string>, build: () => NamedShape): NamedShape {
  used.add(key);
  let entry = builderCache.get(key);
  if (!entry) {
    entry = build();
    builderCache.set(key, entry);
  }
  return copyNamed(entry);
}

// The running-result model: replay features in order, folding each over a
// running set of bodies. A sketch/face profile becomes a solid; mode "new" adds
// it as its own body, while "add"/"remove" fuse/cut it into target bodies in
// place (preserving their ids). A body's id is the feature that produced (or
// last started) it. Callers either tessellate the survivors (regenerate) or
// export one (exportBody); both must delete the body shapes when done.
function buildBodies(
  features: ResolvedFeature[],
  used: Set<string> = new Set(),
): { bodies: Body[]; failures: RegenFeatureResult[]; timings: FeatureTiming[]; warnings: Record<string, string> } {
  const bodies: Body[] = [];
  const failures: RegenFeatureResult[] = [];
  const timings: FeatureTiming[] = [];
  // Non-fatal notices per feature id (references re-matched / partially lost),
  // surfaced in the timeline so a fragile reference is visible, not silent.
  const warnings: Record<string, string> = {};
  // Current content key of the body under a given id (read before mutations).
  const keyOf = (id: string): string => bodies.find((b) => b.id === id)?.key ?? id;

  for (const feature of features) {
    const t0 = performance.now();
    const warn: Warn = (msg) => {
      warnings[feature.id] = warnings[feature.id] ? `${warnings[feature.id]}; ${msg}` : msg;
    };
    try {
      if (feature.type === "primitive") {
        const key = builderKey(feature);
        bodies.push({ id: feature.id, key, ...buildCached(key, used, () => buildPrimitive(feature)) });
      } else if (feature.type === "import") {
        const key = builderKey(feature);
        bodies.push({ id: feature.id, key, ...buildCached(key, used, () => importStepNamed(feature.source, feature.id)) });
      } else if (feature.type === "extrude") {
        const { profile, flip, distance, extent, mode } = feature;
        // A "remove" cuts *into* the body, so its natural direction is opposite
        // the profile normal — the Flip toggle then reverses that. New/Add follow
        // the normal outward.
        const dirFlip = mode === "remove" ? !flip : flip;

        // Merge scope: the user-chosen target body (add/remove now require one),
        // falling back to the face's source body if none was specified. Resolved
        // up front (rather than after building the tool, as before) because
        // extent "throughAll" needs the target's geometry to size the tool.
        const targetId =
          mode !== "new" ? feature.targetId ?? (profile.kind === "bodyFace" ? profile.sourceId : undefined) : undefined;
        const targets = targetId ? bodies.filter((b) => b.id === targetId) : [];

        // One profile face for region/body-face; many (one per glyph) for text.
        let faces: Face[];
        let normal: Vector;
        if (profile.kind === "sketchRegion") {
          const r = sketchRegionFace(profile);
          faces = [r.face]; normal = r.normal;
        } else if (profile.kind === "sketchText") {
          const r = sketchTextFaces(profile);
          faces = r.faces; normal = r.normal;
        } else {
          const r = bodyProfileFace(
            requireBody(bodies, profile.sourceId), profile.faceName, profile.center, profile.normal, warn, "profile face",
          );
          faces = [r.face]; normal = r.normal;
        }
        const face = faces[0]; // representative for through-all / up-to-face sizing

        const sign = dirFlip ? -1 : 1;
        // "Up to face" derives its own signed length (and direction) from the
        // chosen target face's plane, so it bypasses the Flip/sign handling.
        let lengths: number[];
        if (extent === "upToFace" && feature.upTo) {
          const upBody = requireBody(bodies, feature.upTo.sourceId);
          const up = bodyProfileFace(
            upBody, feature.upTo.faceName, feature.upTo.center, feature.upTo.normal, warn, "up-to face",
          );
          lengths = [upToFaceLength(face, normal, up.face, up.normal)];
        } else {
          lengths = extrudeLengths(extent, distance, face, targets).map((l) => l * sign);
        }
        // Prism every face (one per glyph for text) at every length (two for
        // symmetric). The symmetric halves of a SINGLE face touch at the profile
        // plane, so they're fused into one solid; distinct glyph faces are
        // disjoint, so they're collected into a COMPOUND rather than boolean-fused
        // (fusing dozens of glyphs is the bottleneck that made long text time out).
        // A single-face profile keeps the feature id as its name prefix; text
        // scopes each glyph as `${id}/g{n}` so the glyph faces stay distinct.
        const glyphSolids: NamedShape[] = [];
        for (let gi = 0; gi < faces.length; gi++) {
          const prefix = faces.length > 1 ? `${feature.id}/g${gi}` : feature.id;
          let glyph: NamedShape | null = null;
          for (const len of lengths) {
            const piece = prismFromFace(faces[gi], normal, len, prefix);
            if (glyph === null) {
              glyph = piece;
            } else {
              const fused = booleanNamed("fuse", glyph, piece);
              glyph.shape.delete();
              piece.shape.delete();
              glyph = fused;
            }
          }
          if (glyph) glyphSolids.push(glyph);
        }
        let built: NamedShape | null =
          glyphSolids.length === 0 ? null
          : glyphSolids.length === 1 ? glyphSolids[0]
          : compoundOf(glyphSolids);
        if (built === null) throw new Error("extrude: profile produced no geometry");

        // Content key of the swept tool: the feature plus the keys of any bodies
        // it read (a body-face profile / up-to-face target). Result keys fold in
        // the affected target's key so a cut/fuse re-meshes only when it changed.
        const toolInputKeys: string[] = [];
        if (profile.kind === "bodyFace") toolInputKeys.push(keyOf(profile.sourceId));
        if (extent === "upToFace" && feature.upTo) toolInputKeys.push(keyOf(feature.upTo.sourceId));
        const toolKey = contentKey(feature, toolInputKeys);

        if (feature.previewTool) {
          // Live-preview ghost: emit just the swept tool (the changing portion),
          // built with the real direction (dirFlip) and extent, leaving every
          // existing body untouched so they keep their own colour.
          bodies.push({ id: feature.id, key: toolKey, ...built });
        } else if (mode === "new") {
          bodies.push({ id: feature.id, key: toolKey, ...built });
        } else {
          if (targets.length === 0) {
            // Nothing to combine with: add becomes a new body, remove is a no-op.
            if (mode === "add") bodies.push({ id: feature.id, key: toolKey, ...built });
            else built.shape.delete();
          } else if (mode === "add") {
            // Fuse the tool into the targets, preserving the first target's id
            // (and propagating names through the boolean history).
            const targetKeys = targets.map((t) => t.key);
            let acc: NamedShape = built;
            for (const t of targets) {
              const next = booleanNamed("fuse", t, acc);
              acc.shape.delete();
              t.shape.delete();
              acc = next;
            }
            const keepId = targets[0].id;
            const remaining = bodies.filter((b) => !targets.includes(b));
            bodies.length = 0;
            bodies.push(...remaining, { id: keepId, key: contentKey(feature, [toolKey, ...targetKeys]), ...acc });
          } else {
            // remove: cut the tool from each target in place, preserving ids.
            for (const t of targets) {
              const next = booleanNamed("cut", t, built);
              t.shape.delete();
              t.shape = next.shape;
              t.names = next.names;
              t.key = contentKey(feature, [toolKey, t.key]);
            }
            built.shape.delete();
          }
        }
      } else if (feature.type === "dressup") {
        // Chamfer/fillet modifies the target body in place, keeping its id.
        const target = requireBody(bodies, feature.targetId);
        const res = dressUpNamed(feature.op, target, feature.edges, feature.edgeRefs, feature.size, feature.id, warn);
        target.shape.delete();
        target.shape = res.shape;
        target.names = res.names;
        target.key = contentKey(feature, [target.key]);
      } else if (feature.type === "boolean") {
        // Combine 2+ existing bodies into one, consuming the operands and
        // keeping the result keyed by this feature's id. Names propagate through
        // the boolean history so the result's faces/edges stay referenceable.
        // CACHED by content key: OCCT booleans on complex solids are by far the
        // dominant regen cost (seconds each), so on unchanged operands we reuse a
        // cheap copy instead of recomputing the fuse/cut. The operands are still
        // built (cheaply) and consumed below; only the boolean itself is skipped.
        const operandKeys = feature.operands.map(keyOf);
        const key = contentKey(feature, operandKeys);
        const result = buildCached(key, used, () => combineBodies(feature.op, feature.operands, bodies));
        const operandSet = new Set(feature.operands);
        const remaining: Body[] = [];
        for (const b of bodies) {
          if (operandSet.has(b.id)) b.shape.delete(); // operand consumed
          else remaining.push(b);
        }
        bodies.length = 0;
        bodies.push(...remaining, { id: feature.id, key, ...result });
      } else if (feature.type === "transform") {
        const target = requireBody(bodies, feature.targetId);
        const key = contentKey(feature, [target.key]);
        const res = transformNamed(target, feature);
        if (feature.copy) {
          // Keep the original; add the transformed copy as a NEW body keyed by
          // this feature (transformNamed builds a fresh shape, never consuming
          // the target).
          bodies.push({ id: feature.id, key, ...res });
        } else {
          // Move the target in place, keeping its id and names.
          target.shape.delete();
          target.shape = res.shape;
          target.names = res.names;
          target.key = key;
        }
      } else if (feature.type === "mirror") {
        // Reflect the target across the plane; keep the original, add the
        // mirrored body as a NEW body keyed by this feature.
        const src = requireBody(bodies, feature.targetId);
        const res = mirrorNamed(src, feature.origin, feature.normal, feature.id);
        bodies.push({ id: feature.id, key: contentKey(feature, [src.key]), ...res });
      } else if (feature.type === "pattern") {
        // Repeat the target as rigid copies compounded into ONE new body keyed
        // by this feature; the seed body is kept (like mirror). A face axis
        // makes the result depend on that body's geometry, so fold its key in.
        const src = requireBody(bodies, feature.targetId);
        let axisOrigin = feature.axisOrigin as number[] | undefined;
        let axisDir = feature.axisDir as number[] | undefined;
        const depKeys = [src.key];
        if (feature.axisFace) {
          const axBody = requireBody(bodies, feature.axisFace.sourceId);
          depKeys.push(axBody.key);
          const line = facePatternAxis(
            axBody, feature.axisFace.faceName, feature.axisFace.center, feature.axisFace.normal, warn,
          );
          axisOrigin = line.origin;
          axisDir = line.dir;
        }
        const key = contentKey(feature, depKeys);
        const res = buildCached(key, used, () => patternNamed(src, feature, axisOrigin, axisDir));
        bodies.push({ id: feature.id, key, ...res });
      } else if (feature.type === "revolve") {
        if (feature.profile.kind !== "sketchRegion") throw new Error("revolve: profile must be a sketch region");
        const revProfile = feature.profile; // narrowed; used inside the build closure
        // A body-face axis is resolved here (needs the built body + profile frame);
        // sketch-line/plane axes arrive pre-baked as axisOrigin/axisDir.
        let axisOrigin = feature.axisOrigin;
        let axisDir = feature.axisDir;
        if (feature.axisFace) {
          const axBody = requireBody(bodies, feature.axisFace.sourceId);
          const line = faceRevolveAxis(
            axBody, feature.axisFace.faceName, feature.axisFace.center, feature.profile.frame, feature.axisFace.normal, warn,
          );
          axisOrigin = line.origin;
          axisDir = line.dir;
        }
        if (!axisOrigin || !axisDir) throw new Error("revolve: missing axis");
        const ao = axisOrigin, ad = axisDir;
        // A body-face axis makes the result depend on that body's geometry, so
        // fold its key in; a baked line axis is fully captured by the feature.
        const key = feature.axisFace
          ? contentKey(feature, [keyOf(feature.axisFace.sourceId)])
          : builderKey(feature);
        const built = buildCached(key, used, () =>
          revolveSketchRegion(revProfile, ao, ad, (feature.angle * Math.PI) / 180, feature.symmetric, feature.id),
        );
        bodies.push({ id: feature.id, key, ...built });
      } else if (feature.type === "sweep") {
        if (feature.profile.kind !== "sketchRegion") throw new Error("sweep: profile must be a sketch region");
        const swProfile = feature.profile; // narrowed; used inside the build closure
        const path = feature.path;
        const key = builderKey(feature);
        bodies.push({ id: feature.id, key, ...buildCached(key, used, () => sweepBody(swProfile, path, feature.id)) });
      } else if (feature.type === "loft") {
        const regions = feature.profiles.filter((p) => p.kind === "sketchRegion");
        if (regions.length < 2) throw new Error("loft: needs at least 2 sketch-region sections");
        const key = builderKey(feature);
        bodies.push({ id: feature.id, key, ...buildCached(key, used, () => loftBody(regions as Extract<ResolvedProfile, { kind: "sketchRegion" }>[], feature.id)) });
      }
    } catch (err) {
      failures.push({ id: feature.id, ok: false, error: String(err) });
    }
    timings.push({ id: feature.id, type: feature.type, ms: performance.now() - t0 });
  }
  return { bodies, failures, timings, warnings };
}

function regenerate(
  features: ResolvedFeature[],
  emit?: (result: RegenFeatureResult) => void,
): { results: RegenFeatureResult[]; warnings: Record<string, string> } {
  const buildT0 = performance.now();
  const usedBuilders = new Set<string>();
  const { bodies, failures, timings, warnings } = buildBodies(features, usedBuilders);
  const buildMs = performance.now() - buildT0;
  const meshTimings: { id: string; ms: number; hit: boolean }[] = [];
  const usedMeshes = new Set<string>();
  const meshes: RegenFeatureResult[] = bodies.map((b) => {
    let result: RegenFeatureResult;
    const mt0 = performance.now();
    const meshHit = meshCache.has(b.key);
    try {
      // Reuse a cached tessellation when this body's content is unchanged; its
      // faceGroups' build-local faceIds only need to be internally consistent
      // with the mesh being rendered (picking resolves to persistent names), so
      // the cached mesh stays valid even though the rebuilt body has fresh hashes.
      usedMeshes.add(b.key);
      let cached = meshCache.get(b.key);
      if (!cached) {
        const faces = b.shape.mesh(MESH_OPTS);
        const edges = b.shape.meshEdges(MESH_OPTS);
        // Attach each face's / edge's persistent name (matched by build-local hash)
        // so the app carries stable references across rebuilds.
        if (faces.faceGroups) {
          faces.faceGroups = faces.faceGroups.map((g) => ({ ...g, name: b.names.get(g.faceId) }));
        }
        if (edges.edgeGroups) {
          const edgeNames = edgeNamesFrom(b.shape, b.names);
          edges.edgeGroups = edges.edgeGroups.map((g) => ({ ...g, name: edgeNames.get(g.edgeId) }));
        }
        cached = { faces, edges };
        meshCache.set(b.key, cached);
      }
      result = { id: b.id, ok: true, mesh: { name: b.id, faces: cached.faces, edges: cached.edges } };
    } catch (err) {
      result = { id: b.id, ok: false, error: String(err) };
    } finally {
      b.shape.delete();
    }
    meshTimings.push({ id: b.id, ms: performance.now() - mt0, hit: meshHit });
    // Stream this body the instant it's ready so the main thread can paint it
    // without waiting for the rest of the fold (the final message is complete).
    emit?.(result);
    return result;
  });

  // Sweep both caches: drop entries not touched this run (edited/removed
  // features) so memory stays bounded and stale geometry never lingers.
  for (const k of builderCache.keys()) {
    if (!usedBuilders.has(k)) { builderCache.get(k)!.shape.delete(); builderCache.delete(k); }
  }
  for (const k of meshCache.keys()) if (!usedMeshes.has(k)) meshCache.delete(k);

  if (REGEN_PROFILE) {
    const meshMs = meshTimings.reduce((s, m) => s + m.ms, 0);
    const short = (s: string) => s.slice(0, 8);
    const topBuild = timings.filter((t) => t.ms >= 1).sort((a, b) => b.ms - a.ms)
      .map((t) => `${short(t.id)}:${t.type}=${t.ms.toFixed(0)}`);
    const topMesh = meshTimings.filter((m) => m.ms >= 1).sort((a, b) => b.ms - a.ms)
      .map((m) => `${short(m.id)}${m.hit ? "*" : ""}=${m.ms.toFixed(0)}`);
    console.log(
      `[regen] total=${(buildMs + meshMs).toFixed(0)}ms build=${buildMs.toFixed(0)} mesh=${meshMs.toFixed(0)} ` +
      `(bodies=${bodies.length}) | build: ${topBuild.join(" ")} | mesh: ${topMesh.join(" ")} ` +
      `(build ms<10 = cache reuse; mesh * = cache hit)`,
    );
  }

  return { results: [...meshes, ...failures], warnings };
}

// Export one result body: run the same fold, pick the body whose id matches,
// and serialise it. (Exporting a single feature standalone would be wrong now —
// extrude/add/remove only make sense within the running model.)
function exportBody(features: ResolvedFeature[], bodyId: string, format: ExportFormat): Blob {
  const { bodies } = buildBodies(features);
  try {
    const target = bodies.find((b) => b.id === bodyId);
    if (!target) throw new Error("export: body not found");
    // STEP declares its unit explicitly; STL coordinates are already mm. STL
    // uses the viewport's tessellation quality (replicad's 1e-3 default makes
    // far larger files than useful for curved shapes).
    return format === "step"
      ? exportSTEP([{ shape: target.shape, name: bodyId }], { unit: "mm" })
      : target.shape.blobSTL(MESH_OPTS);
  } finally {
    for (const b of bodies) b.shape.delete();
  }
}

ctx.onmessage = async (event: MessageEvent<KernelRequest>) => {
  const req = event.data;
  try {
    await ensureOC();
    // Load the text font only when a feature actually bakes text (keeps the
    // 340 KB asset off the critical path for text-free documents).
    if (
      "features" in req &&
      req.features.some((f) => f.type === "extrude" && f.profile.kind === "sketchText")
    ) {
      await ensureFont();
    }
    let res: KernelResponse;
    switch (req.op) {
      case "regenerate": {
        const { results, warnings } = regenerate(req.features, (result) =>
          ctx.postMessage({ id: req.id, ok: true, op: "regenerate-progress", result }),
        );
        res = { id: req.id, ok: true, op: "regenerate", results, warnings };
        break;
      }
      case "export":
        res = { id: req.id, ok: true, op: "export", blob: exportBody(req.features, req.bodyId, req.format) };
        break;
      default:
        throw new Error(`Unknown kernel op: ${(req as { op: string }).op}`);
    }
    ctx.postMessage(res);
  } catch (err) {
    ctx.postMessage({ id: req.id, ok: false, error: String(err) } as KernelResponse);
  }
};
