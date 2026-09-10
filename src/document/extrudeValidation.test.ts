import { describe, it, expect } from "vitest";
import { validateExtrudeDistance, extrudeUsesDistance } from "./extrudeValidation";
import { addExtrude, addSketch, createDocument, resolveDocument } from "./document";
import type { ExtrudeFeature } from "./types";

const scope = { height: 20, zero: 0 };

describe("extrudeUsesDistance", () => {
  it("is true for the extents whose length comes from the field", () => {
    expect(extrudeUsesDistance("blind")).toBe(true);
    expect(extrudeUsesDistance("symmetric")).toBe(true);
    // Through All falls back to the literal distance with no target to size against.
    expect(extrudeUsesDistance("throughAll")).toBe(true);
  });

  it("is false for the extents that derive their own length", () => {
    expect(extrudeUsesDistance("upToFace")).toBe(false);
    expect(extrudeUsesDistance("upToNext")).toBe(false);
  });
});

describe("validateExtrudeDistance — sync scenarios", () => {
  it("empty field: no error, no value (button disabled, nothing sent to kernel)", () => {
    expect(validateExtrudeDistance("", "blind", scope)).toEqual({ error: null, value: null });
    expect(validateExtrudeDistance("   ", "blind", scope)).toEqual({ error: null, value: null });
  });

  it("valid positive number resolves to a value with no error", () => {
    expect(validateExtrudeDistance("10", "blind", scope)).toEqual({ error: null, value: 10 });
  });

  it("valid expression using a variable resolves", () => {
    expect(validateExtrudeDistance("height/2", "symmetric", scope)).toEqual({ error: null, value: 10 });
  });

  it("zero and negative are rejected", () => {
    expect(validateExtrudeDistance("0", "blind", scope)).toEqual({
      error: "Distance must be greater than 0.",
      value: null,
    });
    expect(validateExtrudeDistance("-5", "blind", scope)).toEqual({
      error: "Distance must be greater than 0.",
      value: null,
    });
    // Via a variable, not just a literal.
    expect(validateExtrudeDistance("zero", "throughAll", scope).error).toBe("Distance must be greater than 0.");
  });

  it("unknown identifier is reworded name -> variable, keeping the name", () => {
    const r = validateExtrudeDistance("asdf", "blind", scope);
    expect(r.value).toBeNull();
    expect(r.error).toBe('Unknown variable "asdf"');
  });

  it("an extent that ignores the field never complains about it", () => {
    expect(validateExtrudeDistance("0", "upToFace", scope)).toEqual({ error: null, value: null });
    expect(validateExtrudeDistance("garbage", "upToNext", scope)).toEqual({ error: null, value: null });
  });
});

// The dialog gates the field, but the agent (`add_extrude`) and a param edit
// write the expression straight into the document — so the resolve path is what
// guarantees a degenerate prism never reaches OCCT.
describe("resolveDocument rejects a degenerate extrude distance", () => {
  const withDistance = (distance: string, extent: ExtrudeFeature["extent"]) => {
    const { doc: d1, id: sk } = addSketch(createDocument(), { kind: "datum", id: "plane-front" });
    const { doc, id } = addExtrude(
      d1,
      { kind: "sketchRegion", sketchId: sk, regionId: "r1" },
      { distance, mode: "new", extent },
    );
    return { errors: resolveDocument(doc).errors, id };
  };

  it("flags zero and negative as a feature error instead of building", () => {
    for (const d of ["0", "-4"]) {
      const { errors, id } = withDistance(d, "blind");
      expect(errors[id]).toBe("extrude: distance must be greater than zero.");
    }
  });

  it("leaves a positive distance to fail (or not) on its own merits", () => {
    const { errors, id } = withDistance("10", "blind");
    expect(errors[id]).not.toBe("extrude: distance must be greater than zero.");
  });

  it("ignores the field for an extent that derives its own length", () => {
    const { errors, id } = withDistance("0", "upToNext");
    expect(errors[id]).not.toBe("extrude: distance must be greater than zero.");
  });
});
