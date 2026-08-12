import { describe, it, expect } from "vitest";
import { vertexRefsOf, pinConstraints } from "./snapPins";
import type { SketchEntity } from "../document/types";

const line = (id: string, a: [number, number], b: [number, number]): SketchEntity => ({ type: "line", id, a, b });
const circle = (id: string, c: [number, number], r = 5): SketchEntity => ({ type: "circle", id, c, r });
const arc = (id: string, c: [number, number]): SketchEntity => ({ type: "arc", id, c, r: 5, start: 0, end: 1 });

/** Deterministic ids so constraints are easy to assert. */
const counter = () => {
  let n = 0;
  return () => `k${n++}`;
};

describe("vertexRefsOf", () => {
  it("gives a line's two endpoints", () => {
    expect(vertexRefsOf(line("l", [0, 0], [3, 4]))).toEqual([
      { at: "a", uv: [0, 0] },
      { at: "b", uv: [3, 4] },
    ]);
  });
  it("gives a circle's / arc's centre", () => {
    expect(vertexRefsOf(circle("c", [1, 2]))).toEqual([{ at: "c", uv: [1, 2] }]);
    expect(vertexRefsOf(arc("a", [1, 2]))).toEqual([{ at: "c", uv: [1, 2] }]);
  });
  it("gives nothing for entities with no addressable vertex", () => {
    expect(
      vertexRefsOf({
        type: "spline",
        id: "s",
        points: [
          [0, 0],
          [1, 1],
        ],
      } as SketchEntity),
    ).toEqual([]);
    expect(vertexRefsOf({ type: "text", id: "t", p: [0, 0], value: "x", height: 5 } as SketchEntity)).toEqual([]);
  });
});

describe("pinConstraints", () => {
  it("pins a line endpoint that sits on a pin location", () => {
    const l = line("l1", [0, 0], [10, 5]);
    const cons = pinConstraints([l], [[10, 5]], counter());
    expect(cons).toEqual([{ id: "k0", type: "coincident", a: { entity: "l1", at: "b" }, b: { fixed: [10, 5] } }]);
  });

  it("pins a circle centre", () => {
    const cons = pinConstraints([circle("c1", [12, 8])], [[12, 8]], counter());
    expect(cons).toEqual([{ id: "k0", type: "coincident", a: { entity: "c1", at: "c" }, b: { fixed: [12, 8] } }]);
  });

  it("skips undefined pins (un-snapped clicks)", () => {
    const l = line("l1", [0, 0], [10, 0]);
    expect(pinConstraints([l], [undefined, undefined], counter())).toEqual([]);
  });

  it("emits nothing when no vertex sits at the pin", () => {
    const l = line("l1", [0, 0], [10, 0]);
    expect(pinConstraints([l], [[5, 5]], counter())).toEqual([]);
  });

  it("pins only ONE vertex per location (the solver merges the rest)", () => {
    // Two lines share the corner (10,0) — a rectangle-style junction.
    const a = line("a", [0, 0], [10, 0]);
    const b = line("b", [10, 0], [10, 10]);
    const cons = pinConstraints([a, b], [[10, 0]], counter());
    expect(cons).toHaveLength(1);
    expect(cons[0].type).toBe("coincident");
    expect((cons[0] as { a: { entity: string } }).a.entity).toBe("a"); // first match wins
  });

  it("matches within a small tolerance but not beyond it", () => {
    const l = line("l1", [0, 0], [10, 0]);
    expect(pinConstraints([l], [[10 + 5e-5, 0]], counter())).toHaveLength(1); // within 1e-4
    expect(pinConstraints([l], [[10.01, 0]], counter())).toHaveLength(0); // beyond
  });

  it("pins each of several locations independently", () => {
    const a = line("a", [0, 0], [10, 0]);
    const c = circle("c", [12, 8]);
    const cons = pinConstraints([a, c], [[0, 0], undefined, [12, 8]], counter());
    expect(cons.map((x) => (x as { a: { entity: string; at: string } }).a)).toEqual([
      { entity: "a", at: "a" },
      { entity: "c", at: "c" },
    ]);
  });
});
