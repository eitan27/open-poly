import { describe, it, expect } from "vitest";
import { addHole, addScrew, createDocument, resolveDocument, updateParam, updateScrew } from "./document";
import { DEFAULT_HOLE_SETTINGS, type HoleSettings } from "./hole";
import { DEFAULT_SCREW_SETTINGS, screwDims, screwProfile, screwSize, type ScrewSettings } from "./screw";
import type { Document, ScrewFeature, SketchFeature } from "./types";

const TOP = { kind: "datum", id: "plane-top" } as const;
const screw = (patch: Partial<ScrewSettings> = {}, params: Partial<ScrewSettings["params"]> = {}): ScrewSettings => ({
  ...DEFAULT_SCREW_SETTINGS,
  ...patch,
  params: { ...DEFAULT_SCREW_SETTINGS.params, ...params },
});
const hole = (patch: Partial<HoleSettings> = {}): HoleSettings => ({
  ...DEFAULT_HOLE_SETTINGS,
  ...patch,
  params: { ...DEFAULT_HOLE_SETTINGS.params },
});

const withPoints = (): Document => {
  const base = createDocument();
  const sketch: SketchFeature = {
    id: "s",
    type: "sketch",
    name: "Sketch",
    suppressed: false,
    plane: TOP,
    entities: [
      { type: "point", id: "a", p: [0, 0] },
      { type: "point", id: "b", p: [20, 0] },
    ],
    constraints: [],
  };
  return { ...base, features: [...base.features, sketch] };
};

describe("screwDims", () => {
  it("takes head dimensions from the ISO tables", () => {
    expect(screwDims("socket", "M3", 10)).toMatchObject({ d: 3, headDiameter: 5.5, headHeight: 3, key: 2.5 });
    expect(screwDims("hex", "M6", 20)).toMatchObject({ headDiameter: 10, headHeight: 4, key: 0 });
    const flat = screwDims("flat", "M4", 10);
    expect(flat.headHeight).toBe(0);
    expect(flat.coneDepth).toBeCloseTo((flat.headDiameter - 4) / 2);
  });

  it("rejects silly lengths and unknown sizes", () => {
    expect(() => screwDims("socket", "M3", 0)).toThrow(/length/);
    expect(() => screwDims("flat", "M10", 3)).toThrow(/longer than its head/);
    expect(() => screwDims("socket", "M7", 10)).toThrow(/unknown size/);
  });

  it("profiles from the head top on the axis to the tip on the axis", () => {
    for (const head of ["socket", "button", "flat", "hex"] as const) {
      const d = screwDims(head, "M5", 16);
      const p = screwProfile(d);
      expect(p[0][0]).toBe(0);
      expect(p.at(-1)).toEqual([0, 16]);
      // Never wider than the head, never past the length.
      for (const [r, z] of p) {
        expect(r).toBeLessThanOrEqual(d.headDiameter / 2 + 1e-9);
        expect(z).toBeLessThanOrEqual(16 + 1e-9);
      }
    }
  });
});

describe("resolve", () => {
  it("puts one screw at every hole, the hole's size, seated on a counterbore floor", () => {
    const h = addHole(withPoints(), "s", "body", hole({ holeType: "counterbore", size: "M5" }));
    const { doc, id } = addScrew(h.doc, TOP, screw({ size: "M3", holeId: h.id }));
    const f = doc.features.find((x) => x.id === id) as ScrewFeature;
    expect(screwSize(doc, f)).toBe("M5");
    const rf = resolveDocument(doc).features.find((x) => x.id === id);
    expect(rf).toMatchObject({
      type: "screw",
      centers: [
        [0, 0],
        [20, 0],
      ],
    });
    // M5 counterbore depth (DIN 974-1) is 5.4: the head top is that far less the head height (5).
    const profile = (rf as { profile: [number, number][] }).profile;
    expect(profile[0][1]).toBeCloseTo(5.4 - 5);
  });

  it("stands alone on a plane at its centre", () => {
    const { doc, id } = addScrew(createDocument(), TOP, screw({}, { centerX: "3", centerY: "-2" }));
    expect(resolveDocument(doc).features.find((x) => x.id === id)).toMatchObject({ centers: [[3, -2]] });
  });

  it("errors when its hole is gone, and can be moved back onto a plane", () => {
    const h = addHole(withPoints(), "s", "body", hole());
    const { doc, id } = addScrew(h.doc, TOP, screw({ holeId: h.id }));
    const gone: Document = { ...doc, features: doc.features.filter((x) => x.id !== h.id) };
    expect(resolveDocument(gone).errors[id]).toMatch(/hole no longer exists/);
    const moved = updateScrew(gone, id, TOP, screw());
    expect((moved.features.find((x) => x.id === id) as ScrewFeature).holeId).toBeUndefined();
    expect(resolveDocument(moved).errors[id]).toBeUndefined();
  });

  it("length is editable through updateParam", () => {
    const { doc, id } = addScrew(createDocument(), TOP, screw());
    expect((updateParam(doc, id, "length", "30").features.at(-1) as ScrewFeature).params.length).toBe("30");
  });
});

describe("modelled thread", () => {
  it("cosmetic is the default", () => {
    expect(DEFAULT_SCREW_SETTINGS.thread).toBe("cosmetic");
  });

  it("modelled: the profile stops at the head and a thread runs from the seat to the tip", () => {
    const { doc, id } = addScrew(createDocument(), TOP, screw({ size: "M5", thread: "modelled" }, { length: "16" }));
    const rf = resolveDocument(doc).features.find((x) => x.id === id) as {
      profile: [number, number][];
      thread?: { d: number; pitch: number; offset: number; z0: number; z1: number; tipChamfer: boolean };
    };
    expect(rf.thread).toMatchObject({ d: 5, pitch: 0.8, offset: -0.1, z1: 16, tipChamfer: true });
    // Starts at the seat, where it is stitched onto the head's underside.
    expect(rf.thread!.z0).toBe(0);
    expect(rf.profile.at(-1)).toEqual([0, 0]);
  });

  it("a countersunk head's thread starts at the bottom of its cone", () => {
    const { doc, id } = addScrew(createDocument(), TOP, screw({ head: "flat", size: "M4", thread: "modelled" }));
    const rf = resolveDocument(doc).features.find((x) => x.id === id) as { thread?: { z0: number } };
    const cone = screwDims("flat", "M4", 12).coneDepth;
    expect(rf.thread!.z0).toBe(cone);
  });

  it("a screw from before modelled threads (no `thread`) stays cosmetic", () => {
    const { doc, id } = addScrew(createDocument(), TOP, screw());
    const old: Document = {
      ...doc,
      features: doc.features.map((f) => (f.id === id ? { ...f, thread: undefined } : f)),
    };
    const rf = resolveDocument(old).features.find((x) => x.id === id) as { thread?: unknown; profile: number[][] };
    expect(rf.thread).toBeUndefined();
    expect(rf.profile.at(-1)).toEqual([0, 12]);
  });

  it("refuses a clearance that would eat the thread", () => {
    const { doc, id } = addScrew(
      createDocument(),
      TOP,
      screw({ size: "M3", thread: "modelled" }, { clearance: "0.2" }),
    );
    expect(resolveDocument(doc).errors[id]).toMatch(/clearance can be at most 0.125/);
  });
});
