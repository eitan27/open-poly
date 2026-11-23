import { describe, expect, it } from "vitest";
import { addGear, createDocument, evaluateVariables, migrateDocument, resolveDocument } from "./document";
import { bakeGear, DEFAULT_GEAR_SETTINGS, type GearSettings } from "./gear";
import type { SketchPlaneRef } from "./planes";
import type { Document, GearFeature } from "./types";

const TOP: SketchPlaneRef = { kind: "datum", id: "plane-top" };
const FRONT: SketchPlaneRef = { kind: "datum", id: "plane-front" };
const settings = (over: Partial<GearSettings> = {}, params: Partial<GearSettings["params"]> = {}): GearSettings => ({
  ...DEFAULT_GEAR_SETTINGS,
  ...over,
  params: { ...DEFAULT_GEAR_SETTINGS.params, ...params },
});
const gearOf = (doc: Document, id: string) => doc.features.find((f) => f.id === id) as GearFeature;
const frame = (doc: Document, id: string) =>
  bakeGear(doc, gearOf(doc, id), evaluateVariables(doc.variables).scope, resolveDocument(doc).planeFrames).frame;
/** A stored gear as an older build saved it: with `extent`, no normalOffset. */
const legacy = (doc: Document, id: string, extent: "blind" | "symmetric", flip = false): Document => {
  const g = gearOf(doc, id);
  const { normalOffset: _n, ...params } = g.params;
  return { ...doc, features: doc.features.map((f) => (f.id === id ? { ...g, flip, extent, params } : f)) as never };
};

describe("a gear's normal offset", () => {
  it("moves it along its plane's normal — the way it extrudes — on any plane", () => {
    for (const plane of [TOP, FRONT]) {
      const { doc, id } = addGear(createDocument(), plane, settings({}, { normalOffset: "-4" }));
      const f = frame(doc, id);
      const n = f.normal;
      f.origin.forEach((c, i) => expect(c).toBeCloseTo(-4 * n[i], 9));
      expect(resolveDocument(doc).errors[id]).toBeUndefined();
    }
  });

  it("is 0 by default, and the extrude is one-sided", () => {
    const { doc, id } = addGear(createDocument(), TOP, settings());
    expect(frame(doc, id).origin).toEqual([0, 0, 0]);
    const r = resolveDocument(doc).features.find((f) => f.id === id);
    expect(r && r.type === "extrude" && r.extent).toBe("blind");
  });

  it("centres an old symmetric gear, before and after migrating it", () => {
    const { doc, id } = addGear(createDocument(), TOP, settings({}, { thickness: "8" }));
    for (const [flip, want] of [
      [false, -4],
      [true, 4],
    ] as const) {
      const old = legacy(doc, id, "symmetric", flip);
      expect(frame(old, id).origin[2]).toBeCloseTo(want, 9); // not yet migrated
      const migrated = migrateDocument(old);
      const g = gearOf(migrated, id);
      expect("extent" in g).toBe(false);
      expect(g.params.normalOffset).toBe(String(want));
      expect(frame(migrated, id).origin[2]).toBeCloseTo(want, 9);
    }
    // An old one-sided gear just loses the field.
    const blind = gearOf(migrateDocument(legacy(doc, id, "blind")), id);
    expect("extent" in blind).toBe(false);
    expect(blind.params.normalOffset).toBeUndefined();
  });

  it("keeps following an expression thickness when migrated", () => {
    let doc = createDocument();
    doc = { ...doc, variables: [{ id: "v", name: "t", expression: "10" }] } as Document;
    const { doc: withGear, id } = addGear(doc, TOP, settings({}, { thickness: "t" }));
    const migrated = migrateDocument(legacy(withGear, id, "symmetric"));
    expect(gearOf(migrated, id).params.normalOffset).toBe("-(t)/2");
    expect(frame(migrated, id).origin[2]).toBeCloseTo(-5, 9);
  });
});
