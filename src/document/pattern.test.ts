import { describe, it, expect } from "vitest";
import { resolveDocument } from "./document";
import type { Document, Feature, PatternFeature, PrimitiveFeature, SketchFeature } from "./types";

// Lowering a body PatternFeature: resolveDocument bakes every copy's rigid
// motion (world offsets for linear, rotation angles + a world axis line for
// circular) so the kernel just loops applyTrsf. Counts INCLUDE the seed, and
// the seed itself is never in the baked list.
const box: PrimitiveFeature = {
  id: "box",
  type: "primitive",
  kind: "box",
  name: "Box 1",
  suppressed: false,
  params: { width: "10", depth: "10", height: "10", x: "0", y: "0", z: "0" },
  color: 0,
  opacity: 1,
};

const mkDoc = (pattern: PatternFeature, extra: Feature[] = []): Document => ({
  features: [box, ...extra, pattern],
  variables: [],
  rollbackIndex: 2 + extra.length,
});

const base: Omit<PatternFeature, "kind"> = {
  id: "pat",
  type: "pattern",
  name: "Pattern 1",
  suppressed: false,
  targetId: "box",
  color: 0,
  opacity: 1,
};

const resolved = (doc: Document) => {
  const res = resolveDocument(doc);
  const rp = res.features.find((f) => f.id === "pat");
  if (rp && rp.type !== "pattern") throw new Error("expected a resolved pattern");
  return { res, rp };
};

describe("pattern lowering — linear", () => {
  it("bakes count−1 world offsets along a world axis", () => {
    const { res, rp } = resolved(mkDoc({ ...base, kind: "linear", dir1: { world: "x" }, count1: "4", spacing1: "25" }));
    expect(res.errors).toEqual({});
    expect(rp?.offsets).toEqual([[25, 0, 0], [50, 0, 0], [75, 0, 0]]);
  });

  it("flip negates the direction; expressions evaluate against variables", () => {
    const doc = mkDoc({ ...base, kind: "linear", dir1: { world: "y" }, count1: "n", spacing1: "pitch", flip1: true });
    doc.variables = [
      { id: "v1", name: "n", expression: "3" },
      { id: "v2", name: "pitch", expression: "7" },
    ];
    const { rp } = resolved(doc);
    expect(rp?.offsets).toEqual([[0, -7, 0], [0, -14, 0]]);
  });

  it("a second direction crosses into a grid (count1×count2 − seed offsets)", () => {
    const { rp } = resolved(mkDoc({
      ...base, kind: "linear",
      dir1: { world: "x" }, count1: "2", spacing1: "10",
      dir2: { world: "y" }, count2: "2", spacing2: "20",
    }));
    expect(rp?.offsets).toEqual([[10, 0, 0], [0, 20, 0], [10, 20, 0]]);
  });

  it("a sketch line bakes to its world direction", () => {
    // A 45° line on the top plane (world XY) → normalized (√2/2, √2/2, 0).
    const sketch: SketchFeature = {
      id: "sk", type: "sketch", name: "Sketch 1", suppressed: false,
      plane: { kind: "datum", id: "plane-top" },
      entities: [{ type: "line", id: "L", a: [0, 0], b: [10, 10] }],
      constraints: [],
    };
    const { rp } = resolved(mkDoc(
      { ...base, kind: "linear", dir1: { sketchId: "sk", entityId: "L" }, count1: "2", spacing1: "10" },
      [sketch],
    ));
    expect(rp?.offsets).toHaveLength(1);
    const o = rp!.offsets![0];
    expect(o[0]).toBeCloseTo(10 * Math.SQRT1_2, 6);
    expect(o[1]).toBeCloseTo(10 * Math.SQRT1_2, 6);
    expect(o[2]).toBeCloseTo(0, 6);
  });

  it("errors on count < 2 / zero spacing / missing direction", () => {
    expect(resolved(mkDoc({ ...base, kind: "linear", dir1: { world: "x" }, count1: "1", spacing1: "5" })).res.errors["pat"]).toMatch(/count/);
    expect(resolved(mkDoc({ ...base, kind: "linear", dir1: { world: "x" }, count1: "3", spacing1: "0" })).res.errors["pat"]).toMatch(/spacing/);
    expect(resolved(mkDoc({ ...base, kind: "linear", count1: "3", spacing1: "5" })).res.errors["pat"]).toMatch(/direction/);
  });
});

describe("pattern lowering — circular", () => {
  it("full circle bakes equal 360/count steps with no wrap duplicate", () => {
    const { res, rp } = resolved(mkDoc({ ...base, kind: "circular", axis: { world: "z" }, count: "4", angle: "360" }));
    expect(res.errors).toEqual({});
    expect(rp?.axisOrigin).toEqual([0, 0, 0]);
    expect(rp?.axisDir).toEqual([0, 0, 1]);
    expect(rp?.angles).toHaveLength(3);
    expect(rp!.angles![0]).toBeCloseTo(Math.PI / 2, 9);
    expect(rp!.angles![2]).toBeCloseTo((3 * Math.PI) / 2, 9);
  });

  it("angle mode spreads endpoints-inclusive; symmetric recenters on the seed", () => {
    const { rp } = resolved(mkDoc({ ...base, kind: "circular", axis: { world: "z" }, count: "3", angle: "90" }));
    expect(rp!.angles!.map((a) => (a * 180) / Math.PI)).toEqual([45, 90]);
    const { rp: rps } = resolved(mkDoc({ ...base, kind: "circular", axis: { world: "z" }, count: "3", angle: "90", symmetric: true }));
    expect(rps!.angles!.map((a) => Math.round((a * 180) / Math.PI))).toEqual([-45, 45]);
  });

  it("a sketch-line axis bakes to a world line", () => {
    const sketch: SketchFeature = {
      id: "sk", type: "sketch", name: "Sketch 1", suppressed: false,
      plane: { kind: "datum", id: "plane-top" },
      entities: [{ type: "line", id: "L", a: [5, 0], b: [5, 10] }],
      constraints: [],
    };
    const { rp } = resolved(mkDoc(
      { ...base, kind: "circular", axis: { sketchId: "sk", entityId: "L" }, count: "2", angle: "180" },
      [sketch],
    ));
    expect(rp?.axisOrigin?.[0]).toBeCloseTo(5, 6);
    expect(rp?.axisDir?.[2]).toBeCloseTo(0, 6);
  });

  it("a face axis is carried through for the worker to resolve", () => {
    const { rp } = resolved(mkDoc({
      ...base, kind: "circular", count: "3", angle: "360",
      axis: { face: { featureId: "box", faceId: 1, center: [1, 2, 3] } },
    }));
    expect(rp?.axisFace).toEqual({ sourceId: "box", faceName: undefined, center: [1, 2, 3], normal: undefined });
    expect(rp?.angles).toHaveLength(2);
  });

  it("errors on a missing axis / zero angle", () => {
    expect(resolved(mkDoc({ ...base, kind: "circular", count: "3", angle: "360" })).res.errors["pat"]).toMatch(/axis/);
    expect(resolved(mkDoc({ ...base, kind: "circular", axis: { world: "z" }, count: "3", angle: "0" })).res.errors["pat"]).toMatch(/angle/);
  });
});
