// The kernel Web Worker: hosts the heavy OCCT WASM module and replicad so the
// UI thread never blocks on geometry regeneration. It builds each feature in a
// document and returns tessellated meshes (or a per-feature error).

import opencascade from "replicad-opencascadejs/src/replicad_single.js";
import opencascadeWasm from "replicad-opencascadejs/src/replicad_single.wasm?url";
import { setOC, makeBaseBox, makeCylinder, makeSphere, draw, Plane } from "replicad";
import type { Shape3D } from "replicad";

import type { KernelRequest, KernelResponse } from "./protocol";
import type {
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

/** Build a primitive solid (already translated to its position). */
function buildPrimitive(feature: Extract<ResolvedFeature, { type: "primitive" }>): Shape3D {
  const p = feature.params;
  let shape: Shape3D;
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
  // NB: replicad's 3D translate() deletes the original and returns a new shape.
  return shape.translate(p.x ?? 0, p.y ?? 0, p.z ?? 0) as Shape3D;
}

/** Extrude a planar profile along its frame normal (signed by `flip`). */
function buildExtrude(feature: Extract<ResolvedFeature, { type: "extrude" }>): Shape3D {
  const { outline, frame } = feature.profile;
  if (outline.length < 3) throw new Error("extrude: profile needs at least 3 points");
  const plane = new Plane(frame.origin, frame.uAxis, frame.normal);
  let pen = draw().movePointerTo(outline[0]);
  for (let i = 1; i < outline.length; i++) pen = pen.lineTo(outline[i]);
  const sketch = pen.close().sketchOnPlane(plane);
  const distance = feature.flip ? -feature.distance : feature.distance;
  return sketch.extrude(distance) as Shape3D;
}

// The running-result model: replay features in order, folding each over a
// running set of bodies (a sketch profile becomes a solid; later: add/remove
// fuse/cut into existing bodies). Then tessellate the surviving bodies. Each
// body's id is the feature that produced it, so meshes stay keyed by feature id.
function regenerate(features: ResolvedFeature[]): RegenFeatureResult[] {
  const bodies: { id: string; shape: Shape3D }[] = [];
  const failures: RegenFeatureResult[] = [];

  for (const feature of features) {
    try {
      if (feature.type === "primitive") {
        bodies.push({ id: feature.id, shape: buildPrimitive(feature) });
      } else if (feature.type === "extrude") {
        // Phase-3 slice 1: only the "new body" mode (add/remove come next).
        bodies.push({ id: feature.id, shape: buildExtrude(feature) });
      }
    } catch (err) {
      failures.push({ id: feature.id, ok: false, error: String(err) });
    }
  }

  const meshes: RegenFeatureResult[] = bodies.map((b) => {
    try {
      return {
        id: b.id,
        ok: true,
        mesh: { name: b.id, faces: b.shape.mesh(MESH_OPTS), edges: b.shape.meshEdges(MESH_OPTS) },
      };
    } catch (err) {
      return { id: b.id, ok: false, error: String(err) };
    } finally {
      b.shape.delete();
    }
  });

  return [...meshes, ...failures];
}

ctx.onmessage = async (event: MessageEvent<KernelRequest>) => {
  const req = event.data;
  try {
    await ensureOC();
    let res: KernelResponse;
    switch (req.op) {
      case "regenerate":
        res = { id: req.id, ok: true, results: regenerate(req.features) };
        break;
      default:
        throw new Error(`Unknown kernel op: ${(req as { op: string }).op}`);
    }
    ctx.postMessage(res);
  } catch (err) {
    ctx.postMessage({ id: req.id, ok: false, error: String(err) } as KernelResponse);
  }
};
