// The kernel Web Worker: hosts the heavy OCCT WASM module and replicad so the
// UI thread never blocks on geometry regeneration. It builds each feature in a
// document and returns tessellated meshes (or a per-feature error).

import opencascade from "replicad-opencascadejs/src/replicad_single.js";
import opencascadeWasm from "replicad-opencascadejs/src/replicad_single.wasm?url";
import {
  setOC, makeBaseBox, makeCylinder, makeSphere, draw, drawPointsInterpolation, Plane,
  cast, getOC, Vector, HASH_CODE_MAX, exportSTEP, measureVolume, loadFont, textBlueprints,
} from "replicad";
import type { Shape3D, Face, Sketch } from "replicad";

import type { KernelRequest, KernelResponse } from "./protocol";
import type {
  BooleanOp,
  ExportFormat,
  ExtrudeExtent,
  RegenFeatureResult,
  ResolvedFeature,
  ResolvedFrame,
  ResolvedProfile,
} from "./types";

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
let fontReady: Promise<void> | null = null;
function ensureFont(): Promise<void> {
  if (!fontReady) {
    fontReady = fetch(FONT_URL)
      .then((r) => r.arrayBuffer())
      .then((buf) => loadFont(buf).then(() => undefined));
  }
  return fontReady;
}

const MESH_OPTS = { tolerance: 0.05, angularTolerance: 30 };

// --- Topological naming (N2: OCCT construction history) ---
// A body carries a name map (face hashCode -> persistent name) built at creation
// and PROPAGATED through every operation via OCCT history (Generated/Modified/
// IsDeleted), so a face keeps its identity across rebuilds and edits. hashCodes
// are only build-local handles; the names are the stable identity.
//
// All geometry is authored directly in millimetres (no unit conversion) since
// that is OpenCascade's default working unit; STEP export declares "mm".
type NamedShape = { shape: Shape3D; names: Map<number, string> };
type Body = NamedShape & { id: string };

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
  const names = new Map<number, string>();
  for (const f of shape.faces) {
    const dir = axisFaceName(f);
    if (dir) names.set(f.hashCode, `${feature.id}/${dir}`);
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

/** Extrude a profile face along `dir` and name the result from MakePrism's
 *  history: the two caps (start/end) and one side face per profile edge. */
function prismFromFace(profileFace: Face, dir: Vector, signedDist: number, id: string): NamedShape {
  const oc = getOC();
  const vec = dir.normalized().multiply(signedDist);
  const builder = new oc.BRepPrimAPI_MakePrism_1(profileFace.wrapped, vec.wrapped, false, true);
  const shape = cast(builder.Shape()) as Shape3D;

  const startHash = hashOf(builder.FirstShape_1());
  const endHash = hashOf(builder.LastShape_1());
  const sideByHash = new Map<number, string>();
  profileFace.edges.forEach((e, i) => {
    for (const g of drainList(builder.Generated(e.wrapped))) sideByHash.set(hashOf(g), `${id}/side${i}`);
  });

  const names = new Map<number, string>();
  for (const f of shape.faces) {
    const h = f.hashCode;
    if (h === startHash) names.set(h, `${id}/start`);
    else if (h === endHash) names.set(h, `${id}/end`);
    else if (sideByHash.has(h)) names.set(h, sideByHash.get(h)!);
  }
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

  const names = new Map<number, string>();
  for (const f of shape.faces) {
    const h = f.hashCode;
    if (capHashes.has(h)) names.set(h, capHashes.get(h)!);
    else if (sideByHash.has(h)) names.set(h, sideByHash.get(h)!);
  }
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

/** Bake a text profile to one OCCT face per glyph (each glyph face already
 *  carries its counters as inner hole wires — replicad `textBlueprints` resolves
 *  even-odd fill), plus the sketch-plane normal. The blueprint is built at the
 *  origin, baseline-left, then rotated (CCW about the anchor) and translated to
 *  the entity's u,v anchor — matching the on-screen preview's placement. Requires
 *  `ensureFont()` to have resolved first. */
function sketchTextFaces(
  profile: Extract<ResolvedFeature, { type: "extrude" }>["profile"] & { kind: "sketchText" },
): { faces: Face[]; normal: Vector } {
  const { value, height, rotation, anchor, frame } = profile;
  let bp = textBlueprints(value, { fontSize: height, startX: 0, startY: 0 });
  if (rotation) bp = bp.rotate((rotation * 180) / Math.PI, [0, 0]);
  bp = bp.translate(anchor[0], anchor[1]);
  const sketches = bp.sketchOnPlane(planeOf(frame));
  const faces = (sketches.faces() as Shape3D).faces;
  if (faces.length === 0) throw new Error("extrude: text produced no glyphs");
  return { faces, normal: new Vector(frame.normal) };
}

/** Resolve a body-face profile to its OCCT face and outward normal. The face
 *  is re-found by its persistent name, else by nearest centroid. */
function bodyProfileFace(
  src: Body,
  faceName: string | undefined,
  center: [number, number, number],
): { face: Face; normal: Vector } {
  let best: Face | null = null;
  if (faceName) {
    for (const f of src.shape.faces) {
      if (src.names.get(f.hashCode) === faceName) { best = f; break; }
    }
  }
  if (!best) {
    let bestDist = Infinity;
    for (const f of src.shape.faces) {
      const c = f.center.toTuple();
      const d = (c[0] - center[0]) ** 2 + (c[1] - center[1]) ** 2 + (c[2] - center[2]) ** 2;
      if (d < bestDist) { bestDist = d; best = f; }
    }
  }
  if (!best) throw new Error("extrude: source body has no faces");
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
): { origin: V3; dir: V3 } {
  const { face } = bodyProfileFace(body, faceName, center);
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
  const builder =
    op === "fuse"
      ? new oc.BRepAlgoAPI_Fuse_3(base.shape.wrapped, tool.shape.wrapped, progress)
      : op === "cut"
        ? new oc.BRepAlgoAPI_Cut_3(base.shape.wrapped, tool.shape.wrapped, progress)
        : new oc.BRepAlgoAPI_Common_3(base.shape.wrapped, tool.shape.wrapped, progress);
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

/** Chamfer or fillet the named edges of a body, propagating face names through
 *  the operation's history (modified faces keep their names; the new bevel/round
 *  faces are named after the feature). Modifies geometry; returns a NamedShape. */
function dressUpNamed(op: "chamfer" | "fillet", target: Body, edgeNames: string[], size: number, id: string): NamedShape {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const oc = getOC() as any;
  const targetEdgeNames = edgeNamesFrom(target.shape, target.names);
  const builder =
    op === "fillet"
      ? new oc.BRepFilletAPI_MakeFillet(target.shape.wrapped, oc.ChFi3d_FilletShape.ChFi3d_Rational)
      : new oc.BRepFilletAPI_MakeChamfer(target.shape.wrapped);

  const dressed: Topo[] = [];
  for (const e of target.shape.edges) {
    const nm = targetEdgeNames.get(e.hashCode);
    if (nm && edgeNames.includes(nm)) {
      builder.Add_2(size, e.wrapped);
      dressed.push(e.wrapped);
    }
  }
  if (dressed.length === 0) throw new Error(`${op}: no matching edges`);
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
  let accVol = measureVolume(acc.shape);
  let accIsIntermediate = false;
  for (let i = 1; i < ops.length; i++) {
    const toolVol = measureVolume(ops[i].shape);
    const next = booleanNamed(BOOL_OCC[op], acc, ops[i]);
    const nextVol = measureVolume(next.shape);
    const eps = VOLUME_EPS_REL * Math.max(accVol, toolVol, 1);
    // A union is valid when it actually joins the bodies into fewer solids —
    // true for overlapping AND merely-touching (shared-face) bodies, which have
    // no shared volume and so can't be told apart from disjoint by volume alone.
    // Subtract/intersect still go by volume (nothing removed / no common volume).
    const bad =
      op === "union"
        ? countSolids(next.shape) >= countSolids(acc.shape) + countSolids(ops[i].shape) &&
          "Solids don't touch — union needs bodies that overlap or share a face."
        : op === "subtract"
          ? nextVol >= accVol - eps && "Solids don't overlap — nothing to subtract."
          : nextVol <= eps && "Solids don't overlap — no common volume.";
    if (bad) {
      next.shape.delete();
      if (accIsIntermediate) acc.shape.delete();
      throw new Error(bad);
    }
    if (accIsIntermediate) acc.shape.delete();
    acc = next;
    accVol = nextVol;
    accIsIntermediate = true;
  }
  return acc;
}

// The running-result model: replay features in order, folding each over a
// running set of bodies. A sketch/face profile becomes a solid; mode "new" adds
// it as its own body, while "add"/"remove" fuse/cut it into target bodies in
// place (preserving their ids). A body's id is the feature that produced (or
// last started) it. Callers either tessellate the survivors (regenerate) or
// export one (exportBody); both must delete the body shapes when done.
function buildBodies(features: ResolvedFeature[]): { bodies: Body[]; failures: RegenFeatureResult[] } {
  const bodies: Body[] = [];
  const failures: RegenFeatureResult[] = [];

  for (const feature of features) {
    try {
      if (feature.type === "primitive") {
        bodies.push({ id: feature.id, ...buildPrimitive(feature) });
      } else if (feature.type === "import") {
        bodies.push({ id: feature.id, ...importStepNamed(feature.source, feature.id) });
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
          const r = bodyProfileFace(requireBody(bodies, profile.sourceId), profile.faceName, profile.center);
          faces = [r.face]; normal = r.normal;
        }
        const face = faces[0]; // representative for through-all / up-to-face sizing

        const sign = dirFlip ? -1 : 1;
        // "Up to face" derives its own signed length (and direction) from the
        // chosen target face's plane, so it bypasses the Flip/sign handling.
        let lengths: number[];
        if (extent === "upToFace" && feature.upTo) {
          const upBody = requireBody(bodies, feature.upTo.sourceId);
          const up = bodyProfileFace(upBody, feature.upTo.faceName, feature.upTo.center);
          lengths = [upToFaceLength(face, normal, up.face, up.normal)];
        } else {
          lengths = extrudeLengths(extent, distance, face, targets).map((l) => l * sign);
        }
        // Prism every face (one per glyph for text) at every length (two for
        // symmetric), fusing into one named solid. A single-face profile keeps the
        // feature id as its name prefix; text scopes each glyph as `${id}/g{n}` so
        // the glyph faces stay distinct.
        let built: NamedShape | null = null;
        for (let gi = 0; gi < faces.length; gi++) {
          const prefix = faces.length > 1 ? `${feature.id}/g${gi}` : feature.id;
          for (const len of lengths) {
            const piece = prismFromFace(faces[gi], normal, len, prefix);
            if (built === null) {
              built = piece;
            } else {
              const fused = booleanNamed("fuse", built, piece);
              built.shape.delete();
              piece.shape.delete();
              built = fused;
            }
          }
        }
        if (built === null) throw new Error("extrude: profile produced no geometry");

        if (feature.previewTool) {
          // Live-preview ghost: emit just the swept tool (the changing portion),
          // built with the real direction (dirFlip) and extent, leaving every
          // existing body untouched so they keep their own colour.
          bodies.push({ id: feature.id, ...built });
        } else if (mode === "new") {
          bodies.push({ id: feature.id, ...built });
        } else {
          if (targets.length === 0) {
            // Nothing to combine with: add becomes a new body, remove is a no-op.
            if (mode === "add") bodies.push({ id: feature.id, ...built });
            else built.shape.delete();
          } else if (mode === "add") {
            // Fuse the tool into the targets, preserving the first target's id
            // (and propagating names through the boolean history).
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
            bodies.push(...remaining, { id: keepId, ...acc });
          } else {
            // remove: cut the tool from each target in place, preserving ids.
            for (const t of targets) {
              const next = booleanNamed("cut", t, built);
              t.shape.delete();
              t.shape = next.shape;
              t.names = next.names;
            }
            built.shape.delete();
          }
        }
      } else if (feature.type === "dressup") {
        // Chamfer/fillet modifies the target body in place, keeping its id.
        const target = requireBody(bodies, feature.targetId);
        const res = dressUpNamed(feature.op, target, feature.edges, feature.size, feature.id);
        target.shape.delete();
        target.shape = res.shape;
        target.names = res.names;
      } else if (feature.type === "boolean") {
        // Combine 2+ existing bodies into one, consuming the operands and
        // keeping the result keyed by this feature's id. Names propagate through
        // the boolean history so the result's faces/edges stay referenceable.
        const result = combineBodies(feature.op, feature.operands, bodies);
        const operandSet = new Set(feature.operands);
        const remaining: Body[] = [];
        for (const b of bodies) {
          if (operandSet.has(b.id)) b.shape.delete(); // operand consumed
          else remaining.push(b);
        }
        bodies.length = 0;
        bodies.push(...remaining, { id: feature.id, ...result });
      } else if (feature.type === "transform") {
        const target = requireBody(bodies, feature.targetId);
        const res = transformNamed(target, feature);
        if (feature.copy) {
          // Keep the original; add the transformed copy as a NEW body keyed by
          // this feature (transformNamed builds a fresh shape, never consuming
          // the target).
          bodies.push({ id: feature.id, ...res });
        } else {
          // Move the target in place, keeping its id and names.
          target.shape.delete();
          target.shape = res.shape;
          target.names = res.names;
        }
      } else if (feature.type === "mirror") {
        // Reflect the target across the plane; keep the original, add the
        // mirrored body as a NEW body keyed by this feature.
        const src = requireBody(bodies, feature.targetId);
        const res = mirrorNamed(src, feature.origin, feature.normal, feature.id);
        bodies.push({ id: feature.id, ...res });
      } else if (feature.type === "revolve") {
        if (feature.profile.kind !== "sketchRegion") throw new Error("revolve: profile must be a sketch region");
        // A body-face axis is resolved here (needs the built body + profile frame);
        // sketch-line/plane axes arrive pre-baked as axisOrigin/axisDir.
        let axisOrigin = feature.axisOrigin;
        let axisDir = feature.axisDir;
        if (feature.axisFace) {
          const axBody = requireBody(bodies, feature.axisFace.sourceId);
          const line = faceRevolveAxis(axBody, feature.axisFace.faceName, feature.axisFace.center, feature.profile.frame);
          axisOrigin = line.origin;
          axisDir = line.dir;
        }
        if (!axisOrigin || !axisDir) throw new Error("revolve: missing axis");
        const built = revolveSketchRegion(
          feature.profile,
          axisOrigin,
          axisDir,
          (feature.angle * Math.PI) / 180,
          feature.symmetric,
          feature.id,
        );
        bodies.push({ id: feature.id, ...built });
      } else if (feature.type === "sweep") {
        if (feature.profile.kind !== "sketchRegion") throw new Error("sweep: profile must be a sketch region");
        bodies.push({ id: feature.id, ...sweepBody(feature.profile, feature.path, feature.id) });
      } else if (feature.type === "loft") {
        const regions = feature.profiles.filter((p) => p.kind === "sketchRegion");
        if (regions.length < 2) throw new Error("loft: needs at least 2 sketch-region sections");
        bodies.push({ id: feature.id, ...loftBody(regions as Extract<ResolvedProfile, { kind: "sketchRegion" }>[], feature.id) });
      }
    } catch (err) {
      failures.push({ id: feature.id, ok: false, error: String(err) });
    }
  }
  return { bodies, failures };
}

function regenerate(features: ResolvedFeature[]): RegenFeatureResult[] {
  const { bodies, failures } = buildBodies(features);
  const meshes: RegenFeatureResult[] = bodies.map((b) => {
    try {
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
      return { id: b.id, ok: true, mesh: { name: b.id, faces, edges } };
    } catch (err) {
      return { id: b.id, ok: false, error: String(err) };
    } finally {
      b.shape.delete();
    }
  });

  return [...meshes, ...failures];
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
      case "regenerate":
        res = { id: req.id, ok: true, op: "regenerate", results: regenerate(req.features) };
        break;
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
