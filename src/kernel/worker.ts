// The kernel Web Worker: hosts the heavy OCCT WASM module and replicad so the
// UI thread never blocks on geometry regeneration. It builds each feature in a
// document and returns tessellated meshes (or a per-feature error).

import opencascade from "replicad-opencascadejs/src/replicad_single.js";
import opencascadeWasm from "replicad-opencascadejs/src/replicad_single.wasm?url";
import { setOC, makeBaseBox, makeCylinder, makeSphere, exportSTEP } from "replicad";
import type { AnyShape } from "replicad";

import type { KernelRequest, KernelResponse } from "./protocol";
import type {
  ExportFormat,
  RegenFeatureResult,
  ResolvedFeature,
  ShapeMeshPayload,
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

// All geometry here is authored directly in millimetres (box width/height,
// cylinder/sphere radii, etc. are taken as-is, with no unit conversion) since
// that's OpenCascade's own default working unit.
function buildShape(feature: ResolvedFeature): AnyShape {
  const p = feature.params;
  let shape: AnyShape;
  switch (feature.kind) {
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
      throw new Error(`Unknown feature kind: ${(feature as { kind: string }).kind}`);
  }
  // NB: replicad's 3D translate() deletes the original and returns a new shape,
  // so reassign and only delete the final shape.
  return shape.translate(p.x ?? 0, p.y ?? 0, p.z ?? 0);
}

function buildFeature(feature: ResolvedFeature): ShapeMeshPayload {
  const shape = buildShape(feature);
  try {
    return {
      name: feature.kind,
      faces: shape.mesh(MESH_OPTS),
      edges: shape.meshEdges(MESH_OPTS),
    };
  } finally {
    shape.delete();
  }
}

function regenerate(features: ResolvedFeature[]): RegenFeatureResult[] {
  return features.map((feature) => {
    try {
      return { id: feature.id, ok: true, mesh: buildFeature(feature) };
    } catch (err) {
      return { id: feature.id, ok: false, error: String(err) };
    }
  });
}

function exportFeature(feature: ResolvedFeature, format: ExportFormat): Blob {
  const shape = buildShape(feature);
  try {
    // STEP declares its unit explicitly; STL has no unit field, but the
    // underlying coordinates are already millimetres so no scaling is needed.
    // Match the viewport's tessellation quality — replicad's own STL default
    // (1e-3 tolerance) generates files orders of magnitude larger for curved
    // shapes than is useful here.
    return format === "step"
      ? exportSTEP([{ shape, name: feature.id }], { unit: "mm" })
      : shape.blobSTL(MESH_OPTS);
  } finally {
    shape.delete();
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
        res = { id: req.id, ok: true, op: "export", blob: exportFeature(req.feature, req.format) };
        break;
      default:
        throw new Error(`Unknown kernel op: ${(req as { op: string }).op}`);
    }
    ctx.postMessage(res);
  } catch (err) {
    ctx.postMessage({ id: req.id, ok: false, error: String(err) } as KernelResponse);
  }
};
