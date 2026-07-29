// The kernel Web Worker: hosts the heavy OCCT WASM module and replicad so the
// UI thread never blocks on geometry regeneration. It builds each feature in a
// document and returns tessellated meshes (or a per-feature error).

import opencascade from "replicad-opencascadejs/src/replicad_single.js";
import opencascadeWasm from "replicad-opencascadejs/src/replicad_single.wasm?url";
import {
  setOC, makeBaseBox, makeSphere, makeSolid, draw, drawPointsInterpolation, Plane,
  cast, getOC, localGC, Vector, HASH_CODE_MAX, exportSTEP, measureVolume, loadFont,
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
  FaceSurface,
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

/** Turn a thrown value into a readable message. OCCT raises C++ exceptions that
 *  emscripten surfaces to JS as a raw *pointer number*, so `String(err)` yields
 *  a meaningless heap address (e.g. "241558136") and the real message is lost.
 *  `Standard_Failure` isn't exposed as an embind class in this build, so we can't
 *  call `Caught()`/`GetMessageString()`. Instead we recover the exception's C++
 *  *type name* straight from the Itanium ABI layout that emscripten's own
 *  `ExceptionInfo` walks: the thrown pointer's `__cxa_exception` header (24 bytes
 *  before it) holds the `std::type_info*` at +4, whose +4 is the length-prefixed
 *  mangled name (e.g. "20Standard_OutOfMemory"). That class alone tells OOM apart
 *  from a geometry/construction failure. This path must never throw — out-of-range
 *  typed-array reads yield `undefined` (falsy), and everything is guarded. */
function errorMessage(err: unknown): string {
  if (typeof err !== "number") return err instanceof Error ? err.message : String(err);
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const oc = getOC() as any;
    const HEAPU32: Uint32Array | undefined = oc?.HEAPU32;
    const HEAPU8: Uint8Array | undefined = oc?.HEAPU8;
    if (HEAPU32 && HEAPU8) {
      const typeInfo = HEAPU32[(err - 24 + 4) >> 2]; // std::type_info* from the exception header
      const namePtr = typeInfo ? HEAPU32[(typeInfo + 4) >> 2] : 0; // type_info::__type_name
      if (namePtr) {
        let raw = "";
        for (let p = namePtr; HEAPU8[p] && raw.length < 128; p++) raw += String.fromCharCode(HEAPU8[p]);
        const name = raw.replace(/^\d+/, ""); // drop the Itanium length prefix
        if (name) return `OCCT ${name} (exception ${err})`;
      }
    }
  } catch {
    /* fall through to the raw pointer so we still return *something* */
  }
  return `OCCT exception (undecoded pointer ${err})`;
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

/** Number of facets a primitive cylinder's circle is approximated with. Higher =
 *  smoother wall (at more faces); 96 reads as visually round while still being a
 *  polygonal prism (so it booleans — see facetedCylinderShape). */
const CIRCLE_FACETS = 96;

/** A cylinder built as a FACETED prism (a 48-gon extruded along +Z), not an
 *  analytic `gp_Cyl`. This OCCT/wasm build can't boolean an analytic cylinder
 *  against a plane (see BACKLOG) — so cutting/fusing anything with an analytic
 *  cylinder throws StdFail_NotDone. A faceted wall booleans fine, exactly as
 *  extruded circles already do here (they're polygonal prisms for the same
 *  reason), so the two now behave — and look — identically. The diameter is
 *  recovered for the readout by tracing the face back to this feature's radius
 *  (measure.ts `extrudedCircleRadius`). */
function facetedCylinderShape(radius: number, height: number): Shape3D {
  const outline: [number, number][] = [];
  for (let i = 0; i < CIRCLE_FACETS; i++) {
    const a = (2 * Math.PI * i) / CIRCLE_FACETS;
    outline.push([radius * Math.cos(a), radius * Math.sin(a)]);
  }
  const frame: ResolvedFrame = { origin: [0, 0, 0], uAxis: [1, 0, 0], vAxis: [0, 1, 0], normal: [0, 0, 1] };
  const face = regionFace({ kind: "sketchRegion", outline, frame }, planeOf(frame));
  return prismFromFace(face, new Vector([0, 0, 1]), height, "cyl").shape;
}

/** Build a primitive solid and name its (axis-aligned) faces, scoped by id. */
function buildPrimitive(feature: Extract<ResolvedFeature, { type: "primitive" }>): NamedShape {
  const p = feature.params;
  let shape: Shape3D;
  switch (feature.kind) {
    case "box": shape = makeBaseBox(p.width, p.depth, p.height); break;
    case "cylinder": shape = facetedCylinderShape(p.radius, p.height); break;
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

/** Sample an edge into world-space points (a fine polyline), via OCCT's
 *  tangential-deflection discretiser — the same method replicad uses to mesh
 *  edges. A straight edge yields its two ends; a curve, points along it. */
function sampleEdgePoints(edge: Edge, tol = 0.05, angTol = 0.15): V3[] {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const oc = getOC() as any;
  const adaptor = new oc.BRepAdaptor_Curve_2(edge.wrapped);
  const d = new oc.GCPnts_TangentialDeflection_2(adaptor, tol, angTol, 2, 1e-9, 1e-7);
  const pts: V3[] = [];
  for (let i = 1; i <= d.NbPoints(); i++) {
    const p = d.Value(i);
    pts.push([p.X(), p.Y(), p.Z()]);
  }
  d.delete();
  adaptor.delete();
  return pts;
}

/** Chain a wire's edges into one ordered ring of world points. Edges aren't
 *  guaranteed to come out in loop order, so segments are stitched by matching
 *  endpoints; the closing duplicate is dropped. */
function chainWirePoints(edges: Edge[]): V3[] {
  const near = (a: V3, b: V3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) < 1e-4;
  const segs = edges.map((e) => sampleEdgePoints(e)).filter((s) => s.length >= 2);
  if (segs.length === 0) return [];
  const used = new Array(segs.length).fill(false);
  const ring: V3[] = [...segs[0]];
  used[0] = true;
  for (let n = 1; n < segs.length; n++) {
    const tail = ring[ring.length - 1];
    let found = false;
    for (let i = 0; i < segs.length; i++) {
      if (used[i]) continue;
      const s = segs[i];
      if (near(s[0], tail)) { ring.push(...s.slice(1)); used[i] = true; found = true; break; }
      if (near(s[s.length - 1], tail)) { ring.push(...s.slice(0, -1).reverse()); used[i] = true; found = true; break; }
    }
    if (!found) break;
  }
  if (ring.length > 1 && near(ring[0], ring[ring.length - 1])) ring.pop();
  return ring;
}

/** Replace a body-face profile that has CURVED boundary edges (a cylinder cap,
 *  a filleted face…) with a FACETED planar face of the same outline on the same
 *  plane. Prisming an analytic circle/arc face makes an analytic `gp_Cyl` side
 *  wall, and this OCCT build fails booleans of an analytic cylinder against a
 *  plane (see BACKLOG) — so cutting/fusing such an extrude throws StdFail_NotDone.
 *  A faceted (polygonal) wall booleans fine, matching how sketch-region extrudes
 *  already facet their profile. Straight-edged faces are returned unchanged
 *  (they prism to planar walls and stay exact). */
function facetedProfileFace(face: Face, normal: Vector): { face: Face; normal: Vector } {
  if (!face.edges.some((e) => e.geomType !== "LINE")) return { face, normal };
  const n = vunit(normal.toTuple() as V3);
  const origin = face.center.toTuple() as V3;
  // A u axis perpendicular to the normal (cross with the world axis least aligned
  // with n, so the cross product is well-conditioned).
  const ax: V3 =
    Math.abs(n[0]) <= Math.abs(n[1]) && Math.abs(n[0]) <= Math.abs(n[2]) ? [1, 0, 0]
    : Math.abs(n[1]) <= Math.abs(n[2]) ? [0, 1, 0] : [0, 0, 1];
  const uAxis = vunit(vcross(n, ax));
  const vAxis = vcross(n, uAxis);
  const toUv = (p: V3): [number, number] => {
    const d: V3 = [p[0] - origin[0], p[1] - origin[1], p[2] - origin[2]];
    return [d[0] * uAxis[0] + d[1] * uAxis[1] + d[2] * uAxis[2], d[0] * vAxis[0] + d[1] * vAxis[1] + d[2] * vAxis[2]];
  };
  const outer = chainWirePoints(face.clone().outerWire().edges).map(toUv);
  if (outer.length < 3) return { face, normal }; // couldn't facet — keep the exact face
  const holes = face.innerWires()
    .map((w) => chainWirePoints(w.edges).map(toUv))
    .filter((r) => r.length >= 3);
  const frame: ResolvedFrame = { origin, uAxis, vAxis, normal: n };
  const faceted = regionFace({ kind: "sketchRegion", outline: outer, holes, frame }, planeOf(frame));
  return { face: faceted, normal: new Vector(n) };
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

/** A FACETED revolve: loft (ruled) through rotated copies of the profile's outer
 *  wire, so the surface of revolution is polygonal, not an analytic `gp_Cyl`/cone
 *  /torus — which this OCCT/wasm build can't boolean (see BACKLOG). Matches how
 *  cylinders + extruded circles are already faceted, so a revolve can be cut/fused
 *  like any other body. Returns null (→ analytic fallback) for cases the ruled
 *  loft can't handle: a profile with holes (ThruSections lofts a single wire per
 *  section) or one touching the axis (degenerate sections at the pole). */
function facetedRevolveFromFace(
  profileFace: Face,
  axisOrigin: number[],
  axisDir: number[],
  angleRad: number,
  symmetric: boolean,
  id: string,
): NamedShape | null {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const oc = getOC() as any;
  // NB: replicad's outerWire()/innerWires() DELETE their receiver, so always call
  // them on clones — `profileFace` must stay valid for the analytic fallback.
  if (profileFace.clone().innerWires().length > 0) return null; // holed cross-section → analytic
  const outer = profileFace.clone().outerWire();
  // Reject a profile that reaches the axis: any boundary point on the axis line
  // makes a pole where the rotated sections collapse (ThruSections fails/degenerates).
  const [ox, oy, oz] = axisOrigin;
  const ad = vunit(axisDir as V3);
  const distToAxis = (pt: number[]) => {
    const d: V3 = [pt[0] - ox, pt[1] - oy, pt[2] - oz];
    const t = d[0] * ad[0] + d[1] * ad[1] + d[2] * ad[2];
    const perp: V3 = [d[0] - t * ad[0], d[1] - t * ad[1], d[2] - t * ad[2]];
    return Math.hypot(perp[0], perp[1], perp[2]);
  };
  for (const e of outer.edges) {
    for (const p of sampleEdgePoints(e)) if (distToAxis(p) < 1e-4) { outer.delete(); return null; }
  }

  const full = angleRad >= 2 * Math.PI - 1e-6;
  const start = symmetric ? -angleRad / 2 : 0;
  const steps = Math.max(3, Math.round((CIRCLE_FACETS * Math.min(angleRad, 2 * Math.PI)) / (2 * Math.PI)));
  const pnt = new oc.gp_Pnt_3(ox, oy, oz);
  const dir = new oc.gp_Dir_4(ad[0], ad[1], ad[2]);
  const ax1 = new oc.gp_Ax1_2(pnt, dir);
  // A FULL revolve closes the loop (section at 2π coincides with 0), so the loft
  // must NOT cap its ends — isSolid=true would cap first AND last at the seam
  // plane, leaving a double-walled membrane there. Build a ruled SHELL and weld
  // it into a solid instead. A PARTIAL revolve genuinely needs the end caps, so
  // it lofts as a solid (isSolid=true) and the first/last profile faces cap it.
  const builder = new oc.BRepOffsetAPI_ThruSections(!full, true, 1e-6);
  for (let k = 0; k <= steps; k++) {
    const a = start + (angleRad * k) / steps;
    const trsf = new oc.gp_Trsf_1();
    trsf.SetRotation_1(ax1, a);
    const xf = new oc.BRepBuilderAPI_Transform_2(outer.wrapped, trsf, true);
    const w = cast(xf.Shape());
    builder.AddWire(w.wrapped);
    // NB: do NOT delete the section wire `w` — the built loft references it (as
    // loftBody's wires are likewise never deleted). Only the transient transform
    // helpers are freed.
    trsf.delete();
    xf.delete();
  }
  let result: NamedShape | null = null;
  try {
    const progress = new oc.Message_ProgressRange_1();
    builder.Build(progress);
    progress.delete();
    if (builder.IsDone()) {
      const lofted = cast(builder.Shape()) as Shape3D;
      // Full: the ruled result is a closed shell → weld to a solid; partial: it's
      // already a solid. Bail to the analytic path if it comes out empty.
      let shape = full ? (makeSolid([lofted]) as unknown as Shape3D) : lofted;
      // Clean the closing seam: UnifySameDomain merges the coplanar cap segments
      // into single annulus faces and unifies the duplicate seam edges the weld
      // leaves behind, so the seam reads as a smooth (hideable) edge, not a crack.
      try {
        const unifier = new oc.ShapeUpgrade_UnifySameDomain_2(shape.wrapped, true, true, false);
        unifier.Build();
        shape = cast(unifier.Shape()) as Shape3D;
        unifier.delete();
      } catch { /* keep the un-unified shape if the pass isn't available */ }
      if (shape.faces.length > 0) {
        const caps = new Map<number, string>();
        if (!full) {
          try { caps.set(hashOf(builder.FirstShape()), `${id}/start`); } catch { /* none */ }
          try { caps.set(hashOf(builder.LastShape()), `${id}/end`); } catch { /* none */ }
        }
        result = namesFromHistory(shape, id, caps, new Map());
      }
    }
  } catch {
    result = null;
  }
  builder.delete();
  ax1.delete();
  dir.delete();
  pnt.delete();
  return result;
}

/** Revolve a profile face around an axis by `angleRad`, naming the result from
 *  MakeRevol's history: the swept side faces (one per profile edge) and, for a
 *  partial revolve, the two caps. Prefers a FACETED loft (booleanable); falls
 *  back to this analytic MakeRevol when the profile has holes / touches the axis. */
function revolveFromFace(
  profileFace: Face,
  axisOrigin: number[],
  axisDir: number[],
  angleRad: number,
  symmetric: boolean,
  id: string,
): NamedShape {
  const faceted = facetedRevolveFromFace(profileFace, axisOrigin, axisDir, angleRad, symmetric, id);
  if (faceted) return faceted;
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
  const face = regionFace(profile, planeOf(frame));
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

/** A closed polyline ring (uv) as a Drawing — used to subtract region holes. */
function ringDrawing(ring: [number, number][]) {
  const closed =
    ring.length > 1 && ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1];
  const pts = closed ? ring.slice(0, -1) : ring;
  let pen = draw().movePointerTo(pts[0]);
  for (let i = 1; i < pts.length; i++) pen = pen.lineTo(pts[i]);
  return pen.close();
}

/** The region as a Drawing with its island `holes` cut out — a proper
 *  face-with-holes (frame/annulus) rather than a solid outer outline. Falls
 *  back to the plain outer profile when the region has no holes. */
function regionDrawing(profile: RegionProfile) {
  let d = profileDrawing(profile);
  for (const hole of profile.holes ?? []) {
    if (hole.length >= 3) d = d.cut(ringDrawing(hole));
  }
  return d;
}

/** The single fillable Face for a region, holes included. A plain (hole-free)
 *  Drawing sketches to a Sketch/CompoundSketch with `.face()`; once holes are
 *  cut, `sketchOnPlane` yields a `Sketches` collection whose lone member is the
 *  face-with-holes — unwrap it. */
function regionFace(profile: RegionProfile, plane: Plane): Face {
  const sk = regionDrawing(profile).sketchOnPlane(plane) as unknown as
    | { face?: () => Face; sketches?: Array<{ face?: () => Face }> };
  if (typeof sk.face === "function") return sk.face();
  const parts = (sk.sketches ?? []).filter((s) => typeof s.face === "function");
  if (parts.length === 1) return parts[0].face!();
  throw new Error("region profile did not resolve to a single face");
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
  const face = regionFace(profile, planeOf(frame));
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

type Vec3 = [number, number, number];
const v3cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const v3dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const v3unit = (a: Vec3): Vec3 => { const L = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / L, a[1] / L, a[2] / L]; };

/** [min,max] of an axis-aligned box's 8 corners projected onto `axis`. */
function projectBounds(bounds: [[number, number, number], [number, number, number]], axis: [number, number, number]): [number, number] {
  const [mn, mx] = bounds;
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < 8; i++) {
    const x = i & 1 ? mx[0] : mn[0];
    const y = i & 2 ? mx[1] : mn[1];
    const z = i & 4 ? mx[2] : mn[2];
    const d = x * axis[0] + y * axis[1] + z * axis[2];
    if (d < lo) lo = d;
    if (d > hi) hi = d;
  }
  return [lo, hi];
}

/** A characteristic length that comfortably exceeds any reach within the current
 *  scene — the profile plus every scanned body's bbox diagonal, plus a margin.
 *  Used to size the "up to" prism/clip box so they surely span the region. */
function bigReach(profileFace: Face, scan: Body[]): number {
  const diag = (b: [[number, number, number], [number, number, number]]) => Math.hypot(b[1][0] - b[0][0], b[1][1] - b[0][1], b[1][2] - b[0][2]);
  let s = diag(profileFace.boundingBox.bounds);
  for (const t of scan) s += diag(t.shape.boundingBox.bounds);
  return s + 100;
}

/** A big box filling the half-space on the +`m` side of the plane through `q`
 *  (|m| = 1). CUTting a prism by it terminates the prism flush with that plane —
 *  conforming even when the plane is tilted relative to the extrude axis. `size`
 *  must exceed the prism's reach beyond the plane and its perpendicular extent. */
function halfSpaceBox(q: Vec3, m: Vec3, size: number): Shape3D {
  // makeBaseBox(2s,2s,s): x,y ∈ [-s,s], z ∈ [0,s] — a slab whose base is the
  // z=0 plane, extending +z. Rotate local +z onto m, then move its base to q.
  let box = makeBaseBox(2 * size, 2 * size, size) as Shape3D;
  const d = Math.max(-1, Math.min(1, m[2])); // cos angle between +z and m
  if (d < 0.999999) {
    let ax: Vec3 = [-m[1], m[0], 0]; // (0,0,1) × m
    const al = Math.hypot(ax[0], ax[1], ax[2]);
    if (al < 1e-9) ax = [1, 0, 0]; // m == -z → rotate 180° about x
    else ax = [ax[0] / al, ax[1] / al, ax[2] / al];
    box = box.rotate((Math.acos(d) * 180) / Math.PI, [0, 0, 0], ax) as Shape3D;
  }
  return box.translate(q[0], q[1], q[2]) as Shape3D;
}

/** A clip plane for an "up to" extrude: the target face's plane, with a normal
 *  oriented to point AWAY from the profile (along the travel direction), so a
 *  half-space box on the +normal side cuts the prism flush with the face. */
interface ClipPlane { point: Vec3; normal: Vec3; boxSize: number }
function makeClipPlane(facePoint: Vec3, faceNormal: Vec3, extrudeNormal: Vector, dirSign: number, reach: number): ClipPlane {
  const en = extrudeNormal.normalized().toTuple();
  const dir: Vec3 = [en[0] * dirSign, en[1] * dirSign, en[2] * dirSign];
  const fn = v3unit(faceNormal);
  const normal: Vec3 = v3dot(fn, dir) >= 0 ? fn : [-fn[0], -fn[1], -fn[2]];
  return { point: facePoint, normal, boxSize: reach * 2 };
}

/** The plane (a point + normal) of the NEAREST face of the model (`scan` = every
 *  existing body) that `profileFace` meets travelling in the flip-adjusted
 *  direction (`normal` × `sign`) — the "up to next" target. Directional (like
 *  every CAD "up to next"): it only looks AHEAD, so the Flip toggle genuinely
 *  reverses it and flipping toward empty space fails. The nearest face whose
 *  footprint OVERLAPS the profile (in the plane perpendicular to the axis) is the
 *  blocker; it must **fully cover** the profile's cross-section — like every CAD
 *  "up to next", a face that only partially blocks the extrude is ambiguous and
 *  is rejected with an error rather than silently extending the (infinite) face
 *  plane across the uncovered part. The extrude CLIPS its prism at this plane, so
 *  a tilted target face gives a conforming (angled) result. Scans all bodies (not
 *  just the boolean target) so a boss can reach a separate wall. Throws when
 *  nothing lies ahead or the blocker only partially covers. Planar faces only. */
function upToNextFace(profileFace: Face, normal: Vector, sign: number, scan: Body[]): { point: Vec3; normal: Vec3 } {
  const p = profileFace.center.toTuple();
  const nu = normal.normalized().toTuple();
  const n: Vec3 = [nu[0] * sign, nu[1] * sign, nu[2] * sign];
  const EPS = 1e-4; // ignore the profile's own (coincident) start face
  const TOL = 1e-3;
  // Two axes spanning the plane perpendicular to n, for the cross-section test.
  const u = v3unit(v3cross(n, Math.abs(n[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0]));
  const v = v3unit(v3cross(n, u));
  const pB = profileFace.boundingBox.bounds;
  const [pu0, pu1] = projectBounds(pB, u);
  const [pv0, pv1] = projectBounds(pB, v);
  const overlaps = (a0: number, a1: number, b0: number, b1: number) => a0 <= b1 + TOL && b0 <= a1 + TOL;
  const contains = (in0: number, in1: number, out0: number, out1: number) => out0 - TOL <= in0 && in1 <= out1 + TOL;
  let best = Infinity; // nearest OVERLAPPING face ahead (the blocker), covering or not
  let bestFace: { point: Vec3; normal: Vec3 } | null = null;
  let bestCovers = false;
  for (const t of scan) {
    for (const f of t.shape.faces) {
      const m = f.normalAt(f.center).normalized().toTuple() as Vec3;
      const denom = v3dot(n, m);
      if (Math.abs(denom) < 1e-7) continue; // axis parallel to this face's plane
      const q = f.center.toTuple() as Vec3;
      const len = ((q[0] - p[0]) * m[0] + (q[1] - p[1]) * m[1] + (q[2] - p[2]) * m[2]) / denom;
      if (len <= EPS || len >= best) continue; // behind / coincident / not closer
      const fB = f.boundingBox.bounds;
      const [fu0, fu1] = projectBounds(fB, u);
      const [fv0, fv1] = projectBounds(fB, v);
      if (!overlaps(pu0, pu1, fu0, fu1) || !overlaps(pv0, pv1, fv0, fv1)) continue; // not in the path
      best = len;
      bestFace = { point: q, normal: m };
      bestCovers = contains(pu0, pu1, fu0, fu1) && contains(pv0, pv1, fv0, fv1);
    }
  }
  if (!bestFace) {
    throw new Error("up to next: no body face lies ahead of the profile in this direction — try Flip direction");
  }
  if (!bestCovers) {
    throw new Error(
      "up to next: the next face only partially covers the profile — it doesn't fully block the extrude. Use a smaller profile, extent \"up to face\", or a blind distance.",
    );
  }
  return bestFace;
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

/** Merge coplanar planar faces (and collinear edges) of a body into single faces
 *  — so an extrude/boolean that leaves a co-planar seam becomes one continuous
 *  face instead of a black seam line. Applied at BUILD time (right where the body
 *  is produced) so the build topology, the selectable/displayed geometry, and any
 *  downstream feature references all stay consistent (e.g. a chamfer hits the
 *  whole merged edge, not half). Names can't come from OCCT history
 *  (BRepTools_History isn't in these bindings), so each unified face inherits the
 *  nearest coplanar original named face — exact for unchanged faces, one of a
 *  merged pair otherwise (deterministic, so stable across rebuilds). Returns null
 *  if the upgrade fails (keep the original body). */
function unifySameDomain(named: NamedShape): NamedShape | null {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const oc = getOC() as any;
  let shape: Shape3D;
  try {
    const unify = new oc.ShapeUpgrade_UnifySameDomain_2(named.shape.wrapped, true, true, false);
    unify.Build();
    shape = cast(unify.Shape()) as Shape3D;
    unify.delete();
  } catch {
    return null;
  }
  const originals: { nm: string; c: Vec3; n: Vec3 }[] = [];
  for (const f of named.shape.faces) {
    const nm = named.names.get(f.hashCode);
    if (nm) originals.push({ nm, c: f.center.toTuple() as Vec3, n: v3unit(f.normalAt(f.center).toTuple() as Vec3) });
  }
  const names = new Map<number, string>();
  for (const uf of shape.faces) {
    const c = uf.center.toTuple() as Vec3;
    const n = v3unit(uf.normalAt(uf.center).toTuple() as Vec3);
    let best: string | undefined;
    let bestD = Infinity;
    for (const o of originals) {
      if (Math.abs(v3dot(o.n, n)) < 0.999) continue; // not coplanar-parallel
      const dd = (o.c[0] - c[0]) ** 2 + (o.c[1] - c[1]) ** 2 + (o.c[2] - c[2]) ** 2;
      if (dd < bestD) { bestD = dd; best = o.nm; }
    }
    if (best) names.set(uf.hashCode, best);
  }
  return { shape, names };
}

/** Unify a body's coplanar faces in place: returns the merged NamedShape (and
 *  deletes the original), or the original unchanged if the upgrade failed. */
function unifyBody(named: NamedShape): NamedShape {
  const u = unifySameDomain(named);
  if (!u) return named;
  named.shape.delete();
  return u;
}

/** Analytic surface facts per face, straight from the kernel — the tessellation
 *  can't tell a cylinder from a finely-faceted prism, so a radius has to come
 *  from OCCT. Returns hashCode -> surface, for the faces we can describe
 *  unambiguously (a cylinder, a flat disc, a flat ring with ONE round hole). */
function faceSurfacesFrom(shape: Shape3D): Map<number, FaceSurface> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const oc = getOC() as any;
  const out = new Map<number, FaceSurface>();
  // Only ever delete objects WE create. replicad's clone() shares `wrapped`, and
  // outerWire()/innerWires() call this.delete() on it — using them here would free
  // the very shape a downstream boolean still needs. So we go through OCCT
  // directly and scope our own temporaries with localGC.

  /** The radius of a wire that traces exactly one circle, else null. OCCT may
   *  split a circle into several arcs, so accept any number of co-radial ones. */
  const circleRadius = (wire: { edges: Edge[] }): number | null => {
    let r: number | null = null;
    for (const e of wire.edges) {
      if (e.geomType !== "CIRCLE") return null;
      const [reg, gc] = localGC();
      const ad = reg(new oc.BRepAdaptor_Curve_2(e.wrapped));
      const er = ad.Circle().Radius() as number;
      gc();
      if (r !== null && Math.abs(er - r) > 1e-7) return null; // arcs of different circles
      r = er;
    }
    return r;
  };

  for (const f of shape.faces) {
    if (f.geomType === "CYLINDRE") {
      const [reg, gc] = localGC();
      const ad = reg(new oc.BRepAdaptor_Surface_2(f.wrapped, true));
      out.set(f.hashCode, { kind: "cylinder", radius: ad.Cylinder().Radius() as number });
      gc();
      continue;
    }
    if (f.geomType !== "PLANE") continue;
    // Split the face's wires into the outer boundary and any holes without the
    // self-deleting helpers: BRepTools.OuterWire gives a fresh handle to compare.
    const [reg, gc] = localGC();
    const outerTopo = reg(oc.BRepTools.OuterWire(f.wrapped));
    const wires = f.wires;
    const outerWire = wires.find((w) => w.wrapped.IsSame(outerTopo));
    const inners = wires.filter((w) => !w.wrapped.IsSame(outerTopo));
    gc();
    if (!outerWire) continue;
    const outer = circleRadius(outerWire);
    if (outer === null) continue;
    if (inners.length === 0) {
      out.set(f.hashCode, { kind: "disc", radius: outer });
    } else if (inners.length === 1) {
      // Several holes, or a non-circular one → no unambiguous inner diameter.
      const inner = circleRadius(inners[0]);
      if (inner !== null) out.set(f.hashCode, { kind: "annulus", radius: outer, innerRadius: inner });
    }
  }
  return out;
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

/** The reference face for an angled chamfer: one of the (≤2) faces meeting at
 *  `edge`, picked deterministically so the bevel doesn't flip side between
 *  regens. Faces are ordered by their PERSISTENT name (the same names the rest
 *  of the document references), unnamed ones last and broken by hashCode;
 *  `flip` takes the second one. Returns null when the edge has no adjacent face
 *  in `adj` (so the caller can fall back to a symmetric chamfer). */
function chamferRefFace(
  adj: Map<number, Face[]>,
  names: Map<number, string>,
  edge: Edge,
  flip: boolean,
): Face | null {
  const faces = adj.get(edge.hashCode);
  if (!faces || faces.length === 0) return null;
  const ordered = [...faces].sort((a, b) => {
    const na = names.get(a.hashCode);
    const nb = names.get(b.hashCode);
    if (na !== nb) {
      if (na === undefined) return 1;
      if (nb === undefined) return -1;
      return na < nb ? -1 : 1;
    }
    return a.hashCode - b.hashCode;
  });
  return ordered[flip && ordered.length > 1 ? 1 : 0];
}

/** Chamfer or fillet the named edges of a body, propagating face names through
 *  the operation's history (modified faces keep their names; the new bevel/round
 *  faces are named after the feature). Modifies geometry; returns a NamedShape.
 *  `angle` (chamfer only, degrees) bevels asymmetrically: `size` is measured on
 *  the reference face and the bevel leaves it at `angle`. Undefined — and 45,
 *  which is the same cut — uses OCCT's plain symmetric chamfer instead. */
function dressUpNamed(
  op: "chamfer" | "fillet",
  target: Body,
  edgeNames: string[],
  edgeRefs: ResolvedEdgeRef[] | undefined,
  size: number,
  id: string,
  warn?: Warn,
  angle?: number,
  flip?: boolean,
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

  // An angled chamfer needs a reference face per edge; 45° is exactly the
  // symmetric chamfer, so it keeps the simpler (and better-trodden) Add path.
  const angled = op === "chamfer" && angle !== undefined && Math.abs(angle - 45) > 1e-9;
  const adj = new Map<number, Face[]>();
  if (angled) {
    for (const f of target.shape.faces) {
      for (const e of f.edges) {
        const arr = adj.get(e.hashCode);
        if (arr) arr.push(f); else adj.set(e.hashCode, [f]);
      }
    }
  }

  const dressed: Topo[] = [];
  for (const e of hits) {
    const ref = angled ? chamferRefFace(adj, target.names, e, flip ?? false) : null;
    if (ref) builder.AddDA(size, (angle! * Math.PI) / 180, e.wrapped, ref.wrapped);
    else builder.Add_2(size, e.wrapped);
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
          // Facet a curved profile face (cylinder cap, fillet…) so its extruded
          // wall is planar and can be cut/fused — an analytic cylinder wall can't
          // (StdFail_NotDone). No-op for straight-edged faces.
          const ff = facetedProfileFace(r.face, r.normal);
          faces = [ff.face]; normal = ff.normal;
        }
        const face = faces[0]; // representative for through-all / up-to-face sizing

        const sign = dirFlip ? -1 : 1;
        // "Up to face/next" build a deliberately LONG prism and then CUT it flush
        // with the target face's plane (`clip`), so a target that isn't
        // perpendicular to the extrude axis yields a conforming (angled) top
        // rather than a flat approximation. "Up to face" derives its own
        // direction from the chosen face (ignoring Flip); "up to next" uses the
        // Flip-adjusted direction.
        let lengths: number[];
        let clip: ClipPlane | null = null;
        if (extent === "upToFace" && feature.upTo) {
          const upBody = requireBody(bodies, feature.upTo.sourceId);
          const up = bodyProfileFace(
            upBody, feature.upTo.faceName, feature.upTo.center, feature.upTo.normal, warn, "up-to face",
          );
          const t = upToFaceLength(face, normal, up.face, up.normal); // signed, validates reachability
          const reach = bigReach(face, bodies);
          lengths = [(t >= 0 ? 1 : -1) * reach];
          clip = makeClipPlane(up.face.center.toTuple() as Vec3, up.normal.normalized().toTuple() as Vec3, normal, t >= 0 ? 1 : -1, reach);
        } else if (extent === "upToNext") {
          // Scan every existing body (the model so far), not just the boolean
          // target, so a boss can stop at a separate wall ahead of it.
          const tgt = upToNextFace(face, normal, sign, bodies);
          const reach = bigReach(face, bodies);
          lengths = [sign * reach];
          clip = makeClipPlane(tgt.point, tgt.normal, normal, sign, reach);
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
            let piece = prismFromFace(faces[gi], normal, len, prefix);
            // Up to face/next: trim the long prism flush with the target plane.
            if (clip) {
              const box = halfSpaceBox(clip.point, clip.normal, clip.boxSize);
              const trimmed = booleanNamed("cut", piece, { shape: box, names: new Map() });
              piece.shape.delete();
              box.delete();
              piece = trimmed;
            }
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
        // "Up to next" sizes the tool against the whole model, so fold in every
        // scanned body's key — the ghost/tool must re-solve when any of them moves.
        if (extent === "upToNext") for (const b of bodies) toolInputKeys.push(b.key);
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
            // Merge co-planar faces the fuse left (e.g. stacking a taller section
            // on a body) so there's no black seam line where the tool met the body.
            acc = unifyBody(acc);
            const keepId = targets[0].id;
            const remaining = bodies.filter((b) => !targets.includes(b));
            bodies.length = 0;
            bodies.push(...remaining, { id: keepId, key: contentKey(feature, [toolKey, ...targetKeys]), ...acc });
          } else {
            // remove: cut the tool from each target in place, preserving ids.
            for (const t of targets) {
              const next = unifyBody(booleanNamed("cut", t, built));
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
        const res = dressUpNamed(feature.op, target, feature.edges, feature.edgeRefs, feature.size, feature.id, warn, feature.angle, feature.flip);
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
        // Unify inside the cached builder (so it runs only on a cache miss and the
        // merged result is what's stored) — no black seam where operands met.
        const result = buildCached(key, used, () => unifyBody(combineBodies(feature.op, feature.operands, bodies)));
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
      failures.push({ id: feature.id, ok: false, error: errorMessage(err) });
    }
    timings.push({ id: feature.id, type: feature.type, ms: performance.now() - t0 });
  }
  return { bodies, failures, timings, warnings };
}

/** Bodies with more faces than this mesh per-face (see `meshFaceByFace`); below it,
 *  replicad's one-shot whole-shape mesh is faster. Large imported STEP assemblies
 *  (a populated PCB is ~80k faces) are the case this guards against. */
const PER_FACE_MESH_THRESHOLD = 5000;

/** Deflection (mm) for a large body's tessellation, scaled to its size so the
 *  triangle count stays bounded regardless of the model's absolute scale. */
function referenceMeshOpts(shape: Shape3D): { tolerance: number; angularTolerance: number } {
  let diag = 100;
  try {
    const bb = shape.boundingBox;
    diag = Math.hypot(bb.width, bb.height, bb.depth) || diag;
    bb.delete();
  } catch { /* fall back to the default diagonal */ }
  // ~0.5% of the diagonal, clamped to a sane band. An imported assembly is a
  // reference body (you model an enclosure AROUND it, not on it), so it's tuned
  // coarse to keep the triangle count — and thus GPU load and per-regen transfer
  // — low. Raise the factor for lighter/faster, lower it for crisper curves.
  return { tolerance: Math.min(5, Math.max(0.4, diag * 0.005)), angularTolerance: 0.6 };
}

/** Mesh a shape ONE FACE AT A TIME. replicad's `Shape.mesh()` runs `BRepMesh` over
 *  the whole compound, holding every face's triangulation simultaneously — which
 *  exhausts the (bounded) wasm heap on huge assemblies. Here each face is meshed,
 *  its triangles extracted, then `BRepTools.Clean`-ed to release the triangulation
 *  before the next, so peak memory stays at a single face. A per-face guard skips a
 *  pathological face rather than failing the whole import. Returns replicad's
 *  `MeshedFaces` shape (edges are omitted — a reference body doesn't need them). */
function meshFaceByFace(
  shape: Shape3D,
  opts: { tolerance: number; angularTolerance: number },
  onProgress?: (done: number, total: number) => void,
): MeshedFaces {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const oc = getOC() as any;
  const vChunks: number[][] = [], nChunks: number[][] = [], tChunks: number[][] = [];
  const faceGroups: { start: number; count: number; faceId: number }[] = [];
  let nodeOffset = 0, triLen = 0, skipped = 0;
  const faces = shape.faces;
  const total = faces.length;
  faces.forEach((face, i) => {
    // Report progress periodically — posting from the worker doesn't block it, and
    // the main thread (idle during our synchronous mesh) can paint a status.
    if (onProgress && i % 2000 === 0) onProgress(i, total);
    try {
      const im = new oc.BRepMesh_IncrementalMesh_2(face.wrapped, opts.tolerance, false, opts.angularTolerance, false);
      im.delete();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const tri = (face as any).triangulation(nodeOffset) as { vertices: number[]; trianglesIndexes: number[]; verticesNormals: number[] } | null;
      if (tri) {
        faceGroups.push({ start: triLen, count: tri.trianglesIndexes.length, faceId: face.hashCode });
        tChunks.push(tri.trianglesIndexes); triLen += tri.trianglesIndexes.length;
        vChunks.push(tri.vertices); nodeOffset += tri.vertices.length / 3;
        nChunks.push(tri.verticesNormals);
      }
      oc.BRepTools.Clean(face.wrapped, true); // free THIS face's triangulation
    } catch {
      skipped++; // a single un-meshable face shouldn't sink the whole body
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (face as any).delete?.();
  });
  onProgress?.(total, total);
  if (skipped) console.warn(`mesh: skipped ${skipped} un-meshable face(s) of ${faceGroups.length + skipped}`);
  // Concatenate the per-face chunks straight into typed arrays (fill, not `.flat()`
  // — ~4× faster at this scale, and the result transfers to the main thread as a
  // raw ArrayBuffer copy instead of a per-element structured clone).
  const fillF = (chunks: number[][]): Float32Array => {
    const out = new Float32Array(chunks.reduce((s, c) => s + c.length, 0));
    let o = 0; for (const c of chunks) { out.set(c, o); o += c.length; }
    return out;
  };
  const triangles = new Uint32Array(triLen);
  { let o = 0; for (const c of tChunks) { triangles.set(c, o); o += c.length; } }
  return { triangles, vertices: fillF(vChunks), normals: fillF(nChunks), faceGroups };
}

// Two faces meeting below this angle read as one smooth surface: their shared
// edge is a facet seam (or a tangent fillet blend), not a real crease. Used to
// smooth shading + hide seam edges so faceted curved bodies (cylinder/revolve/
// extruded circle) DISPLAY as round while the kernel still booleans the facets.
const CREASE_DOT = Math.cos((22 * Math.PI) / 180);

/** Edge hashCodes whose two adjacent faces meet below the crease angle (a facet
 *  seam / tangent blend). Same face-adjacency walk as edgeNamesFrom. */
function smoothEdgeHashes(shape: Shape3D): Set<number> {
  const adj = new Map<number, V3[]>();
  for (const f of shape.faces) {
    let n: V3;
    try { n = vunit(f.normalAt(f.center).normalized().toTuple() as V3); } catch { continue; }
    for (const e of f.edges) {
      const arr = adj.get(e.hashCode);
      if (arr) arr.push(n); else adj.set(e.hashCode, [n]);
    }
  }
  const smooth = new Set<number>();
  for (const [h, ns] of adj) {
    if (ns.length === 2 && v3dot(ns[0], ns[1]) > CREASE_DOT) smooth.add(h);
  }
  return smooth;
}

/** Group faces into LOGICAL surfaces: the connected components of the face graph
 *  whose edges are the "smooth" (sub-crease) seams — i.e. all the flat facets of
 *  one faceted cylinder/revolve/extruded-circle, plus any tangent fillet blend,
 *  collapse into a single cluster, while a box's six faces each stay a singleton.
 *  Returns faceHash -> a stable representative faceHash for its cluster. Same
 *  crease test + adjacency walk as smoothEdgeHashes, so clusters == exactly the
 *  regions the display already shades as one smooth surface. */
function faceClustersFrom(shape: Shape3D): Map<number, number> {
  const parent = new Map<number, number>();
  const find = (x: number): number => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r)!;
    while (parent.get(x) !== r) { const nx = parent.get(x)!; parent.set(x, r); x = nx; }
    return r;
  };
  const union = (a: number, b: number) => { const ra = find(a), rb = find(b); if (ra !== rb) parent.set(ra, rb); };
  // edge hash -> the (≤2) adjacent faces, each with its outward normal at centre.
  const adj = new Map<number, { h: number; n: V3 }[]>();
  for (const f of shape.faces) {
    let n: V3;
    try { n = vunit(f.normalAt(f.center).normalized().toTuple() as V3); } catch { continue; }
    const fh = f.hashCode;
    if (!parent.has(fh)) parent.set(fh, fh);
    for (const e of f.edges) {
      const arr = adj.get(e.hashCode);
      if (arr) arr.push({ h: fh, n }); else adj.set(e.hashCode, [{ h: fh, n }]);
    }
  }
  for (const fs of adj.values()) {
    if (fs.length === 2 && v3dot(fs[0].n, fs[1].n) > CREASE_DOT) union(fs[0].h, fs[1].h);
  }
  const out = new Map<number, number>();
  for (const h of parent.keys()) out.set(h, find(h));
  return out;
}

// Two straight segments meeting below this turn angle read as one smooth curve —
// the chords of a faceted circle/arc (a 96-gon turns 3.75°/segment). A real corner
// (box rim = 90°, chamfer = 45°) stays a separate edge.
const CHAIN_DOT = Math.cos((35 * Math.PI) / 180);

/** Group edges into LOGICAL curves: the tangent-continuous chains of straight
 *  segments that approximate one smooth circle/arc (a faceted cylinder's N rim
 *  chords), so a click on any chord selects the whole ring. Returns edgeHash -> a
 *  representative edgeHash for its chain; a sharp-cornered edge is a singleton.
 *  Two edges chain when, at a shared vertex, their tangents-into-the-edge oppose
 *  (dot < −CHAIN_DOT) — i.e. they continue smoothly through it. A prism rim
 *  corner also has the vertical seam edge, but its ⟂ tangent fails the test, so
 *  only the two rim chords chain. */
function edgeChainsFrom(shape: Shape3D): Map<number, number> {
  const parent = new Map<number, number>();
  const find = (x: number): number => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r)!;
    while (parent.get(x) !== r) { const nx = parent.get(x)!; parent.set(x, r); x = nx; }
    return r;
  };
  const union = (a: number, b: number) => { const ra = find(a), rb = find(b); if (ra !== rb) parent.set(ra, rb); };
  const vkey = (p: V3) => `${Math.round(p[0] * 1e3)},${Math.round(p[1] * 1e3)},${Math.round(p[2] * 1e3)}`;
  // vertex -> the edge-ends there, each with the unit tangent pointing INTO the edge.
  const atVertex = new Map<string, { h: number; tan: V3 }[]>();
  for (const e of shape.edges) {
    const h = e.hashCode;
    if (!parent.has(h)) parent.set(h, h);
    let pts: V3[];
    try { pts = sampleEdgePoints(e); } catch { continue; }
    if (pts.length < 2) continue;
    const a = pts[0], a2 = pts[1], b = pts[pts.length - 1], b2 = pts[pts.length - 2];
    const tanA = vunit([a2[0] - a[0], a2[1] - a[1], a2[2] - a[2]]);
    const tanB = vunit([b2[0] - b[0], b2[1] - b[1], b2[2] - b[2]]);
    for (const [p, tan] of [[a, tanA], [b, tanB]] as [V3, V3][]) {
      const k = vkey(p);
      const arr = atVertex.get(k);
      if (arr) arr.push({ h, tan }); else atVertex.set(k, [{ h, tan }]);
    }
  }
  for (const arr of atVertex.values()) {
    for (let i = 0; i < arr.length; i++)
      for (let j = i + 1; j < arr.length; j++)
        if (arr[i].h !== arr[j].h && v3dot(arr[i].tan, arr[j].tan) < -CHAIN_DOT) union(arr[i].h, arr[j].h);
  }
  const out = new Map<number, number>();
  for (const h of parent.keys()) out.set(h, find(h));
  return out;
}

/** Drop the smooth (facet-seam) edges from a meshed edge set, so only real
 *  feature edges render/pick. `lines` is flat xyz; `edgeGroups` index it by
 *  point. */
function filterSmoothEdges(edges: MeshedEdges, smooth: Set<number>): MeshedEdges {
  if (!edges.edgeGroups || smooth.size === 0) return edges;
  const src = edges.lines;
  const outLines: number[] = [];
  const outGroups: NonNullable<MeshedEdges["edgeGroups"]> = [];
  for (const g of edges.edgeGroups) {
    if (smooth.has(g.edgeId)) continue;
    const startPt = outLines.length / 3;
    for (let i = g.start * 3; i < (g.start + g.count) * 3; i++) outLines.push(src[i]);
    outGroups.push({ ...g, start: startPt });
  }
  return { lines: outLines, edgeGroups: outGroups };
}

/** Smooth a mesh's per-vertex normals so faceted curved walls SHADE as round.
 *  Coincident vertices are clustered by crease angle: normals within a cluster
 *  (a facet seam) are averaged; clusters across a real crease (a box corner, a
 *  cap↔wall rim) stay distinct, keeping sharp features crisp. Mutates in place;
 *  never touches vertices/triangles/faceGroups, so picking + measurement are
 *  unaffected. */
function smoothMeshNormals(faces: MeshedFaces): void {
  const V = faces.vertices, N = faces.normals;
  if (!V || !N) return;
  const nv = V.length / 3;
  const groups = new Map<string, number[]>();
  for (let vi = 0; vi < nv; vi++) {
    const k = `${Math.round(V[vi * 3] * 1e4)},${Math.round(V[vi * 3 + 1] * 1e4)},${Math.round(V[vi * 3 + 2] * 1e4)}`;
    const arr = groups.get(k);
    if (arr) arr.push(vi); else groups.set(k, [vi]);
  }
  for (const arr of groups.values()) {
    if (arr.length < 2) continue;
    const clusters: { sum: V3; rep: V3; members: number[] }[] = [];
    for (const vi of arr) {
      const n: V3 = [N[vi * 3], N[vi * 3 + 1], N[vi * 3 + 2]];
      let c = clusters.find((cl) => v3dot(cl.rep, n) > CREASE_DOT);
      if (!c) { c = { sum: [0, 0, 0], rep: n, members: [] }; clusters.push(c); }
      c.sum[0] += n[0]; c.sum[1] += n[1]; c.sum[2] += n[2];
      c.members.push(vi);
    }
    if (clusters.length < 2 && arr.length < 3) continue;
    for (const c of clusters) {
      const L = Math.hypot(c.sum[0], c.sum[1], c.sum[2]) || 1;
      const a: V3 = [c.sum[0] / L, c.sum[1] / L, c.sum[2] / L];
      for (const vi of c.members) { N[vi * 3] = a[0]; N[vi * 3 + 1] = a[1]; N[vi * 3 + 2] = a[2]; }
    }
  }
}

function regenerate(
  features: ResolvedFeature[],
  emit?: (result: RegenFeatureResult) => void,
  onMeshProgress?: (featureId: string, done: number, total: number) => void,
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
        // Huge bodies (large imported assemblies) mesh per-face so peak memory
        // stays bounded — replicad's whole-shape mesh holds every triangulation at
        // once and exhausts the heap. Normal bodies use the faster one-shot path.
        let faces: MeshedFaces, edges: MeshedEdges;
        if (b.names.size > PER_FACE_MESH_THRESHOLD) {
          // Large imported assembly: mesh per-face so peak memory stays bounded
          // (replicad's whole-shape mesh holds every triangulation at once and
          // exhausts the heap). Produce typed arrays — this mesh is millions of
          // triangles and re-transfers to the main thread every regen, so the
          // ArrayBuffer copy (vs per-number structured clone) is a big win here.
          faces = meshFaceByFace(b.shape, referenceMeshOpts(b.shape), (done, total) => onMeshProgress?.(b.id, done, total));
          edges = { lines: [], edgeGroups: [] }; // edges omitted for a reference body
        } else {
          // Normal body: replicad's one-shot mesh (number[]). Small meshes clone
          // across the worker boundary instantly, so typed-array repacking would
          // only add overhead with no transfer benefit.
          faces = b.shape.mesh(MESH_OPTS);
          edges = b.shape.meshEdges(MESH_OPTS);
          // Display-only smoothing: faceted curved bodies (cylinder/revolve/
          // extruded circle) are genuinely polygonal, so shade their walls smooth
          // and drop the facet seam edges — they READ as round while the kernel
          // keeps booleaning the facets. Sharp features (creases above the
          // threshold) are preserved. Geometry the kernel sees is untouched.
          smoothMeshNormals(faces);
          edges = filterSmoothEdges(edges, smoothEdgeHashes(b.shape));
        }
        // Attach each face's / edge's persistent name (matched by build-local hash)
        // so the app carries stable references across rebuilds.
        if (faces.faceGroups) {
          // Surface classification walks every face with an OCCT adaptor, so skip
          // it for huge reference bodies (the per-face mesh path) — they're
          // reference-only, and the pass would cost more than it's worth.
          const surfaces = b.names.size > PER_FACE_MESH_THRESHOLD ? null : faceSurfacesFrom(b.shape);
          // Logical-surface clustering (whole-cylinder selection). Skipped for huge
          // reference bodies alongside surface classification — same O(faces) walk.
          const clusters = b.names.size > PER_FACE_MESH_THRESHOLD ? null : faceClustersFrom(b.shape);
          faces.faceGroups = faces.faceGroups.map((g) => ({
            ...g,
            name: b.names.get(g.faceId),
            surface: surfaces?.get(g.faceId),
            clusterId: clusters?.get(g.faceId),
          }));
        }
        if (edges.edgeGroups) {
          const edgeNames = edgeNamesFrom(b.shape, b.names);
          // Chain tangent-continuous chords (whole-circle edge selection); skipped
          // for huge reference bodies alongside the surface/cluster passes.
          const chains = b.names.size > PER_FACE_MESH_THRESHOLD ? null : edgeChainsFrom(b.shape);
          edges.edgeGroups = edges.edgeGroups.map((g) => ({ ...g, name: edgeNames.get(g.edgeId), chainId: chains?.get(g.edgeId) }));
        }
        cached = { faces, edges };
        meshCache.set(b.key, cached);
      }
      result = { id: b.id, ok: true, mesh: { name: b.id, faces: cached.faces, edges: cached.edges } };
    } catch (err) {
      result = { id: b.id, ok: false, error: errorMessage(err) };
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
        const { results, warnings } = regenerate(
          req.features,
          (result) => ctx.postMessage({ id: req.id, ok: true, op: "regenerate-progress", result }),
          (featureId, done, total) => ctx.postMessage({ id: req.id, ok: true, op: "mesh-progress", featureId, done, total }),
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
    ctx.postMessage({ id: req.id, ok: false, error: errorMessage(err) } as KernelResponse);
  }
};
