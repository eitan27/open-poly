import { afterEach, describe, expect, it } from "vitest";
import {
  colorToHex,
  hexToColor,
  newBodyColor,
  setNewBodyColorPreference,
  siblingBodyColor,
  SOLID_COLORS,
} from "./colors";
import { addPlane, makeFeature, migrateDocument } from "./document";
import type { Document, PlaneFeature, TransformFeature } from "./types";

// Module-level preference — every test has to hand it back.
afterEach(() => setNewBodyColorPreference(null));

describe("hex conversion", () => {
  it("round-trips every palette colour", () => {
    for (const c of SOLID_COLORS) expect(hexToColor(colorToHex(c))).toBe(c);
  });

  it("pads short channels rather than dropping them", () => {
    expect(colorToHex(0x0066ff)).toBe("#0066ff");
    expect(colorToHex(0)).toBe("#000000");
  });

  it("rejects anything that isn't #rrggbb", () => {
    for (const bad of ["66b5d6", "#66b5d", "#66b5d6f", "#GGGGGG", "", "#"]) {
      expect(hexToColor(bad)).toBeNull();
    }
  });
});

describe("newBodyColor", () => {
  it("draws from the palette when no colour is pinned", () => {
    for (let i = 0; i < 50; i++) expect(SOLID_COLORS).toContain(newBodyColor());
  });

  it("returns the pinned colour every time once one is set", () => {
    setNewBodyColorPreference(0x123456);
    expect([newBodyColor(), newBodyColor(), newBodyColor()]).toEqual([0x123456, 0x123456, 0x123456]);
  });

  it("goes back to random when the pin is cleared", () => {
    setNewBodyColorPreference(0x123456);
    setNewBodyColorPreference(null);
    for (let i = 0; i < 20; i++) expect(SOLID_COLORS).toContain(newBodyColor());
  });
});

describe("which colours the preference reaches", () => {
  it("colours a newly created primitive", () => {
    setNewBodyColorPreference(0x123456);
    const f = makeFeature("box", []);
    expect(f.type === "primitive" && f.color).toBe(0x123456);
  });

  it("does NOT colour a reference plane — planes need to stay distinguishable", () => {
    setNewBodyColorPreference(0x123456);
    const doc: Document = { features: [], rollbackIndex: 0, variables: [] };
    const plane = addPlane(doc, { method: "offset", base: { kind: "datum", id: "plane-top" } }).doc.features.at(
      -1,
    ) as PlaneFeature;
    expect(plane.color).not.toBe(0x123456);
    expect(SOLID_COLORS).toContain(plane.color);
  });

  it("does NOT repaint an old document's features on migration", () => {
    setNewBodyColorPreference(0x123456);
    // A pre-colour transform, as an old persisted document would hold it.
    const legacy = {
      features: [
        {
          id: "t1",
          type: "transform",
          name: "Move 1",
          suppressed: false,
          targetId: "b1",
          tx: "0",
          ty: "0",
          tz: "0",
          angle: "0",
          axis: "z",
          pivot: [0, 0, 0],
        },
      ],
      rollbackIndex: 1,
      variables: [],
    } as unknown as Document;
    const migrated = migrateDocument(legacy).features[0] as TransformFeature;
    expect(migrated.color).not.toBe(0x123456);
    expect(SOLID_COLORS).toContain(migrated.color);
  });
});

describe("siblingBodyColor", () => {
  it("leaves a feature's first part on the feature's own colour", () => {
    expect(siblingBodyColor(SOLID_COLORS[3], 0)).toBe(SOLID_COLORS[3]);
  });

  it("steps siblings on through the palette, so they're told apart at a glance", () => {
    expect(siblingBodyColor(SOLID_COLORS[3], 1)).toBe(SOLID_COLORS[4]);
    expect(siblingBodyColor(SOLID_COLORS[3], 2)).toBe(SOLID_COLORS[5]);
  });

  it("wraps round the palette", () => {
    expect(siblingBodyColor(SOLID_COLORS[SOLID_COLORS.length - 1], 1)).toBe(SOLID_COLORS[0]);
  });

  it("still gives a distinct series for a hand-picked colour outside the palette", () => {
    expect(siblingBodyColor(0x123456, 1)).toBe(SOLID_COLORS[1]);
    expect(siblingBodyColor(0x123456, 2)).toBe(SOLID_COLORS[2]);
  });

  it("honours a fixed new-body-colour preference — that means every body, siblings included", () => {
    setNewBodyColorPreference(0xabcdef);
    expect(siblingBodyColor(0xabcdef, 2)).toBe(0xabcdef);
    setNewBodyColorPreference(null);
  });
});
