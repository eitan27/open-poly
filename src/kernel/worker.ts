// The kernel Web Worker: hosts the heavy OCCT WASM module and replicad so the
// UI thread never blocks on geometry regeneration. It builds each feature in a
// document and returns tessellated meshes (or a per-feature error).

import opencascade from "replicad-opencascadejs/src/replicad_single.js";
import opencascadeWasm from "replicad-opencascadejs/src/replicad_single.wasm?url";
import {
  setOC,
  makeBaseBox,
  makeSphere,
  makeSolid,
  draw,
  drawPointsInterpolation,
  Plane,
  cast,
  getOC,
  localGC,
  Vector,
  HASH_CODE_MAX,
  exportSTEP,
  measureVolume,
  loadFont,
  Blueprint,
  BlueprintSketcher,
  CompoundBlueprint,
  DistanceQuery,
  makeVertex,
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
  ProfileSegment,
  ResolvedEdgeRef,
  ResolvedFaceRef,
  ResolvedFeature,
  ResolvedFrame,
  ResolvedProfile,
} from "./types";
import { DRESSUP_DELTA_IDS, dressUpDeltaBase } from "./types";
import { CIRCLE_FACETS, circleStations } from "../geom/circleFacets";
import { expandToChains, expansionCount } from "../geom/edgeChains";
import { fitRing } from "../geom/ringFit";
import {
  chamferLegs,
  chamferTriangle,
  filletCrossSection,
  inFaceDirection,
  isConvexEdge,
  isRightAngle,
  legFits,
} from "../geom/chamferWedge";
import {
  matchEdges,
  matchFace,
  matchFaces,
  type EdgeCandidate,
  type FaceCandidate,
  type NamedFaceCandidate,
  type NamedFaceRefFingerprint,
} from "./topoMatch";
import { clamp } from "../lib/clamp";
import { vunit, vcross, vdot } from "../lib/vec3";
import { insetOutline, padOutline, ringEscapes } from "../geom/loftInset";

const ctx = self as unknown as DedicatedWorkerGlobalScope;

let ocReady: Promise<void> | null = null;
function ensureOC(): Promise<void> {
  if (!ocReady) {
    // The emscripten factory accepts a `locateFile` override (not in its .d.ts).
    const init = opencascade as unknown as (opts: { locateFile: () => string }) => Promise<unknown>;
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

// Fallback tolerances tried, in order, when a boolean comes back DEGENERATE (no
// solid at all). Two near-tangent B-spline surfaces — e.g. an inner offset loft
// held a uniform ~2.4mm inside its outer, the standard way to hollow an organic
// shell — make BRepAlgoAPI return an EMPTY shape at one tolerance and the right
// answer at another. Only ever step DOWN from BOOL_FUZZY: per the note above, a
// fuzzy value larger than the thinnest wall collapses the cut, so raising it
// would trade one silent failure for another.
const BOOL_FUZZY_FALLBACKS = [BOOL_FUZZY, 1e-3, 1e-4, 0] as const;

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
// `preview` marks a display-only body (a dress-up delta): nothing may reference
// it, so it is meshed for pixels alone — see the mesh loop, which skips the
// naming, surface-classification and clustering passes for it.
type Body = NamedShape & {
  id: string;
  key: string;
  preview?: boolean;
  /** Never split into parts, however many disjoint solids it holds. Set for
   *  the things whose lumps aren't parts in any useful sense: extruded text
   *  (one solid per glyph) and the live preview tool. */
  noSplit?: boolean;
};

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
  const axes: [string, number][] = [
    ["x", x],
    ["y", y],
    ["z", z],
  ];
  const dom = axes.reduce((a, b) => (Math.abs(b[1]) > Math.abs(a[1]) ? b : a));
  if (Math.abs(dom[1]) < 0.999) return null;
  return (dom[1] >= 0 ? "+" : "-") + dom[0];
}

// How many facets a round wall gets, and the station angles they sit at, live in
// geom/circleFacets — shared with the sketch layer on purpose. A primitive
// cylinder and a sketch arc of the same radius have to produce the SAME polygon,
// or the boolean between them slices one into slivers.

/** A cylinder built as a FACETED prism (a 48-gon extruded along +Z), not an
 *  analytic `gp_Cyl`. This OCCT/wasm build can't boolean an analytic cylinder
 *  against a plane (see BACKLOG) — so cutting/fusing anything with an analytic
 *  cylinder throws StdFail_NotDone. A faceted wall booleans fine, exactly as
 *  extruded circles already do here (they're polygonal prisms for the same
 *  reason), so the two now behave — and look — identically. The diameter is
 *  recovered for the readout by tracing the face back to this feature's radius
 *  (measure.ts `extrudedCircleRadius`). */
function facetedCylinderShape(radius: number, height: number): Shape3D {
  const outline: [number, number][] = circleStations().map((a) => [radius * Math.cos(a), radius * Math.sin(a)]);
  const frame: ResolvedFrame = { origin: [0, 0, 0], uAxis: [1, 0, 0], vAxis: [0, 1, 0], normal: [0, 0, 1] };
  const face = regionFace({ kind: "sketchRegion", outline, frame }, planeOf(frame));
  return prismFromFace(face, new Vector([0, 0, 1]), height, "cyl").shape;
}

/** Build a primitive solid and name its (axis-aligned) faces, scoped by id. */
function buildPrimitive(feature: Extract<ResolvedFeature, { type: "primitive" }>): NamedShape {
  const p = feature.params;
  let shape: Shape3D;
  switch (feature.kind) {
    case "box":
      shape = makeBaseBox(p.width, p.depth, p.height);
      break;
    case "cylinder":
      shape = facetedCylinderShape(p.radius, p.height);
      break;
    case "sphere":
      shape = makeSphere(p.radius);
      break;
    default:
      throw new Error(`Unknown feature kind: ${(feature as { kind: string }).kind}`);
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

/** The solid content of a shape that carries more than `minVolume` of material,
 *  as a compound — loose faces, shells and wires dropped, and with them the
 *  slivers a boolean between near-coincident solids leaves behind (a dress-up
 *  delta's clip reliably produces a speck or two at the box corners). Returns
 *  null when nothing survives — the usual case for the half of a delta that
 *  doesn't apply, since a convex edge only removes and a concave one only adds.
 *  The result is an independent COPY, so the caller can free the shape it came
 *  from; the name map is dropped, since these bodies are display-only and
 *  nothing may reference their faces. */
function solidsOnly(named: NamedShape, minVolume: number): NamedShape | null {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const oc = getOC() as any;
  const comp = new oc.TopoDS_Compound();
  const builder = new oc.TopoDS_Builder();
  builder.MakeCompound(comp);
  const ex = new oc.TopExp_Explorer_2(
    named.shape.wrapped,
    oc.TopAbs_ShapeEnum.TopAbs_SOLID,
    oc.TopAbs_ShapeEnum.TopAbs_SHAPE,
  );
  let n = 0;
  for (; ex.More(); ex.Next()) {
    const props = new oc.GProp_GProps_1();
    oc.BRepGProp.VolumeProperties_1(ex.Current(), props, false, false, false);
    const volume = Math.abs(props.Mass());
    props.delete();
    if (volume <= minVolume) continue;
    builder.Add(comp, ex.Current());
    n++;
  }
  ex.delete();
  if (n === 0) return null;
  // The compound holds references INTO `named`; copy so it owns its geometry and
  // the caller's cleanup can't pull the ground out from under it.
  const shared: NamedShape = { shape: cast(comp) as Shape3D, names: new Map() };
  const owned = copyNamed(shared);
  shared.shape.delete();
  return owned;
}

/** Split a shape holding several disjoint solids into one NamedShape per solid,
 *  or null when there is nothing to split (0 or 1 solid). Each lump takes the
 *  part of the name map that names ITS faces, remapped by the copy — so a
 *  chamfer that referenced a face still finds it on whichever part now holds it.
 *  On a successful split the input shape is consumed. */
function splitLumps(named: NamedShape): NamedShape[] | null {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const oc = getOC() as any;
  const out: NamedShape[] = [];
  // Each lump is copied inside the loop: TopExp_Explorer.Current() is a
  // reference into the explorer, invalid the moment Next() is called.
  const ex = new oc.TopExp_Explorer_2(
    named.shape.wrapped,
    oc.TopAbs_ShapeEnum.TopAbs_SOLID,
    oc.TopAbs_ShapeEnum.TopAbs_SHAPE,
  );
  for (; ex.More(); ex.Next()) {
    const shape = cast(ex.Current()) as Shape3D;
    const names = new Map<number, string>();
    for (const f of shape.faces) {
      const nm = named.names.get(f.hashCode);
      if (nm) names.set(f.hashCode, nm);
    }
    // A sub-shape's faces share their parent's hash codes, so the lookup above
    // works; copyNamed then re-keys them onto the independent copy.
    out.push(copyNamed({ shape, names }));
  }
  ex.delete();
  if (out.length < 2) {
    for (const o of out) o.shape.delete();
    return null;
  }
  named.shape.delete();
  return out;
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
      if (near(s[0], tail)) {
        ring.push(...s.slice(1));
        used[i] = true;
        found = true;
        break;
      }
      if (near(s[s.length - 1], tail)) {
        ring.push(...s.slice(0, -1).reverse());
        used[i] = true;
        found = true;
        break;
      }
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
/** A sketch-style frame for a PLANAR face: the face's own centroid + normal, with
 *  an arbitrary but well-conditioned u/v pair spanning its plane. Lets a body
 *  face stand in for a sketch plane wherever the kernel needs a profile frame —
 *  faceting a profile, and intersecting a plane/face axis with it. */
function planarFaceFrame(origin: V3, normal: V3): ResolvedFrame {
  const n = vunit(normal);
  // A u axis perpendicular to the normal (cross with the world axis least aligned
  // with n, so the cross product is well-conditioned).
  const ax: V3 =
    Math.abs(n[0]) <= Math.abs(n[1]) && Math.abs(n[0]) <= Math.abs(n[2])
      ? [1, 0, 0]
      : Math.abs(n[1]) <= Math.abs(n[2])
        ? [0, 1, 0]
        : [0, 0, 1];
  const uAxis = vunit(vcross(n, ax));
  return { origin, uAxis, vAxis: vcross(n, uAxis), normal: n };
}

function facetedProfileFace(face: Face, normal: Vector): { face: Face; normal: Vector } {
  if (!face.edges.some((e) => e.geomType !== "LINE")) return { face, normal };
  const frame = planarFaceFrame(face.center.toTuple() as V3, normal.toTuple() as V3);
  const { origin, uAxis, vAxis, normal: n } = frame;
  const toUv = (p: V3): [number, number] => {
    const d: V3 = [p[0] - origin[0], p[1] - origin[1], p[2] - origin[2]];
    return [d[0] * uAxis[0] + d[1] * uAxis[1] + d[2] * uAxis[2], d[0] * vAxis[0] + d[1] * vAxis[1] + d[2] * vAxis[2]];
  };
  const outer = chainWirePoints(face.clone().outerWire().edges).map(toUv);
  if (outer.length < 3) return { face, normal }; // couldn't facet — keep the exact face
  const holes = face
    .innerWires()
    .map((w) => chainWirePoints(w.edges).map(toUv))
    .filter((r) => r.length >= 3);
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
    for (const p of sampleEdgePoints(e))
      if (distToAxis(p) < 1e-4) {
        outer.delete();
        return null;
      }
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
      } catch {
        /* keep the un-unified shape if the pass isn't available */
      }
      if (shape.faces.length > 0) {
        const caps = new Map<number, string>();
        if (!full) {
          try {
            caps.set(hashOf(builder.FirstShape()), `${id}/start`);
          } catch {
            /* none */
          }
          try {
            caps.set(hashOf(builder.LastShape()), `${id}/end`);
          } catch {
            /* none */
          }
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
  try {
    capHashes.set(hashOf(builder.FirstShape_1()), `${id}/start`);
  } catch {
    /* full revolve: no caps */
  }
  try {
    capHashes.set(hashOf(builder.LastShape_1()), `${id}/end`);
  } catch {
    /* full revolve: no caps */
  }
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

type RegionProfile = Extract<ResolvedProfile, { kind: "sketchRegion" }>;

type V3 = [number, number, number];
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
  const closed = ring.length > 1 && ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1];
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
  const sk = regionDrawing(profile).sketchOnPlane(plane) as unknown as {
    face?: () => Face;
    sketches?: Array<{ face?: () => Face }>;
  };
  if (typeof sk.face === "function") return sk.face();
  const parts = (sk.sketches ?? []).filter((s) => typeof s.face === "function");
  if (parts.length === 1) return parts[0].face!();
  throw new Error("region profile did not resolve to a single face");
}

/** Resolve `shape`'s faces to a name map, given hash→name maps for the swept
 *  side faces and the start/end caps; anything unmapped gets a stable `f{n}`. */
function namesFromHistory(
  shape: Shape3D,
  id: string,
  caps: Map<number, string>,
  sides: Map<number, string>,
): NamedShape {
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
function sweepBody(
  profile: RegionProfile,
  path: Extract<ResolvedFeature, { type: "sweep" }>["path"],
  id: string,
): NamedShape {
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
  const profileWire = (profileDrawing(profile).sketchOnPlane(new Plane(start, uAxis, tangent)) as unknown as Sketch)
    .wire;

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
  try {
    caps.set(hashOf(builder.FirstShape()), `${id}/start`);
  } catch {
    /* no start cap */
  }
  try {
    caps.set(hashOf(builder.LastShape()), `${id}/end`);
  } catch {
    /* no end cap */
  }

  const res = namesFromHistory(shape, id, caps, sides);
  progress.delete();
  builder.delete();
  return res;
}

/** Loft through 2+ profile regions (in order) into a solid. Built on raw OCCT
 *  `BRepOffsetAPI_ThruSections` so faces are named from history: one lateral
 *  face per section edge (`GeneratedFace`) + the start/end caps. */
function loftBody(profiles: RegionProfile[], id: string, ruled = false): NamedShape {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const oc = getOC() as any;
  const wires = profiles.map((p) => (profileDrawing(p).sketchOnPlane(planeOf(p.frame)) as unknown as Sketch).wire);
  const builder = new oc.BRepOffsetAPI_ThruSections(true, ruled, 1e-6); // solid
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
  try {
    caps.set(hashOf(builder.FirstShape()), `${id}/start`);
  } catch {
    /* no start cap */
  }
  try {
    caps.set(hashOf(builder.LastShape()), `${id}/end`);
  } catch {
    /* no end cap */
  }

  const res = namesFromHistory(shape, id, caps, sides);
  progress.delete();
  builder.delete();
  return res;
}

/** Resolve a sketch-region profile to the OCCT face it extrudes and the
 *  outward direction (its frame normal). */
function sketchRegionFace(
  profile: Extract<ResolvedFeature, { type: "extrude" }>["profiles"][number] & { kind: "sketchRegion" },
): { face: Face; normal: Vector } {
  const { outline, frame } = profile;
  if (outline.length < 3) throw new Error("extrude: profile needs at least 3 points");
  const face = regionFace(profile, planeOf(frame));
  return { face, normal: new Vector(frame.normal) };
}

/** Build a closed 2D blueprint from a flattened polygon ring (already in the
 *  sketch's u,v convention), dropping the clipper's duplicated closing point. */
function ringToBlueprint(ring: [number, number][]): Blueprint {
  const closed = ring.length > 1 && ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1];
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
  profile: Extract<ResolvedFeature, { type: "extrude" }>["profiles"][number] & { kind: "sketchText" },
): {
  faces: Face[];
  normal: Vector;
} {
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
    const sketch = bps.length > 1 ? new CompoundBlueprint(bps).sketchOnPlane(plane) : bps[0].sketchOnPlane(plane);
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
    if (d < bestDist) {
      bestDist = d;
      best = f;
    }
  }
  return { face: best, normal: best.normalAt() };
}

/** The line two planes (each `origin` + `normal`) share, or null if parallel —
 *  same math as `planeIntersectionLine` in document/planes.ts. `origin` is the
 *  foot of the perpendicular from the world origin onto that line. */
function intersectPlanes(o1: V3, n1: V3, o2: V3, n2: V3): { origin: V3; dir: V3 } | null {
  const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const dir = cross(n1, n2);
  const denom = dot(dir, dir);
  if (denom < 1e-12) return null;
  const d1 = dot(n1, o1),
    d2 = dot(n2, o2);
  const t1 = cross(n2, dir),
    t2 = cross(dir, n1);
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
    face.center.toTuple(),
    face.normalAt().toTuple(),
    profileFrame.origin,
    profileFrame.normal,
  );
  if (!line) throw new Error("revolve: axis face is parallel to the profile plane (no intersection line)");
  return line;
}

/** Resolve a body edge armed as a revolve axis to a world line (origin + dir).
 *  The edge must be STRAIGHT — a circular/spline edge isn't a line, so there'd be
 *  no axis to spin about. Re-found by persistent name first, then the stored
 *  mid/length fingerprint, sharing the dress-up resolver so a renamed edge
 *  behaves the same here as it does for a fillet. */
function edgeRevolveAxis(
  body: Body,
  edgeName: string | undefined,
  ref: { mid?: V3; length?: number },
  warn?: Warn,
): { origin: V3; dir: V3 } {
  if (!edgeName) throw new Error("revolve: axis edge has no name — edit the feature to re-pick it");
  const { hits, lost } = resolveDressUpEdges(body, [edgeName], [{ name: edgeName, ...ref }], warn);
  if (lost.length || hits.length === 0) {
    throw new Error(
      `revolve: axis edge "${edgeName}" no longer exists on the body and nothing similar was found — edit the feature to re-pick it`,
    );
  }
  const edge = hits[0];
  if (edge.geomType !== "LINE") throw new Error("revolve: axis edge must be straight (a curved edge isn't an axis)");
  const a = edge.startPoint.toTuple() as V3;
  const b = edge.endPoint.toTuple() as V3;
  const dir: V3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  if (Math.hypot(dir[0], dir[1], dir[2]) < 1e-9) throw new Error("revolve: axis edge is degenerate (zero length)");
  return { origin: a, dir };
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
  const centerDist = Math.hypot(fb.center[0] - tb.center[0], fb.center[1] - tb.center[1], fb.center[2] - tb.center[2]);
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

/** [min,max] of an axis-aligned box's 8 corners projected onto `axis`. */
function projectBounds(
  bounds: [[number, number, number], [number, number, number]],
  axis: [number, number, number],
): [number, number] {
  const [mn, mx] = bounds;
  let lo = Infinity,
    hi = -Infinity;
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
  const diag = (b: [[number, number, number], [number, number, number]]) =>
    Math.hypot(b[1][0] - b[0][0], b[1][1] - b[0][1], b[1][2] - b[0][2]);
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
  const d = clamp(m[2], -1, 1); // cos angle between +z and m
  if (d < 0.999999) {
    let ax: Vec3 = [-m[1], m[0], 0]; // (0,0,1) × m
    const al = Math.hypot(ax[0], ax[1], ax[2]);
    if (al < 1e-9)
      ax = [1, 0, 0]; // m == -z → rotate 180° about x
    else ax = [ax[0] / al, ax[1] / al, ax[2] / al];
    box = box.rotate((Math.acos(d) * 180) / Math.PI, [0, 0, 0], ax) as Shape3D;
  }
  return box.translate(q[0], q[1], q[2]) as Shape3D;
}

/** A clip plane for an "up to" extrude: the target face's plane, with a normal
 *  oriented to point AWAY from the profile (along the travel direction), so a
 *  half-space box on the +normal side cuts the prism flush with the face. */
interface ClipPlane {
  point: Vec3;
  normal: Vec3;
  boxSize: number;
}
function makeClipPlane(
  facePoint: Vec3,
  faceNormal: Vec3,
  extrudeNormal: Vector,
  dirSign: number,
  reach: number,
): ClipPlane {
  const en = extrudeNormal.normalized().toTuple();
  const dir: Vec3 = [en[0] * dirSign, en[1] * dirSign, en[2] * dirSign];
  const fn = vunit(faceNormal);
  const normal: Vec3 = vdot(fn, dir) >= 0 ? fn : [-fn[0], -fn[1], -fn[2]];
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
  const u = vunit(vcross(n, Math.abs(n[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0]));
  const v = vunit(vcross(n, u));
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
      const denom = vdot(n, m);
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
      'up to next: the next face only partially covers the profile — it doesn\'t fully block the extrude. Use a smaller profile, extent "up to face", or a blind distance.',
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
function booleanNamed(
  op: "fuse" | "cut" | "common",
  base: NamedShape,
  tool: NamedShape,
  fuzzy = BOOL_FUZZY,
): NamedShape {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const oc = getOC() as any;
  const progress = new oc.Message_ProgressRange_1();
  // Low-level construction (empty ctor + SetArguments/SetTools) so we can set a
  // fuzzy value before Build — the (S1,S2,PR) ctor performs the op immediately,
  // leaving no window to configure it. args = base, tools = tool (for cut this
  // is base − tool).
  const builder =
    op === "fuse"
      ? new oc.BRepAlgoAPI_Fuse_1()
      : op === "cut"
        ? new oc.BRepAlgoAPI_Cut_1()
        : new oc.BRepAlgoAPI_Common_1();
  const args = new oc.TopTools_ListOfShape_1();
  args.Append_1(base.shape.wrapped);
  const tools = new oc.TopTools_ListOfShape_1();
  tools.Append_1(tool.shape.wrapped);
  builder.SetArguments(args);
  builder.SetTools(tools);
  if (fuzzy > 0) builder.SetFuzzyValue(fuzzy);
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
      if (images.length === 0)
        names.set(f.hashCode, nm); // unchanged passthrough
      else for (const img of images) assign(hashOf(img), nm);
    }
  }
  builder.delete();
  args.delete();
  tools.delete();
  progress.delete();
  return { shape, names };
}

/** `booleanNamed`, retried down BOOL_FUZZY_FALLBACKS while OCCT hands back a
 *  DEGENERATE (solid-less) shape. BRepAlgoAPI is not robust on near-tangent
 *  B-spline pairs: the same cut can yield an empty shape at one fuzzy value and
 *  the correct solid at the next, so one attempt isn't enough. Returns the first
 *  result with a solid in it; if every tolerance degenerates, returns the last
 *  one and lets the caller report the failure. */
function booleanRetrying(op: "fuse" | "cut" | "common", base: NamedShape, tool: NamedShape): NamedShape {
  let last: NamedShape | null = null;
  for (const fuzzy of BOOL_FUZZY_FALLBACKS) {
    const next = booleanNamed(op, base, tool, fuzzy);
    if (countSolids(next.shape) > 0) {
      if (last) last.shape.delete();
      return next;
    }
    if (last) last.shape.delete();
    last = next;
  }
  return last!;
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
  // A face whose normal cannot be evaluated at its centre of mass is skipped
  // rather than aborting the merge. A CONE band's centroid lies off its own
  // surface and OCCT's projection fails there (StdFail_NotDone) — which used to
  // take down the entire regeneration, not just this face: a chamfered rim is a
  // conical band, so any later "add" extrude onto that body threw here AFTER the
  // fuse had already freed the target's shape, and the mesh pass then freed it a
  // second time ("This object has been deleted"). Such a face simply does not
  // take part in name matching.
  const centreNormal = (f: Face): Vec3 | null => {
    try {
      return vunit(f.normalAt(f.center).toTuple() as Vec3);
    } catch {
      return null;
    }
  };
  const originals: { nm: string; c: Vec3; n: Vec3 }[] = [];
  for (const f of named.shape.faces) {
    const nm = named.names.get(f.hashCode);
    if (!nm) continue;
    const n = centreNormal(f);
    if (n) originals.push({ nm, c: f.center.toTuple() as Vec3, n });
  }
  const names = new Map<number, string>();
  for (const uf of shape.faces) {
    const n = centreNormal(uf);
    if (!n) continue; // same reason as above — leave it unnamed rather than throw
    const c = uf.center.toTuple() as Vec3;
    let best: string | undefined;
    let bestD = Infinity;
    for (const o of originals) {
      if (Math.abs(vdot(o.n, n)) < 0.999) continue; // not coplanar-parallel
      const dd = (o.c[0] - c[0]) ** 2 + (o.c[1] - c[1]) ** 2 + (o.c[2] - c[2]) ** 2;
      if (dd < bestD) {
        bestD = dd;
        best = o.nm;
      }
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
    try {
      length = e.length;
    } catch {
      /* degenerate edge — mid still matches */
    }
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

/**
 * The boundary edges of every named face — what a face selection means to a
 * chamfer/fillet: dress everything around this face.
 *
 * A picked face is first widened to the smooth SURFACE it belongs to (the same
 * clustering the display shades as one surface, and the same one the viewport
 * highlights on a face pick). That is what makes this useful on round geometry:
 * a faceted wall's 96 facets are one surface, so its boundary is the two rims,
 * not one facet's four sides. Edges INTERNAL to the surface — the facet seams,
 * each shared by two of its faces — are dropped for the same reason; they are
 * artifacts of faceting and dressing them would shred the wall.
 *
 * Returns edges in shape order and deduplicated, so a face and one of its own
 * edges can both be selected without dressing that edge twice.
 */
function faceBoundaryEdgesNamed(
  target: Body,
  faceNames: string[],
  faceRefs: ResolvedFaceRef[] | undefined,
  warn: Warn | undefined,
): { hits: Edge[]; lost: string[] } {
  const clusterOf = faceClustersFrom(target.shape);
  const byHash = new Map(target.shape.faces.map((f) => [f.hashCode, f]));
  const lost: string[] = [];
  const wantedEdges = new Set<number>();

  faceNames.forEach((nm, i) => {
    let face: Face | undefined;
    for (const f of target.shape.faces) {
      if (target.names.get(f.hashCode) === nm) {
        face = f;
        break;
      }
    }
    if (!face) {
      // Name gone — same geometric fallback as every other named reference.
      const ref = faceRefs?.[i];
      const candidates: FaceCandidate[] = target.shape.faces.map((f) => ({
        center: f.center.toTuple() as [number, number, number],
        normal: f.geomType === "PLANE" ? (f.normalAt().normalized().toTuple() as [number, number, number]) : undefined,
      }));
      const m = ref?.center
        ? matchFace({ center: ref.center, normal: ref.normal }, candidates, bboxDiagonal(target.shape))
        : null;
      if (!m) {
        lost.push(nm);
        return;
      }
      face = target.shape.faces[m.index];
      warn?.(`face "${nm}" was renamed by an upstream edit; re-matched geometrically`);
    }
    // The whole smooth surface, then its boundary: an edge used by exactly one
    // of the surface's faces. (Facet seams are used by two and drop out.)
    const rep = clusterOf.get(face.hashCode) ?? face.hashCode;
    const surface: Face[] = [];
    for (const [h, r] of clusterOf) {
      if (r !== rep) continue;
      const f = byHash.get(h);
      if (f) surface.push(f);
    }
    if (surface.length === 0) surface.push(face);
    const useCount = new Map<number, number>();
    for (const f of surface) {
      for (const e of f.edges) useCount.set(e.hashCode, (useCount.get(e.hashCode) ?? 0) + 1);
    }
    for (const [h, n] of useCount) if (n === 1) wantedEdges.add(h);
  });

  const hits = target.shape.edges.filter((e) => wantedEdges.has(e.hashCode));
  return { hits, lost };
}

/**
 * True when any two of these edges meet at a shared vertex — i.e. they touch.
 *
 * The boolean fast path sweeps a wedge along each edge independently and stops
 * it at the edge's ends. Where two dressed edges meet, their wedges overlap in
 * the corner and the cut leaves it subdivided rather than mitred: chamfering two
 * adjacent top edges of a box shredded the top face into a grid of slivers and
 * cost it its `+z` name. Mitring a corner is what BRepFilletAPI does properly,
 * so touching selections are handed back to it — the same reasoning as the
 * tangent-chain gate, one step further along the same edge.
 *
 * A closed edge starts and ends at one vertex, so each edge's own endpoints are
 * de-duplicated before looking for collisions with other edges.
 */
function edgesShareAVertex(hits: Edge[]): boolean {
  const vkey = (p: V3) => `${Math.round(p[0] * 1e3)},${Math.round(p[1] * 1e3)},${Math.round(p[2] * 1e3)}`;
  const seen = new Set<string>();
  for (const e of hits) {
    let pts: V3[];
    try {
      pts = sampleEdgePoints(e);
    } catch {
      return true;
    } // unreadable — assume the worst
    if (pts.length < 2) continue;
    const ends = new Set([vkey(pts[0]), vkey(pts[pts.length - 1])]);
    for (const k of ends) {
      if (seen.has(k)) return true;
      seen.add(k);
    }
  }
  return false;
}

/** The reference face for an angled chamfer: one of the (≤2) faces meeting at
 *  `edge`, picked deterministically so the bevel doesn't flip side between
 *  regens. Faces are ordered by their PERSISTENT name (the same names the rest
 *  of the document references), unnamed ones last and broken by hashCode;
 *  `flip` takes the second one. Returns null when the edge has no adjacent face
 *  in `adj` (so the caller can fall back to a symmetric chamfer). */
function chamferRefFace(adj: Map<number, Face[]>, names: Map<number, string>, edge: Edge, flip: boolean): Face | null {
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

/** A planar face through 3+ coplanar world points, on their own plane. Used for a
 *  chamfer's cross-section triangle; null if the points are collinear. */
function polygonFace(pts: V3[]): Face | null {
  if (pts.length < 3) return null;
  const e1: V3 = [pts[1][0] - pts[0][0], pts[1][1] - pts[0][1], pts[1][2] - pts[0][2]];
  const e2: V3 = [pts[2][0] - pts[0][0], pts[2][1] - pts[0][1], pts[2][2] - pts[0][2]];
  const nRaw = vcross(e1, e2);
  if (Math.hypot(nRaw[0], nRaw[1], nRaw[2]) < 1e-12) return null;
  const n = vunit(nRaw);
  const u = vunit(e1);
  const frame: ResolvedFrame = { origin: pts[0], uAxis: u, vAxis: vcross(n, u), normal: n };
  const outline: [number, number][] = pts.map((p) => {
    const d: V3 = [p[0] - pts[0][0], p[1] - pts[0][1], p[2] - pts[0][2]];
    return [vdot(d, u), vdot(d, frame.vAxis as V3)];
  });
  return regionFace({ kind: "sketchRegion", outline, frame }, planeOf(frame));
}

/** A fillet's cross-section as a face: two segments out along the faces, closed
 *  by a TRUE arc of radius `r` tangent to both. Built from exact curve segments
 *  rather than a polyline, so the rounded surface really is round rather than a
 *  fan of chords. Null if the points are degenerate. */
/**
 * The cross-section of a revolved ring tool: the corner region to remove, but
 * with its OUTER boundary pushed `margin` clear of both faces.
 *
 * The per-edge wedge can afford a sharp corner, because its two legs lie exactly
 * IN the body's two faces and OCCT's fuzzy boolean copes with coincidence. A
 * revolved tool cannot: its outer surface is a cylinder that would be exactly
 * TANGENT to each of the 96 wall facets, touching at every vertex and nowhere
 * else, and the cut fails outright (StdFail_NotDone). Padding outward turns
 * every contact transversal.
 *
 * Local frame: u along the reference face, v along the other, so the material is
 * the u ≥ 0, v ≥ 0 quadrant and the padding runs into negative u and v — outside
 * the solid, where there is nothing to disturb.
 */
function ringSectionFace(
  op: "chamfer" | "fillet",
  corner: V3,
  towardRef: V3,
  towardOther: V3,
  legs: { ref: number; other: number },
  margin: number,
): Face | null {
  const u = vunit(towardRef);
  const v = vunit(towardOther);
  const n = vcross(u, v);
  if (Math.hypot(n[0], n[1], n[2]) < 1e-12) return null;
  const frame: ResolvedFrame = { origin: corner, uAxis: u, vAxis: v, normal: vunit(n) };
  const m = margin;
  // A fillet takes the whole padded BOX; its round is carved out afterwards by
  // subtracting an analytic torus (see revolvedRingTool). Revolving the arc
  // directly is geometrically right but yields a generic REVOLUTION_SURFACE,
  // which has no fast intersector. A chamfer's bevel closes the box across the
  // corner instead, and a revolved line canonicalises to a CONE by itself.
  const outline: [number, number][] =
    op === "fillet"
      ? [
          [legs.ref, -m],
          [-m, -m],
          [-m, legs.other],
          [legs.ref, legs.other],
        ]
      : [
          [legs.ref, 0],
          [legs.ref, -m],
          [-m, -m],
          [-m, legs.other],
          [0, legs.other],
        ];
  const segments: ProfileSegment[] = outline.slice(1).map((to) => ({ kind: "line" as const, to }));
  segments.push({ kind: "line", to: outline[0] });
  try {
    return regionFace({ kind: "sketchRegion", outline, frame, segmentStart: outline[0], segments }, planeOf(frame));
  } catch {
    return null;
  }
}

function filletFace(onEdge: V3, towardRef: V3, towardOther: V3, r: number): Face | null {
  const cs = filletCrossSection(onEdge, towardRef, towardOther, r);
  if (!cs) return null;
  // A 2D frame on the cross-section's own plane: u along the reference face, v
  // along the other. Both legs are the radius, so the plane is well conditioned.
  const u = vunit(towardRef);
  const v = vunit(towardOther);
  const n = vcross(u, v);
  if (Math.hypot(n[0], n[1], n[2]) < 1e-12) return null;
  const frame: ResolvedFrame = { origin: onEdge, uAxis: u, vAxis: v, normal: vunit(n) };
  const uv = (p: V3): [number, number] => {
    const d: V3 = [p[0] - onEdge[0], p[1] - onEdge[1], p[2] - onEdge[2]];
    return [vdot(d, u), vdot(d, v)];
  };
  // Loop: corner → along the reference face → arc (through arcMid) → back. The
  // `outline` is the faceted fallback; `segments` is what the kernel prefers.
  const corner = uv(cs.corner);
  const endRef = uv(cs.endRef);
  const endOther = uv(cs.endOther);
  const arcMid = uv(cs.arcMid);
  try {
    return regionFace(
      {
        kind: "sketchRegion",
        outline: [corner, endRef, arcMid, endOther],
        frame,
        segmentStart: corner,
        segments: [
          { kind: "line", to: endRef },
          { kind: "arc", mid: arcMid, to: endOther },
        ],
      },
      planeOf(frame),
    );
  } catch {
    return null; // the caller falls back to OCCT
  }
}

/** The solid a chamfer or fillet removes (or adds), for the one configuration
 *  where it can be built exactly by hand: a STRAIGHT edge between two PLANAR faces
 *  meeting at a right angle. `convex` says whether the caller should CUT it away or
 *  FUSE it in. The two differ only in the cross-section — a straight bevel for a
 *  chamfer, an arc tangent to both faces for a fillet; the sweep, the convexity
 *  test, the fit checks and the concave bounding are shared.
 *
 *  Why this exists. BRepFilletAPI must propagate the run-out onto whatever
 *  adjoins the edge's ends. Our round walls are polygons, so the run-out reaches a
 *  facet boundary as soon as the chamfer is wider than one facet chord, and OCCT
 *  fails. Measured on a 96-gon at r = 18 (chord 1.178mm): builds at 1.17, fails at
 *  1.18; halving the facet count to 48 (chord 2.356) moves the cutoff to between 2
 *  and 3. So the biggest chamfer you could build WAS the facet chord — the rounder
 *  the wall, the smaller the chamfer, which is backwards. A boolean has no run-out
 *  to propagate, so faceting stops mattering.
 *
 *  Returns null for anything it can't do exactly, so the caller falls back. */
function dressUpWedgeFor(
  op: "chamfer" | "fillet",
  edge: Edge,
  adjacent: Face[],
  size: number,
  angleDeg: number,
  flip: boolean,
  id: string,
): { wedge: NamedShape; convex: boolean } | null {
  if (edge.geomType !== "LINE" || adjacent.length !== 2) return null;
  if (adjacent.some((f) => f.geomType !== "PLANE")) return null;

  let pts: V3[];
  try {
    pts = sampleEdgePoints(edge);
  } catch {
    return null;
  }
  if (pts.length < 2) return null;
  const a = pts[0],
    b = pts[pts.length - 1];
  const len = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
  if (!(len > 1e-9)) return null;
  const along = vunit([b[0] - a[0], b[1] - a[1], b[2] - a[2]]);

  const n1 = faceOutwardNormal(adjacent[0]);
  const n2 = faceOutwardNormal(adjacent[1]);
  if (!n1 || !n2) return null;
  if (!isRightAngle(n1, n2)) return null;

  const mid: V3 = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
  const t1 = inFaceDirection(along, n1, mid, adjacent[0].center.toTuple() as V3);
  const t2 = inFaceDirection(along, n2, mid, adjacent[1].center.toTuple() as V3);
  if (!t1 || !t2) return null;
  const convex = isConvexEdge(t1, n2);

  // A fillet has no angle: both legs are the radius.
  const legs =
    op === "fillet"
      ? size > 1e-9 && Number.isFinite(size)
        ? { ref: size, other: size }
        : null
      : chamferLegs(size, angleDeg);
  if (!legs) return null;
  const [tRef, tOther] = flip ? [t2, t1] : [t1, t2];
  const [fRef, fOther] = flip ? [adjacent[1], adjacent[0]] : [adjacent[0], adjacent[1]];

  // How far a face reaches from the edge in a direction — the room a leg has.
  const reach = (f: Face, t: V3): number => {
    let far = 0;
    for (const e of f.edges) {
      let ps: V3[];
      try {
        ps = sampleEdgePoints(e);
      } catch {
        continue;
      }
      for (const p of ps) far = Math.max(far, vdot([p[0] - mid[0], p[1] - mid[1], p[2] - mid[2]], t));
    }
    return far;
  };
  if (!legFits(legs.ref, reach(fRef, tRef))) return null;
  if (!legFits(legs.other, reach(fOther, tOther))) return null;

  // Sweep the cross-section triangle along the edge, a hair past both ends so the
  // booleans intersect transversally instead of exactly touching at the endpoints.
  const pad = Math.max(len * 1e-3, 1e-4);
  const o: V3 = [a[0] - along[0] * pad, a[1] - along[1] * pad, a[2] - along[2] * pad];
  const tri =
    op === "fillet" ? filletFace(o, tRef, tOther, legs.ref) : polygonFace(chamferTriangle(o, tRef, tOther, legs));
  if (!tri) return null;

  let wedge: NamedShape;
  try {
    wedge = prismFromFace(tri, new Vector(along), len + 2 * pad, `${id}/wedge`);
  } catch {
    return null;
  }

  // A tool's names must not leak into the result: leaving the new faces unnamed
  // lets the caller name them `${id}/chamfer`, as the OCCT path does.
  const bare = (s: NamedShape): NamedShape => ({ shape: s.shape, names: new Map() });
  if (convex) return { wedge: bare(wedge), convex };

  // Concave: the notch lies OUTSIDE the body, so the body can't bound the wedge.
  // Bound it by the two faces' own extents swept outwards — the notch exists
  // exactly where both faces do. Without this the wedge protrudes past the edge's
  // ends, since a chamfer along a diameter runs off the rim where its
  // cross-section is already outside the cylinder.
  try {
    let bounded = wedge;
    for (let i = 0; i < 2; i++) {
      const sweep = prismFromFace(
        adjacent[i],
        new Vector(i === 0 ? n1 : n2),
        Math.max(legs.ref, legs.other) * 4 + 1,
        `${id}/bound`,
      );
      const next = booleanNamed("common", bounded, sweep);
      if (bounded !== wedge) bounded.shape.delete();
      sweep.shape.delete();
      bounded = next;
    }
    if (bounded.shape.faces.length === 0) {
      bounded.shape.delete();
      wedge.shape.delete();
      return null;
    }
    if (bounded !== wedge) wedge.shape.delete();
    return { wedge: bare(bounded), convex };
  } catch {
    return null;
  }
}

/** Name whatever a boolean-built dress-up created and bound it. The faces the
 *  booleans made carry no name (the tools were stripped), so they are the
 *  bevels/rounds — named as the OCCT path names them. `changedBox` bounds just
 *  those faces, which is what keeps the delta preview honest. */
function nameBooleanDressUp(
  acc: NamedShape,
  op: "chamfer" | "fillet",
  id: string,
): NamedShape & { changedBox?: [Vec3, Vec3] } {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const oc = getOC() as any;
  const names = new Map(acc.names);
  const bnd = new oc.Bnd_Box_1();
  let n = 0;
  for (const f of acc.shape.faces) {
    if (names.has(f.hashCode)) continue;
    names.set(f.hashCode, n === 0 ? `${id}/${op}` : `${id}/${op}#${n}`);
    n++;
    oc.BRepBndLib.Add(f.wrapped, bnd, false);
  }
  let changedBox: [Vec3, Vec3] | undefined;
  if (!bnd.IsVoid()) {
    const lo = bnd.CornerMin(),
      hi = bnd.CornerMax();
    changedBox = [
      [lo.X(), lo.Y(), lo.Z()],
      [hi.X(), hi.Y(), hi.Z()],
    ];
  }
  bnd.delete();
  return { shape: acc.shape, names, changedBox };
}

/**
 * The dress-up tool for a whole faceted circle: the cross-section swept ONCE all
 * the way round, instead of one prism per chord.
 *
 * A 96-chord rim has no good per-chord answer. Sweeping a wedge along each chord
 * leaves the corners between them uncut — a castellated crown of 96 teeth. And
 * `BRepFilletAPI`, handed the 96 edges, returns a top face whose boundary wire
 * SELF-OVERLAPS: each inner edge keeps its full original chord length (measured:
 * perimeter 188.46mm, the circumference of the r=30 rim it came from, on a ring
 * at r=26 where a mitred 96-gon would be 163.3) so consecutive edges cross by
 * 0.29°. That renders correctly and poisons everything built on that face —
 * extruding it carries the bad wire up, and dressing THAT rim is what produced
 * the crown in the wild.
 *
 * Revolving one cross-section has neither problem: the result is a single
 * analytic round/bevel face bounded by true circles.
 *
 * The cross-section is placed at the ring's CIRCUMSCRIBED radius — a chord's
 * midpoint is nearer than its endpoints by the sagitta, so a tool built at the
 * midpoint radius would fall short at each vertex and leave 96 slivers, the
 * crown again in miniature. At the vertex radius the tool covers the corner
 * everywhere and merely cuts ~16µm deeper into the wall mid-chord (r=30, 96
 * facets), far below the faceting error already present.
 *
 * CONVEX rings only. A concave ring is added material rather than removed, so
 * which way the sagitta should err is the opposite question, and the existing
 * paths already handle the concave joints this codebase cares about — see
 * verify-fillet-boolean. Returns null for anything it can't do exactly.
 */
function revolvedRingTool(
  op: "chamfer" | "fillet",
  hits: Edge[],
  adj: Map<number, Face[]>,
  size: number,
  angleDeg: number,
  flip: boolean,
): { tool: NamedShape; sagitta: number } | null {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const oc = getOC() as any;

  // Every chord must be a straight edge between two planar faces, or this is not
  // the faceted-circle shape we think it is.
  const chords: [V3, V3][] = [];
  for (const e of hits) {
    if (e.geomType !== "LINE") return null;
    const fs = adj.get(e.hashCode);
    if (!fs || fs.length !== 2 || fs.some((f) => f.geomType !== "PLANE")) return null;
    let pts: V3[];
    try {
      pts = sampleEdgePoints(e);
    } catch {
      return null;
    }
    if (pts.length < 2) return null;
    chords.push([pts[0], pts[pts.length - 1]]);
  }
  const ring = fitRing(chords);
  if (!ring) return null;

  // Geometry at one representative chord — the ring is uniform, so any will do.
  const rep = hits[0];
  const adjacent = adj.get(rep.hashCode)!;
  const [a, b] = chords[0];
  const len = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
  if (!(len > 1e-9)) return null;
  const along = vunit([b[0] - a[0], b[1] - a[1], b[2] - a[2]]);
  const n1 = faceOutwardNormal(adjacent[0]);
  const n2 = faceOutwardNormal(adjacent[1]);
  if (!n1 || !n2 || !isRightAngle(n1, n2)) return null;
  const mid: V3 = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
  const t1 = inFaceDirection(along, n1, mid, adjacent[0].center.toTuple() as V3);
  const t2 = inFaceDirection(along, n2, mid, adjacent[1].center.toTuple() as V3);
  if (!t1 || !t2) return null;
  if (!isConvexEdge(t1, n2)) return null;

  const legs =
    op === "fillet"
      ? size > 1e-9 && Number.isFinite(size)
        ? { ref: size, other: size }
        : null
      : chamferLegs(size, angleDeg);
  if (!legs) return null;
  const [tRef, tOther] = flip ? [t2, t1] : [t1, t2];
  const [fRef, fOther] = flip ? [adjacent[1], adjacent[0]] : [adjacent[0], adjacent[1]];

  // Both legs must fit on their face, same test as the per-edge wedge.
  const reach = (f: Face, t: V3): number => {
    let far = 0;
    for (const e of f.edges) {
      let ps: V3[];
      try {
        ps = sampleEdgePoints(e);
      } catch {
        continue;
      }
      for (const p of ps) far = Math.max(far, vdot([p[0] - mid[0], p[1] - mid[1], p[2] - mid[2]], t));
    }
    return far;
  };
  if (!legFits(legs.ref, reach(fRef, tRef))) return null;
  if (!legFits(legs.other, reach(fOther, tOther))) return null;

  // Rebuild the cross-section in the AXIAL half-plane through this chord. The
  // chord's own perpendicular plane is tilted off the axis by half a facet, and
  // revolving a profile that isn't axial sweeps a skewed surface.
  const spoke: V3 = [mid[0] - ring.center[0], mid[1] - ring.center[1], mid[2] - ring.center[2]];
  const height = vdot(spoke, ring.axis);
  const radial = vunit([
    spoke[0] - ring.axis[0] * height,
    spoke[1] - ring.axis[1] * height,
    spoke[2] - ring.axis[2] * height,
  ]);
  if (!(Math.hypot(radial[0], radial[1], radial[2]) > 0.5)) return null;
  // The circumferential direction — the component to drop from each leg.
  const around = vunit(vcross(ring.axis, radial));
  const axialize = (t: V3): V3 => {
    const k = vdot(t, around);
    return vunit([t[0] - around[0] * k, t[1] - around[1] * k, t[2] - around[2] * k]);
  };
  const aRef = axialize(tRef);
  const aOther = axialize(tOther);
  if (!(Math.hypot(...aRef) > 0.5) || !(Math.hypot(...aOther) > 0.5)) return null;
  // The corner, moved out to the vertex radius (see the sagitta note above).
  const corner: V3 = [
    ring.center[0] + radial[0] * ring.radius + ring.axis[0] * height,
    ring.center[1] + radial[1] * ring.radius + ring.axis[1] * height,
    ring.center[2] + radial[2] * ring.radius + ring.axis[2] * height,
  ];

  // Clear the wall by more than the sagitta (chord midpoints sit that far inside
  // the vertex radius) and the cap by a hair, so no surface is tangent — but keep
  // it small enough that the tool cannot reach a neighbouring feature.
  //
  // The floor is a comfortable multiple of the boolean's fuzzy value so the
  // OUTER surface can never read as coincident either. A tenth of a millimetre
  // is far too little to reach a neighbouring feature. (What actually decides
  // whether the facets survive intact is the fuzz used for the cut, not this —
  // see the sagitta note at the call site.)
  const sagitta = ring.radius * (1 - Math.cos(Math.PI / ring.segments));
  const margin = Math.max(sagitta * 4, size * 0.02, BOOL_FUZZY * 10);
  const section = ringSectionFace(op, corner, aRef, aOther, legs, margin);
  if (!section) return null;

  try {
    // Analytic MakeRevol, NOT the faceted loft revolveFromFace prefers. The
    // faceted tool carries 480 faces here and made the cut far worse: 1807ms for
    // a fillet and 1223ms for a chamfer, against 1276 and 148 analytically.
    const pnt = new oc.gp_Pnt_3(ring.center[0], ring.center[1], ring.center[2]);
    const dir = new oc.gp_Dir_4(ring.axis[0], ring.axis[1], ring.axis[2]);
    const ax1 = new oc.gp_Ax1_2(pnt, dir);
    const builder = new oc.BRepPrimAPI_MakeRevol_1(section.wrapped, ax1, 2 * Math.PI, false);
    let shape = cast(builder.Shape()) as Shape3D;
    builder.delete();
    if (op === "fillet") {
      // Subtract the round as an ANALYTIC torus. OCCT canonicalises a revolved
      // LINE into a cone or cylinder — which is why a chamfer's band comes out
      // CONE and cuts in 148ms — but leaves a revolved arc as a generic
      // REVOLUTION_SURFACE with no fast intersector, and that cut measured
      // 1276ms against the same 96 facets. Built this way the band is a real
      // TORUS, so the intersections stay analytic.
      //
      // The arc's centre sits one radius in along both faces from the corner;
      // revolved, that is a torus of major radius |centre − axis| and minor
      // radius `legs.ref`, coaxial with the ring.
      const ctr: V3 = [
        corner[0] + aRef[0] * legs.ref + aOther[0] * legs.ref,
        corner[1] + aRef[1] * legs.ref + aOther[1] * legs.ref,
        corner[2] + aRef[2] * legs.ref + aOther[2] * legs.ref,
      ];
      const spokeC: V3 = [ctr[0] - ring.center[0], ctr[1] - ring.center[1], ctr[2] - ring.center[2]];
      const hC = vdot(spokeC, ring.axis);
      const major = Math.hypot(
        spokeC[0] - ring.axis[0] * hC,
        spokeC[1] - ring.axis[1] * hC,
        spokeC[2] - ring.axis[2] * hC,
      );
      if (!(major > legs.ref)) {
        shape.delete();
        return null;
      } // torus would self-intersect
      const tp = new oc.gp_Pnt_3(
        ring.center[0] + ring.axis[0] * hC,
        ring.center[1] + ring.axis[1] * hC,
        ring.center[2] + ring.axis[2] * hC,
      );
      const td = new oc.gp_Dir_4(ring.axis[0], ring.axis[1], ring.axis[2]);
      const ax2 = new oc.gp_Ax2_3(tp, td);
      const tb = new oc.BRepPrimAPI_MakeTorus_5(ax2, major, legs.ref);
      const torus: NamedShape = { shape: cast(tb.Shape()) as Shape3D, names: new Map() };
      tb.delete();
      const carved = booleanNamed("cut", { shape, names: new Map() }, torus);
      torus.shape.delete();
      shape.delete();
      shape = carved.shape;
    }
    // Unnamed on purpose: the caller names whatever the boolean creates, exactly
    // as it does for the per-edge wedges and the OCCT path.
    return { tool: { shape, names: new Map() }, sagitta };
  } catch {
    return null;
  }
}

/** Chamfer or fillet the named edges of a body, propagating face names through
 *  the operation's history (modified faces keep their names; the new bevel/round
 *  faces are named after the feature). Modifies geometry; returns a NamedShape.
 *  `angle` (chamfer only, degrees) bevels asymmetrically: `size` is measured on
 *  the reference face and the bevel leaves it at `angle`. Undefined — and 45,
 *  which is the same cut — uses OCCT's plain symmetric chamfer instead.
 *  `changedBox` bounds the faces the operation GENERATED (the bevels/rounds) —
 *  i.e. where the shape actually changed. Used to keep the delta preview honest;
 *  see the `previewDelta` branch. */
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
  faceNames?: string[],
  faceRefs?: ResolvedFaceRef[],
): NamedShape & { changedBox?: [Vec3, Vec3] } {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const oc = getOC() as any;
  const { hits, lost } = resolveDressUpEdges(target, edgeNames, edgeRefs, warn);
  // Selected faces contribute their boundary edges, merged into the same list —
  // from here on a face selection IS an edge selection, so chain expansion, the
  // boolean fast path and the OCCT fallback all behave identically.
  if (faceNames?.length) {
    const fromFaces = faceBoundaryEdgesNamed(target, faceNames, faceRefs, warn);
    const have = new Set(hits.map((e) => e.hashCode));
    for (const e of fromFaces.hits)
      if (!have.has(e.hashCode)) {
        have.add(e.hashCode);
        hits.push(e);
      }
    if (fromFaces.lost.length > 0) {
      warn?.(
        `${fromFaces.lost.length} of ${faceNames.length} faces could not be re-found and were skipped: ` +
          `${fromFaces.lost.join(", ")} — edit the feature to re-pick them`,
      );
    }
  }
  if (hits.length === 0) {
    const what = faceNames?.length && edgeNames.length === 0 ? "faces" : "edges";
    throw new Error(
      `${op}: none of the ${what} could be re-found on the body (an upstream edit changed its shape) — edit the feature to re-pick them`,
    );
  }
  if (lost.length > 0) {
    warn?.(
      `${lost.length} of ${edgeNames.length} edges could not be re-found and were skipped: ${lost.join(", ")} — edit the feature to re-pick them`,
    );
  }

  // A stored edge list is a set of REPRESENTATIVES, not an inventory. Clicking a
  // faceted rim selects its whole tangent chain, but the feature saves the literal
  // segment names it had at the time — so if the wall is later cut into more
  // facets, the same list resolves to only PART of the rim and you get part of a
  // chamfer, silently. Expanding each hit to its chain makes "this rim" mean the
  // rim however finely it is cut. A straight edge is its own singleton and passes
  // through untouched, which is the common case. See geom/edgeChains.
  const chainOf = edgeChainsFrom(target.shape);
  const wanted = expandToChains(
    hits.map((e) => e.hashCode),
    chainOf,
  );
  const added = expansionCount(
    hits.map((e) => e.hashCode),
    wanted,
  );
  if (added > 0) {
    const byHash = new Map(target.shape.edges.map((e) => [e.hashCode, e]));
    hits.length = 0;
    for (const h of wanted) {
      const e = byHash.get(h);
      if (e) hits.push(e);
    }
    warn?.(
      `the stored selection covered ${hits.length - added} of ${hits.length} segments of its edge chain, ` +
        `so ${added} more were included to dress the whole curve — re-pick the edge to store it afresh`,
    );
  }

  // Edge → its (≤2) adjacent faces. Wanted by the angled-chamfer reference pick
  // and by the boolean fast path, so it's built either way.
  const adj = new Map<number, Face[]>();
  for (const f of target.shape.faces) {
    for (const e of f.edges) {
      const arr = adj.get(e.hashCode);
      if (arr) arr.push(f);
      else adj.set(e.hashCode, [f]);
    }
  }

  // A closed faceted circle is dressed with ONE tool swept all the way round —
  // see revolvedRingTool for why neither per-chord wedges nor BRepFilletAPI can
  // do this rim justice. Tried first, since a ring is exactly the tangent chain
  // the per-edge path below refuses.
  //
  // One tool per CHAIN, since a selection can hold several rings at once —
  // picking a cylinder's wall means both of its rims. All-or-nothing, like the
  // per-edge path: if any chain isn't a ring the whole selection falls through,
  // so a mixed pick never gets dressed two different ways.
  {
    const byChain = new Map<number, Edge[]>();
    for (const e of hits) {
      const k = chainOf.get(e.hashCode) ?? e.hashCode;
      const arr = byChain.get(k);
      if (arr) arr.push(e);
      else byChain.set(k, [e]);
    }
    const rings: { tool: NamedShape; sagitta: number }[] = [];
    for (const group of byChain.values()) {
      const r = revolvedRingTool(op, group, adj, size, angle ?? 45, flip ?? false);
      if (!r) break;
      rings.push(r);
    }
    if (rings.length === byChain.size && rings.length > 0) {
      const tools = rings.map((r) => r.tool);
      try {
        const tool = tools.length === 1 ? tools[0] : compoundOf(tools);
        // The round is TANGENT to the ring's circumscribed cylinder, and the
        // faceted wall touches that cylinder only at its vertices — pulling away
        // by the sagitta in between. When the sagitta is under the boolean's
        // fuzzy value the cut cannot tell the two apart and splits every facet in
        // two (measured: r=20 and r=10, whose sagittas are 0.011 and 0.005 against
        // a 0.01 fuzzy, came out at 194 names instead of 99; r=30 and r=50, at
        // 0.016 and 0.027, were already clean). So the fuzz has to fit under the
        // gap it is meant to resolve — the tightest one, with several rings.
        const gap = Math.min(...rings.map((r) => r.sagitta));
        const cut = booleanNamed(
          "cut",
          { shape: target.shape, names: target.names },
          tool,
          Math.min(BOOL_FUZZY, gap / 4),
        );
        if (tool !== tools[0]) tool.shape.delete();
        for (const t of tools) t.shape.delete();
        // No unifySameDomain here, unlike the per-edge path: these cuts leave no
        // coplanar duplicates to merge, and its name transfer matches faces by
        // parallel normals + nearest centre, which happily hands a new round's
        // name to whichever flat face it points at — leaving the round nameless.
        return nameBooleanDressUp(cut, op, id);
      } catch {
        for (const t of tools) {
          try {
            t.shape.delete();
          } catch {
            /* already gone */
          }
        }
      }
    } else {
      for (const r of rings) r.tool.shape.delete();
    }
  }

  // Fast path: when EVERY edge is a straight edge between two perpendicular flat
  // faces, the chamfer or fillet is built as a boolean instead — exact there, and
  // unlike BRepFilletAPI indifferent to how the adjoining round walls are faceted
  // (see dressUpWedgeFor: the old ceiling was one facet chord). All-or-nothing,
  // and every wedge is derived from the ORIGINAL shape, so no edge has to be
  // re-found on a partially rebuilt body.
  //
  // Only for edges that STAND ALONE, though. A wedge is swept along one edge and
  // stops at its ends, so where the next dressed edge continues smoothly — the
  // chords of a faceted rim — consecutive wedges meet at an angle and leave the
  // corner between them uncut. Dressing a cylinder's whole rim that way came out
  // as a castellated crown, 96 leftover teeth, at every size (measured: 146 faces
  // and 528 edges regardless of radius, which is itself the tell — a real bevel's
  // topology moves with its size). Blending across a chain is what BRepFilletAPI
  // is for, so hand those back. The cases the boolean exists for — a diameter
  // across a cylinder's top, a box edge, a step — are all singletons.
  const chainSize = new Map<number, number>();
  for (const rep of chainOf.values()) chainSize.set(rep, (chainSize.get(rep) ?? 0) + 1);
  const standalone = hits.every((e) => (chainSize.get(chainOf.get(e.hashCode) ?? e.hashCode) ?? 1) === 1);
  if (hits.length > 0 && standalone && !edgesShareAVertex(hits)) {
    const wedges: { wedge: NamedShape; convex: boolean }[] = [];
    let all = true;
    for (const e of hits) {
      const w = dressUpWedgeFor(op, e, adj.get(e.hashCode) ?? [], size, angle ?? 45, flip ?? false, id);
      if (!w) {
        all = false;
        break;
      }
      wedges.push(w);
    }
    if (all && wedges.length === hits.length) {
      try {
        let acc: NamedShape = { shape: target.shape, names: target.names };
        let owns = false;
        for (const kind of ["cut", "fuse"] as const) {
          const group = wedges.filter((w) => (kind === "cut") === w.convex).map((w) => w.wedge);
          if (group.length === 0) continue;
          const tool = group.length === 1 ? group[0] : compoundOf(group);
          const next = booleanNamed(kind, acc, tool);
          if (tool !== group[0]) tool.shape.delete();
          if (owns) acc.shape.delete();
          acc = next;
          owns = true;
        }
        for (const w of wedges) w.wedge.shape.delete();
        // A concave wedge is bounded by the extents of the two faces it lies
        // between, so its ends land exactly ON whatever the round runs out onto —
        // and a fuse keeps coplanar faces separate, leaving a hairline seam drawn
        // across each of them (measured: a filleted step came out 11 faces instead
        // of 9, one extra per end). Merge them, as the extrude and boolean paths
        // already do. Only when a boolean actually ran: otherwise `acc` still IS
        // the target body and unifyBody would delete it.
        if (owns) acc = unifyBody(acc);
        return nameBooleanDressUp(acc, op, id);
      } catch {
        // Fall through to OCCT below; the wedges are released either way.
        for (const w of wedges) {
          try {
            w.wedge.shape.delete();
          } catch {
            /* already gone */
          }
        }
      }
    } else {
      for (const w of wedges) w.wedge.shape.delete();
    }
  }

  const builder =
    op === "fillet"
      ? new oc.BRepFilletAPI_MakeFillet(target.shape.wrapped, oc.ChFi3d_FilletShape.ChFi3d_Rational)
      : new oc.BRepFilletAPI_MakeChamfer(target.shape.wrapped);

  // An angled chamfer needs a reference face per edge; 45° is exactly the
  // symmetric chamfer, so it keeps the simpler (and better-trodden) Add path.
  const angled = op === "chamfer" && angle !== undefined && Math.abs(angle - 45) > 1e-9;

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
  // The new bevel/round faces, generated from each dressed edge. Those faces
  // plus the edges they replaced bound the whole change exactly: everything the
  // operation added or removed lies between an original edge and the face that
  // superseded it.
  const bnd = new oc.Bnd_Box_1();
  for (const e of dressed) {
    oc.BRepBndLib.Add(e, bnd, false);
    for (const g of drainList(builder.Generated(e))) {
      assign(hashOf(g), `${id}/${op}`);
      oc.BRepBndLib.Add(g, bnd, false);
    }
  }
  let changedBox: [Vec3, Vec3] | undefined;
  if (!bnd.IsVoid()) {
    const lo = bnd.CornerMin();
    const hi = bnd.CornerMax();
    changedBox = [
      [lo.X(), lo.Y(), lo.Z()],
      [hi.X(), hi.Y(), hi.Z()],
    ];
  }
  bnd.delete();
  builder.delete();
  return { shape, names, changedBox };
}

/** An axis-aligned box solid spanning `[lo, hi]` grown by `margin` on every
 *  side. */
function boxFromBounds([lo, hi]: [Vec3, Vec3], margin: number): Shape3D {
  // makeBaseBox is centred in x and y, with its base on the z=0 plane.
  const box = makeBaseBox(
    hi[0] - lo[0] + 2 * margin,
    hi[1] - lo[1] + 2 * margin,
    hi[2] - lo[2] + 2 * margin,
  ) as Shape3D;
  return box.translate((lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, lo[2] - margin) as Shape3D;
}

/** Re-resolve a Shell's stored face references (the faces to remove) against
 *  the body's current faces — mirrors `resolveDressUpEdges`: exact persistent
 *  name first, then a suffix-insensitive base-name match, then a geometric
 *  match on the stored fingerprint (centroid + normal). Emits a warning for
 *  every re-matched or lost face; only outright-lost faces are dropped. */
function resolveShellFaces(
  target: Body,
  faceNames: string[],
  faceRefs: ResolvedFaceRef[] | undefined,
  warn: Warn | undefined,
): { hits: Face[]; lost: string[] } {
  const faces = target.shape.faces;

  // Fast path: every requested name still exists — no fingerprinting needed.
  const byName = new Map<string, number>();
  faces.forEach((f, i) => {
    const nm = target.names.get(f.hashCode);
    if (nm !== undefined && !byName.has(nm)) byName.set(nm, i);
  });
  if (faceNames.every((nm) => byName.has(nm))) {
    return { hits: faceNames.map((nm) => faces[byName.get(nm)!]), lost: [] };
  }

  // Slow path: build geometric candidates and match all refs one-to-one.
  const candidates: NamedFaceCandidate[] = faces.map((f) => ({
    name: target.names.get(f.hashCode),
    center: f.center.toTuple() as [number, number, number],
    normal: f.geomType === "PLANE" ? (f.normalAt().normalized().toTuple() as [number, number, number]) : undefined,
  }));
  const refs: NamedFaceRefFingerprint[] = faceNames.map((nm, i) => ({
    name: nm,
    center: faceRefs?.[i]?.center,
    normal: faceRefs?.[i]?.normal,
  }));
  const matches = matchFaces(refs, candidates, bboxDiagonal(target.shape));

  const hits: Face[] = [];
  const lost: string[] = [];
  matches.forEach((m, i) => {
    if (m.kind === "lost") {
      lost.push(faceNames[i]);
      return;
    }
    hits.push(faces[m.index]);
    if (m.kind !== "name") {
      const nowName = candidates[m.index].name;
      warn?.(
        `face "${faceNames[i]}" was renamed by an upstream edit; re-matched ` +
          `${m.kind === "base" ? "by base name" : "geometrically"}${nowName ? ` (now "${nowName}")` : ""}`,
      );
    }
  });
  return { hits, lost };
}

/** Is `result` a believable hollowing of `source`?
 *
 *  Face count alone is not enough, and quietly wasn't: MakeThickSolidByJoin on
 *  a lofted body returns a shape with ONE more face than it started with and a
 *  volume of exactly zero — a solid by topology, empty by geometry. That sailed
 *  through a `faces.length >` test and shipped an invisible body. Volume is the
 *  honest check: hollowing must leave something behind, and must remove
 *  something, so the result sits strictly between empty and the original.
 *
 *  BRepGProp integration isn't free, but it runs once per shell build (not per
 *  operand like a boolean chain), which is worth paying to never emit a
 *  phantom body. */
function isHollowedSolid(result: Shape3D, source: Shape3D): boolean {
  if (countSolids(result) === 0) return false;
  if (result.faces.length <= source.faces.length) return false;
  const srcVol = measureVolume(source);
  const resVol = measureVolume(result);
  // Relative floor, so this reads the same on a 2mm part and a 2m one.
  if (!(resVol > srcVol * 1e-6)) return false;
  return resVol < srcVol;
}

const SHELL_BUILD_FAILED =
  "Shell failed on this geometry — the offset could not be built. This is common on " +
  "freeform lofted surfaces; try a thinner wall, or hollow it by subtracting an inner body.";

/** Hollow out a body: remove the named faces (they become openings) and offset
 *  the remaining wall inward by `thickness`, propagating face names through
 *  the operation's history (kept faces keep their names; each kept face's new
 *  inner-offset face is named `"<name>/in"`). Zero faces makes a fully sealed
 *  hollow shell. Uses OCCT's `BRepOffsetAPI_MakeThickSolid` (the same op
 *  replicad's `.shell()` wraps) directly, since the running-fold model needs
 *  the target's `NamedShape` history, which replicad's high-level API doesn't
 *  expose. Modifies geometry; returns a NamedShape. */
function shellByOffset(target: Body, hits: Face[], thickness: number): NamedShape {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const oc = getOC() as any;
  const removedHashes = new Set(hits.map((f) => f.hashCode));
  const facesToRemove = new oc.TopTools_ListOfShape_1();
  for (const f of hits) facesToRemove.Append_1(f.wrapped);

  const builder = new oc.BRepOffsetAPI_MakeThickSolid();
  const progress = new oc.Message_ProgressRange_1();

  // A SEALED shell (no openings) cannot go through MakeThickSolidByJoin: that
  // op exists to open a solid along its closing faces, and handed an empty list
  // it does no work and returns the input untouched. Sealed shells therefore
  // produced a silently un-hollowed body until the result guard below started
  // rejecting them outright — and MakeThickSolidBySimple, the obvious
  // replacement, reports not-done for even a plain box in this OCCT build.
  // So build it the way the failure message tells users to: offset the solid
  // inward and subtract that. It's an ordinary boolean, so it also inherits
  // booleanRetrying's tolerance ladder for near-tangent walls.
  if (hits.length === 0) {
    const off = new oc.BRepOffsetAPI_MakeOffsetShape();
    // Everything from here to the cut is OCCT that can fail in ways that read
    // as gibberish to a user — IsDone() false, a null shape that blows up on
    // cast ("This shape has not type, it is null"), or a throw from deep in the
    // offsetter. A freeform loft hits all three. Whatever the mechanism, the
    // answer to the user is the same, so report the one actionable message
    // instead of leaking the internals.
    let cavity: Shape3D;
    try {
      off.PerformByJoin(
        target.shape.wrapped,
        -thickness,
        1e-3,
        oc.BRepOffset_Mode.BRepOffset_Skin,
        false,
        false,
        oc.GeomAbs_JoinType.GeomAbs_Arc,
        false,
        progress,
      );
      if (!off.IsDone()) throw new Error(SHELL_BUILD_FAILED);
      cavity = cast(off.Shape()) as Shape3D;
      if (cavity.faces.length === 0) throw new Error(SHELL_BUILD_FAILED);
    } catch {
      off.delete();
      builder.delete();
      progress.delete();
      facesToRemove.delete();
      throw new Error(SHELL_BUILD_FAILED);
    }
    // The cavity's walls inherit the identity of the faces they were offset
    // from, so a sealed shell names its inner faces "<face>/in" exactly like
    // the opened-face path does.
    const cavityNames = new Map<number, string>();
    for (const f of target.shape.faces) {
      const nm = target.names.get(f.hashCode);
      if (!nm) continue;
      // MakeOffsetShape reports the offset image under Generated for some
      // faces and Modified for others depending on whether the surface had to
      // be rebuilt, so take both rather than betting on one.
      const images = [...drainList(off.Generated(f.wrapped)), ...drainList(off.Modified(f.wrapped))];
      for (const img of images) cavityNames.set(hashOf(img), `${nm}/in`);
    }
    off.delete();
    builder.delete();
    progress.delete();
    facesToRemove.delete();

    let hollow: NamedShape;
    try {
      hollow = booleanRetrying(
        "cut",
        { shape: target.shape, names: target.names },
        { shape: cavity, names: cavityNames },
      );
    } catch {
      cavity.delete();
      throw new Error(SHELL_BUILD_FAILED);
    }
    cavity.delete();
    // Same degenerate-result guard as the opened path: a cut that collapsed
    // leaves a solid-less, empty or un-hollowed shape, which must not reach the
    // caller as a success.
    if (!isHollowedSolid(hollow.shape, target.shape)) {
      hollow.shape.delete();
      throw new Error(SHELL_BUILD_FAILED);
    }
    return hollow;
  }

  builder.MakeThickSolidByJoin(
    target.shape.wrapped,
    facesToRemove,
    -thickness,
    1e-3,
    oc.BRepOffset_Mode.BRepOffset_Skin,
    false,
    false,
    oc.GeomAbs_JoinType.GeomAbs_Arc,
    false,
    progress,
  );
  const shape = cast(builder.Shape()) as Shape3D;
  // MakeThickSolidByJoin can "succeed" and hand back a shape with no solid in it
  // (or the untouched input) on geometry it can't offset — freeform lofts with
  // many small spline patches are the usual case. Both look like success to the
  // caller, so check the result really is a hollowed solid rather than emitting a
  // zero-face body downstream.
  if (!isHollowedSolid(shape, target.shape)) {
    shape.delete();
    facesToRemove.delete();
    builder.delete();
    progress.delete();
    throw new Error(SHELL_BUILD_FAILED);
  }

  const names = new Map<number, string>();
  const used = new Map<string, number>();
  const assign = (h: number, name: string) => {
    const c = used.get(name) ?? 0;
    used.set(name, c + 1);
    names.set(h, c === 0 ? name : `${name}#${c}`);
  };
  for (const f of target.shape.faces) {
    // A removed face is skipped unconditionally: MakeThickSolidByJoin doesn't
    // reliably flag its "closing" faces IsDeleted (unlike a boolean/fillet),
    // so trusting IsDeleted here can leak the old name onto a stray hash that
    // happens to collide with an unrelated face in the result.
    if (removedHashes.has(f.hashCode)) continue;
    const nm = target.names.get(f.hashCode);
    if (!nm || builder.IsDeleted(f.wrapped)) continue;
    const images = drainList(builder.Modified(f.wrapped));
    if (images.length === 0) names.set(f.hashCode, nm);
    else for (const img of images) assign(hashOf(img), nm);
  }
  // The new inner-wall faces, generated as the offset image of each face that
  // was kept (an opening has no offset image of its own).
  for (const f of target.shape.faces) {
    if (removedHashes.has(f.hashCode)) continue;
    const nm = target.names.get(f.hashCode);
    if (!nm) continue;
    for (const g of drainList(builder.Generated(f.wrapped))) assign(hashOf(g), `${nm}/in`);
  }
  facesToRemove.delete();
  builder.delete();
  return { shape, names };
}

/** The loft a Shell target came from, when the body is still that loft and
 *  nothing else — see `loftShellSource`. */
type LoftShellSource = { id: string; profiles: RegionProfile[] };

/** How far past an opening the cavity reaches, as a multiple of the wall. The
 *  cut only has to CROSS the outer surface rather than touch it — a coincident
 *  face is the boolean that comes back empty — and reaching too far is free,
 *  since the excess is outside the body and removes nothing. */
const OPENING_OVERSHOOT = 2;

const SHELL_LOFT_FACE_UNSUPPORTED =
  "Shell couldn't work out where one of the picked faces meets this loft's sections, so it can't " +
  "open it. Pick a face of the loft itself — a cap or a side — rather than one of the inner faces " +
  "a previous shell created.";

/** Samples per section edge of the LOFT, when an opening is traced onto the
 *  sections. Every section is subdivided to about this multiple of the largest
 *  section's point count before tracing.
 *
 *  It has to be a multiple, not a match: `ThruSections` splits the sections
 *  against each other, so the loft can carry more side faces than either
 *  section has points — a square lofted to a hexagon has four and six, and
 *  twelve faces. Sampling at the sections' own resolution left most of those
 *  faces with no sample at all, and a pick on one of them traced to nothing. */
const OPENING_TRACE_RESOLUTION = 3;

/** Floor on points per traced section, so a coarse pair of sections still gets
 *  enough samples to tell their loft's faces apart. */
const MIN_TRACED_POINTS = 32;

/** Ceiling on points per refined section, so tracing an opening onto a section
 *  that is already dense can't explode the cavity's face count. */
const MAX_TRACED_POINTS = 400;

const SHELL_LOFT_OPENING_TOO_NARROW =
  "That face is narrower than the wall, so opening it leaves nothing open — the wall closes over " +
  "it from both sides. Use a thinner wall, or pick a larger face (a lofted circle's side is split " +
  "into many narrow faces; its end caps are single faces).";

/** The fallback's own, actionable failures — everything else it can throw is
 *  OCCT internals and gets mapped to `SHELL_BUILD_FAILED`. */
const SHELL_LOFT_DIAGNOSES = new Set<string>();

const SHELL_LOFT_TOO_THICK =
  "That wall is too thick for this loft — insetting a section by it leaves nothing, or breaks it " +
  "into pieces. Try a thinner wall.";

for (const m of [SHELL_LOFT_FACE_UNSUPPORTED, SHELL_LOFT_TOO_THICK, SHELL_LOFT_OPENING_TOO_NARROW]) {
  SHELL_LOFT_DIAGNOSES.add(m);
}

/** The frame's own normal, taken the way `planeOf` takes it. A frame's stored
 *  `normal` can be the NEGATIVE of `uAxis × vAxis` (the "front" datum is
 *  left-handed), and everything built here has to agree with the plane the
 *  sections are actually built on, not with the stored field. */
function frameAxis(f: ResolvedFrame): V3 {
  return vunit(vcross(f.uAxis as V3, f.vAxis as V3));
}

/** Whether a picked face is one of the loft's two end CAPS, which `loftBody`
 *  names `<id>/start` and `<id>/end`.
 *
 *  Nothing else is decided by name. A side face's name carries the index of the
 *  first section's edge it came from, but that index doesn't survive to the
 *  other sections (see `traceOpenings`), so the side wall is matched by
 *  geometry instead — which also covers the `f{n}` faces whose history
 *  `loftBody` couldn't follow, and any name a boolean has since suffixed. */
function loftFacePart(name: string | undefined, loftId: string): "start" | "end" | null {
  const part = loftNamePart(name, loftId);
  return part === "start" || part === "end" ? part : null;
}

function loftNamePart(name: string | undefined, loftId: string): string | null {
  if (!name || !name.startsWith(`${loftId}/`)) return null;
  // A boolean or re-match can suffix a name with "#n"; the part is unchanged.
  return name.slice(loftId.length + 1).replace(/#\d+$/, "");
}

/** The first section's edge a `<id>/side{i}` face was generated from, or null
 *  for anything else (a cap, an `f{n}` whose history was lost, a stale name). */
function loftSideIndex(name: string | undefined, loftId: string): number | null {
  const m = /^side(\d+)$/.exec(loftNamePart(name, loftId) ?? "");
  return m ? Number(m[1]) : null;
}

/** A big planar face lying in `frame`'s plane, shifted `along` the frame axis
 *  by `offset`, sized to cover `span` in every direction from the plane's
 *  projection of `center`. Used as the tool face for the end trims. */
function planeCoverFace(frame: ResolvedFrame, offset: number, center: V3, span: number): Face {
  const axis = frameAxis(frame);
  const origin: V3 = [
    frame.origin[0] + axis[0] * offset,
    frame.origin[1] + axis[1] * offset,
    frame.origin[2] + axis[2] * offset,
  ];
  const d: V3 = [center[0] - origin[0], center[1] - origin[1], center[2] - origin[2]];
  const cu = vdot(d, frame.uAxis as V3);
  const cv = vdot(d, frame.vAxis as V3);
  const plane = new Plane(origin, frame.uAxis, axis);
  const drawing = draw()
    .movePointerTo([cu - span, cv - span])
    .lineTo([cu + span, cv - span])
    .lineTo([cu + span, cv + span])
    .lineTo([cu - span, cv + span])
    .close();
  return (drawing.sketchOnPlane(plane) as unknown as Sketch).face();
}

/** Subdivide a section's edges until none is longer than `maxLen`, inserting
 *  points ON the existing edges — the polygon is geometrically identical, just
 *  described more finely. Used before an opening is traced onto a section: a
 *  6-point hexagon can't express which sixteenth of itself sits under a face
 *  generated from a 96-point circle, but its subdivision can. */
function refineOutline(outline: [number, number][], maxLen: number, cap: number): [number, number][] {
  const n = outline.length;
  if (!(maxLen > 0) || n < 3) return outline;
  const out: [number, number][] = [];
  for (let i = 0; i < n && out.length < cap; i++) {
    const a = outline[i];
    const b = outline[(i + 1) % n];
    out.push(a);
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    // The epsilon keeps a section from splitting against ITSELF: `maxLen` comes
    // from the finest section's AVERAGE edge, so that section's own edges divide
    // out at 1.0000000001 and every one of them would split in two, leaving a
    // ring of alternating long and short edges that is harder to erode than the
    // regular one it started as.
    const pieces = Math.min(Math.ceil(len / maxLen - 1e-9), Math.max(1, cap - out.length));
    for (let k = 1; k < pieces; k++) {
      const t = k / pieces;
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
    }
  }
  return out;
}

/** Which edges of each section lie under `faces` — the opening, traced onto the
 *  sections geometrically rather than by index.
 *
 *  `loftBody` names a side face after edge *i of the FIRST section's wire*, and
 *  that index means nothing on the others: `ThruSections` splits the sections
 *  against each other to make them compatible, so on a loft from a 96-point
 *  circle to a 6-point hexagon, one named side face covers one chord at one end
 *  and a sixteenth of an edge at the other. Matching by index needed every
 *  section to have the same point count, which refused every loft between two
 *  genuinely different profiles — the ordinary case.
 *
 *  So ask the geometry instead: a section edge belongs to an opening when its
 *  midpoint lies ON the picked face. The sections lie exactly on the loft's
 *  surface, so that distance is either ~0 or a whole edge away, and one
 *  `DistanceQuery` per face answers it for every sample. */
function traceOpenings(
  faces: Face[],
  sections: [number, number][][],
  frames: ResolvedFrame[],
  tol: number,
): Set<number>[] {
  const open: Set<number>[] = sections.map(() => new Set<number>());
  for (const face of faces) {
    const query = new DistanceQuery(face);
    try {
      sections.forEach((outline, k) => {
        const n = outline.length;
        for (let i = 0; i < n; i++) {
          const a = outline[i];
          const b = outline[(i + 1) % n];
          const mid: [number, number] = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
          const vertex = makeVertex(frameToWorld(frames[k], mid));
          try {
            if (query.distanceTo(vertex) <= tol) open[k].add(i);
          } finally {
            vertex.delete();
          }
        }
      });
    } finally {
      query.delete();
    }
  }
  return open;
}

/** Hollow a LOFTED body by re-lofting its own sections, inset.
 *
 *  OCCT cannot offset a loft's surface inward — `MakeThickSolidByJoin` hands
 *  back a zero-volume solid, `MakeOffsetShape.PerformByJoin` throws on a null
 *  shape, and `PerformBySimple` offsets the wrong way by √2 per side. All three
 *  were measured, and none of them is coming back. What DOES work is building
 *  the cavity where the shape came from: inset each of the loft's sections in
 *  2D by the wall thickness (`insetOutline`), loft the inset sections into a
 *  second body, and subtract it.
 *
 *  THE ENDS are where the interesting decisions are, because a section inset in
 *  its own plane says nothing about the caps:
 *
 *  - A SEALED cap is made by trimming the finished cavity back with a plane
 *    parallel to that end section, `thickness` inside it. Trimming is exact —
 *    the material left between the cap and the cavity is `thickness` measured
 *    along the cap's normal, which is what a wall thickness means there — and,
 *    unlike moving the end section inward, it leaves the interpolated side
 *    surface completely alone. Moving a section reparameterises the whole
 *    B-spline through the sections; on a loft that tapers near an end that can
 *    thin the wall, or turn it inside out.
 *
 *  - An OPEN cap is made by NOT trimming, and instead extending the cavity past
 *    the end with a straight prism raised from the cavity's own end face, so
 *    the subtraction crosses the cap transversally. Extending rather than
 *    prism-cutting the cap outright is what keeps the side wall's rim: the
 *    material to remove is what lies inside the cavity's cross-section, not the
 *    whole footprint of the cap face.
 *
 *  - An OPEN SIDE face is the 2D case, handled inside `insetOutline`: its edge
 *    contributes no wall, and the section is carried out past it.
 *
 *  Returns a NamedShape whose new inner faces all end in `/in`, so they can be
 *  referenced by later features like any other face. */
function shellLoftSections(target: Body, hits: Face[], thickness: number, loft: LoftShellSource): NamedShape {
  const profiles = loft.profiles;
  const overshoot = thickness * OPENING_OVERSHOOT;

  // 1. Which of the loft's own faces are being opened. The two caps are known
  //    by name; everything else is treated as part of the SIDE wall and traced
  //    onto the sections geometrically — including the `f{n}` faces, whose
  //    history `loftBody` couldn't follow and which used to be refused outright
  //    even though they are ordinary side faces.
  let openStart = false;
  let openEnd = false;
  const sideFaces: Face[] = [];
  const sideIndices: number[] = [];
  let allIndexed = true;
  for (const f of hits) {
    const name = target.names.get(f.hashCode);
    const part = loftFacePart(name, loft.id);
    if (part === "start") {
      openStart = true;
      continue;
    }
    if (part === "end") {
      openEnd = true;
      continue;
    }
    sideFaces.push(f);
    const idx = loftSideIndex(name, loft.id);
    if (idx === null) allIndexed = false;
    else sideIndices.push(idx);
  }

  // 2. Trace those side faces onto the sections. The sections are refined
  //    first, so a coarse one can still follow a face generated from a fine
  //    one; refining inserts points on existing edges, so nothing moves.
  let sections = profiles.map((p) => p.outline);
  let openEdges: Set<number>[] = sections.map(() => new Set<number>());
  // When every section has the same point count and every picked side face
  // carries its `side{i}` name, edge i means the same thing on all of them and
  // the index IS the answer — no sampling, no subdivision, and the sections go
  // to the cavity exactly as the loft used them. That is the case the loft
  // harness covers end to end, so it keeps its own path.
  const n0 = profiles[0].outline.length;
  const uniform = profiles.every((p) => p.outline.length === n0);
  if (sideFaces.length > 0 && allIndexed && uniform && sideIndices.every((i) => i < n0)) {
    openEdges = sections.map(() => new Set(sideIndices));
  } else if (sideFaces.length > 0) {
    const target_ = clamp(
      OPENING_TRACE_RESOLUTION * Math.max(...sections.map((o) => o.length)),
      MIN_TRACED_POINTS,
      MAX_TRACED_POINTS,
    );
    sections = sections.map((o) => {
      let perimeter = 0;
      for (let i = 0; i < o.length; i++) {
        const a = o[i];
        const b = o[(i + 1) % o.length];
        perimeter += Math.hypot(b[0] - a[0], b[1] - a[1]);
      }
      return refineOutline(o, perimeter / target_, MAX_TRACED_POINTS);
    });
    // The sections sit exactly on the loft's surface, so a midpoint is either
    // on the face or a whole edge away from it — the tolerance only has to
    // clear tessellation noise.
    const tol = Math.max(bboxDiagonal(target.shape) * 1e-5, 1e-7);
    openEdges = traceOpenings(
      sideFaces,
      sections,
      profiles.map((p) => p.frame),
      tol,
    );
    // A pick that lands on no section at all isn't a side face of this loft —
    // most likely an inner face left by an earlier shell. Refuse rather than
    // quietly building a sealed shell and looking like nothing happened.
    if (openEdges.every((set) => set.size === 0)) throw new Error(SHELL_LOFT_FACE_UNSUPPORTED);
  }

  // 3. Inset every section in its own plane.
  let escaped = false;
  const insetProfiles: RegionProfile[] = profiles.map((p, k) => {
    const ring = insetOutline(sections[k], thickness, { openEdges: openEdges[k], overshoot });
    if (!ring) throw new Error(SHELL_LOFT_TOO_THICK);
    if (openEdges[k].size > 0 && ringEscapes(ring, sections[k])) escaped = true;
    // Only the inset OUTLINE survives: `segments`/`holes` describe the source
    // boundary and no longer match it (and loft ignores holes regardless).
    return { kind: "sketchRegion", outline: ring, frame: p.frame };
  });
  // Match the sections' point counts before they are lofted — see padOutline.
  const widest = Math.max(...insetProfiles.map((p) => p.outline.length));
  for (const p of insetProfiles) p.outline = padOutline(p.outline, widest);

  // Asking to open a side face doesn't guarantee an opening: the walls either
  // side of it carry on past the lip, and a face narrower than twice the wall
  // is closed over again. Correct, but it builds a shell that looks sealed and
  // reads as "the tool ignored my pick" — so say what happened instead.
  if (sideFaces.length > 0 && !escaped) throw new Error(SHELL_LOFT_OPENING_TOO_NARROW);

  const cavityId = `${loft.id}/cavity`;
  // The cavity's sections can differ far more in point count than the loft's own
  // did — an opening adds a lip and a fan of arc points to one section and
  // nothing to another — and `ThruSections` throws a bare ConstructionError on
  // some of those pairs when it is smoothing through them. RULED costs nothing
  // to try: with two sections it is the same surface, and with more it only
  // straightens the cavity's interpolation between them, which a subtraction
  // tool can afford.
  let cavity: NamedShape;
  try {
    cavity = loftBody(insetProfiles, cavityId);
  } catch {
    cavity = loftBody(insetProfiles, cavityId, true);
  }
  const span = bboxDiagonal(target.shape);
  const bb = target.shape.boundingBox;
  const center: V3 = [
    (bb.bounds[0][0] + bb.bounds[1][0]) / 2,
    (bb.bounds[0][1] + bb.bounds[1][1]) / 2,
    (bb.bounds[0][2] + bb.bounds[1][2]) / 2,
  ];
  bb.delete();

  // 4. The ends. `inward` is the frame axis turned to point at the far end, so
  // the same code serves both caps whichever way their planes happen to face.
  const ends: { frame: ResolvedFrame; ring: [number, number][]; open: boolean; away: V3 }[] = [];
  const first = profiles[0].frame;
  const last = profiles[profiles.length - 1].frame;
  const spine: V3 = [
    last.origin[0] - first.origin[0],
    last.origin[1] - first.origin[1],
    last.origin[2] - first.origin[2],
  ];
  for (const [frame, ring, open, sign] of [
    [first, insetProfiles[0].outline, openStart, 1],
    [last, insetProfiles[insetProfiles.length - 1].outline, openEnd, -1],
  ] as const) {
    const axis = frameAxis(frame);
    const toward = vdot(axis, spine) * sign >= 0 ? axis : ([-axis[0], -axis[1], -axis[2]] as V3);
    ends.push({ frame, ring, open, away: [-toward[0], -toward[1], -toward[2]] });
  }

  try {
    for (const [i, end] of ends.entries()) {
      if (end.open) {
        // Raise a prism from the cavity's own end section, outward past the cap.
        const face = regionFace({ kind: "sketchRegion", outline: end.ring, frame: end.frame }, planeOf(end.frame));
        const lip = prismFromFace(face, new Vector(end.away), overshoot, `${cavityId}/lip${i}`);
        face.delete();
        const fused = booleanRetrying("fuse", cavity, lip);
        cavity.shape.delete();
        lip.shape.delete();
        cavity = fused;
      } else {
        // Trim the cavity back to `thickness` inside the cap, leaving the wall.
        const inward = -vdot(end.away, frameAxis(end.frame)) >= 0 ? thickness : -thickness;
        const face = planeCoverFace(end.frame, inward, center, span);
        const slab = prismFromFace(face, new Vector(end.away), span * 2, `${cavityId}/floor${i}`);
        face.delete();
        const trimmed = booleanRetrying("cut", cavity, slab);
        cavity.shape.delete();
        slab.shape.delete();
        cavity = trimmed;
      }
    }
    if (countSolids(cavity.shape) === 0) throw new Error(SHELL_LOFT_TOO_THICK);

    // 5. Every face of the cavity becomes an inner face of the shell, so they
    //    all take the `/in` suffix the offset path uses. They do NOT correspond
    //    one-to-one with the outer `side{i}` faces — an inset ring has its own
    //    edges, having picked up round joins and shed collapsed ones — so they
    //    are named for the cavity, not for the outer face they face.
    const inner = new Map<number, string>();
    for (const [h, nm] of cavity.names) inner.set(h, `${nm}/in`);
    const hollow = booleanRetrying(
      "cut",
      { shape: target.shape, names: target.names },
      { shape: cavity.shape, names: inner },
    );
    if (!isHollowedSolid(hollow.shape, target.shape)) {
      hollow.shape.delete();
      throw new Error(SHELL_BUILD_FAILED);
    }
    return hollow;
  } finally {
    cavity.shape.delete();
  }
}

/** Hollow out a body — see `shellByOffset` for the primary path.
 *
 *  The OCCT offset is tried first, always: on a box, a cylinder or an extrude
 *  it is exact, and it handles openings this module's 2D fallback can't express.
 *  Only when it fails does a LOFTED target fall back to re-lofting its own
 *  sections (`shellLoftSections`), which is the one construction that hollows
 *  freeform loft geometry at all. A failure there reports the fallback's own
 *  message when it has something specific to say — too thick, or a face it
 *  can't open — and otherwise the original build failure. */
function shellNamed(
  target: Body,
  faceNames: string[],
  faceRefs: ResolvedFaceRef[] | undefined,
  thickness: number,
  warn?: Warn,
  loft?: LoftShellSource,
): NamedShape {
  const { hits, lost } = resolveShellFaces(target, faceNames, faceRefs, warn);
  if (faceNames.length > 0 && hits.length === 0) {
    throw new Error(
      "shell: none of the picked faces could be re-found on the body (an upstream edit changed its shape) — edit the feature to re-pick them",
    );
  }
  if (lost.length > 0) {
    warn?.(
      `${lost.length} of ${faceNames.length} faces could not be re-found and were skipped: ${lost.join(", ")} — edit the feature to re-pick them`,
    );
  }
  try {
    return shellByOffset(target, hits, thickness);
  } catch (err) {
    if (!loft) throw err;
    try {
      return shellLoftSections(target, hits, thickness, loft);
    } catch (fallbackErr) {
      // The fallback's own diagnoses say something the user can act on and are
      // passed through. Anything else is OCCT giving up somewhere in the
      // cavity build — a decoded exception name and a heap pointer, which
      // means nothing to anyone — so report the same actionable failure the
      // offset path does rather than leaking it.
      const msg = errorMessage(fallbackErr);
      if (SHELL_LOFT_DIAGNOSES.has(msg)) throw fallbackErr;
      throw new Error(SHELL_BUILD_FAILED);
    }
  }
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

/** Scale + rotate + translate a body in place, composed in that order (the
 *  uniform scale and the rotation both about `pivot`, then the translation).
 *  Returns a FRESH NamedShape distinct from `target` (the caller disposes the
 *  original); names pass through unchanged since topology doesn't — a similarity
 *  transform is as topology-preserving as a rigid one. */
function transformNamed(target: Body, t: Extract<ResolvedFeature, { type: "transform" }>): NamedShape {
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

  // Scale first, so a scaled body still rotates about (and translates from) the
  // same pivot — matching the viewport gizmo's T · R · S composition.
  if (t.scale !== 1) {
    const center = new oc.gp_Pnt_3(t.pivot[0], t.pivot[1], t.pivot[2]);
    const sc = new oc.gp_Trsf_1();
    sc.SetScale(center, t.scale);
    step(sc);
    center.delete();
  }

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

/** The axis of a FACETED round wall — the wall a user actually clicks in this
 *  build. Cylinders here are 48-gon prisms (facetedCylinderShape) and extruded
 *  circles are polygonal for the same reason, so the "cylindrical face" under
 *  the cursor is ONE flat strip whose geomType is PLANE: there is no analytic
 *  axis to read off it, and the pattern used to refuse it after the fact, with
 *  the feature already in the timeline.
 *
 *  The strip alone can't answer: its plane is parallel to the axis, but every
 *  direction in that plane is. Its smooth CLUSTER can — the same grouping the
 *  viewport shades and picks as one surface (faceClustersFrom), which is the
 *  whole wall. A prism wall pins its axis exactly: each facet plane is parallel
 *  to the axis and the same distance (the apothem) from it, so
 *
 *      n_i · x + a = n_i · p_i        for every facet i
 *
 *  is three unknowns — the axis point x in the cross-section, plus the apothem
 *  a — over as many equations as there are facets. Least squares, so a wall a
 *  boolean has cut down to a few facets still answers, and the residual is the
 *  test of whether this was a round wall at all. No radius needed, and none
 *  assumed: an elliptical or irregular prism fails the residual instead of
 *  quietly patterning about the wrong line.
 *
 *  Returns null for anything that isn't a prism wall (a lone flat face, a
 *  fillet blend, facets that share no perpendicular), leaving the caller to
 *  raise its own error. */
function facetedWallAxis(body: Body, face: Face): { origin: V3; dir: V3 } | null {
  // The cluster walk is over every face of the body; skip it on the same huge
  // bodies the meshing pass skips clustering for.
  if (body.shape.faces.length > PER_FACE_MESH_THRESHOLD) return null;
  const clusterOf = faceClustersFrom(body.shape);
  const rep = clusterOf.get(face.hashCode);
  if (rep === undefined) return null;
  const facets: { n: V3; p: V3 }[] = [];
  for (const f of body.shape.faces) {
    if (clusterOf.get(f.hashCode) !== rep) continue;
    if (f.geomType !== "PLANE") return null; // a blend or a real surface, not facets
    const n = faceOutwardNormal(f);
    if (!n) return null;
    facets.push({ n, p: f.center.toTuple() as V3 });
  }
  if (facets.length < 3) return null; // 3 unknowns; 2 facets can't pin the apothem

  // Direction: perpendicular to every facet normal, so the cross product of the
  // two most independent ones. A cluster whose normals are all parallel (a flat
  // face split in two) collapses here.
  let dir: V3 | null = null;
  let best = 0;
  for (let i = 1; i < facets.length; i++) {
    const x = vcross(facets[0].n, facets[i].n);
    const m = Math.hypot(x[0], x[1], x[2]);
    if (m > best) {
      best = m;
      dir = x;
    }
  }
  if (!dir || best < 1e-3) return null;
  dir = vunit(dir);
  // Every facet must be PARALLEL to that direction, or this is a dome/cone soup
  // rather than a prism wall.
  if (facets.some((f) => Math.abs(vdot(f.n, dir!)) > 1e-4)) return null;

  // Cross-section basis, then the 3x3 normal equations of the least squares.
  const e1 = vunit(facets[0].n);
  const e2 = vunit(vcross(dir, e1));
  let a11 = 0,
    a12 = 0,
    a13 = 0,
    a22 = 0,
    a23 = 0,
    a33 = 0,
    b1 = 0,
    b2 = 0,
    b3 = 0;
  const rows: { m1: number; m2: number; c: number }[] = [];
  for (const f of facets) {
    const m1 = vdot(f.n, e1);
    const m2 = vdot(f.n, e2);
    const c = vdot(f.n, f.p);
    rows.push({ m1, m2, c });
    a11 += m1 * m1;
    a12 += m1 * m2;
    a13 += m1;
    a22 += m2 * m2;
    a23 += m2;
    a33 += 1;
    b1 += m1 * c;
    b2 += m2 * c;
    b3 += c;
  }
  const det = a11 * (a22 * a33 - a23 * a23) - a12 * (a12 * a33 - a23 * a13) + a13 * (a12 * a23 - a22 * a13);
  if (Math.abs(det) < 1e-9) return null; // facets don't span the cross-section
  const solve = (r1: number, r2: number, r3: number) =>
    (r1 * (a22 * a33 - a23 * a23) - a12 * (r2 * a33 - a23 * r3) + a13 * (r2 * a23 - a22 * r3)) / det;
  const q1 = solve(b1, b2, b3);
  const q2 = (a11 * (b2 * a33 - a23 * b3) - b1 * (a12 * a33 - a23 * a13) + a13 * (a12 * b3 - b2 * a13)) / det;
  const apothem = (a11 * (a22 * b3 - b2 * a23) - a12 * (a12 * b3 - b2 * a13) + b1 * (a12 * a23 - a22 * a13)) / det;
  if (!Number.isFinite(q1) || !Number.isFinite(q2) || !Number.isFinite(apothem)) return null;
  if (Math.abs(apothem) < 1e-6) return null; // the "axis" would lie in the wall

  // The residual IS the "is this a round wall" test: a regular prism fits to
  // machine precision, an irregular one does not fit at all.
  const tol = Math.max(1e-4, Math.abs(apothem) * 1e-3);
  if (rows.some((r) => Math.abs(r.m1 * q1 + r.m2 * q2 + apothem - r.c) > tol)) return null;

  // Any point of the line will do; put it at the wall's mid-height so it reads
  // sensibly in a debug dump. The direction's SIGN is arbitrary for a rotation
  // axis (as it is for OCCT's own), so fix it deterministically.
  let t = 0;
  for (const f of facets) t += vdot(f.p, dir);
  t /= facets.length;
  const origin: V3 = [
    q1 * e1[0] + q2 * e2[0] + t * dir[0],
    q1 * e1[1] + q2 * e2[1] + t * dir[1],
    q1 * e1[2] + q2 * e2[2] + t * dir[2],
  ];
  const k = dir.reduce((bi, v, i, arr) => (Math.abs(v) > Math.abs(arr[bi]) ? i : bi), 0);
  if (dir[k] < 0) dir = [-dir[0], -dir[1], -dir[2]];
  return { origin, dir };
}

/** Resolve a body face armed as a circular-pattern axis: a cylindrical/conical
 *  face → that surface's own central axis, or a FACETED round wall's fitted one
 *  (facetedWallAxis). A genuinely flat face is rejected — unlike revolve there
 *  is no profile plane to intersect with. */
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
    // Nothing analytic to read — but a round wall HERE is a polygonal prism, so
    // the flat strip that was clicked may still carry an axis. See
    // facetedWallAxis; it returns null for a face that is merely flat.
    const fitted = facetedWallAxis(body, face);
    if (fitted) return fitted;
    throw new Error(
      "pattern: the axis face must be cylindrical or conical, or a faceted round wall (its own axis is the pattern axis)",
    );
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
  while (exp.More()) {
    n++;
    exp.Next();
  }
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
    const next = booleanRetrying(BOOL_OCC[op], acc, ops[i]);
    // A DEGENERATE result (no solids) has to be caught here, before the
    // op-specific tests below: an empty cut has volume 0, so `nextVol >= accVol`
    // is false and it would sail through the "nothing to subtract" guard as if
    // it were a successful large cut — consuming both operands and leaving a
    // zero-face body. Report it instead of silently producing nothing.
    if (countSolids(next.shape) === 0) {
      next.shape.delete();
      if (accIsIntermediate) acc.shape.delete();
      throw new Error(
        "The boolean produced an empty result — the operands are probably tangent or " +
          "near-coincident over some region. Try nudging one operand so the surfaces aren't parallel.",
      );
    }
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
//  • dressUpCache — the result of each chamfer/fillet. Unlike a pure builder a
//    dress-up READS another body, but its key folds in that body's own content
//    key, so the key still names the result exactly: same feature over the same
//    input is the same solid. Without this every dress-up in a document was
//    rebuilt on every regeneration, so cost grew linearly with how many the
//    document held — two rim fillets measured 726ms + 682ms on each edit, and
//    only the last one had changed. The stored `warnings` ride along because a
//    cache hit skips the build that would have raised them, and a reference
//    re-matched or partly lost must not go quiet just because it was cached.
const dressUpCache = new Map<string, { result: NamedShape & { changedBox?: [Vec3, Vec3] }; warning?: string }>();

// --- Regen profiling (dev): per-feature build ms + per-body mesh ms, logged
// once per regen. `hit` = the pure-builder canonical was already cached. Set
// REGEN_PROFILE=false to silence. ---
const REGEN_PROFILE = false;
type FeatureTiming = { id: string; type: string; ms: number };

/** cyrb53 — a fast, well-distributed 53-bit string hash. Used to keep content
 *  keys short and bounded (combining keys down a long feature chain would grow
 *  without a hash). Collisions are astronomically unlikely at our scale. */
function hashKey(str: string): string {
  let h1 = 0xdeadbeef,
    h2 = 0x41c6ce57;
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
/** The loft a Shell can fall back to re-lofting, or undefined.
 *
 *  This only ever applies when the target body IS that loft and nothing has
 *  touched it since — the fallback rebuilds the cavity from the loft's SECTIONS,
 *  so a transform, a dress-up or a boolean in between would put it in the wrong
 *  place or the wrong shape. Comparing the body's content key against the loft's
 *  own builder key is the exact test for that: every modifier re-keys the body
 *  it changes, so a match means nothing has. */
function loftShellSource(target: Body, features: ResolvedFeature[]): LoftShellSource | undefined {
  const loft = features.find((f) => f.id === target.id && f.type === "loft");
  if (loft?.type !== "loft" || target.key !== builderKey(loft)) return undefined;
  const regions = loft.profiles.filter((p): p is RegionProfile => p.kind === "sketchRegion");
  return regions.length >= 2 ? { id: loft.id, profiles: regions } : undefined;
}

/** Turn any body that has come out as several disjoint solids into several
 *  PARTS. Lump 0 keeps the body's id, the rest take `id#1`, `id#2`… — so every
 *  reference already in a document (a chamfer's targetId, a boolean operand)
 *  still names lump 0, and nothing needs migrating.
 *
 *  Runs after every feature, because disconnection can arrive at any point: an
 *  extrude of two separate regions, a cut that severs a bar in two, a pattern's
 *  copies, an imported assembly. `singleSolid` remembers the body keys already
 *  known to hold one solid, so the scan costs one explorer walk per body per
 *  CHANGE rather than per feature. */
function splitPartsPass(bodies: Body[], singleSolid: Set<string>): void {
  for (let i = 0; i < bodies.length; i++) {
    const b = bodies[i];
    if (b.noSplit || b.preview || singleSolid.has(b.key)) continue;
    const lumps = splitLumps(b);
    if (!lumps) {
      singleSolid.add(b.key);
      continue;
    }
    const taken = new Set(bodies.map((x) => x.id));
    const parts: Body[] = lumps.map((lump, n) => {
      let id = b.id;
      if (n > 0) {
        let k = n;
        while (taken.has(`${b.id}#${k}`)) k++;
        id = `${b.id}#${k}`;
      }
      taken.add(id);
      // Lump 0 needs its own key too: it holds less material than the body the
      // key was computed for, and the mesh cache is keyed by exactly that.
      const key = `${b.key}#${n}`;
      singleSolid.add(key);
      return { ...lump, id, key };
    });
    bodies.splice(i, 1, ...parts);
    i += parts.length - 1;
  }
}

function buildBodies(
  features: ResolvedFeature[],
  used: Set<string> = new Set(),
  usedDressUps: Set<string> = new Set(),
): {
  bodies: Body[];
  previews: Body[];
  failures: RegenFeatureResult[];
  timings: FeatureTiming[];
  warnings: Record<string, string>;
} {
  const bodies: Body[] = [];
  // Display-only bodies (currently just dress-up deltas). Deliberately kept OUT
  // of `bodies` so nothing that scans the running set — an "up to next" extrude,
  // a boolean's operand lookup — can ever see them; the caller meshes them
  // alongside the real bodies and is responsible for deleting them.
  const previews: Body[] = [];
  const failures: RegenFeatureResult[] = [];
  const timings: FeatureTiming[] = [];
  // Non-fatal notices per feature id (references re-matched / partially lost),
  // surfaced in the timeline so a fragile reference is visible, not silent.
  const warnings: Record<string, string> = {};
  // Current content key of the body under a given id (read before mutations).
  const keyOf = (id: string): string => bodies.find((b) => b.id === id)?.key ?? id;
  // Body keys already known to hold exactly one solid — see splitPartsPass.
  const singleSolid = new Set<string>();

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
        bodies.push({
          id: feature.id,
          key,
          ...buildCached(key, used, () => importStepNamed(feature.source, feature.id)),
        });
      } else if (feature.type === "extrude") {
        const { flip, distance, extent, mode } = feature;
        // A "remove" cuts *into* the body, so its natural direction is opposite
        // the profile normal — the Flip toggle then reverses that. New/Add follow
        // the normal outward.
        const dirFlip = mode === "remove" ? !flip : flip;
        // One tool per profile. In "new" they gather into a single body, which
        // splitPartsPass then breaks into one PART per disjoint solid; in
        // add/remove each tool goes into its own target, so extruding faces of
        // two different parts modifies each of them (see targetOf below).
        const newSolids: NamedShape[] = [];
        const newKeys: string[] = [];
        let newNoSplit = false;
        for (let pi = 0; pi < feature.profiles.length; pi++) {
          const profile = feature.profiles[pi];
          // Merge scope. A profile taken from a body face acts on THAT body —
          // the part it grew from — and a sketch profile, which has no body of
          // its own, uses the target the dialog chose. Resolved up front (rather
          // than after building the tool) because extent "throughAll" needs the
          // target's geometry to size the tool.
          const targetId =
            mode !== "new" ? (profile.kind === "bodyFace" ? profile.sourceId : feature.targetId) : undefined;
          const targets = targetId ? bodies.filter((b) => b.id === targetId) : [];

          // One profile face for region/body-face; many (one per glyph) for text.
          let faces: Face[];
          let normal: Vector;
          if (profile.kind === "sketchRegion") {
            const r = sketchRegionFace(profile);
            faces = [r.face];
            normal = r.normal;
          } else if (profile.kind === "sketchText") {
            const r = sketchTextFaces(profile);
            faces = r.faces;
            normal = r.normal;
          } else {
            const r = bodyProfileFace(
              requireBody(bodies, profile.sourceId),
              profile.faceName,
              profile.center,
              profile.normal,
              warn,
              "profile face",
            );
            // Facet a curved profile face (cylinder cap, fillet…) so its extruded
            // wall is planar and can be cut/fused — an analytic cylinder wall can't
            // (StdFail_NotDone). No-op for straight-edged faces.
            const ff = facetedProfileFace(r.face, r.normal);
            faces = [ff.face];
            normal = ff.normal;
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
              upBody,
              feature.upTo.faceName,
              feature.upTo.center,
              feature.upTo.normal,
              warn,
              "up-to face",
            );
            const t = upToFaceLength(face, normal, up.face, up.normal); // signed, validates reachability
            const reach = bigReach(face, bodies);
            lengths = [(t >= 0 ? 1 : -1) * reach];
            clip = makeClipPlane(
              up.face.center.toTuple() as Vec3,
              up.normal.normalized().toTuple() as Vec3,
              normal,
              t >= 0 ? 1 : -1,
              reach,
            );
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
          // A lone profile keeps the feature id as its name prefix — so every
          // stored reference into a single-profile extrude still resolves;
          // several profiles scope theirs as `${id}/p{n}`, and text scopes each
          // glyph below that, so no two profiles' faces share a name.
          const prefixBase = feature.profiles.length > 1 ? `${feature.id}/p${pi}` : feature.id;
          const glyphSolids: NamedShape[] = [];
          for (let gi = 0; gi < faces.length; gi++) {
            const prefix = faces.length > 1 ? `${prefixBase}/g${gi}` : prefixBase;
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
          const built: NamedShape | null =
            glyphSolids.length === 0 ? null : glyphSolids.length === 1 ? glyphSolids[0] : compoundOf(glyphSolids);
          if (built === null) throw new Error("extrude: profile produced no geometry");

          // Content key of the swept tool: the feature (and which profile of it)
          // plus the keys of any bodies it read (a body-face profile / up-to-face
          // target). Result keys fold in the affected target's key so a cut/fuse
          // re-meshes only when it changed.
          const toolInputKeys: string[] = [`p${pi}`];
          if (profile.kind === "bodyFace") toolInputKeys.push(keyOf(profile.sourceId));
          if (extent === "upToFace" && feature.upTo) toolInputKeys.push(keyOf(feature.upTo.sourceId));
          // "Up to next" sizes the tool against the whole model, so fold in every
          // scanned body's key — the ghost/tool must re-solve when any of them moves.
          if (extent === "upToNext") for (const b of bodies) toolInputKeys.push(b.key);
          const toolKey = contentKey(feature, toolInputKeys);

          // Text is one solid per glyph and always disjoint; its letters are not
          // parts, so a compound holding any stays whole (see splitPartsPass).
          if (profile.kind === "sketchText") newNoSplit = true;
          if (feature.previewTool || mode === "new" || targets.length === 0) {
            // previewTool: the live ghost is just the swept tool, leaving every
            // existing body untouched so they keep their own colour.
            // targets.length === 0: nothing to combine with — add becomes a new
            // body, remove is a no-op.
            if (feature.previewTool || mode !== "remove") {
              newSolids.push(built);
              newKeys.push(toolKey);
            } else {
              built.shape.delete();
            }
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
        // Everything that didn't go into an existing body lands as this feature's
        // own body — one for a single profile, a compound for several, which the
        // split pass turns into one part per disjoint solid.
        if (newSolids.length > 0) {
          const built = newSolids.length === 1 ? newSolids[0] : compoundOf(newSolids);
          bodies.push({
            id: feature.id,
            key: contentKey(feature, newKeys),
            noSplit: newNoSplit || !!feature.previewTool,
            ...built,
          });
        }
      } else if (feature.type === "dressup") {
        // Chamfer/fillet modifies each target body in place, keeping its id. One
        // feature can dress several bodies (picks spanning parts); every target
        // carries its own edge names, because a name only means something on the
        // body it came from.
        for (let ti = 0; ti < feature.targets.length; ti++) {
          const spec = feature.targets[ti];
          const target = requireBody(bodies, spec.targetId);
          const beforeKey = target.key;
          // Reuse the cached result when this feature over this input has already
          // been solved. The canonical is cache-owned and never handed to the fold
          // (which consumes and deletes what it is given), so the fold gets a copy
          // — same discipline as buildCached.
          const dressKey = contentKey(feature, [`t${ti}`, beforeKey]);
          usedDressUps.add(dressKey);
          let res: NamedShape & { changedBox?: [Vec3, Vec3] };
          const hit = dressUpCache.get(dressKey);
          if (hit) {
            if (hit.warning) warn(hit.warning);
            res = { ...copyNamed(hit.result), changedBox: hit.result.changedBox };
          } else {
            // Capture whatever this build reports, so a cache hit can replay it.
            let raised: string | undefined;
            const record: Warn = (msg) => {
              raised = raised ? `${raised}; ${msg}` : msg;
              warn(msg);
            };
            res = dressUpNamed(
              feature.op,
              target,
              spec.edges,
              spec.edgeRefs,
              feature.size,
              feature.id,
              record,
              feature.angle,
              feature.flip,
              spec.faces,
              spec.faceRefs,
            );
            dressUpCache.set(dressKey, { result: { ...copyNamed(res), changedBox: res.changedBox }, warning: raised });
          }
          if (feature.previewDelta) {
            // The two halves of the change, as solids the UI can ghost: what the
            // bevel/round carves off (before − after) and what it fills in
            // (after − before). Computed from the SAME pair the fold already has,
            // so the preview can't disagree with the committed result. Each cut is
            // keyed off the pre-dress body key so an unchanged dialog re-uses the
            // cached tessellation instead of re-cutting on every keystroke.
            // Both bodies are first restricted to the region the operation
            // actually changed (`changedBox`). This is not an optimisation.
            // Differencing the FULL bodies differences two solids that share large
            // coincident faces everywhere the dress-up didn't reach, and OCCT
            // hangs a zero-thickness FLAP off the true result there: a
            // back-to-back pair of faces spanning the whole shared face, enclosing
            // no volume. It passes every volume and solid-count test (it belongs
            // to the one real solid) but it tessellates — and a zero-thickness
            // sheet drawn without depth testing paints that entire face.
            //
            // The clip has to come FIRST, on the operands. Trimming the finished
            // difference instead does not work: the flap makes that solid invalid,
            // and intersecting an invalid solid with a box just returns nothing.
            //
            // Clipping can't abolish the effect either, only confine it — wherever
            // a box wall passes through material common to both bodies it makes a
            // fresh coincident pair of its own. The margin is therefore
            // deliberately tiny: the box already contains the delta exactly, so
            // any flap the clip induces lies inside the delta's own footprint,
            // where it is indistinguishable from the delta. Growing the box "to be
            // safe" is precisely wrong — it drags the flap back out into open
            // space where it shows.
            const clipBox = res.changedBox ? boxFromBounds(res.changedBox, Math.max(feature.size * 0.05, 1e-6)) : null;
            const localize = (s: NamedShape) =>
              clipBox ? booleanNamed("common", s, { shape: clipBox, names: new Map() }) : s;
            const before: NamedShape = { shape: target.shape, names: target.names };
            const beforeLocal = localize(before);
            const afterLocal = localize(res);
            const deltas: [string, NamedShape, NamedShape][] = [
              [DRESSUP_DELTA_IDS.removed(dressUpDeltaBase(feature.id, ti)), beforeLocal, afterLocal],
              [DRESSUP_DELTA_IDS.added(dressUpDeltaBase(feature.id, ti)), afterLocal, beforeLocal],
            ];
            for (const [id, base, tool] of deltas) {
              const cut = booleanNamed("cut", base, tool);
              // A convex edge yields only "removed", a concave one only "added" —
              // the other cut has no solid content and is dropped, not rendered.
              // The floor is a hundredth of `size` cubed — orders of magnitude
              // below any real bevel or round, and above the free-floating debris
              // a near-coincident boolean leaves behind: specks at the clip box's
              // corners, and the razor slivers thrown off when a dress-up blends a
              // FACETED cylinder into a true one, so that before and after differ
              // by a hair over the whole wall. (Those slivers only get dropped
              // when they come back as separate solids. Fused into the real delta
              // they survive, and can defeat the mesher outright — a dress-up that
              // spans two rings far apart on one faceted boss can still lose its
              // ghost that way. It degrades to no preview, never a wrong one.)
              const delta = solidsOnly(cut, feature.size ** 3 * 1e-2);
              cut.shape.delete();
              if (delta) previews.push({ id, key: contentKey(feature, [beforeKey, id]), preview: true, ...delta });
            }
            if (beforeLocal !== before) beforeLocal.shape.delete();
            if (afterLocal !== res) afterLocal.shape.delete();
            clipBox?.delete();
          }
          target.shape.delete();
          target.shape = res.shape;
          target.names = res.names;
          target.key = contentKey(feature, [`t${ti}`, target.key]);
        }
      } else if (feature.type === "shell") {
        // Hollow out the target body in place, keeping its id.
        const target = requireBody(bodies, feature.targetId);
        const res = shellNamed(
          target,
          feature.faces,
          feature.faceRefs,
          feature.thickness,
          warn,
          loftShellSource(target, features),
        );
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
          if (operandSet.has(b.id))
            b.shape.delete(); // operand consumed
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
            axBody,
            feature.axisFace.faceName,
            feature.axisFace.center,
            feature.axisFace.normal,
            warn,
          );
          axisOrigin = line.origin;
          axisDir = line.dir;
        }
        const key = contentKey(feature, depKeys);
        const res = buildCached(key, used, () => patternNamed(src, feature, axisOrigin, axisDir));
        bodies.push({ id: feature.id, key, ...res });
      } else if (feature.type === "revolve") {
        const profile = feature.profile;
        // The profile is either a baked sketch region or a PLANAR body face. Both
        // reduce to one face + the plane it lies in (`frame`): the face is what
        // gets spun, the frame is what a plane/face axis is intersected with.
        // A curved face profile is faceted, exactly as extrude does, so the
        // surface of revolution stays booleanable.
        let profileFace: Face;
        let frame: ResolvedFrame;
        if (profile.kind === "sketchRegion") {
          if (profile.outline.length < 3) throw new Error("revolve: profile needs at least 3 points");
          frame = profile.frame;
          profileFace = regionFace(profile, planeOf(frame));
        } else if (profile.kind === "bodyFace") {
          const r = bodyProfileFace(
            requireBody(bodies, profile.sourceId),
            profile.faceName,
            profile.center,
            profile.normal,
            warn,
            "revolve profile face",
          );
          // A curved face has no single plane, so there'd be nothing to spin
          // (and no plane for a plane/face axis to meet) — rejected up front
          // rather than producing a self-intersecting solid.
          if (r.face.geomType !== "PLANE") {
            throw new Error(
              "revolve: profile face must be planar — a curved face (cylinder, sphere, fillet) has no plane to spin",
            );
          }
          const ff = facetedProfileFace(r.face, r.normal);
          profileFace = ff.face;
          frame = planarFaceFrame(r.face.center.toTuple() as V3, r.normal.toTuple() as V3);
        } else {
          throw new Error("revolve: profile must be a sketch region or a planar body face");
        }
        // A body-face axis is resolved here (needs the built body + profile
        // plane), as is a plane axis whose profile is a body face (the document
        // layer had no profile plane to intersect it with). A sketch-line axis —
        // and a plane axis on a sketch-region profile — arrive pre-baked.
        let axisOrigin = feature.axisOrigin;
        let axisDir = feature.axisDir;
        if (feature.axisFace) {
          const axBody = requireBody(bodies, feature.axisFace.sourceId);
          const line = faceRevolveAxis(
            axBody,
            feature.axisFace.faceName,
            feature.axisFace.center,
            frame,
            feature.axisFace.normal,
            warn,
          );
          axisOrigin = line.origin;
          axisDir = line.dir;
        } else if (feature.axisEdge) {
          const axBody = requireBody(bodies, feature.axisEdge.sourceId);
          const line = edgeRevolveAxis(
            axBody,
            feature.axisEdge.edgeName,
            { mid: feature.axisEdge.mid, length: feature.axisEdge.length },
            warn,
          );
          axisOrigin = line.origin;
          axisDir = line.dir;
        } else if (feature.axisPlane) {
          const line = intersectPlanes(feature.axisPlane.origin, feature.axisPlane.normal, frame.origin, frame.normal);
          if (!line) throw new Error("revolve: axis plane is parallel to the profile plane (no intersection line)");
          axisOrigin = line.origin;
          axisDir = line.dir;
        }
        if (!axisOrigin || !axisDir) throw new Error("revolve: missing axis");
        const ao = axisOrigin,
          ad = axisDir;
        // A body-face profile or axis makes the result depend on that body's
        // geometry, so fold its key in; baked profiles/axes are fully captured by
        // the feature itself.
        const sourceKeys = [
          ...(profile.kind === "bodyFace" ? [keyOf(profile.sourceId)] : []),
          ...(feature.axisFace ? [keyOf(feature.axisFace.sourceId)] : []),
          ...(feature.axisEdge ? [keyOf(feature.axisEdge.sourceId)] : []),
        ];
        const key = sourceKeys.length ? contentKey(feature, sourceKeys) : builderKey(feature);
        const face = profileFace;
        const built = buildCached(key, used, () =>
          revolveFromFace(face, ao, ad, (feature.angle * Math.PI) / 180, feature.symmetric, feature.id),
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
        bodies.push({
          id: feature.id,
          key,
          ...buildCached(key, used, () =>
            loftBody(regions as Extract<ResolvedProfile, { kind: "sketchRegion" }>[], feature.id),
          ),
        });
      }
    } catch (err) {
      failures.push({ id: feature.id, ok: false, error: errorMessage(err) });
    }
    splitPartsPass(bodies, singleSolid);
    timings.push({ id: feature.id, type: feature.type, ms: performance.now() - t0 });
  }
  return { bodies, previews, failures, timings, warnings };
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
  } catch {
    /* fall back to the default diagonal */
  }
  // ~0.5% of the diagonal, clamped to a sane band. An imported assembly is a
  // reference body (you model an enclosure AROUND it, not on it), so it's tuned
  // coarse to keep the triangle count — and thus GPU load and per-regen transfer
  // — low. Raise the factor for lighter/faster, lower it for crisper curves.
  return { tolerance: clamp(diag * 0.005, 0.4, 5), angularTolerance: 0.6 };
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
  const vChunks: number[][] = [],
    nChunks: number[][] = [],
    tChunks: number[][] = [];
  const faceGroups: { start: number; count: number; faceId: number }[] = [];
  let nodeOffset = 0,
    triLen = 0,
    skipped = 0;
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
      const tri = (face as any).triangulation(nodeOffset) as {
        vertices: number[];
        trianglesIndexes: number[];
        verticesNormals: number[];
      } | null;
      if (tri) {
        faceGroups.push({ start: triLen, count: tri.trianglesIndexes.length, faceId: face.hashCode });
        tChunks.push(tri.trianglesIndexes);
        triLen += tri.trianglesIndexes.length;
        vChunks.push(tri.vertices);
        nodeOffset += tri.vertices.length / 3;
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
    let o = 0;
    for (const c of chunks) {
      out.set(c, o);
      o += c.length;
    }
    return out;
  };
  const triangles = new Uint32Array(triLen);
  {
    let o = 0;
    for (const c of tChunks) {
      triangles.set(c, o);
      o += c.length;
    }
  }
  return { triangles, vertices: fillF(vChunks), normals: fillF(nChunks), faceGroups };
}

/** How faces fared in an adjacency walk: how many needed the boundary fallback
 *  for their normal, and how many yielded none at all. A face with no normal is
 *  invisible to the crease test, so its seams get drawn as hard creases — worth
 *  reporting rather than swallowing. */
type FaceNormalStats = { fallback: number; unknown: number };

/** A face's outward normal. `normalAt(center)` is authoritative but throws on
 *  exactly the faces a boolean over tangent surfaces leaves behind — the centre
 *  of a trimmed face need not lie on it, and a face with inconsistent 2D curves
 *  can't be evaluated at all. Those faces then vanish from every adjacency walk
 *  that skips what it can't evaluate, and their seams get drawn as hard creases:
 *  a black line down an otherwise smooth wall. So fall back first to the
 *  surface's parametric middle (always ON the face's surface), then to Newell's
 *  normal over the boundary ring, which needs only the 3D edges. Null when even
 *  that is degenerate. */
function faceOutwardNormal(f: Face, stats?: FaceNormalStats): V3 | null {
  try {
    return vunit(f.normalAt(f.center).normalized().toTuple() as V3);
  } catch {
    /* fall through to the parametric middle */
  }
  // A CLOSED analytic face has its centre of mass OFF the surface — an analytic
  // revolve's cylinder is centred on its own axis — so projecting that centre
  // back onto the surface has no unique solution and `normalAt(center)` throws.
  // The parametric middle is always on the surface, and for such a face it is a
  // faithful sample (a cylinder's normal there is radial, ⟂ to its end caps).
  // Newell over the boundary of a closed face is NOT: its two rim circles are
  // opposed rings that nearly cancel, leaving an axis-aligned normal that reads
  // as tangent to one end cap — which hid that whole rim edge as a facet seam.
  try {
    return vunit(f.normalAt().normalized().toTuple() as V3);
  } catch {
    /* fall through to the boundary */
  }
  if (stats) stats.fallback++;
  try {
    const wires = f.wires;
    if (wires.length === 0) return null;
    const ring = chainWirePoints(wires[0].edges);
    if (ring.length < 3) return null;
    let nx = 0,
      ny = 0,
      nz = 0;
    for (let i = 0; i < ring.length; i++) {
      const p = ring[i],
        q = ring[(i + 1) % ring.length];
      nx += (p[1] - q[1]) * (p[2] + q[2]);
      ny += (p[2] - q[2]) * (p[0] + q[0]);
      nz += (p[0] - q[0]) * (p[1] + q[1]);
    }
    const len = Math.hypot(nx, ny, nz);
    if (len < 1e-12) return null;
    // Newell follows the wire's winding, which is the face's natural normal; a
    // REVERSED face points the other way.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const oc = getOC() as any;
    const flip = f.wrapped.Orientation_1() === oc.TopAbs_Orientation.TopAbs_REVERSED;
    const s = (flip ? -1 : 1) / len;
    return [nx * s, ny * s, nz * s];
  } catch {
    if (stats) {
      stats.fallback--;
      stats.unknown++;
    }
    return null;
  }
}

/** Ear-clip a simple 2D polygon into triangles (indices into `poly`). Assumes
 *  counter-clockwise winding and no holes — the caller arranges both. Skips ears
 *  that would be degenerate, and bails out rather than looping forever on input
 *  it can't reduce, returning whatever it managed. */
function earClip(poly: [number, number][]): [number, number, number][] {
  const n = poly.length;
  if (n < 3) return [];
  const idx = poly.map((_, i) => i);
  const cross = (o: number, a: number, b: number) =>
    (poly[a][0] - poly[o][0]) * (poly[b][1] - poly[o][1]) - (poly[a][1] - poly[o][1]) * (poly[b][0] - poly[o][0]);
  const inTriangle = (p: number, a: number, b: number, c: number) => {
    const d1 = cross(a, b, p),
      d2 = cross(b, c, p),
      d3 = cross(c, a, p);
    const neg = d1 < 0 || d2 < 0 || d3 < 0;
    const pos = d1 > 0 || d2 > 0 || d3 > 0;
    return !(neg && pos);
  };
  const out: [number, number, number][] = [];
  let guard = n * n + 16;
  while (idx.length > 3 && guard-- > 0) {
    let clipped = false;
    for (let i = 0; i < idx.length; i++) {
      const a = idx[(i + idx.length - 1) % idx.length],
        b = idx[i],
        c = idx[(i + 1) % idx.length];
      if (cross(a, b, c) <= 1e-12) continue; // reflex or collinear — not an ear
      let empty = true;
      for (const p of idx) {
        if (p === a || p === b || p === c) continue;
        if (inTriangle(p, a, b, c)) {
          empty = false;
          break;
        }
      }
      if (!empty) continue;
      out.push([a, b, c]);
      idx.splice(i, 1);
      clipped = true;
      break;
    }
    if (!clipped) break; // not a simple polygon; keep what we have
  }
  if (idx.length === 3) out.push([idx[0], idx[1], idx[2]]);
  return out;
}

/** Tessellate a PLANAR face ourselves, from the 3D geometry of its boundary
 *  edges. The last resort for a face OCCT's mesher won't touch.
 *
 *  BRepMesh works in a face's parametric space, so a planar face whose 2D curves
 *  are inconsistent is unmeshable no matter the tolerance — and a boolean
 *  between exactly tangent surfaces (a block as wide as the cylinder it sits on,
 *  a semicircle extruded from a cylinder's own rim) produces precisely that.
 *  The 3D edges are perfectly good, though, so the boundary is chained into a
 *  ring, fitted to its own best-fit plane, and ear-clipped in 2D.
 *
 *  `snap` pulls each boundary point onto a vertex the rest of the mesh already
 *  has there, when one is close enough. That matters for more than tidiness: our
 *  own sampling of the boundary is finer than the mesher's, so an unsnapped patch
 *  meets its neighbours along a slightly different polyline — which shows up as a
 *  notch where the two disagree, and as a shading seam, because the pass that
 *  averages normals across a smooth surface matches vertices by exact position
 *  and so never blends the patch with the wall around it.
 *
 *  Single-wire faces only: a planar face with holes would need the rings bridged,
 *  and every case seen in practice here is a sliver with one boundary. Returns
 *  null if the face isn't planar, has holes, or the ring doesn't close. */
function triangulatePlanarFace(
  face: Face,
  nodeOffset: number,
  snap: (p: V3) => V3 = (p) => p,
): { vertices: number[]; trianglesIndexes: number[]; verticesNormals: number[] } | null {
  if (face.geomType !== "PLANE") return null;
  let wires: { edges: Edge[] }[];
  try {
    wires = face.wires;
  } catch {
    return null;
  }
  if (wires.length !== 1) return null;
  const chained = chainWirePoints(wires[0].edges).map(snap);
  // Snapping can land neighbouring samples on the same existing vertex; collapse
  // the duplicates or ear clipping sees zero-length edges.
  const ring: V3[] = [];
  for (const p of chained) {
    const last = ring[ring.length - 1];
    if (last && Math.hypot(p[0] - last[0], p[1] - last[1], p[2] - last[2]) < 1e-9) continue;
    ring.push(p);
  }
  while (ring.length > 1) {
    const a = ring[0],
      b = ring[ring.length - 1];
    if (Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) >= 1e-9) break;
    ring.pop();
  }
  if (ring.length < 3) return null;

  const n = faceOutwardNormal(face);
  if (!n) return null; // degenerate: no area to draw

  // A 2D basis in the plane, u chosen against the world axis least aligned with
  // the normal so the cross product is well conditioned.
  const ax: V3 =
    Math.abs(n[0]) < Math.abs(n[1]) && Math.abs(n[0]) < Math.abs(n[2])
      ? [1, 0, 0]
      : Math.abs(n[1]) < Math.abs(n[2])
        ? [0, 1, 0]
        : [0, 0, 1];
  const u = vunit(vcross(ax, n));
  const v = vcross(n, u);
  const o = ring[0];
  const poly2d: [number, number][] = ring.map((p) => {
    const d: V3 = [p[0] - o[0], p[1] - o[1], p[2] - o[2]];
    return [vdot(d, u), vdot(d, v)];
  });
  // Ear clipping wants counter-clockwise input; the projection's winding follows
  // from the basis, so measure it rather than assume.
  let area2 = 0;
  for (let i = 0; i < poly2d.length; i++) {
    const a = poly2d[i],
      b = poly2d[(i + 1) % poly2d.length];
    area2 += a[0] * b[1] - b[0] * a[1];
  }
  const order = area2 >= 0 ? poly2d.map((_, i) => i) : poly2d.map((_, i) => poly2d.length - 1 - i);
  const tris = earClip(order.map((i) => poly2d[i]));
  if (tris.length === 0) return null;

  const vertices: number[] = [];
  const verticesNormals: number[] = [];
  for (const i of order) {
    vertices.push(ring[i][0], ring[i][1], ring[i][2]);
    verticesNormals.push(n[0], n[1], n[2]);
  }
  const trianglesIndexes: number[] = [];
  for (const [a, b, c] of tris) trianglesIndexes.push(a + nodeOffset, b + nodeOffset, c + nodeOffset);
  return { vertices, trianglesIndexes, verticesNormals };
}

/** A repaired copy of a face — pcurves rebuilt from the 3D edges, wires
 *  re-ordered and re-oriented — or null if the fix did nothing useful. OCCT's
 *  mesher works in the face's parametric space, so a face whose 2D curves are
 *  wrong (a boolean along coincident walls is the usual source) is unmeshable
 *  however fine the tolerance, while the 3D geometry it renders from is fine. */
function repairFace(face: Topo): Topo | null {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const oc = getOC() as any;
  try {
    const fix = new oc.ShapeFix_Face_2(face);
    fix.SetPrecision(1e-4);
    fix.FixAddPCurveMode = true;
    fix.FixOrientationMode = true;
    fix.Perform();
    const out = fix.Face();
    fix.delete();
    return out ?? null;
  } catch {
    return null;
  }
}

/** The triangulation stored on a face, in the same shape replicad's own
 *  `Face.triangulation()` returns, read straight from OCCT so it can be called
 *  on a bare TopoDS_Face (a repaired copy has no replicad wrapper). Vertices are
 *  transformed by the face's location; indices are offset by `nodeOffset` so
 *  they address a shared vertex buffer. Returns null when the face has none. */
function faceTriangulation(
  face: Topo,
  nodeOffset: number,
): { vertices: number[]; trianglesIndexes: number[]; verticesNormals: number[] } | null {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const oc = getOC() as any;
  const loc = new oc.TopLoc_Location_1();
  const handle = oc.BRep_Tool.Triangulation(face, loc, 0);
  if (handle.IsNull()) {
    loc.delete();
    handle.delete?.();
    return null;
  }
  const tri = handle.get();
  const trsf = loc.Transformation();
  const nbNodes = tri.NbNodes();
  const nbTris = tri.NbTriangles();
  const vertices: number[] = [];
  const verticesNormals: number[] = [];
  for (let i = 1; i <= nbNodes; i++) {
    const p = tri.Node(i).Transformed(trsf);
    vertices.push(p.X(), p.Y(), p.Z());
  }
  // Normals come from the surface where OCCT computed them; otherwise fall back
  // to per-face flat shading, which smoothMeshNormals may refine later.
  let haveNormals = false;
  try {
    if (tri.HasNormals()) {
      for (let i = 1; i <= nbNodes; i++) {
        const n = tri.Normal(i).Transformed(trsf);
        verticesNormals.push(n.X(), n.Y(), n.Z());
      }
      haveNormals = true;
    }
  } catch {
    haveNormals = false;
  }
  if (!haveNormals) {
    // Planar faces are the case that lands here; a constant normal is exact.
    const surf = oc.BRep_Tool.Surface_2(face);
    let nx = 0,
      ny = 0,
      nz = 1;
    try {
      const props = new oc.GeomLProp_SLProps_1(surf, 0.5, 0.5, 1, 1e-7);
      if (props.IsNormalDefined()) {
        const n = props.Normal();
        nx = n.X();
        ny = n.Y();
        nz = n.Z();
      }
      props.delete();
    } catch {
      /* keep the +Z fallback */
    }
    // TopAbs_REVERSED === 1: the face's outward direction is the surface's
    // reversed, exactly as replicad's own mesh path treats it.
    const flip = face.Orientation_1() === oc.TopAbs_Orientation.TopAbs_REVERSED;
    for (let i = 0; i < nbNodes; i++) verticesNormals.push(flip ? -nx : nx, flip ? -ny : ny, flip ? -nz : nz);
  }
  const reversed = face.Orientation_1() === oc.TopAbs_Orientation.TopAbs_REVERSED;
  const trianglesIndexes: number[] = [];
  for (let i = 1; i <= nbTris; i++) {
    const t = tri.Triangle(i);
    const a = t.Value(1) - 1 + nodeOffset;
    const b = t.Value(2) - 1 + nodeOffset;
    const c = t.Value(3) - 1 + nodeOffset;
    // A reversed face's triangles wind the other way; emit them so the visible
    // side faces out, or the patch renders as a hole again under backface culling.
    if (reversed) trianglesIndexes.push(a, c, b);
    else trianglesIndexes.push(a, b, c);
  }
  loc.delete();
  return { vertices, trianglesIndexes, verticesNormals };
}

/** Re-mesh, one at a time, any face the whole-shape tessellation produced no
 *  triangles for, appending them to `meshed` in place. Returns how many were
 *  recovered.
 *
 *  OCCT's one-shot BRepMesh gives up on individual faces and says nothing about
 *  it — the shape is valid, the mesher just emits no triangulation for them. The
 *  renderer then draws a hole, and you can see through the solid. It shows up
 *  where a boolean has left slivers along coincident walls (extrude a semicircle
 *  from a cylinder's top and its curved wall lies exactly on the cylinder's) and
 *  a later chamfer re-trims them into shapes the mesher won't take.
 *
 *  Three escalating attempts per face, cheapest first. Meshing it alone often
 *  works, because the tolerances no longer have to suit every face at once, and
 *  tightening them helps again after that — the tolerance only ever goes finer,
 *  so a recovered face is never coarser than the rest of the body. Failing that,
 *  ShapeFix rebuilds the face's 2D curves, which is what's actually broken when a
 *  boolean ran along exactly tangent surfaces. And when even a repaired face is
 *  refused, a planar one is tessellated directly from the 3D geometry of its
 *  boundary, bypassing BRepMesh and its parametric space altogether.
 *
 *  Faces that survive all of that are left out, as before: a hole is bad, but it
 *  beats failing the whole body over one sliver. The caller logs either way. */
function patchMissingFaces(shape: Shape3D, meshed: MeshedFaces): { recovered: number; lost: number } {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const oc = getOC() as any;
  // Only the one-shot path is patchable: it yields growable number[]s, and it's
  // the only one that hides a failure (meshFaceByFace already reports skips).
  if (!meshed.faceGroups || !Array.isArray(meshed.vertices) || !Array.isArray(meshed.triangles)) {
    return { recovered: 0, lost: 0 };
  }
  const faceGroups = meshed.faceGroups;
  const drawn = new Set(faceGroups.map((g) => g.faceId));
  const missing = shape.faces.filter((f) => !drawn.has(f.hashCode));
  if (missing.length === 0) return { recovered: 0, lost: 0 };

  const vertices = meshed.vertices;
  const triangles = meshed.triangles;
  const normals = Array.isArray(meshed.normals) ? meshed.normals : null;

  // A hash grid over the vertices the mesher DID produce, so a hand-tessellated
  // patch can land its boundary exactly on the points its neighbours already use
  // (see triangulatePlanarFace). Built once from the pre-patch buffer; patches
  // don't snap to each other, which keeps the result independent of face order.
  const CELL = 0.2,
    SNAP = 0.05; // mm: grid pitch, and the radius to snap within
  const grid = new Map<string, number[]>();
  const cellKey = (x: number, y: number, z: number) =>
    `${Math.floor(x / CELL)},${Math.floor(y / CELL)},${Math.floor(z / CELL)}`;
  for (let i = 0; i < vertices.length; i += 3) {
    const k = cellKey(vertices[i], vertices[i + 1], vertices[i + 2]);
    const arr = grid.get(k);
    if (arr) arr.push(i);
    else grid.set(k, [i]);
  }
  const snap = (p: V3): V3 => {
    let best = -1,
      bestD = SNAP * SNAP;
    const cx = Math.floor(p[0] / CELL),
      cy = Math.floor(p[1] / CELL),
      cz = Math.floor(p[2] / CELL);
    for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 1; dy++)
        for (let dz = -1; dz <= 1; dz++) {
          for (const i of grid.get(`${cx + dx},${cy + dy},${cz + dz}`) ?? []) {
            const d = (vertices[i] - p[0]) ** 2 + (vertices[i + 1] - p[1]) ** 2 + (vertices[i + 2] - p[2]) ** 2;
            if (d < bestD) {
              bestD = d;
              best = i;
            }
          }
        }
    return best < 0 ? p : [vertices[best], vertices[best + 1], vertices[best + 2]];
  };

  type Tri = { vertices: number[]; trianglesIndexes: number[]; verticesNormals: number[] };
  const append = (face: Face, tri: Tri) => {
    faceGroups.push({ start: triangles.length, count: tri.trianglesIndexes.length, faceId: face.hashCode });
    for (const t of tri.trianglesIndexes) triangles.push(t);
    for (const v of tri.vertices) vertices.push(v);
    // A body meshed without normals shades flat from geometry; don't invent a
    // partial normal buffer for it, which would shade the patch differently.
    if (normals) for (const n of tri.verticesNormals) normals.push(n);
  };

  let patched = 0;
  for (const face of missing) {
    // Each attempt is a (shape to mesh, tolerance scale) pair, cheapest first.
    // Meshing the face alone often succeeds where the whole-body pass didn't,
    // because the tolerances no longer have to suit every face at once; a finer
    // tolerance helps again after that. Then ShapeFix, which rebuilds the 2D
    // curves that are the actual defect after a boolean along tangent surfaces.
    const attempts: { shape: Topo; scale: number }[] = [];
    for (const scale of [1, 0.25, 0.05]) attempts.push({ shape: face.wrapped, scale });
    const repaired = repairFace(face.wrapped);
    if (repaired) for (const scale of [1, 0.25]) attempts.push({ shape: repaired, scale });

    let done = false;
    for (const { shape: target, scale } of attempts) {
      let tri: Tri | null = null;
      try {
        // Drop whatever the failed whole-shape pass left on this face first, or
        // IncrementalMesh considers it already meshed and does nothing.
        oc.BRepTools.Clean(target, true);
        const im = new oc.BRepMesh_IncrementalMesh_2(
          target,
          MESH_OPTS.tolerance * scale,
          false,
          MESH_OPTS.angularTolerance * scale,
          false,
        );
        im.delete();
        // Indices come back already offset by the node count we pass, so the
        // face's triangles address our combined vertex buffer directly.
        tri = faceTriangulation(target, vertices.length / 3);
      } catch {
        tri = null; // this attempt failed; try the next
      }
      if (!tri || tri.trianglesIndexes.length === 0) continue;
      append(face, tri);
      done = true;
      break;
    }
    // Last resort: OCCT won't take this face at any tolerance, repaired or not.
    // Tessellate it ourselves from the 3D boundary, bypassing BRepMesh entirely.
    if (!done) {
      try {
        const tri = triangulatePlanarFace(face, vertices.length / 3, snap);
        if (tri && tri.trianglesIndexes.length > 0) {
          append(face, tri);
          done = true;
        }
      } catch {
        /* nothing left to try; the caller reports it */
      }
    }
    if (done) patched++;
  }
  return { recovered: patched, lost: missing.length - patched };
}

// Two faces meeting below this angle read as one smooth surface: their shared
// edge is a facet seam (or a tangent fillet blend), not a real crease. Used to
// smooth shading + hide seam edges so faceted curved bodies (cylinder/revolve/
// extruded circle) DISPLAY as round while the kernel still booleans the facets.
const CREASE_DOT = Math.cos((22 * Math.PI) / 180);

/** A curved face's outward normal WHERE IT MEETS `e`: the face's own 2D curve
 *  for that edge, sampled mid-span, evaluated on `props` (a BRepGProp_Face
 *  loaded with the face, which orients the normal outward). Null when the edge
 *  carries no such curve on this face. */
function faceNormalAtEdge(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  props: any,
  f: Face,
  e: Edge,
): V3 | null {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const oc = getOC() as any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let c2d: any = null,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    uv: any = null,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    p: any = null,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vn: any = null;
  try {
    c2d = new oc.BRepAdaptor_Curve2d_2(e.wrapped, f.wrapped);
    const t = 0.5 * (c2d.FirstParameter() + c2d.LastParameter());
    if (!Number.isFinite(t)) return null;
    uv = c2d.Value(t);
    p = new oc.gp_Pnt_1();
    vn = new oc.gp_Vec_1();
    props.Normal(uv.X(), uv.Y(), p, vn);
    const n: V3 = [vn.X(), vn.Y(), vn.Z()];
    return Math.hypot(n[0], n[1], n[2]) > 1e-12 ? vunit(n) : null;
  } catch {
    return null;
  } finally {
    vn?.delete();
    p?.delete();
    uv?.delete();
    c2d?.delete();
  }
}

/** One side of an edge: the face meeting it, and that face's outward normal
 *  THERE (not at the face's centre — see faceEdgeAdjacency). */
type EdgeSide = { h: number; n: V3 };

/** The (≤2) faces meeting along each edge with their outward normals there,
 *  plus every periodic SEAM and the hash of every face walked. The shared input
 *  to both the crease test (smoothEdgeHashes) and the logical-surface clustering
 *  (faceClustersFrom), so the two always agree.
 *
 *  The normals are sampled ON each edge because a CURVED face has no single
 *  normal to speak for it. Sampling one — a cylinder's, at its parametric middle
 *  — and comparing that with each neighbour around a ring puts the junction
 *  inside the crease angle for the arc facing that sample and outside it for the
 *  rest: extruding a cylinder's cap left an arc of the join drawn and the rest
 *  hidden, on a wall that is tangent the whole way round. A PLANE is exempt: its
 *  normal is the same everywhere, so its centre normal is already exact. */
function faceEdgeAdjacency(
  shape: Shape3D,
  stats?: FaceNormalStats,
): { adj: Map<number, EdgeSide[]>; seams: Set<number>; faceHashes: number[] } {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const oc = getOC() as any;
  const adj = new Map<number, EdgeSide[]>();
  const seams = new Set<number>();
  const faceHashes: number[] = [];
  for (const f of shape.faces) {
    const fh = f.hashCode;
    faceHashes.push(fh);
    const centre = faceOutwardNormal(f, stats);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let props: any = null;
    if (f.geomType !== "PLANE") {
      try {
        props = new oc.BRepGProp_Face_2(f.wrapped, false);
      } catch {
        props = null; // fall back to the face's centre normal below
      }
    }
    for (const e of f.edges) {
      // A seam is where a periodic surface wraps round and meets itself: an
      // analytic revolve's cylinder, a sphere, a cylindrical hole. It is ONE
      // face on both sides, so the crease test can never see two normals for it
      // (the topology explorer yields each edge once) and it drew as a hard line
      // down an otherwise seamless wall — an "extra edge" back where the revolve
      // started. The surface is continuous through it by construction, and
      // nothing can reference it: an edge is only named when BOTH its faces are.
      try {
        if (oc.BRep_Tool.IsClosed_2(e.wrapped, f.wrapped)) seams.add(e.hashCode);
      } catch {
        /* not a seam (or no curve on the face to ask about) */
      }
      const n = (props ? faceNormalAtEdge(props, f, e) : null) ?? centre;
      if (!n) continue;
      const arr = adj.get(e.hashCode);
      if (arr) arr.push({ h: fh, n });
      else adj.set(e.hashCode, [{ h: fh, n }]);
    }
    props?.delete();
  }
  return { adj, seams, faceHashes };
}

type FaceEdgeAdjacency = ReturnType<typeof faceEdgeAdjacency>;

/** Edge hashCodes whose two adjacent faces meet below the crease angle (a facet
 *  seam / tangent blend) — plus every periodic seam. */
function smoothEdgeHashes(shape: Shape3D, stats?: FaceNormalStats, walked?: FaceEdgeAdjacency): Set<number> {
  const { adj, seams } = walked ?? faceEdgeAdjacency(shape, stats);
  const smooth = new Set<number>(seams);
  for (const [h, fs] of adj) {
    if (fs.length === 2 && vdot(fs[0].n, fs[1].n) > CREASE_DOT) smooth.add(h);
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
function faceClustersFrom(shape: Shape3D, walked?: FaceEdgeAdjacency): Map<number, number> {
  const parent = new Map<number, number>();
  const find = (x: number): number => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r)!;
    while (parent.get(x) !== r) {
      const nx = parent.get(x)!;
      parent.set(x, r);
      x = nx;
    }
    return r;
  };
  const union = (a: number, b: number) => {
    const ra = find(a),
      rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };
  const { adj, faceHashes } = walked ?? faceEdgeAdjacency(shape);
  for (const fh of faceHashes) if (!parent.has(fh)) parent.set(fh, fh);
  for (const fs of adj.values()) {
    if (fs.length === 2 && vdot(fs[0].n, fs[1].n) > CREASE_DOT) union(fs[0].h, fs[1].h);
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
    while (parent.get(x) !== r) {
      const nx = parent.get(x)!;
      parent.set(x, r);
      x = nx;
    }
    return r;
  };
  const union = (a: number, b: number) => {
    const ra = find(a),
      rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };
  const vkey = (p: V3) => `${Math.round(p[0] * 1e3)},${Math.round(p[1] * 1e3)},${Math.round(p[2] * 1e3)}`;
  // vertex -> the edge-ends there, each with the unit tangent pointing INTO the edge.
  const atVertex = new Map<string, { h: number; tan: V3 }[]>();
  for (const e of shape.edges) {
    const h = e.hashCode;
    if (!parent.has(h)) parent.set(h, h);
    let pts: V3[];
    try {
      pts = sampleEdgePoints(e);
    } catch {
      continue;
    }
    if (pts.length < 2) continue;
    const a = pts[0],
      a2 = pts[1],
      b = pts[pts.length - 1],
      b2 = pts[pts.length - 2];
    const tanA = vunit([a2[0] - a[0], a2[1] - a[1], a2[2] - a[2]]);
    const tanB = vunit([b2[0] - b[0], b2[1] - b[1], b2[2] - b[2]]);
    for (const [p, tan] of [
      [a, tanA],
      [b, tanB],
    ] as [V3, V3][]) {
      const k = vkey(p);
      const arr = atVertex.get(k);
      if (arr) arr.push({ h, tan });
      else atVertex.set(k, [{ h, tan }]);
    }
  }
  for (const arr of atVertex.values()) {
    for (let i = 0; i < arr.length; i++)
      for (let j = i + 1; j < arr.length; j++)
        if (arr[i].h !== arr[j].h && vdot(arr[i].tan, arr[j].tan) < -CHAIN_DOT) union(arr[i].h, arr[j].h);
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
  const V = faces.vertices,
    N = faces.normals;
  if (!V || !N) return;
  const nv = V.length / 3;
  const groups = new Map<string, number[]>();
  for (let vi = 0; vi < nv; vi++) {
    const k = `${Math.round(V[vi * 3] * 1e4)},${Math.round(V[vi * 3 + 1] * 1e4)},${Math.round(V[vi * 3 + 2] * 1e4)}`;
    const arr = groups.get(k);
    if (arr) arr.push(vi);
    else groups.set(k, [vi]);
  }
  for (const arr of groups.values()) {
    if (arr.length < 2) continue;
    const clusters: { sum: V3; rep: V3; members: number[] }[] = [];
    for (const vi of arr) {
      const n: V3 = [N[vi * 3], N[vi * 3 + 1], N[vi * 3 + 2]];
      let c = clusters.find((cl) => vdot(cl.rep, n) > CREASE_DOT);
      if (!c) {
        c = { sum: [0, 0, 0], rep: n, members: [] };
        clusters.push(c);
      }
      c.sum[0] += n[0];
      c.sum[1] += n[1];
      c.sum[2] += n[2];
      c.members.push(vi);
    }
    if (clusters.length < 2 && arr.length < 3) continue;
    for (const c of clusters) {
      const L = Math.hypot(c.sum[0], c.sum[1], c.sum[2]) || 1;
      const a: V3 = [c.sum[0] / L, c.sum[1] / L, c.sum[2] / L];
      for (const vi of c.members) {
        N[vi * 3] = a[0];
        N[vi * 3 + 1] = a[1];
        N[vi * 3 + 2] = a[2];
      }
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
  const usedDressUps = new Set<string>();
  const { bodies, previews, failures, timings, warnings } = buildBodies(features, usedBuilders, usedDressUps);
  const buildMs = performance.now() - buildT0;
  const meshTimings: { id: string; ms: number; hit: boolean }[] = [];
  const usedMeshes = new Set<string>();
  // Preview bodies tessellate on exactly the same path as real ones (they're
  // ordinary solids); they differ only in that no feature can reference them.
  const meshes: RegenFeatureResult[] = [...bodies, ...previews].map((b) => {
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
        // The face/edge adjacency walk, shared by the crease test and the
        // logical-surface clustering below so they can't disagree — and so the
        // walk (an OCCT adaptor per face, another per curved face's edge) is
        // paid for once per body rather than twice.
        let walked: FaceEdgeAdjacency | undefined;
        if (b.names.size > PER_FACE_MESH_THRESHOLD) {
          // Large imported assembly: mesh per-face so peak memory stays bounded
          // (replicad's whole-shape mesh holds every triangulation at once and
          // exhausts the heap). Produce typed arrays — this mesh is millions of
          // triangles and re-transfers to the main thread every regen, so the
          // ArrayBuffer copy (vs per-number structured clone) is a big win here.
          faces = meshFaceByFace(b.shape, referenceMeshOpts(b.shape), (done, total) =>
            onMeshProgress?.(b.id, done, total),
          );
          edges = { lines: [], edgeGroups: [] }; // edges omitted for a reference body
        } else {
          // Normal body: replicad's one-shot mesh (number[]). Small meshes clone
          // across the worker boundary instantly, so typed-array repacking would
          // only add overhead with no transfer benefit.
          faces = b.shape.mesh(MESH_OPTS);
          edges = b.shape.meshEdges(MESH_OPTS);
          // Recover any face the one-shot mesh silently dropped, before anything
          // downstream reads the buffers. Runs after meshEdges, which wants the
          // triangulation the whole-shape pass left on the shape. Both outcomes
          // are logged with stable prefixes: a hole in a solid is invisible in
          // any other telemetry, and the verification harness asserts on these.
          const { recovered, lost } = patchMissingFaces(b.shape, faces);
          if (recovered) console.warn(`mesh: recovered ${recovered} dropped face(s) on ${b.id}`);
          if (lost) console.warn(`mesh: UNMESHED ${lost} face(s) on ${b.id} — the body will render with holes`);
          // Display-only smoothing: faceted curved bodies (cylinder/revolve/
          // extruded circle) are genuinely polygonal, so shade their walls smooth
          // and drop the facet seam edges — they READ as round while the kernel
          // keeps booleaning the facets. Sharp features (creases above the
          // threshold) are preserved. Geometry the kernel sees is untouched.
          // Skipped for preview bodies: it walks each edge's adjacent faces with
          // OCCT adaptors, which throws on the slivers a dress-up delta carries,
          // and a translucent ghost gains nothing from smooth shading anyway.
          if (!b.preview) {
            smoothMeshNormals(faces);
            // A face the crease test can't get a normal for drops out of the
            // adjacency walk, and every seam around it is then drawn as a hard
            // crease — a black line down an otherwise smooth wall. Reported for
            // the same reason as a hole: otherwise it's silent.
            const nstats: FaceNormalStats = { fallback: 0, unknown: 0 };
            walked = faceEdgeAdjacency(b.shape, nstats);
            edges = filterSmoothEdges(edges, smoothEdgeHashes(b.shape, nstats, walked));
            if (nstats.fallback)
              console.warn(`mesh: ${nstats.fallback} face normal(s) via boundary fallback on ${b.id}`);
            if (nstats.unknown)
              console.warn(`mesh: NORMALLESS ${nstats.unknown} face(s) on ${b.id} — their seams draw as creases`);
          }
        }
        // Attach each face's / edge's persistent name (matched by build-local hash)
        // so the app carries stable references across rebuilds. All of it is
        // skipped for a preview body: nothing can reference or pick one, and
        // these passes walk every face with OCCT adaptors — which a dress-up
        // delta, full of slivers where two nearly-identical solids were
        // differenced, is very good at making throw.
        if (faces.faceGroups && !b.preview) {
          // Surface classification walks every face with an OCCT adaptor, so skip
          // it for huge reference bodies (the per-face mesh path) — they're
          // reference-only, and the pass would cost more than it's worth.
          const surfaces = b.names.size > PER_FACE_MESH_THRESHOLD ? null : faceSurfacesFrom(b.shape);
          // Logical-surface clustering (whole-cylinder selection). Skipped for huge
          // reference bodies alongside surface classification — same O(faces) walk.
          const clusters = b.names.size > PER_FACE_MESH_THRESHOLD ? null : faceClustersFrom(b.shape, walked);
          faces.faceGroups = faces.faceGroups.map((g) => ({
            ...g,
            name: b.names.get(g.faceId),
            surface: surfaces?.get(g.faceId),
            clusterId: clusters?.get(g.faceId),
          }));
        }
        if (edges.edgeGroups && !b.preview) {
          const edgeNames = edgeNamesFrom(b.shape, b.names);
          // Chain tangent-continuous chords (whole-circle edge selection); skipped
          // for huge reference bodies alongside the surface/cluster passes.
          const chains = b.names.size > PER_FACE_MESH_THRESHOLD ? null : edgeChainsFrom(b.shape);
          edges.edgeGroups = edges.edgeGroups.map((g) => ({
            ...g,
            name: edgeNames.get(g.edgeId),
            chainId: chains?.get(g.edgeId),
          }));
        }
        cached = { faces, edges };
        meshCache.set(b.key, cached);
      }
      result = { id: b.id, ok: true, mesh: { name: b.id, faces: cached.faces, edges: cached.edges } };
    } catch (err) {
      result = { id: b.id, ok: false, error: errorMessage(err) };
    } finally {
      // A feature that threw part-way may have freed a body's shape and left the
      // dangling entry in `bodies` (its own error is already recorded). Freeing
      // it again would throw out of the mesh pass and turn one bad feature into a
      // dead regeneration, so the cleanup tolerates it.
      try {
        b.shape.delete();
      } catch {
        /* already released by a failed feature */
      }
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
    if (!usedBuilders.has(k)) {
      builderCache.get(k)!.shape.delete();
      builderCache.delete(k);
    }
  }
  // Same sweep for dress-ups, and it is what makes UNDO safe to cache through:
  // undo replays an earlier document, so the entries belonging to the undone
  // state go untouched this run and are disposed here. (Correctness never
  // depended on it — a content key names its own result — but the geometry
  // would otherwise sit in memory for a state no longer reachable.)
  for (const k of dressUpCache.keys()) {
    if (!usedDressUps.has(k)) {
      dressUpCache.get(k)!.result.shape.delete();
      dressUpCache.delete(k);
    }
  }
  for (const k of meshCache.keys()) if (!usedMeshes.has(k)) meshCache.delete(k);

  if (REGEN_PROFILE) {
    const meshMs = meshTimings.reduce((s, m) => s + m.ms, 0);
    const short = (s: string) => s.slice(0, 8);
    const topBuild = timings
      .filter((t) => t.ms >= 1)
      .sort((a, b) => b.ms - a.ms)
      .map((t) => `${short(t.id)}:${t.type}=${t.ms.toFixed(0)}`);
    const topMesh = meshTimings
      .filter((m) => m.ms >= 1)
      .sort((a, b) => b.ms - a.ms)
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
  const { bodies, previews } = buildBodies(features);
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
    for (const b of [...bodies, ...previews]) b.shape.delete();
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
      req.features.some((f) => f.type === "extrude" && f.profiles.some((p) => p.kind === "sketchText"))
    ) {
      await ensureFont();
    }
    let res: KernelResponse;
    switch (req.op) {
      case "regenerate": {
        const { results, warnings } = regenerate(
          req.features,
          (result) => ctx.postMessage({ id: req.id, ok: true, op: "regenerate-progress", result }),
          (featureId, done, total) =>
            ctx.postMessage({ id: req.id, ok: true, op: "mesh-progress", featureId, done, total }),
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
