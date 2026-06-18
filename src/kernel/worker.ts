// The kernel Web Worker: hosts the heavy OCCT WASM module and replicad so the
// UI thread never blocks on geometry regeneration. It builds each feature in a
// document and returns tessellated meshes (or a per-feature error).

import opencascade from "replicad-opencascadejs/src/replicad_single.js";
import opencascadeWasm from "replicad-opencascadejs/src/replicad_single.wasm?url";
import {
  setOC, makeBaseBox, makeCylinder, makeSphere, draw, Plane,
  cast, getOC, Vector, HASH_CODE_MAX, exportSTEP, measureVolume,
} from "replicad";
import type { Shape3D, Face } from "replicad";

import type { KernelRequest, KernelResponse } from "./protocol";
import type {
  BooleanOp,
  ExportFormat,
  RegenFeatureResult,
  ResolvedFeature,
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

/** Extrude a baked sketch outline along its frame normal (signed by `flip`). */
function extrudeSketchRegion(
  profile: Extract<ResolvedFeature, { type: "extrude" }>["profile"] & { kind: "sketchRegion" },
  flip: boolean,
  distance: number,
  id: string,
): NamedShape {
  const { outline, frame } = profile;
  if (outline.length < 3) throw new Error("extrude: profile needs at least 3 points");
  const plane = new Plane(frame.origin, frame.uAxis, frame.normal);
  let pen = draw().movePointerTo(outline[0]);
  for (let i = 1; i < outline.length; i++) pen = pen.lineTo(outline[i]);
  const face = (pen.close().sketchOnPlane(plane) as { face(): Face }).face();
  return prismFromFace(face, new Vector(frame.normal), flip ? -distance : distance, id);
}

/** Extrude a face of a running body along its normal (signed by `flip`). The
 *  face is re-found by its persistent name, else by nearest centroid. */
function extrudeBodyFace(
  src: Body,
  faceName: string | undefined,
  center: [number, number, number],
  flip: boolean,
  distance: number,
  id: string,
): NamedShape {
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
  return prismFromFace(best, best.normalAt(), flip ? -distance : distance, id);
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

// Relative epsilon (vs. the larger operand's volume) for "did this boolean
// actually do anything" — non-overlapping solids that OCCT happily combines
// into a degenerate result are caught and reported instead.
const VOLUME_EPS_REL = 1e-6;
const BOOL_OCC: Record<BooleanOp, "fuse" | "cut" | "common"> = {
  union: "fuse",
  subtract: "cut",
  intersect: "common",
};

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
    const bad =
      op === "union"
        ? nextVol >= accVol + toolVol - eps && "Solids don't overlap — union needs overlapping bodies."
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
      } else if (feature.type === "extrude") {
        const { profile, flip, distance, mode } = feature;
        const built: NamedShape =
          profile.kind === "sketchRegion"
            ? extrudeSketchRegion(profile, flip, distance, feature.id)
            : extrudeBodyFace(
                requireBody(bodies, profile.sourceId),
                profile.faceName, profile.center, flip, distance, feature.id,
              );

        if (mode === "new") {
          bodies.push({ id: feature.id, ...built });
        } else {
          // Merge scope: a face profile combines with its source body; a sketch
          // profile combines with every current body (Phase-7 will refine this).
          const targetIds =
            profile.kind === "bodyFace" ? [profile.sourceId] : bodies.map((b) => b.id);
          const targets = bodies.filter((b) => targetIds.includes(b.id));

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
