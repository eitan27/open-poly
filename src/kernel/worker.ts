// The kernel Web Worker: hosts the heavy OCCT WASM module and replicad so the
// UI thread never blocks on geometry regeneration. It builds each feature in a
// document and returns tessellated meshes (or a per-feature error).

import opencascade from "replicad-opencascadejs/src/replicad_single.js";
import opencascadeWasm from "replicad-opencascadejs/src/replicad_single.wasm?url";
import { setOC, makeBaseBox, makeCylinder, makeSphere, draw, Plane, basicFaceExtrusion } from "replicad";
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

/** Extrude a baked sketch outline along its frame normal (signed by `flip`). */
function extrudeSketchRegion(
  profile: Extract<ResolvedFeature, { type: "extrude" }>["profile"] & { kind: "sketchRegion" },
  flip: boolean,
  distance: number,
): Shape3D {
  const { outline, frame } = profile;
  if (outline.length < 3) throw new Error("extrude: profile needs at least 3 points");
  const plane = new Plane(frame.origin, frame.uAxis, frame.normal);
  let pen = draw().movePointerTo(outline[0]);
  for (let i = 1; i < outline.length; i++) pen = pen.lineTo(outline[i]);
  const sketch = pen.close().sketchOnPlane(plane);
  return sketch.extrude(flip ? -distance : distance) as Shape3D;
}

/** Extrude a face of a running body along its normal (signed by `flip`). The
 *  face is re-found by nearest centroid (OCCT hashes aren't stable across the
 *  rebuild, so we match geometry — a pragmatic stand-in for topological naming). */
function extrudeBodyFace(
  sourceId: string,
  center: [number, number, number],
  flip: boolean,
  distance: number,
  bodies: { id: string; shape: Shape3D }[],
): Shape3D {
  const src = bodies.find((b) => b.id === sourceId);
  if (!src) throw new Error("extrude: source body not found");
  let best: (typeof src.shape.faces)[number] | null = null;
  let bestDist = Infinity;
  for (const f of src.shape.faces) {
    const c = f.center.toTuple();
    const d = (c[0] - center[0]) ** 2 + (c[1] - center[1]) ** 2 + (c[2] - center[2]) ** 2;
    if (d < bestDist) {
      bestDist = d;
      best = f;
    }
  }
  if (!best) throw new Error("extrude: source body has no faces");
  const vec = best.normalAt().normalized().multiply(flip ? -distance : distance);
  return basicFaceExtrusion(best, vec);
}

type Body = { id: string; shape: Shape3D };

// The running-result model: replay features in order, folding each over a
// running set of bodies. A sketch/face profile becomes a solid; mode "new" adds
// it as its own body, while "add"/"remove" fuse/cut it into target bodies in
// place (preserving their ids). Then tessellate the survivors. A body's id is
// the feature that produced (or last started) it, so meshes stay keyed by id.
function regenerate(features: ResolvedFeature[]): RegenFeatureResult[] {
  const bodies: Body[] = [];
  const failures: RegenFeatureResult[] = [];

  for (const feature of features) {
    try {
      if (feature.type === "primitive") {
        bodies.push({ id: feature.id, shape: buildPrimitive(feature) });
      } else if (feature.type === "extrude") {
        const { profile, flip, distance, mode } = feature;
        const built =
          profile.kind === "sketchRegion"
            ? extrudeSketchRegion(profile, flip, distance)
            : extrudeBodyFace(profile.sourceId, profile.center, flip, distance, bodies);

        if (mode === "new") {
          bodies.push({ id: feature.id, shape: built });
        } else {
          // Merge scope: a face profile combines with its source body; a sketch
          // profile combines with every current body (Phase-7 will refine this).
          const targetIds =
            profile.kind === "bodyFace" ? [profile.sourceId] : bodies.map((b) => b.id);
          const targets = bodies.filter((b) => targetIds.includes(b.id));

          if (targets.length === 0) {
            // Nothing to combine with: add becomes a new body, remove is a no-op.
            if (mode === "add") bodies.push({ id: feature.id, shape: built });
            else built.delete();
          } else if (mode === "add") {
            let acc = built;
            for (const t of targets) {
              const next = acc.fuse(t.shape);
              acc.delete();
              t.shape.delete();
              acc = next;
            }
            const keepId = targets[0].id;
            const remaining = bodies.filter((b) => !targets.includes(b));
            bodies.length = 0;
            bodies.push(...remaining, { id: keepId, shape: acc });
          } else {
            // remove: cut the tool from each target in place, preserving ids.
            for (const t of targets) {
              const next = t.shape.cut(built);
              t.shape.delete();
              t.shape = next;
            }
            built.delete();
          }
        }
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
