import { describe, expect, it } from "vitest";
import { solveSketch } from "./solver";
import type { SketchConstraint, SketchEntity } from "../document/types";

// A line from the sketch origin to (10, 0).
const line: SketchEntity = { type: "line", id: "L", a: [0, 0], b: [10, 0] };

describe("solveSketch origin anchoring", () => {
  it("keeps a line's origin end pinned when lengthened (no explicit constraint)", async () => {
    // Regression: without auto-anchoring the origin, the solver grows the line
    // symmetrically so it passes *through* the origin (a drifts to ~-21).
    const constraints: SketchConstraint[] = [
      { id: "h", type: "horizontal", entity: "L" },
      { id: "d", type: "distance", entity: "L", value: 40 },
    ];
    const res = await solveSketch([line], constraints);
    const solved = res.entities[0];
    if (solved.type !== "line") throw new Error("expected line");
    expect(Math.hypot(solved.a[0], solved.a[1])).toBeLessThan(1e-6); // stays on origin
    expect(Math.hypot(solved.b[0] - solved.a[0], solved.b[1] - solved.a[1])).toBeCloseTo(40, 4);
    // Fully constrained: origin pins 2 DOF, horizontal + length pin the rest.
    expect(res.dof).toBe(0);
  });
});

describe("solveSketch coincident", () => {
  it("anchors a line's origin end while a length dimension moves the free end", async () => {
    const constraints: SketchConstraint[] = [
      { id: "co", type: "coincident", a: { entity: "L", at: "a" }, b: { origin: true } },
      { id: "d", type: "distance", entity: "L", value: 25 },
    ];
    const res = await solveSketch([line], constraints);
    expect(res.hasConflicts).toBe(false);
    const solved = res.entities[0];
    if (solved.type !== "line") throw new Error("expected line");
    // The origin end stayed at (0,0)...
    expect(Math.hypot(solved.a[0], solved.a[1])).toBeLessThan(1e-6);
    // ...and the line is now 25 long.
    expect(Math.hypot(solved.b[0] - solved.a[0], solved.b[1] - solved.a[1])).toBeCloseTo(25, 4);
  });
});

describe("solveSketch pointOnLine", () => {
  it("keeps a drawn endpoint on the target line when the drawn line is lengthened", async () => {
    // A square's vertical edge fixed at x=20 (one end on the origin-fixed corner...
    // here pinned via vertical + a fixed lower end at (20,0) won't move because the
    // edge is vertical and its lower corner is held by a distance from origin).
    // A new line from the origin lands on that edge at (20,15); lengthening it
    // must keep its free end ON the edge instead of disconnecting.
    const corner: SketchEntity = { type: "line", id: "C", a: [0, 0], b: [20, 0] }; // origin → corner
    const square: SketchEntity = { type: "line", id: "S", a: [20, 0], b: [20, 40] };
    const drawn: SketchEntity = { type: "line", id: "D", a: [0, 0], b: [20, 15] };
    const constraints: SketchConstraint[] = [
      { id: "ch", type: "horizontal", entity: "C" },
      { id: "cd", type: "distance", entity: "C", value: 20 }, // corner sits at x=20 (origin auto-fixed)
      { id: "sv", type: "vertical", entity: "S" }, // edge S is vertical through the corner ⇒ x=20
      { id: "p", type: "pointOnLine", point: { entity: "D", at: "b" }, line: "S" },
      { id: "d", type: "distance", entity: "D", value: 50 }, // lengthen the drawn line
    ];
    const res = await solveSketch([corner, square, drawn], constraints);
    expect(res.hasConflicts).toBe(false);
    const d = res.entities.find((e) => e.id === "D");
    if (d?.type !== "line") throw new Error("bad result");
    // The drawn line's free end stays on the (now pinned, vertical) edge at x=20.
    expect(d.b[0]).toBeCloseTo(20, 3);
    // And it's now 50 long (the dimension took effect).
    expect(Math.hypot(d.b[0] - d.a[0], d.b[1] - d.a[1])).toBeCloseTo(50, 3);
    // Origin end stayed pinned.
    expect(Math.hypot(d.a[0], d.a[1])).toBeLessThan(1e-6);
  });

  it("pulls the origin onto a line (line + origin coincident)", async () => {
    // A line offset from the origin; constrain the origin to lie on it. With no
    // other constraints the solver moves the line so it passes through (0,0).
    const offset: SketchEntity = { type: "line", id: "L", a: [10, 10], b: [30, 10] };
    const constraints: SketchConstraint[] = [
      { id: "h", type: "horizontal", entity: "L" },
      { id: "p", type: "pointOnLine", point: { origin: true }, line: "L" },
    ];
    const res = await solveSketch([offset], constraints);
    expect(res.hasConflicts).toBe(false);
    const l = res.entities[0];
    if (l.type !== "line") throw new Error("line");
    // The line is horizontal and now sits at y = 0 (so the origin is on it).
    expect(l.a[1]).toBeCloseTo(0, 3);
    expect(l.b[1]).toBeCloseTo(0, 3);
  });
});

describe("solveSketch midpoint", () => {
  it("locks a drawn endpoint to a line's midpoint and tracks it as the line moves", async () => {
    // A horizontal edge (from the origin), and a drawn line whose end is locked to
    // the edge's midpoint. Growing the edge keeps the endpoint on the new midpoint.
    const edge: SketchEntity = { type: "line", id: "E", a: [0, 0], b: [40, 0] };
    const drawn: SketchEntity = { type: "line", id: "D", a: [20, 20], b: [20, 0] };
    const res = await solveSketch([edge, drawn], [
      { id: "h", type: "horizontal", entity: "E" },
      { id: "m", type: "midpoint", point: { entity: "D", at: "b" }, target: "E" },
      { id: "d", type: "distance", entity: "E", value: 60 }, // grows the edge (origin-fixed a)
    ]);
    expect(res.hasConflicts).toBe(false);
    const e = res.entities.find((x) => x.id === "E");
    const d = res.entities.find((x) => x.id === "D");
    if (e?.type !== "line" || d?.type !== "line") throw new Error("bad result");
    // The drawn end sits exactly at the (moved) edge's midpoint.
    expect(d.b[0]).toBeCloseTo((e.a[0] + e.b[0]) / 2, 3);
    expect(d.b[1]).toBeCloseTo((e.a[1] + e.b[1]) / 2, 3);
  });

  it("locks a drawn endpoint to an arc's mid-arc point", async () => {
    // A quarter arc centred at origin (0..90°); its mid-arc point is at 45°. A
    // drawn line's end starts off it and is pulled onto the mid-arc point.
    const r = 10;
    const arc: SketchEntity = { type: "arc", id: "A", c: [0, 0], r, start: 0, end: Math.PI / 2 };
    const drawn: SketchEntity = { type: "line", id: "D", a: [0, 20], b: [5, 5] };
    const res = await solveSketch([arc, drawn], [
      { id: "m", type: "midpoint", point: { entity: "D", at: "b" }, target: "A" },
    ]);
    expect(res.hasConflicts).toBe(false);
    const d = res.entities.find((x) => x.id === "D");
    if (d?.type !== "line") throw new Error("line");
    const mid = Math.PI / 4;
    expect(d.b[0]).toBeCloseTo(r * Math.cos(mid), 3);
    expect(d.b[1]).toBeCloseTo(r * Math.sin(mid), 3);
  });
});

describe("solveSketch tangent", () => {
  it("makes a line tangent to a circle", async () => {
    const ents: SketchEntity[] = [
      { type: "line", id: "L", a: [-10, 5], b: [10, 5] },
      { type: "circle", id: "C", c: [0, 0], r: 3 },
    ];
    const constraints: SketchConstraint[] = [
      { id: "h", type: "horizontal", entity: "L" },
      { id: "t", type: "tangent", a: "L", b: "C" },
    ];
    const res = await solveSketch(ents, constraints);
    expect(res.hasConflicts).toBe(false);
    const c = res.entities.find((e) => e.id === "C");
    const l = res.entities.find((e) => e.id === "L");
    if (c?.type !== "circle" || l?.type !== "line") throw new Error("bad result");
    // Horizontal line at y = l.a[1]; its distance to the circle centre equals r.
    expect(Math.abs(l.a[1] - c.c[1])).toBeCloseTo(c.r, 3);
  });
});
