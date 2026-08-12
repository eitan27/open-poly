import { describe, it, expect } from "vitest";
import {
  addBoolean,
  addDressUp,
  addExtrude,
  addPattern,
  addPlane,
  addRevolve,
  addShell,
  addSketch,
  createDocument,
  updateBoolean,
  updateDressUp,
  updateExtrude,
  updatePattern,
  updatePlane,
  updateRevolve,
  updateShell,
} from "./document";
import type { BooleanFeature, DressUpFeature, ExtrudeFeature, PatternFeature, PlaneFeature, RevolveFeature, ShellFeature } from "./types";

const feat = <T,>(doc: ReturnType<typeof createDocument>, id: string) =>
  doc.features.find((f) => f.id === id) as unknown as T;

describe("in-place feature edits preserve identity + timeline position", () => {
  it("updateExtrude swaps profile/params, keeps id/name/color", () => {
    let doc = createDocument();
    const { doc: d1, id: sk } = addSketch(doc, { kind: "datum", id: "plane-front" });
    const { doc: d2, id } = addExtrude(d1, { kind: "sketchRegion", sketchId: sk, regionId: "r1" }, { distance: "10", mode: "new" });
    const before = feat<ExtrudeFeature>(d2, id);
    doc = updateExtrude(d2, id, { kind: "sketchRegion", sketchId: sk, regionId: "r2" }, { distance: "25", flip: true, extent: "symmetric", mode: "new" });
    const after = feat<ExtrudeFeature>(doc, id);
    expect(after.id).toBe(id);
    expect(after.name).toBe(before.name);
    expect(after.color).toBe(before.color);
    expect(after.distance).toBe("25");
    expect(after.flip).toBe(true);
    expect(after.extent).toBe("symmetric");
    expect((after.profile as { regionId: string }).regionId).toBe("r2");
    // timeline index unchanged
    expect(doc.features.findIndex((f) => f.id === id)).toBe(d2.features.findIndex((f) => f.id === id));
  });

  it("updatePlane changes method/offset in place", () => {
    let doc = createDocument();
    const { doc: d1, id } = addPlane(createDocument(), { method: "offset", base: { kind: "datum", id: "plane-top" }, offset: "20" });
    doc = updatePlane(d1, id, { method: "offset", base: { kind: "datum", id: "plane-front" }, offset: "50" });
    const p = feat<PlaneFeature>(doc, id);
    expect(p.offset).toBe("50");
    expect(p.base).toEqual({ kind: "datum", id: "plane-front" });
  });

  it("updateRevolve changes angle/symmetric", () => {
    const { doc: d1, id } = addRevolve(createDocument(), { sketchId: "s", regionId: "r" }, { sketchId: "s", entityId: "e" }, "360", false);
    const doc = updateRevolve(d1, id, { sketchId: "s", regionId: "r" }, { sketchId: "s", entityId: "e" }, "90", true);
    const r = feat<RevolveFeature>(doc, id);
    expect(r.angle).toBe("90");
    expect(r.symmetric).toBe(true);
  });

  it("updateBoolean changes op + operands", () => {
    const { doc: d1, id } = addBoolean(createDocument(), "union", ["a", "b"]);
    const doc = updateBoolean(d1, id, "subtract", ["a", "c", "d"]);
    const b = feat<BooleanFeature>(doc, id);
    expect(b.op).toBe("subtract");
    expect(b.operands).toEqual(["a", "c", "d"]);
  });

  it("updateDressUp changes size + edges", () => {
    const { doc: d1, id } = addDressUp(createDocument(), "fillet", "body", ["e1"], "2");
    const doc = updateDressUp(d1, id, { op: "fillet", targetId: "body", edges: ["e1", "e2"], size: "5" });
    const f = feat<DressUpFeature>(doc, id);
    expect(f.size).toBe("5");
    expect(f.edges).toEqual(["e1", "e2"]);
  });

  it("updateDressUp sets the chamfer angle, and drops it when switched to a fillet", () => {
    const { doc: d1, id } = addDressUp(createDocument(), "chamfer", "body", ["e1"], "2", undefined, "30", true);
    expect(feat<DressUpFeature>(d1, id).angle).toBe("30");
    expect(feat<DressUpFeature>(d1, id).flip).toBe(true);

    const d2 = updateDressUp(d1, id, { op: "chamfer", targetId: "body", edges: ["e1"], size: "2", angle: "60" });
    expect(feat<DressUpFeature>(d2, id).angle).toBe("60");
    // `flip` isn't carried by the new spec, so it clears with it.
    expect(feat<DressUpFeature>(d2, id).flip).toBeUndefined();

    const d3 = updateDressUp(d2, id, { op: "fillet", targetId: "body", edges: ["e1"], size: "2", angle: "60" });
    expect(feat<DressUpFeature>(d3, id).angle).toBeUndefined();
  });

  it("a fillet never stores an angle, even if one is passed", () => {
    const { doc, id } = addDressUp(createDocument(), "fillet", "body", ["e1"], "2", undefined, "30", true);
    expect(feat<DressUpFeature>(doc, id).angle).toBeUndefined();
    expect(feat<DressUpFeature>(doc, id).flip).toBeUndefined();
  });

  it("updateShell changes thickness + faces, keeps id/name", () => {
    const { doc: d1, id } = addShell(createDocument(), "body", ["+z"], "2");
    const before = feat<ShellFeature>(d1, id);
    const doc = updateShell(d1, id, { targetId: "body", faces: ["+z", "+x"], thickness: "4" });
    const after = feat<ShellFeature>(doc, id);
    expect(after.id).toBe(id);
    expect(after.name).toBe(before.name);
    expect(after.thickness).toBe("4");
    expect(after.faces).toEqual(["+z", "+x"]);
  });

  it("addShell allows zero faces (a fully sealed hollow shell)", () => {
    const { doc, id } = addShell(createDocument(), "body", [], "3");
    const s = feat<ShellFeature>(doc, id);
    expect(s.faces).toEqual([]);
    expect(s.thickness).toBe("3");
    expect(s.targetId).toBe("body");
  });

  it("updatePattern changes count/spacing", () => {
    const { doc: d1, id } = addPattern(createDocument(), "body", { kind: "linear", dir1: { world: "x" }, count1: "3", spacing1: "25", flip1: false });
    const doc = updatePattern(d1, id, "body", { kind: "linear", dir1: { world: "y" }, count1: "6", spacing1: "10", flip1: true });
    const p = feat<PatternFeature>(doc, id);
    expect(p.count1).toBe("6");
    expect(p.spacing1).toBe("10");
    expect(p.dir1).toEqual({ world: "y" });
  });
});
