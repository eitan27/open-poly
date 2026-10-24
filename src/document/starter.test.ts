import { describe, expect, it } from "vitest";
import { addFeature, createDocument, isStarterDocument, seedDocument } from "./document";
import type { Document } from "./types";

describe("isStarterDocument", () => {
  it("is true for an empty document and for the seed box, whatever its id and colour", () => {
    expect(isStarterDocument(createDocument())).toBe(true);
    expect(isStarterDocument(seedDocument())).toBe(true);
    const roundTripped = JSON.parse(JSON.stringify(seedDocument()));
    expect(isStarterDocument(roundTripped)).toBe(true);
  });

  it("is false once anything is added, changed or defined", () => {
    const seed = seedDocument();
    expect(isStarterDocument(addFeature(seed, "sphere").doc)).toBe(false);
    expect(isStarterDocument(addFeature(createDocument(), "sphere").doc)).toBe(false);
    const box = seed.features[0] as Extract<Document["features"][number], { type: "primitive" }>;
    const wider = { ...seed, features: [{ ...box, params: { ...box.params, width: "41" } }] };
    expect(isStarterDocument(wider)).toBe(false);
    expect(isStarterDocument({ ...seed, features: [{ ...box, name: "Lid" }] })).toBe(false);
    expect(isStarterDocument({ ...seed, rollbackIndex: 0 })).toBe(false);
    expect(isStarterDocument({ ...createDocument(), variables: [{ id: "v", name: "w", expression: "1" }] })).toBe(
      false,
    );
  });
});
