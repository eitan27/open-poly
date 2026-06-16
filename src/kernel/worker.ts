// The kernel Web Worker: hosts the heavy OCCT WASM module and replicad so the
// UI thread never blocks on geometry regeneration. For now it implements a
// single op (buildBox); future feature ops are added behind the same protocol.

import opencascade from "replicad-opencascadejs/src/replicad_single.js";
import opencascadeWasm from "replicad-opencascadejs/src/replicad_single.wasm?url";
import { setOC, makeBaseBox } from "replicad";

import type { KernelRequest, KernelResponse } from "./protocol";
import type { BoxParams, ShapeMeshPayload } from "./types";

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

function buildBox(params: BoxParams): ShapeMeshPayload {
  const { width, height, depth } = params;
  // makeBaseBox(x, y, z) extrudes along Z, which is "up" in the viewport.
  // Map height -> Z (vertical) and depth -> Y (front-to-back) to match intuition.
  const shape = makeBaseBox(width, depth, height);
  try {
    return {
      name: "box",
      faces: shape.mesh({ tolerance: 0.05, angularTolerance: 30 }),
      edges: shape.meshEdges({ tolerance: 0.05, angularTolerance: 30 }),
    };
  } finally {
    // Discipline from day one: free the OCCT-heap object every regeneration.
    shape.delete();
  }
}

ctx.onmessage = async (event: MessageEvent<KernelRequest>) => {
  const req = event.data;
  try {
    await ensureOC();
    let result: ShapeMeshPayload;
    switch (req.op) {
      case "buildBox":
        result = buildBox(req.params);
        break;
      default:
        throw new Error(`Unknown kernel op: ${(req as { op: string }).op}`);
    }
    const res: KernelResponse = { id: req.id, ok: true, result };
    ctx.postMessage(res);
  } catch (err) {
    const res: KernelResponse = { id: req.id, ok: false, error: String(err) };
    ctx.postMessage(res);
  }
};
