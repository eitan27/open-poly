import { describe, it, expect } from "vitest";
import {
  matchFace,
  matchEdges,
  stripNameSuffixes,
  type FaceCandidate,
  type EdgeCandidate,
} from "./topoMatch";

describe("stripNameSuffixes", () => {
  it("removes #n collision suffixes anywhere in the name", () => {
    expect(stripNameSuffixes("a/side0#1∩a/start")).toBe("a/side0∩a/start");
    expect(stripNameSuffixes("a/+z#12")).toBe("a/+z");
    expect(stripNameSuffixes("a/+z")).toBe("a/+z");
  });
});

describe("matchFace", () => {
  // A 10×10×10 box's six faces (diagonal scale ≈ 17.3).
  const box: FaceCandidate[] = [
    { center: [5, 5, 10], normal: [0, 0, 1] },
    { center: [5, 5, 0], normal: [0, 0, -1] },
    { center: [10, 5, 5], normal: [1, 0, 0] },
    { center: [0, 5, 5], normal: [-1, 0, 0] },
    { center: [5, 10, 5], normal: [0, 1, 0] },
    { center: [5, 0, 5], normal: [0, 0, -1] }, // deliberately odd normal below
  ];
  const scale = Math.hypot(10, 10, 10);

  it("finds the same face after a modest move", () => {
    // The top face after the box grew 10 → 12 tall.
    const m = matchFace({ center: [5, 5, 12], normal: [0, 0, 1] }, box, scale);
    expect(m?.index).toBe(0);
  });

  it("uses the normal to break centroid ties", () => {
    // Equidistant from +x and top; normal picks +x.
    const m = matchFace({ center: [7.5, 5, 7.5], normal: [1, 0, 0] }, box, scale);
    expect(m?.index).toBe(2);
  });

  it("rejects when everything is too far (reference lost)", () => {
    const m = matchFace({ center: [500, 500, 500], normal: [0, 0, 1] }, box, scale);
    expect(m).toBeNull();
  });

  it("matches a legacy centre-only reference by distance", () => {
    const m = matchFace({ center: [5.2, 5.1, 9.9] }, box, scale);
    expect(m?.index).toBe(0);
  });
});

describe("matchEdges", () => {
  const scale = Math.hypot(10, 10, 10);
  const cands: EdgeCandidate[] = [
    { name: "a/+z∩a/side0", mid: [5, 0, 10], length: 10 },
    { name: "a/+z∩a/side1", mid: [10, 5, 10], length: 10 },
    { name: "a/+z∩a/side2#1", mid: [5, 10, 10], length: 10 },
    { mid: [0, 5, 10], length: 10 }, // unnamed (a face lost its name)
  ];

  it("prefers exact names", () => {
    const [m] = matchEdges([{ name: "a/+z∩a/side1" }], cands, scale);
    expect(m).toEqual({ kind: "name", index: 1 });
  });

  it("falls back to a unique base-name match when suffixes churned", () => {
    const [m] = matchEdges([{ name: "a/+z∩a/side2" }], cands, scale);
    expect(m).toEqual({ kind: "base", index: 2 });
  });

  it("matches geometrically when the name is gone entirely", () => {
    const [m] = matchEdges(
      [{ name: "a/+z∩a/side9", mid: [0, 5, 10.5], length: 10 }],
      cands,
      scale,
    );
    expect(m).toEqual({ kind: "geom", index: 3 });
  });

  it("reports lost when nothing is plausibly the same edge", () => {
    const [m] = matchEdges(
      [{ name: "a/+z∩a/side9", mid: [300, 300, 300], length: 10 }],
      cands,
      scale,
    );
    expect(m).toEqual({ kind: "lost" });
  });

  it("rejects a geometric match whose length changed too much", () => {
    const [m] = matchEdges(
      [{ name: "gone", mid: [0, 5, 10], length: 100 }],
      cands,
      scale,
    );
    expect(m).toEqual({ kind: "lost" });
  });

  it("is lost for a legacy ref with no fingerprint and no name hit", () => {
    const [m] = matchEdges([{ name: "nope" }], cands, scale);
    expect(m).toEqual({ kind: "lost" });
  });

  it("assigns one-to-one, best pairing first", () => {
    const refs = [
      { name: "x", mid: [5, 0, 10] as [number, number, number], length: 10 },
      { name: "y", mid: [5, 1, 10] as [number, number, number], length: 10 },
    ];
    const ms = matchEdges(refs, cands, scale);
    // Both want candidate 0; the closer ref gets it, the other must go elsewhere
    // (candidate 3 is nearest of the rest at dist ~ sqrt(25+16+0) ≈ 6.4 / 17.3 ≈ 0.37 > reject)
    expect(ms[0]).toEqual({ kind: "geom", index: 0 });
    expect(ms[1]).toEqual({ kind: "lost" });
  });
});
