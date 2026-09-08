import { describe, expect, it } from "vitest";
import { featureIdOfPart, isSubPart, partAppearance, partIndex, setPartAppearance } from "./parts";
import type { Document, PrimitiveFeature } from "./types";

const box = (id: string, name: string): PrimitiveFeature => ({
  id,
  type: "primitive",
  kind: "box",
  name,
  suppressed: false,
  params: { width: "10", depth: "10", height: "10" },
  color: 0x112233,
  opacity: 1,
});

const doc: Document = { features: [box("ext", "Extrude 1")], variables: [], rollbackIndex: 1 };
const GREY = 0x999999;

describe("part ids", () => {
  it("reads the feature off a part id, suffixed or not", () => {
    expect(featureIdOfPart("ext")).toBe("ext");
    expect(featureIdOfPart("ext#2")).toBe("ext");
  });

  it("knows which parts are the feature's own first body", () => {
    expect(isSubPart("ext")).toBe(false);
    expect(isSubPart("ext#1")).toBe(true);
    expect(partIndex("ext")).toBe(0);
    expect(partIndex("ext#2")).toBe(2);
  });
});

describe("partAppearance", () => {
  it("gives a feature's first part the feature's own name and colour", () => {
    expect(partAppearance(doc, "ext", GREY)).toMatchObject({ name: "Extrude 1", color: 0x112233, owned: true });
  });

  it("names a sub-part after its feature, by ordinal", () => {
    expect(partAppearance(doc, "ext#1", GREY).name).toBe("Extrude 1 (2)");
    expect(partAppearance(doc, "ext#2", GREY).name).toBe("Extrude 1 (3)");
  });

  it("gives each sibling its own colour — three lumps painted alike read as one object", () => {
    const first = partAppearance(doc, "ext", GREY).color;
    const second = partAppearance(doc, "ext#1", GREY).color;
    const third = partAppearance(doc, "ext#2", GREY).color;
    expect(new Set([first, second, third]).size).toBe(3);
    expect(first).toBe(0x112233); // the feature's own colour is the first part's
  });

  it("picks the same sibling colours on every rebuild", () => {
    expect(partAppearance(doc, "ext#1", GREY).color).toBe(partAppearance(doc, "ext#1", GREY).color);
    expect(partAppearance(doc, "ext#2", GREY).color).not.toBe(partAppearance(doc, "ext#1", GREY).color);
  });

  it("lets a sub-part be painted, without touching its siblings", () => {
    const painted = setPartAppearance(doc, "ext#1", { color: 0xff0000 });
    expect(partAppearance(painted, "ext#1", GREY).color).toBe(0xff0000);
    expect(partAppearance(painted, "ext", GREY).color).toBe(0x112233);
    expect(partAppearance(painted, "ext#2", GREY).color).toBe(partAppearance(doc, "ext#2", GREY).color);
  });

  it("falls back to the default look for a body whose feature owns no appearance", () => {
    const bare: Document = { features: [], variables: [], rollbackIndex: 0 };
    expect(partAppearance(bare, "gone", GREY)).toMatchObject({ color: GREY, opacity: 1, owned: false });
  });
});

describe("setPartAppearance", () => {
  it("writes a first part onto the feature, leaving no parts map behind", () => {
    const next = setPartAppearance(doc, "ext", { color: 0x00ff00, name: "Bracket" });
    expect(next.parts).toBeUndefined();
    expect(next.features[0]).toMatchObject({ color: 0x00ff00, name: "Bracket" });
  });

  it("writes a sub-part into doc.parts, keyed by part id", () => {
    const next = setPartAppearance(doc, "ext#1", { name: "Left tab" });
    expect(next.parts).toEqual({ "ext#1": { name: "Left tab" } });
    expect(next.features[0].name).toBe("Extrude 1"); // the feature is untouched
  });

  it("merges successive writes to the same part", () => {
    const next = setPartAppearance(setPartAppearance(doc, "ext#1", { name: "Tab" }), "ext#1", { hidden: true });
    expect(next.parts?.["ext#1"]).toEqual({ name: "Tab", hidden: true });
  });

  it("drops an override that has nothing left to say, and the map with it", () => {
    const painted = setPartAppearance(doc, "ext#1", { color: 0xff0000 });
    const cleared = setPartAppearance(painted, "ext#1", { color: undefined });
    expect(cleared.parts).toBeUndefined();
  });

  it("leaves other parts' overrides alone", () => {
    const two = setPartAppearance(setPartAppearance(doc, "ext#1", { name: "A" }), "ext#2", { name: "B" });
    expect(Object.keys(two.parts ?? {})).toEqual(["ext#1", "ext#2"]);
  });
});
