import { describe, expect, it } from "vitest";
import { coincidentEnabled, planCoincident, type CoincidentCurve, type CoincidentPoint } from "./coincidentSelection";
import type { PointRef } from "../document/types";

// A sketch vertex (editable — the solver may move it).
const sketchVertex = (entity: string, at: "a" | "b" | "c" = "a"): CoincidentPoint => ({
  ref: { entity, at },
  editable: true,
});
// A body/solid-face vertex, projected onto the sketch plane (fixed — immovable).
const bodyVertex = (uv: [number, number]): CoincidentPoint => ({ ref: { fixed: uv }, editable: false });
// The sketch origin, reached by clicking it (editable ref, but it's ground).
const originPoint: CoincidentPoint = { ref: { origin: true }, editable: true };
// The selected edges a point can land on.
const line = (id: string): CoincidentCurve => ({ id, kind: "line" });
const circle = (id: string): CoincidentCurve => ({ id, kind: "circle" });

describe("planCoincident — sketch vertex + solid-face vertex (the reported bug)", () => {
  it("makes the two coincident instead of anchoring the sketch vertex to the origin", () => {
    // Bug #1: the solid vertex was ignored, so a lone sketch point silently
    // anchored to the origin (the rectangle corner 'snapped to origin').
    const plan = planCoincident([sketchVertex("rect-corner", "b"), bodyVertex([30, 40])], []);
    expect(plan).toEqual({
      kind: "coincident",
      a: { entity: "rect-corner", at: "b" },
      b: { fixed: [30, 40] },
    });
    // Crucially, it is NOT an origin anchor.
    expect(plan?.kind).not.toBe("originAnchor");
  });

  it("enables the button for a sketch vertex + a solid-face vertex", () => {
    // Bug #2: the button was disabled because a body vertex wasn't counted as a
    // selectable point.
    expect(coincidentEnabled([sketchVertex("line1", "a"), bodyVertex([10, 0])], [])).toBe(true);
  });

  it("works regardless of pick order (solid vertex selected first)", () => {
    const plan = planCoincident([bodyVertex([5, 5]), sketchVertex("line1", "a")], []);
    expect(plan).toEqual({ kind: "coincident", a: { fixed: [5, 5] }, b: { entity: "line1", at: "a" } });
  });
});

describe("planCoincident — anchoring rules", () => {
  it("anchors a lone sketch vertex to the origin", () => {
    expect(planCoincident([sketchVertex("line1", "a")], [])).toEqual({
      kind: "originAnchor",
      point: { entity: "line1", at: "a" },
    });
  });

  it("does NOT anchor a lone solid vertex to the origin (nothing can move)", () => {
    // A fixed body vertex on its own has nothing to constrain — the button is off.
    expect(planCoincident([bodyVertex([12, 8])], [])).toBeNull();
    expect(coincidentEnabled([bodyVertex([12, 8])], [])).toBe(false);
  });

  it("refuses two solid vertices (neither is free to move)", () => {
    expect(planCoincident([bodyVertex([0, 0]), bodyVertex([10, 10])], [])).toBeNull();
    expect(coincidentEnabled([bodyVertex([0, 0]), bodyVertex([10, 10])], [])).toBe(false);
  });

  it("makes two sketch vertices coincident", () => {
    expect(planCoincident([sketchVertex("a", "a"), sketchVertex("b", "b")], [])).toEqual({
      kind: "coincident",
      a: { entity: "a", at: "a" },
      b: { entity: "b", at: "b" },
    });
  });
});

describe("planCoincident — point-on-line", () => {
  it("puts a sketch vertex on a selected line", () => {
    expect(planCoincident([sketchVertex("p", "a")], [line("target")])).toEqual({
      kind: "pointOnLine",
      point: { entity: "p", at: "a" },
      lineId: "target",
    });
  });

  it("puts a solid-face vertex on a selected line (the line moves to it)", () => {
    expect(planCoincident([bodyVertex([15, 25])], [line("edge")])).toEqual({
      kind: "pointOnLine",
      point: { fixed: [15, 25] },
      lineId: "edge",
    });
  });

  it("pulls the origin onto a selected line", () => {
    expect(planCoincident([originPoint], [line("edge")])).toEqual({
      kind: "pointOnLine",
      point: { origin: true },
      lineId: "edge",
    });
  });

  it("is a no-op (disabled) when the point is an endpoint of that same line", () => {
    // Constraining a line's own endpoint onto itself is meaningless.
    const plan = planCoincident([sketchVertex("edge", "a")], [line("edge")]);
    expect(plan).toBeNull();
    expect(coincidentEnabled([sketchVertex("edge", "a")], [line("edge")])).toBe(false);
  });
});

describe("planCoincident — invalid selections are disabled", () => {
  it("no selection", () => {
    expect(coincidentEnabled([], [])).toBe(false);
  });
  it("two lines (no points)", () => {
    expect(coincidentEnabled([], [line("l1"), line("l2")])).toBe(false);
  });
  it("three points", () => {
    const pts: CoincidentPoint[] = [sketchVertex("a"), sketchVertex("b"), sketchVertex("c")];
    expect(coincidentEnabled(pts, [])).toBe(false);
  });
  it("two points and a line", () => {
    expect(coincidentEnabled([sketchVertex("a"), sketchVertex("b")], [line("l")])).toBe(false);
  });
});

describe("planCoincident — point-on-circle (the reported bug)", () => {
  it("puts a line's endpoint on a selected circle instead of anchoring it to the ORIGIN", () => {
    // Bug #3: a circle wasn't a thing a point could be coincident with, so the
    // selection looked like "one lone point" and the point jumped to (0,0).
    const plan = planCoincident([sketchVertex("edge", "b")], [circle("hole")]);
    expect(plan).toEqual({ kind: "pointOnCircle", point: { entity: "edge", at: "b" }, circleId: "hole" });
    expect(plan?.kind).not.toBe("originAnchor");
  });

  it("does the same for an arc (its rim is a rim)", () => {
    expect(planCoincident([sketchVertex("edge", "a")], [circle("arc1")])).toMatchObject({
      kind: "pointOnCircle",
      circleId: "arc1",
    });
  });

  it("pulls the origin onto a circle, and a fixed body vertex too", () => {
    expect(planCoincident([originPoint], [circle("c")])).toEqual({
      kind: "pointOnCircle",
      point: { origin: true },
      circleId: "c",
    });
    expect(planCoincident([bodyVertex([4, 5])], [circle("c")])).toEqual({
      kind: "pointOnCircle",
      point: { fixed: [4, 5] },
      circleId: "c",
    });
  });

  it("enables the button for a point + a circle", () => {
    expect(coincidentEnabled([sketchVertex("edge", "b")], [circle("hole")])).toBe(true);
  });

  it("is a no-op when the point is that circle's own centre", () => {
    // Putting a circle's centre on its own rim is a contradiction, not a wish.
    expect(planCoincident([sketchVertex("hole", "c")], [circle("hole")])).toBeNull();
  });

  it("still refuses a point with TWO edges, whatever they are", () => {
    expect(planCoincident([sketchVertex("p")], [circle("c"), line("l")])).toBeNull();
    expect(planCoincident([sketchVertex("p")], [circle("c1"), circle("c2")])).toBeNull();
  });
});

describe("coincidentEnabled mirrors planCoincident", () => {
  it("is true exactly when a plan exists", () => {
    const cases: [CoincidentPoint[], CoincidentCurve[]][] = [
      [[sketchVertex("a"), bodyVertex([1, 1])], []],
      [[sketchVertex("a")], []],
      [[bodyVertex([1, 1])], []],
      [[], []],
      [[sketchVertex("a")], [line("l")]],
      [[sketchVertex("a")], [circle("c")]],
      [[sketchVertex("c", "c")], [circle("c")]],
    ];
    for (const [pts, curves] of cases) {
      expect(coincidentEnabled(pts, curves)).toBe(planCoincident(pts, curves) !== null);
    }
  });
});

// Type-level sanity: a fixed body vertex is a valid PointRef the solver resolves.
const _fixed: PointRef = { fixed: [1, 2] };
void _fixed;
