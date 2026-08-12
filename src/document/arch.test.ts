import { describe, it, expect } from "vitest";
import { detectSketchRegions } from "./regions";
import { solveSketch } from "../sketch/solver";
import { arcFrom3 } from "./sketchTools";
import type { SketchEntity, Vec2 } from "./types";

// A closed loop whose arc + line both meet at the ORIGIN. After solving, an
// off-axis arc places its origin endpoint at ~0 but with a sub-epsilon negative
// sign; the vertex key must normalize "-0.0000" → "0.0000" so the loop still
// closes (regression for "not enclosed only at the origin").
function loop(start: Vec2, mid: Vec2, end: Vec2, lines: [Vec2, Vec2][]): SketchEntity[] {
  const a = arcFrom3(start, mid, end)!;
  return [
    { type: "arc", id: "a", c: a.center, r: a.r, start: a.start, end: a.end },
    ...lines.map(([p, q], i): SketchEntity => ({ type: "line", id: `l${i}`, a: p, b: q })),
  ];
}

describe("loop closing at the origin", () => {
  it("encloses with an on-axis arc through the origin", async () => {
    const ents = loop(
      [0, 0],
      [25, 25],
      [50, 0],
      [
        [
          [50, 0],
          [50, -30],
        ],
        [
          [50, -30],
          [0, -30],
        ],
        [
          [0, -30],
          [0, 0],
        ],
      ],
    );
    const res = await solveSketch(ents, []);
    expect(detectSketchRegions(res.entities).length).toBe(1);
  });

  it("encloses with an off-axis arc through the origin (negative-zero key)", async () => {
    const ents = loop(
      [0, 0],
      [8, 18],
      [28, 12],
      [
        [
          [28, 12],
          [28, -12],
        ],
        [
          [28, -12],
          [0, -12],
        ],
        [
          [0, -12],
          [0, 0],
        ],
      ],
    );
    const res = await solveSketch(ents, []);
    expect(detectSketchRegions(res.entities).length).toBe(1);
  });
});
