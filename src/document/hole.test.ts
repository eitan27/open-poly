import { describe, it, expect } from "vitest";
import { addHole, createDocument, resolveDocument, updateParam } from "./document";
import {
  DEFAULT_HOLE_SETTINGS,
  countersinkDepth,
  holeCenters,
  holeDims,
  holeProfile,
  tipDepth,
  type HoleSettings,
} from "./hole";
import type { Document, HoleFeature, SketchFeature } from "./types";

const settings = (patch: Partial<HoleSettings> = {}, params: Partial<HoleSettings["params"]> = {}): HoleSettings => ({
  ...DEFAULT_HOLE_SETTINGS,
  ...patch,
  params: { ...DEFAULT_HOLE_SETTINGS.params, ...params },
});

describe("holeDims", () => {
  it("takes a metric clearance hole from the ISO 273 table by fit", () => {
    expect(holeDims(settings({ size: "M3", fit: "close" }), {}).diameter).toBe(3.2);
    expect(holeDims(settings({ size: "M3", fit: "normal" }), {}).diameter).toBe(3.4);
    expect(holeDims(settings({ size: "M3", fit: "loose" }), {}).diameter).toBe(3.6);
  });

  it("drills the tap drill for a tapped hole, and reports the thread", () => {
    const d = holeDims(
      settings({ holeType: "tapped", size: "M6", extent: "blind" }, { depth: "12", threadDepth: "10" }),
      {},
    );
    expect(d).toMatchObject({ diameter: 5, threadDiameter: 6, pitch: 1, threadDepth: 10 });
  });

  it("ignores a metric hole's typed diameters, and reads a custom hole's (with variables)", () => {
    expect(holeDims(settings({ size: "M4" }, { diameter: "99" }), {}).diameter).toBe(4.5);
    expect(holeDims(settings({ size: "custom" }, { diameter: "d + 1" }), { d: 4 }).diameter).toBe(5);
  });

  it("drops the drill point on a through hole", () => {
    expect(holeDims(settings({ extent: "throughAll" }, { tipAngle: "118" }), {}).tipAngle).toBe(0);
  });

  it("refuses shapes that aren't a hole", () => {
    const bad: [Partial<HoleSettings>, Partial<HoleSettings["params"]>, RegExp][] = [
      [{ size: "custom" }, { diameter: "0" }, /diameter/],
      [{ extent: "blind" }, { depth: "0" }, /depth/],
      [{ holeType: "counterbore", size: "custom" }, { diameter: "8", counterboreDiameter: "6" }, /wider/],
      [{ holeType: "counterbore", extent: "blind", size: "M3" }, { depth: "2" }, /shallower/],
      [{ holeType: "tapped", extent: "blind" }, { depth: "5", threadDepth: "6" }, /deeper/],
      [{ extent: "blind" }, { tipAngle: "180" }, /tip angle/],
    ];
    for (const [patch, params, msg] of bad) expect(() => holeDims(settings(patch, params), {})).toThrow(msg);
  });
});

describe("holeProfile", () => {
  it("a blind simple hole: wall, then a drill point on the axis", () => {
    const d = holeDims(
      settings({ size: "custom", extent: "blind" }, { diameter: "6", depth: "10", tipAngle: "90" }),
      {},
    );
    expect(tipDepth(d)).toBeCloseTo(3);
    expect(holeProfile(d)).toEqual([
      [3, 0],
      [3, 10],
      [0, 13],
    ]);
  });

  it("a flat-bottomed blind hole ends square on the axis", () => {
    const d = holeDims(
      settings({ size: "custom", extent: "blind" }, { diameter: "6", depth: "10", tipAngle: "0" }),
      {},
    );
    expect(holeProfile(d).at(-1)).toEqual([0, 10]);
  });

  it("a counterbore steps in at its depth", () => {
    const d = holeDims(
      settings({ holeType: "counterbore", size: "M3", extent: "blind" }, { depth: "10", tipAngle: "0" }),
      {},
    );
    expect(holeProfile(d)).toEqual([
      [3, 0],
      [3, 3.4],
      [1.7, 3.4],
      [1.7, 10],
      [0, 10],
    ]);
  });

  it("a 90° countersink runs in at 45° to the bore", () => {
    const d = holeDims(
      settings(
        { holeType: "countersink", size: "custom", extent: "blind" },
        { diameter: "4", countersinkDiameter: "8", countersinkAngle: "90", depth: "10", tipAngle: "0" },
      ),
      {},
    );
    expect(countersinkDepth(d)).toBeCloseTo(2);
    expect(holeProfile(d)[1][1]).toBeCloseTo(2);
  });

  it("through all: the bore never ends above the head feature, so depth stays monotonic", () => {
    const d = holeDims(settings({ holeType: "counterbore", size: "M6", extent: "throughAll" }), {});
    const prof = holeProfile(d, 0);
    for (let i = 1; i < prof.length; i++) expect(prof[i][1]).toBeGreaterThanOrEqual(prof[i - 1][1]);
    expect(prof.at(-1)).toEqual([0, 6.4]);
  });
});

describe("holeCenters + resolve", () => {
  const sketch = (entities: SketchFeature["entities"]): SketchFeature => ({
    id: "s",
    type: "sketch",
    name: "Sketch",
    suppressed: false,
    plane: { kind: "datum", id: "plane-top" },
    entities,
    constraints: [],
  });

  it("uses points and circle centres, once each", () => {
    const s = sketch([
      { type: "point", id: "a", p: [1, 2] },
      { type: "circle", id: "b", c: [5, 5], r: 1 },
      { type: "point", id: "c", p: [5, 5] },
      { type: "line", id: "d", a: [0, 0], b: [9, 9] },
    ]);
    expect(holeCenters(s)).toEqual([
      [1, 2],
      [5, 5],
    ]);
  });

  it("resolves to a hole on the sketch's plane, and errors usefully", () => {
    const base: Document = { ...createDocument() };
    const withSketch: Document = {
      ...base,
      features: [...base.features, sketch([{ type: "point", id: "a", p: [1, 2] }])],
    };
    const { doc, id } = addHole(withSketch, "s", "body", settings());
    const rf = resolveDocument(doc).features.find((f) => f.id === id);
    expect(rf).toMatchObject({ type: "hole", targetId: "body", centers: [[1, 2]], throughAll: true });
    const noTarget = addHole(withSketch, "s", undefined, settings());
    expect(resolveDocument(noTarget.doc).errors[noTarget.id]).toMatch(/body/);
    const empty: Document = { ...base, features: [...base.features, sketch([])] };
    const e = addHole(empty, "s", "body", settings());
    expect(resolveDocument(e.doc).errors[e.id]).toMatch(/no points/);
  });

  it("params are editable through updateParam", () => {
    const { doc, id } = addHole(createDocument(), "s", "b", settings());
    expect((updateParam(doc, id, "depth", "7").features.at(-1) as HoleFeature).params.depth).toBe("7");
  });
});
