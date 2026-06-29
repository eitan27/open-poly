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

  it("locks a drawn endpoint to an arc's mid-arc point (arc-relative)", async () => {
    // A quarter arc and a drawn line whose end is locked to the arc's midpoint.
    // The arc is solver-aware now, so assert the geometric invariant: the point
    // is on the arc and equidistant from its two ends (⇒ the angular midpoint).
    const arc: SketchEntity = { type: "arc", id: "A", c: [0, 0], r: 10, start: 0, end: Math.PI / 2 };
    const drawn: SketchEntity = { type: "line", id: "D", a: [0, 20], b: [5, 5] };
    const res = await solveSketch([arc, drawn], [
      { id: "m", type: "midpoint", point: { entity: "D", at: "b" }, target: "A" },
    ]);
    expect(res.hasConflicts).toBe(false);
    const a = res.entities.find((x) => x.id === "A");
    const d = res.entities.find((x) => x.id === "D");
    if (a?.type !== "arc" || d?.type !== "line") throw new Error("bad result");
    const onArc = Math.hypot(d.b[0] - a.c[0], d.b[1] - a.c[1]);
    expect(onArc).toBeCloseTo(a.r, 3); // on the arc's circle
    const s: [number, number] = [a.c[0] + a.r * Math.cos(a.start), a.c[1] + a.r * Math.sin(a.start)];
    const e: [number, number] = [a.c[0] + a.r * Math.cos(a.end), a.c[1] + a.r * Math.sin(a.end)];
    expect(Math.hypot(d.b[0] - s[0], d.b[1] - s[1])).toBeCloseTo(Math.hypot(d.b[0] - e[0], d.b[1] - e[1]), 3);
  });
});

describe("solveSketch arcs (solver-aware)", () => {
  it("drives an arc's radius with a radius constraint", async () => {
    const arc: SketchEntity = { type: "arc", id: "A", c: [20, 0], r: 5, start: 0, end: Math.PI / 2 };
    const res = await solveSketch([arc], [{ id: "r", type: "radius", entity: "A", value: 8 }]);
    expect(res.hasConflicts).toBe(false);
    const a = res.entities.find((x) => x.id === "A");
    if (a?.type !== "arc") throw new Error("arc");
    expect(a.r).toBeCloseTo(8, 3);
  });

  it("keeps a line connected to an arc endpoint as the line is lengthened", async () => {
    // Line from the origin to [10,0]; an arc whose start endpoint is also [10,0]
    // (coincident via shared coordinate). Growing the line drags the shared point,
    // and the arc reshapes to keep its endpoint attached.
    const line: SketchEntity = { type: "line", id: "L", a: [0, 0], b: [10, 0] };
    const arc: SketchEntity = { type: "arc", id: "A", c: [10, 5], r: 5, start: -Math.PI / 2, end: 0 };
    const res = await solveSketch([line, arc], [
      { id: "h", type: "horizontal", entity: "L" },
      { id: "d", type: "distance", entity: "L", value: 20 },
    ]);
    expect(res.hasConflicts).toBe(false);
    const l = res.entities.find((x) => x.id === "L");
    const a = res.entities.find((x) => x.id === "A");
    if (l?.type !== "line" || a?.type !== "arc") throw new Error("bad result");
    expect(l.b[0]).toBeCloseTo(20, 3); // line grew (origin-fixed a)
    // The arc's start endpoint followed the shared point to the line's new end.
    const startPt: [number, number] = [a.c[0] + a.r * Math.cos(a.start), a.c[1] + a.r * Math.sin(a.start)];
    expect(startPt[0]).toBeCloseTo(l.b[0], 2);
    expect(startPt[1]).toBeCloseTo(l.b[1], 2);
  });

  it("makes a line tangent to an arc", async () => {
    const line: SketchEntity = { type: "line", id: "L", a: [-10, 5], b: [10, 5] };
    const arc: SketchEntity = { type: "arc", id: "A", c: [0, 0], r: 3, start: 0, end: Math.PI };
    const res = await solveSketch([line, arc], [
      { id: "h", type: "horizontal", entity: "L" },
      { id: "r", type: "radius", entity: "A", value: 3 }, // pin the arc radius
      { id: "t", type: "tangent", a: "L", b: "A" },
    ]);
    expect(res.hasConflicts).toBe(false);
    const l = res.entities.find((x) => x.id === "L");
    const a = res.entities.find((x) => x.id === "A");
    if (l?.type !== "line" || a?.type !== "arc") throw new Error("bad result");
    // Horizontal line tangent to the arc's circle ⇒ |line.y − centre.y| = radius.
    expect(Math.abs(l.a[1] - a.c[1])).toBeCloseTo(a.r, 2);
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

describe("solveSketch text", () => {
  it("passes a text entity through unchanged (not a constraint participant)", async () => {
    const ents: SketchEntity[] = [
      { type: "line", id: "L", a: [0, 0], b: [10, 0] },
      { type: "text", id: "T", p: [2, 2], value: "Hi", height: 5 },
    ];
    const res = await solveSketch(ents, [{ id: "h", type: "horizontal", entity: "L" }]);
    const t = res.entities.find((e) => e.id === "T");
    expect(t).toEqual(ents[1]); // identical object content — solver left it alone
  });
});

describe("solveSketch derived geometry", () => {
  it("ignores derivedFrom entities (no DOF, returned untouched)", async () => {
    // A free, fully-constrained line plus a generated (derived) line. The derived
    // line must not enter the GCS problem: it adds no DOF and is returned as-is.
    const derived: SketchEntity = { type: "line", id: "D", a: [3, 7], b: [9, 7], derivedFrom: "op1" };
    const constraints: SketchConstraint[] = [
      { id: "h", type: "horizontal", entity: "L" },
      { id: "d", type: "distance", entity: "L", value: 40 },
    ];
    const res = await solveSketch([line, derived], constraints);
    expect(res.dof).toBe(0); // only L's DOF; D contributes none
    const d = res.entities.find((e) => e.id === "D");
    expect(d).toEqual(derived); // identical content — solver left it alone
  });
});
