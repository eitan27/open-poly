import { describe, expect, it } from "vitest";
import opentype from "opentype.js";
import { textToContours } from "./text";
import { detectSketchRegions } from "./regions";
import type { SketchEntity } from "./types";

// The bundled sketch font (loaded straight off disk for the test).
const font = opentype.loadSync("public/fonts/Inter-Regular.ttf");

describe("textToContours", () => {
  it("returns at least one closed contour for a simple string", () => {
    const cs = textToContours("Hi", 10, font);
    expect(cs.length).toBeGreaterThanOrEqual(1);
    for (const c of cs) expect(c.length).toBeGreaterThanOrEqual(3);
  });

  it("returns multiple contours for a glyph with a counter (e.g. 'o' has a hole)", () => {
    // 'o' = outer outline + inner counter ⇒ ≥2 sub-paths.
    expect(textToContours("o", 20, font).length).toBeGreaterThanOrEqual(2);
  });

  it("is empty for an empty string", () => {
    expect(textToContours("", 10, font)).toEqual([]);
  });

  it("grows upward from the baseline anchor (y-up) and respects the anchor", () => {
    const cs = textToContours("I", 10, font, { anchor: [5, 3] });
    const ys = cs.flat().map((p) => p[1]);
    const xs = cs.flat().map((p) => p[0]);
    // Glyph sits above the baseline anchor (y >= anchor.y) and to its right.
    expect(Math.min(...ys)).toBeGreaterThanOrEqual(3 - 1e-6);
    expect(Math.min(...xs)).toBeGreaterThanOrEqual(5 - 1e-6);
  });
});

describe("text entity is inert for regions", () => {
  it("a text entity contributes no profile region", () => {
    const text: SketchEntity = { type: "text", id: "t1", p: [0, 0], value: "AB", height: 10 };
    expect(detectSketchRegions([text])).toEqual([]);
    // Adding text alongside a real square doesn't change its single region.
    const sq: SketchEntity[] = [
      { type: "line", id: "a", a: [0, 0], b: [4, 0] },
      { type: "line", id: "b", a: [4, 0], b: [4, 4] },
      { type: "line", id: "c", a: [4, 4], b: [0, 4] },
      { type: "line", id: "d", a: [0, 4], b: [0, 0] },
    ];
    expect(detectSketchRegions([...sq, text]).length).toBe(detectSketchRegions(sq).length);
  });
});
