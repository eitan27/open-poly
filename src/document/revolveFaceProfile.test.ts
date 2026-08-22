import { describe, it, expect } from "vitest";
import { migrateDocument, resolveDocument } from "./document";
import { detectSketchRegions } from "./regions";
import type { Document, RevolveFeature, SketchFeature } from "./types";

// Lowering a revolve whose PROFILE is a planar body face. Unlike a sketch region
// (baked here to an outline + frame), a face reference is carried through — its
// plane only exists once the B-rep is built — which also defers a PLANE axis to
// the worker, since there's no profile plane here to intersect it with.
describe("revolve with a body-face profile", () => {
  const face: RevolveFeature["profile"] = {
    kind: "bodyFace",
    featureId: "box",
    faceId: 42,
    faceName: "box/side0",
    center: [1, 2, 3],
    normal: [0, 0, 1],
  };
  const revolve = (profile: RevolveFeature["profile"], axis: RevolveFeature["axis"]): RevolveFeature => ({
    id: "rev",
    type: "revolve",
    name: "Revolve 1",
    suppressed: false,
    profile,
    axis,
    angle: "360",
    symmetric: false,
    color: 0,
    opacity: 1,
  });
  const box = {
    id: "box",
    type: "primitive" as const,
    kind: "box" as const,
    name: "Box 1",
    suppressed: false,
    params: { width: "10", depth: "10", height: "10" },
    color: 0,
    opacity: 1,
  };
  const docOf = (f: RevolveFeature): Document => ({
    features: [box, f],
    variables: [],
    rollbackIndex: 2,
  });

  it("carries the face reference through instead of baking an outline", () => {
    const withAxis = resolveDocument({
      features: [
        box,
        {
          id: "sk",
          type: "sketch",
          name: "Sketch 1",
          suppressed: false,
          plane: { kind: "datum", id: "plane-front" },
          entities: [{ type: "line", id: "e", a: [0, 0], b: [0, 10], construction: true }],
          constraints: [],
        } satisfies SketchFeature,
        revolve(face, { sketchId: "sk", entityId: "e" }),
      ],
      variables: [],
      rollbackIndex: 3,
    });
    const rr = withAxis.features.find((f) => f.id === "rev");
    expect(withAxis.errors).toEqual({});
    expect(rr?.type).toBe("revolve");
    if (rr?.type !== "revolve") throw new Error("unreachable");
    expect(rr.profile.kind).toBe("bodyFace");
    if (rr.profile.kind !== "bodyFace") throw new Error("unreachable");
    expect(rr.profile.sourceId).toBe("box");
    expect(rr.profile.faceName).toBe("box/side0");
    expect(rr.profile.center).toEqual([1, 2, 3]);
    // A sketch-line axis is baked to a world line whatever the profile is.
    expect(rr.axisOrigin).toBeDefined();
    expect(rr.axisDir).toBeDefined();
  });

  it("defers a PLANE axis to the worker (no profile plane to intersect here)", () => {
    const res = resolveDocument(docOf(revolve(face, { plane: { kind: "datum", id: "plane-front" } })));
    expect(res.errors).toEqual({});
    const r = res.features.find((f) => f.id === "rev");
    if (r?.type !== "revolve") throw new Error("unreachable");
    expect(r.axisOrigin).toBeUndefined();
    expect(r.axisPlane).toBeDefined();
    expect(r.axisPlane?.normal).toHaveLength(3);
  });

  it("still bakes a plane axis when the profile IS a sketch region", () => {
    const sketch: SketchFeature = {
      id: "sk",
      type: "sketch",
      name: "Sketch 1",
      suppressed: false,
      plane: { kind: "datum", id: "plane-front" },
      entities: [
        { type: "line", id: "l1", a: [2, 0], b: [6, 0] },
        { type: "line", id: "l2", a: [6, 0], b: [6, 8] },
        { type: "line", id: "l3", a: [6, 8], b: [2, 8] },
        { type: "line", id: "l4", a: [2, 8], b: [2, 0] },
      ],
      constraints: [],
    };
    const regionId = detectSketchRegions(sketch.entities)[0].id;
    const doc: Document = {
      features: [
        sketch,
        revolve({ kind: "sketchRegion", sketchId: "sk", regionId }, { plane: { kind: "datum", id: "plane-right" } }),
      ],
      variables: [],
      rollbackIndex: 2,
    };
    const res = resolveDocument(doc);
    expect(res.errors).toEqual({});
    const r = res.features.find((f) => f.id === "rev");
    if (r?.type !== "revolve") throw new Error("unreachable");
    expect(r.profile.kind).toBe("sketchRegion");
    expect(r.axisPlane).toBeUndefined();
    expect(r.axisOrigin).toBeDefined();
  });

  it("migrates a legacy untagged {sketchId, regionId} profile", () => {
    const legacy = {
      features: [
        {
          id: "rev",
          type: "revolve",
          name: "Revolve 1",
          suppressed: false,
          profile: { sketchId: "sk", regionId: "r0" },
          axis: { sketchId: "sk", entityId: "e" },
          angle: "360",
          symmetric: false,
          color: 0,
          opacity: 1,
        },
      ],
      variables: [],
      rollbackIndex: 1,
    } as unknown as Document;
    const migrated = migrateDocument(legacy);
    const r = migrated.features[0];
    if (r.type !== "revolve") throw new Error("unreachable");
    expect(r.profile).toEqual({ kind: "sketchRegion", sketchId: "sk", regionId: "r0" });
  });
});
