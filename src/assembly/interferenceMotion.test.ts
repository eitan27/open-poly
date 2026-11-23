import { describe, expect, it } from "vitest";
import { clashRanges, motionSamples, movingInstances } from "./interference";
import { IDENTITY, translation } from "./placement";

describe("clashRanges", () => {
  it("groups consecutive clashing values per pair, keeping the worst", () => {
    const c = (a: string, b: string, volume: number) => ({ a, b, volume });
    const r = clashRanges([
      { value: 0, clashes: [] },
      { value: 10, clashes: [c("P", "R", 1)] },
      { value: 20, clashes: [c("R", "P", 3), c("P", "Q", 0.5)] },
      { value: 30, clashes: [c("P", "R", 2)] },
      { value: 40, clashes: [] },
      { value: 50, clashes: [c("P", "R", 0.1)] },
    ]);
    expect(r).toEqual([
      { a: "P", b: "R", from: 10, to: 30, worst: { value: 20, volume: 3 } },
      { a: "P", b: "Q", from: 20, to: 20, worst: { value: 20, volume: 0.5 } },
      { a: "P", b: "R", from: 50, to: 50, worst: { value: 50, volume: 0.1 } },
    ]);
  });
});

describe("motionSamples", () => {
  it("about every 2° or 0.5 mm, ends included, 24–240 steps", () => {
    const r = motionSamples(-90, 90, true);
    expect(r.length).toBe(91);
    expect(r[0]).toBe(-90);
    expect(r.at(-1)).toBe(90);
    expect(motionSamples(0, 5, false).length).toBe(25);
    expect(motionSamples(0, 3600, true).length).toBe(241);
  });
});

describe("movingInstances", () => {
  it("is the instances placed differently in some frame", () => {
    const f = (x: number) => ({
      value: x,
      placements: new Map([
        ["still", IDENTITY],
        ["moves", translation([x, 0, 0])],
      ]),
    });
    expect([...movingInstances([f(0), f(0), f(2)])]).toEqual(["moves"]);
  });
});
