import { describe, it, expect } from "vitest";
import { resolveDocument } from "./document";
import type { Document, SketchFeature, ExtrudeFeature } from "./types";

// Lowering a `sketchText` extrude profile: resolveDocument must bake the text
// entity's value/height/rotation/anchor + plane frame onto the resolved profile
// (the worker re-bakes the glyph wires from these — no font needed here).
describe("text extrude lowering", () => {
  const sketch: SketchFeature = {
    id: "sk",
    type: "sketch",
    name: "Sketch 1",
    suppressed: false,
    plane: { kind: "datum", id: "plane-top" },
    entities: [{ type: "text", id: "t1", p: [5, 7], value: "AB", height: 12, rotation: 0 }],
    constraints: [],
  };
  const extrude: ExtrudeFeature = {
    id: "ex",
    type: "extrude",
    name: "Extrude 1",
    suppressed: false,
    profile: { kind: "sketchText", sketchId: "sk", textId: "t1" },
    distance: "10",
    flip: false,
    extent: "blind",
    mode: "new",
    color: 0,
    opacity: 1,
  };

  it("bakes a text entity into a resolved sketchText profile", () => {
    const doc: Document = { features: [sketch, extrude], variables: [], rollbackIndex: 2 };
    const res = resolveDocument(doc);
    expect(res.errors).toEqual({});
    const rex = res.features.find((f) => f.id === "ex");
    expect(rex?.type).toBe("extrude");
    if (rex?.type !== "extrude") throw new Error("unreachable");
    expect(rex.profile.kind).toBe("sketchText");
    if (rex.profile.kind !== "sketchText") throw new Error("unreachable");
    expect(rex.profile.value).toBe("AB");
    expect(rex.profile.height).toBe(12);
    expect(rex.profile.rotation).toBe(0);
    expect(rex.profile.anchor).toEqual([5, 7]);
    expect(rex.profile.frame.normal).toHaveLength(3);
  });

  it("errors when the text entity is empty (nothing to bake)", () => {
    const empty: SketchFeature = {
      ...sketch,
      entities: [{ type: "text", id: "t1", p: [0, 0], value: "   ", height: 10 }],
    };
    const doc: Document = { features: [empty, extrude], variables: [], rollbackIndex: 2 };
    const res = resolveDocument(doc);
    expect(res.errors["ex"]).toMatch(/text is empty/);
  });
});
