// The kernel Web Worker: hosts the heavy OCCT WASM module and replicad so the
// UI thread never blocks on geometry regeneration. It builds each feature in a
// document and returns tessellated meshes (or a per-feature error).

import opencascade from "replicad-opencascadejs/src/replicad_single.js";
import opencascadeWasm from "replicad-opencascadejs/src/replicad_single.wasm?url";
import { setOC, makeBaseBox, makeCylinder, makeSphere, exportSTEP, measureVolume } from "replicad";
import type { AnyShape } from "replicad";

import type { KernelRequest, KernelResponse } from "./protocol";
import type {
  BooleanOp,
  ExportFormat,
  RegenFeatureResult,
  ResolvedFeature,
  ShapeMeshPayload,
} from "./types";
import { consumedFeatureIds } from "./types";

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

// All geometry here is authored directly in millimetres (box width/height,
// cylinder/sphere radii, etc. are taken as-is, with no unit conversion) since
// that's OpenCascade's own default working unit.
function buildPrimitiveShape(p: Record<string, number>, kind: string): AnyShape {
  let shape: AnyShape;
  switch (kind) {
    case "box":
      shape = makeBaseBox(p.width, p.depth, p.height);
      break;
    case "cylinder":
      shape = makeCylinder(p.radius, p.height);
      break;
    case "sphere":
      shape = makeSphere(p.radius);
      break;
    default:
      throw new Error(`Unknown feature kind: ${kind}`);
  }
  // NB: replicad's 3D translate() deletes the original and returns a new shape,
  // so reassign and only delete the final shape.
  return shape.translate(p.x ?? 0, p.y ?? 0, p.z ?? 0);
}

// Relative epsilon (vs. the larger operand's volume) for "did this boolean
// actually do anything" checks below — an absolute tolerance would be wrong
// at both very small and very large scales.
const VOLUME_EPS_REL = 1e-6;

/** One fuse/cut/intersect step, plus a verdict on whether it had any effect
 *  (used to detect non-overlapping solids, which OCCT happily "combines"
 *  into a degenerate result instead of erroring). */
function combineStep(
  op: BooleanOp,
  acc: AnyShape,
  tool: AnyShape,
  accVolume: number,
  toolVolume: number,
): { next: AnyShape; invalidMessage: string | null } {
  const eps = VOLUME_EPS_REL * Math.max(accVolume, toolVolume, 1);
  if (op === "union") {
    const next = acc.fuse(tool);
    const invalidMessage =
      measureVolume(next) >= accVolume + toolVolume - eps
        ? "Solids don't intersect — union requires overlapping bodies."
        : null;
    return { next, invalidMessage };
  }
  if (op === "subtract") {
    const next = acc.cut(tool);
    const invalidMessage =
      measureVolume(next) >= accVolume - eps
        ? "Solids don't intersect — nothing to subtract."
        : null;
    return { next, invalidMessage };
  }
  const next = acc.intersect(tool);
  const invalidMessage =
    measureVolume(next) <= eps ? "Solids don't intersect — no common volume." : null;
  return { next, invalidMessage };
}

/** Combines operands left-to-right, validating at each step that the solids
 *  actually overlap. `shapes` are owned by the caller (the worker's batch
 *  cache) and are never deleted here; only this function's own intermediate
 *  results are. */
function combineBoolean(op: BooleanOp, shapes: AnyShape[]): AnyShape {
  if (shapes.length < 2) throw new Error("A Boolean needs at least two operands.");
  let acc = shapes[0];
  let accIsIntermediate = false;
  let accVolume = measureVolume(acc);
  for (let i = 1; i < shapes.length; i++) {
    const tool = shapes[i];
    const toolVolume = measureVolume(tool);
    const { next, invalidMessage } = combineStep(op, acc, tool, accVolume, toolVolume);
    if (invalidMessage) {
      next.delete();
      if (accIsIntermediate) acc.delete();
      throw new Error(invalidMessage);
    }
    if (accIsIntermediate) acc.delete();
    acc = next;
    accIsIntermediate = true;
    accVolume = measureVolume(acc);
  }
  return acc;
}

function buildShape(feature: ResolvedFeature, cache: Map<string, AnyShape>): AnyShape {
  if (feature.type === "primitive") return buildPrimitiveShape(feature.params, feature.kind);
  const shapes = feature.operands.map((id) => {
    const shape = cache.get(id);
    if (!shape) throw new Error(`Missing operand — it must come earlier in the timeline.`);
    return shape;
  });
  return combineBoolean(feature.op, shapes);
}

function meshShape(shape: AnyShape): ShapeMeshPayload {
  return { name: "shape", faces: shape.mesh(MESH_OPTS), edges: shape.meshEdges(MESH_OPTS) };
}

// Builds every active feature (primitives and booleans) into a shared cache
// keyed by feature id, in timeline order, so a boolean can reference any
// earlier feature's shape (primitive or boolean) by id. Operands consumed by
// a boolean are meshed only as part of that boolean's result, not on their
// own. Every cached shape is deleted exactly once at the end.
function regenerate(features: ResolvedFeature[]): RegenFeatureResult[] {
  const cache = new Map<string, AnyShape>();
  const results: RegenFeatureResult[] = [];

  for (const feature of features) {
    try {
      cache.set(feature.id, buildShape(feature, cache));
    } catch (err) {
      results.push({ id: feature.id, ok: false, error: String(err) });
    }
  }

  const consumed = consumedFeatureIds(features);
  for (const feature of features) {
    if (consumed.has(feature.id)) continue;
    const shape = cache.get(feature.id);
    if (!shape) continue; // build already failed and was recorded above
    try {
      results.push({ id: feature.id, ok: true, mesh: meshShape(shape) });
    } catch (err) {
      results.push({ id: feature.id, ok: false, error: String(err) });
    }
  }

  for (const shape of cache.values()) shape.delete();
  return results;
}

// A boolean's shape depends on its operands (themselves possibly booleans),
// so exporting it needs the same batch-build as regenerate — the request
// carries the whole resolved feature list and the id to export out of it.
// Failures in unrelated features are ignored; only featureId's build matters.
function exportFeature(features: ResolvedFeature[], featureId: string, format: ExportFormat): Blob {
  const cache = new Map<string, AnyShape>();
  for (const feature of features) {
    try {
      cache.set(feature.id, buildShape(feature, cache));
    } catch {
      // ignored — only featureId's own build outcome matters below
    }
  }
  const shape = cache.get(featureId);
  if (!shape) throw new Error("This solid has no resolved geometry to export.");
  try {
    // STEP declares its unit explicitly; STL has no unit field, but the
    // underlying coordinates are already millimetres so no scaling is needed.
    // Match the viewport's tessellation quality — replicad's own STL default
    // (1e-3 tolerance) generates files orders of magnitude larger for curved
    // shapes than is useful here.
    return format === "step"
      ? exportSTEP([{ shape, name: featureId }], { unit: "mm" })
      : shape.blobSTL(MESH_OPTS);
  } finally {
    for (const s of cache.values()) s.delete();
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
        res = {
          id: req.id,
          ok: true,
          op: "export",
          blob: exportFeature(req.features, req.featureId, req.format),
        };
        break;
      default:
        throw new Error(`Unknown kernel op: ${(req as { op: string }).op}`);
    }
    ctx.postMessage(res);
  } catch (err) {
    ctx.postMessage({ id: req.id, ok: false, error: String(err) } as KernelResponse);
  }
};
