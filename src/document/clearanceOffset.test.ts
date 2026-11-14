import { describe, it, expect } from "vitest";
import {
  addBoolean,
  addExtrude,
  createDocument,
  resolveDocument,
  updateBoolean,
  updateExtrude,
  updateParam,
} from "./document";
import type { BooleanFeature, Document, ExtrudeFeature } from "./types";

const resolved = (doc: Document, id: string) => resolveDocument(doc).features.find((f) => f.id === id)!;

describe("boolean clearance offset + keep tools", () => {
  it("resolves offset and keepTools on a subtract", () => {
    const { doc, id } = addBoolean(createDocument(), "subtract", ["a", "b"], { offset: "k/2", keepTools: true });
    const withVar: Document = { ...doc, variables: [{ id: "v", name: "k", expression: "0.4" }] };
    expect(resolved(withVar, id)).toMatchObject({ offset: 0.2, keepTools: true });
  });

  it("leaves both off a union/intersect and off an unset subtract (content key unchanged)", () => {
    const u = addBoolean(createDocument(), "union", ["a", "b"], { offset: "1", keepTools: true });
    expect(resolved(u.doc, u.id)).toEqual({ id: u.id, type: "boolean", op: "union", operands: ["a", "b"] });
    const s = addBoolean(createDocument(), "subtract", ["a", "b"], { offset: " ", keepTools: false });
    expect(resolved(s.doc, s.id)).toEqual({ id: s.id, type: "boolean", op: "subtract", operands: ["a", "b"] });
    expect(s.doc.features[0]).not.toHaveProperty("offset");
  });

  it("a zero offset resolves to none", () => {
    const { doc, id } = addBoolean(createDocument(), "subtract", ["a", "b"], { offset: "0" });
    expect(resolved(doc, id)).not.toHaveProperty("offset");
  });

  it("updateBoolean replaces the options; without opts it keeps them", () => {
    const { doc, id } = addBoolean(createDocument(), "subtract", ["a", "b"], { offset: "1", keepTools: true });
    const kept = updateBoolean(doc, id, "subtract", ["a", "c"]).features[0] as BooleanFeature;
    expect(kept).toMatchObject({ offset: "1", keepTools: true, operands: ["a", "c"] });
    const cleared = updateBoolean(doc, id, "subtract", ["a", "b"], { offset: "", keepTools: false })
      .features[0] as BooleanFeature;
    expect(cleared).not.toHaveProperty("offset");
    expect(cleared).not.toHaveProperty("keepTools");
  });

  it("is editable through updateParam", () => {
    const { doc, id } = addBoolean(createDocument(), "subtract", ["a", "b"]);
    const next = updateParam(updateParam(doc, id, "offset", "0.3"), id, "keepTools", "true");
    expect(next.features[0]).toMatchObject({ offset: "0.3", keepTools: true });
  });

  it("reports a bad offset expression as the feature's error", () => {
    const { doc, id } = addBoolean(createDocument(), "subtract", ["a", "b"], { offset: "nope" });
    expect(resolveDocument(doc).errors[id]).toBeTruthy();
  });
});

describe("extrude Remove clearance offset", () => {
  const profile = { kind: "sketchRegion" as const, sketchId: "s", regionId: "r" };

  it("is stored trimmed, and only resolved on a remove", () => {
    const { doc, id } = addExtrude(createDocument(), profile, { mode: "remove", offset: " 0.2 " });
    expect((doc.features[0] as ExtrudeFeature).offset).toBe("0.2");
    // The sketch doesn't exist, so the resolver errors on the profile; check
    // the stored field and the mode switch through updateParam instead.
    const asNew = updateParam(doc, id, "mode", "new");
    expect((asNew.features[0] as ExtrudeFeature).offset).toBe("0.2");
  });

  it("updateExtrude: undefined keeps the offset, blank removes it", () => {
    const { doc, id } = addExtrude(createDocument(), profile, { mode: "remove", offset: "1" });
    expect((updateExtrude(doc, id, profile, { distance: "4" }).features[0] as ExtrudeFeature).offset).toBe("1");
    expect(updateExtrude(doc, id, profile, { offset: "" }).features[0]).not.toHaveProperty("offset");
  });
});
