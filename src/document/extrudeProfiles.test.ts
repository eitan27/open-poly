import { describe, expect, it } from "vitest";
import { extrudeProfilesFromPicks, isExtrudePick, toggleExtrudePick, type ExtrudeMesh } from "./extrudeProfiles";
import { detectSketchRegions } from "./regions";
import type { Document, SketchFeature } from "./types";

// A sketch holding one square (four lines) plus a text entity. The square's
// region id is whatever detectSketchRegions assigns, so the tests read it back
// rather than hard-coding it.
const square: SketchFeature = {
  id: "sk",
  type: "sketch",
  name: "Sketch 1",
  suppressed: false,
  plane: { kind: "datum", id: "plane-top" },
  entities: [
    { type: "line", id: "l1", a: [0, 0], b: [10, 0] },
    { type: "line", id: "l2", a: [10, 0], b: [10, 10] },
    { type: "line", id: "l3", a: [10, 10], b: [0, 10] },
    { type: "line", id: "l4", a: [0, 10], b: [0, 0] },
    { type: "text", id: "t1", p: [2, 2], value: "AB", height: 5, rotation: 0 },
  ],
  constraints: [],
};
const doc: Document = { features: [square], variables: [], rollbackIndex: 1 };
const regionId = detectSketchRegions(square.entities)[0].id;

// One body with a named, planar face 1 (a unit triangle in z = 0).
const meshes: ExtrudeMesh[] = [
  {
    id: "body1",
    mesh: {
      faces: {
        vertices: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
        triangles: new Uint32Array([0, 1, 2]),
        normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
        faceGroups: [{ start: 0, count: 3, faceId: 1, name: "F1" }],
      },
      edges: { lines: new Float32Array([]), edgeGroups: [] },
    },
  },
];

describe("extrudeProfilesFromPicks", () => {
  it("takes a clicked sketch region", () => {
    expect(extrudeProfilesFromPicks([{ kind: "sketchFace", sketchId: "sk", regionId }], doc, meshes)).toEqual([
      { kind: "sketchRegion", sketchId: "sk", regionId },
    ]);
  });

  it("turns the EDGES that enclose a region into that region — the whole point of resolving the set at once", () => {
    const picks = ["l1", "l2", "l3", "l4"].map((entityId) => ({
      kind: "sketchEntity" as const,
      sketchId: "sk",
      entityId,
    }));
    expect(extrudeProfilesFromPicks(picks, doc, meshes)).toEqual([{ kind: "sketchRegion", sketchId: "sk", regionId }]);
  });

  it("gives nothing for edges that don't close a loop — three sides of the square", () => {
    const picks = ["l1", "l2", "l3"].map((entityId) => ({ kind: "sketchEntity" as const, sketchId: "sk", entityId }));
    expect(extrudeProfilesFromPicks(picks, doc, meshes)).toEqual([]);
  });

  it("extrudes a text entity on its own — no enclosing region needed", () => {
    expect(extrudeProfilesFromPicks([{ kind: "sketchEntity", sketchId: "sk", entityId: "t1" }], doc, meshes)).toEqual([
      { kind: "sketchText", sketchId: "sk", textId: "t1" },
    ]);
  });

  it("takes a planar body face, with its name and fingerprint", () => {
    const out = extrudeProfilesFromPicks([{ kind: "face", featureId: "body1", faceId: 1 }], doc, meshes);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ kind: "bodyFace", featureId: "body1", faceId: 1, faceName: "F1" });
  });

  it("dedupes a region reached both by its face and by its enclosing edges", () => {
    const picks = [
      { kind: "sketchFace" as const, sketchId: "sk", regionId },
      ...["l1", "l2", "l3", "l4"].map((entityId) => ({ kind: "sketchEntity" as const, sketchId: "sk", entityId })),
    ];
    expect(extrudeProfilesFromPicks(picks, doc, meshes)).toEqual([{ kind: "sketchRegion", sketchId: "sk", regionId }]);
  });

  it("ignores picks it can't use, rather than failing the whole list", () => {
    const picks = [{ kind: "vertex" as const }, { kind: "sketchFace" as const, sketchId: "sk", regionId }];
    expect(extrudeProfilesFromPicks(picks, doc, meshes)).toHaveLength(1);
  });

  it("is empty with nothing picked (the dialog opens that way on purpose)", () => {
    expect(extrudeProfilesFromPicks([], doc, meshes)).toEqual([]);
  });
});

describe("isExtrudePick", () => {
  it("accepts the three pick kinds an extrude can consume", () => {
    expect(isExtrudePick({ kind: "sketchFace" })).toBe(true);
    expect(isExtrudePick({ kind: "sketchEntity" })).toBe(true);
    expect(isExtrudePick({ kind: "face" })).toBe(true);
  });

  it("refuses the rest, so the dialog can keep its arming live and say why", () => {
    expect(isExtrudePick({ kind: "edge" })).toBe(false);
    expect(isExtrudePick({ kind: "vertex" })).toBe(false);
  });
});

describe("toggleExtrudePick", () => {
  const face = { kind: "sketchFace" as const, sketchId: "sk", regionId };

  it("adds a pick that isn't there", () => {
    expect(toggleExtrudePick([], face)).toEqual([face]);
  });

  it("removes the same region picked twice — clicking a listed profile drops it", () => {
    expect(toggleExtrudePick([face], face)).toEqual([]);
  });

  it("tells regions in different sketches apart", () => {
    expect(toggleExtrudePick([face], { ...face, sketchId: "sk2" })).toHaveLength(2);
  });

  it("tells a body face from a sketch region with the same ids", () => {
    const bodyFace = { kind: "face" as const, featureId: "sk", faceId: 1 };
    expect(toggleExtrudePick([bodyFace], { ...bodyFace, faceId: 2 })).toHaveLength(2);
    expect(toggleExtrudePick([bodyFace], bodyFace)).toEqual([]);
  });
});
