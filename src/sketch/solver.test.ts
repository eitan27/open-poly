import { describe, expect, it } from "vitest";
import { solveSketch } from "./solver";
import { measureBetween, resolveSide } from "./distanceDim";
import type { DistanceRef, SketchConstraint, SketchEntity, Vec2 } from "../document/types";

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

  it("moves a line so its endpoint reaches a fixed body vertex, holding under a re-solve", async () => {
    // The reported bug: making a sketch entity's vertex coincident with a solid
    // face's vertex. The solid vertex is an EXTERNAL fixed point (its projected
    // uv), so the sketch endpoint must travel to it — and STAY there when the
    // sketch is re-solved (a length dimension used to drag it back / to origin).
    const vertexUv: Vec2 = [30, 40]; // a projected solid-face corner
    const seg: SketchEntity = { type: "line", id: "L", a: [0, 0], b: [10, 0] };
    const constraints: SketchConstraint[] = [
      { id: "co", type: "coincident", a: { entity: "L", at: "b" }, b: { fixed: vertexUv } },
    ];
    const res = await solveSketch([seg], constraints);
    expect(res.hasConflicts).toBe(false);
    const l = res.entities[0];
    if (l.type !== "line") throw new Error("line");
    // The free "b" end landed exactly on the fixed vertex...
    expect(l.b[0]).toBeCloseTo(30, 4);
    expect(l.b[1]).toBeCloseTo(40, 4);
    // ...while the untouched "a" end stayed put.
    expect(l.a[0]).toBeCloseTo(0, 4);
    expect(l.a[1]).toBeCloseTo(0, 4);
  });

  it("keeps a sketch vertex pinned to a fixed body vertex when a dimension re-solves", async () => {
    // Same anchor, but now a length dimension also acts on the line. The pinned
    // end must not be dragged off the vertex — the line grows from the other end.
    const vertexUv: Vec2 = [20, 0];
    const seg: SketchEntity = { type: "line", id: "L", a: [20, 0], b: [10, 0] };
    const constraints: SketchConstraint[] = [
      { id: "co", type: "coincident", a: { entity: "L", at: "a" }, b: { fixed: vertexUv } },
      { id: "h", type: "horizontal", entity: "L" },
      { id: "d", type: "distance", entity: "L", value: 25 },
    ];
    const res = await solveSketch([seg], constraints);
    expect(res.hasConflicts).toBe(false);
    const l = res.entities[0];
    if (l.type !== "line") throw new Error("line");
    // The anchored "a" end stayed exactly on the fixed vertex (20, 0)...
    expect(l.a[0]).toBeCloseTo(20, 4);
    expect(l.a[1]).toBeCloseTo(0, 4);
    // ...and the line is now 25 long (dimension enforced from the free end).
    expect(Math.hypot(l.b[0] - l.a[0], l.b[1] - l.a[1])).toBeCloseTo(25, 3);
  });

  it("orders coincident by anchor: fixed body vertex on side A also pins the sketch end", async () => {
    // Same as above but the fixed point is side A (not B) — the anchor detection
    // must be symmetric so which side the user picked first doesn't matter.
    const vertexUv: Vec2 = [-5, 12];
    const seg: SketchEntity = { type: "line", id: "L", a: [0, 0], b: [10, 0] };
    const constraints: SketchConstraint[] = [
      { id: "co", type: "coincident", a: { fixed: vertexUv }, b: { entity: "L", at: "b" } },
    ];
    const res = await solveSketch([seg], constraints);
    expect(res.hasConflicts).toBe(false);
    const l = res.entities[0];
    if (l.type !== "line") throw new Error("line");
    expect(l.b[0]).toBeCloseTo(-5, 4);
    expect(l.b[1]).toBeCloseTo(12, 4);
  });

  it("pulls a line onto a fixed body vertex (point-on-line with a fixed point)", async () => {
    // A fixed body vertex constrained to lie ON a sketch line: the immovable
    // point stays put, so the line must move to pass through it. (The line starts
    // offset from the vertex, as it would after snapping — not degenerately on an
    // axis through it, which is a separate planegcs convergence edge case.)
    const vertexUv: Vec2 = [15, 25];
    const seg: SketchEntity = { type: "line", id: "L", a: [0, 10], b: [40, 10] };
    const constraints: SketchConstraint[] = [
      { id: "h", type: "horizontal", entity: "L" },
      { id: "p", type: "pointOnLine", point: { fixed: vertexUv }, line: "L" },
    ];
    const res = await solveSketch([seg], constraints);
    expect(res.hasConflicts).toBe(false);
    const l = res.entities[0];
    if (l.type !== "line") throw new Error("line");
    // Horizontal line raised to y = 25 so the fixed vertex sits on it.
    expect(l.a[1]).toBeCloseTo(25, 3);
    expect(l.b[1]).toBeCloseTo(25, 3);
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

// End-to-end validation that each distanceBetween pair maps to a planegcs
// primitive the real solver accepts and enforces: apply the dimension, solve,
// then re-measure the solved geometry — it must hit the target value. This is
// also what proves whether arc rims work (arc treated as a circle).
describe("solveSketch distanceBetween", () => {
  const measure = (entities: SketchEntity[], a: DistanceRef, b: DistanceRef) => {
    const ra = resolveSide(a, entities);
    const rb = resolveSide(b, entities);
    if (!ra || !rb) throw new Error("side did not resolve");
    const m = measureBetween(ra, rb);
    if (!m) throw new Error("degenerate pair");
    return m.value;
  };
  const dim = (a: DistanceRef, b: DistanceRef, value: number): SketchConstraint => ({
    id: "d",
    type: "distanceBetween",
    a,
    b,
    value,
  });

  it("point–point (two circle centres) drives the straight distance", async () => {
    const c1: SketchEntity = { type: "circle", id: "A", c: [0, 0], r: 3 };
    const c2: SketchEntity = { type: "circle", id: "B", c: [8, 0], r: 2 };
    const a: DistanceRef = { on: "point", ref: { entity: "A", at: "c" } };
    const b: DistanceRef = { on: "point", ref: { entity: "B", at: "c" } };
    const res = await solveSketch([c1, c2], [dim(a, b, 20)]);
    expect(res.hasConflicts).toBe(false);
    expect(measure(res.entities, a, b)).toBeCloseTo(20, 3);
  });

  it("point–line drives the perpendicular distance", async () => {
    const c: SketchEntity = { type: "circle", id: "P", c: [0, 4], r: 1 };
    const l: SketchEntity = { type: "line", id: "L", a: [-10, 0], b: [10, 0] };
    const a: DistanceRef = { on: "point", ref: { entity: "P", at: "c" } };
    const b: DistanceRef = { on: "line", entity: "L" };
    const res = await solveSketch([c, l], [{ id: "h", type: "horizontal", entity: "L" }, dim(a, b, 15)]);
    expect(res.hasConflicts).toBe(false);
    expect(measure(res.entities, a, b)).toBeCloseTo(15, 3);
  });

  it("point–rim (circle) drives the nearest gap (centre distance − radius)", async () => {
    const p: SketchEntity = { type: "circle", id: "P", c: [0, 0], r: 1 };
    const circle: SketchEntity = { type: "circle", id: "C", c: [10, 0], r: 3 };
    const a: DistanceRef = { on: "point", ref: { entity: "P", at: "c" } };
    const b: DistanceRef = { on: "rim", entity: "C" };
    const res = await solveSketch([p, circle], [{ id: "r", type: "radius", entity: "C", value: 3 }, dim(a, b, 12)]);
    expect(res.hasConflicts).toBe(false);
    expect(measure(res.entities, a, b)).toBeCloseTo(12, 3);
  });

  it("line–rim (circle) drives the tangent gap", async () => {
    const l: SketchEntity = { type: "line", id: "L", a: [-10, 0], b: [10, 0] };
    const circle: SketchEntity = { type: "circle", id: "C", c: [0, 8], r: 2 };
    const a: DistanceRef = { on: "line", entity: "L" };
    const b: DistanceRef = { on: "rim", entity: "C" };
    const res = await solveSketch(
      [l, circle],
      [{ id: "h", type: "horizontal", entity: "L" }, { id: "r", type: "radius", entity: "C", value: 2 }, dim(a, b, 5)],
    );
    expect(res.hasConflicts).toBe(false);
    expect(measure(res.entities, a, b)).toBeCloseTo(5, 3);
  });

  it("rim–rim (circle–circle) drives the gap between boundaries", async () => {
    const c1: SketchEntity = { type: "circle", id: "A", c: [0, 0], r: 3 };
    const c2: SketchEntity = { type: "circle", id: "B", c: [10, 0], r: 2 };
    const a: DistanceRef = { on: "rim", entity: "A" };
    const b: DistanceRef = { on: "rim", entity: "B" };
    const res = await solveSketch(
      [c1, c2],
      [
        { id: "ra", type: "radius", entity: "A", value: 3 },
        { id: "rb", type: "radius", entity: "B", value: 2 },
        dim(a, b, 15),
      ],
    );
    expect(res.hasConflicts).toBe(false);
    expect(measure(res.entities, a, b)).toBeCloseTo(15, 3);
  });

  it("line–line already parallel (both horizontal): one p2l, no redundancy", async () => {
    const l1: SketchEntity = { type: "line", id: "A", a: [0, 0], b: [10, 0] };
    const l2: SketchEntity = { type: "line", id: "B", a: [0, 4], b: [10, 4] };
    const a: DistanceRef = { on: "line", entity: "A" };
    const b: DistanceRef = { on: "line", entity: "B" };
    const res = await solveSketch(
      [l1, l2],
      [{ id: "h1", type: "horizontal", entity: "A" }, { id: "h2", type: "horizontal", entity: "B" }, dim(a, b, 12)],
    );
    expect(res.hasConflicts).toBe(false);
    expect(res.redundantIds).not.toContain("d"); // adaptive encoding avoids the self-redundancy
    expect(measure(res.entities, a, b)).toBeCloseTo(12, 3);
  });

  it("line–line not pre-parallel: two p2l establish parallel + separation", async () => {
    // Second line slightly tilted; the dimension alone must both level it to
    // parallel and set the gap.
    const l1: SketchEntity = { type: "line", id: "A", a: [0, 0], b: [10, 0] };
    const l2: SketchEntity = { type: "line", id: "B", a: [0, 4], b: [10, 4.5] };
    const a: DistanceRef = { on: "line", entity: "A" };
    const b: DistanceRef = { on: "line", entity: "B" };
    const res = await solveSketch([l1, l2], [{ id: "h1", type: "horizontal", entity: "A" }, dim(a, b, 12)]);
    expect(res.hasConflicts).toBe(false);
    expect(measure(res.entities, a, b)).toBeCloseTo(12, 3);
    const b2 = res.entities.find((e) => e.id === "B");
    if (b2?.type !== "line") throw new Error("line");
    expect(b2.a[1]).toBeCloseTo(b2.b[1], 3); // B is now horizontal ⇒ parallel to A
  });

  it("point–rim (ARC) — arc treated as a circle for the rim gap", async () => {
    const p: SketchEntity = { type: "circle", id: "P", c: [0, 0], r: 1 };
    const arc: SketchEntity = { type: "arc", id: "R", c: [10, 0], r: 3, start: 0, end: Math.PI };
    const a: DistanceRef = { on: "point", ref: { entity: "P", at: "c" } };
    const b: DistanceRef = { on: "rim", entity: "R" };
    const res = await solveSketch([p, arc], [{ id: "r", type: "radius", entity: "R", value: 3 }, dim(a, b, 12)]);
    expect(res.hasConflicts).toBe(false);
    // If planegcs accepts the arc where a circle is expected, the gap is enforced.
    expect(measure(res.entities, a, b)).toBeCloseTo(12, 3);
  });
});

describe("solveSketch midpoint", () => {
  it("locks a drawn endpoint to a line's midpoint and tracks it as the line moves", async () => {
    // A horizontal edge (from the origin), and a drawn line whose end is locked to
    // the edge's midpoint. Growing the edge keeps the endpoint on the new midpoint.
    const edge: SketchEntity = { type: "line", id: "E", a: [0, 0], b: [40, 0] };
    const drawn: SketchEntity = { type: "line", id: "D", a: [20, 20], b: [20, 0] };
    const res = await solveSketch(
      [edge, drawn],
      [
        { id: "h", type: "horizontal", entity: "E" },
        { id: "m", type: "midpoint", point: { entity: "D", at: "b" }, target: "E" },
        { id: "d", type: "distance", entity: "E", value: 60 }, // grows the edge (origin-fixed a)
      ],
    );
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
    const res = await solveSketch(
      [arc, drawn],
      [{ id: "m", type: "midpoint", point: { entity: "D", at: "b" }, target: "A" }],
    );
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
    const res = await solveSketch(
      [line, arc],
      [
        { id: "h", type: "horizontal", entity: "L" },
        { id: "d", type: "distance", entity: "L", value: 20 },
      ],
    );
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
    const res = await solveSketch(
      [line, arc],
      [
        { id: "h", type: "horizontal", entity: "L" },
        { id: "r", type: "radius", entity: "A", value: 3 }, // pin the arc radius
        { id: "t", type: "tangent", a: "L", b: "A" },
      ],
    );
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

describe("solveSketch redundant/conflicting diagnostics (square legs)", () => {
  // A 10×10 square at the origin: chained lines with H/V on every edge —
  // opposite legs are coupled, so a second dimension on the far leg is dead
  // weight and must be identifiable (this froze real sketches: the dead dim
  // was stored silently, then every later dimension edit conflicted).
  const square = (): SketchEntity[] => [
    { type: "line", id: "B", a: [0, 0], b: [10, 0] },
    { type: "line", id: "R", a: [10, 0], b: [10, 10] },
    { type: "line", id: "T", a: [10, 10], b: [0, 10] },
    { type: "line", id: "L", a: [0, 10], b: [0, 0] },
  ];
  const hv: SketchConstraint[] = [
    { id: "hb", type: "horizontal", entity: "B" },
    { id: "vr", type: "vertical", entity: "R" },
    { id: "ht", type: "horizontal", entity: "T" },
    { id: "vl", type: "vertical", entity: "L" },
  ];
  const len = (e: SketchEntity) => {
    if (e.type !== "line") throw new Error("line");
    return Math.hypot(e.b[0] - e.a[0], e.b[1] - e.a[1]);
  };

  it("changing a leg's dimension resizes the square (edit flow)", async () => {
    const first = await solveSketch(square(), [...hv, { id: "d", type: "distance", entity: "R", value: 10 }]);
    const second = await solveSketch(first.entities, [...hv, { id: "d2", type: "distance", entity: "R", value: 20 }]);
    expect(second.hasConflicts).toBe(false);
    const r = second.entities.find((e) => e.id === "R")!;
    expect(len(r)).toBeCloseTo(20, 3);
  });

  it("names a same-value dimension on the coupled opposite leg as redundant", async () => {
    const res = await solveSketch(square(), [
      ...hv,
      { id: "dr", type: "distance", entity: "R", value: 10 },
      { id: "dl", type: "distance", entity: "L", value: 10 },
    ]);
    expect(res.hasRedundant).toBe(true);
    expect(res.redundantIds).toContain("dl");
    expect(res.hasConflicts).toBe(false);
  });

  it("names the constraints of an inconsistent coupled pair as conflicting", async () => {
    const res = await solveSketch(square(), [
      ...hv,
      { id: "dr", type: "distance", entity: "R", value: 10 },
      { id: "dl", type: "distance", entity: "L", value: 20 },
    ]);
    expect(res.hasConflicts || res.status >= 2).toBe(true);
    expect(res.conflictingIds).toContain("dr");
    expect(res.conflictingIds).toContain("dl");
    // The geometry must not silently half-satisfy the new value.
    const l = res.entities.find((e) => e.id === "L")!;
    expect(len(l)).toBeCloseTo(10, 3);
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

describe("solveSketch diameter", () => {
  // Ø and R are the same constraint stated at two scales: the stored `value` is
  // what the user typed, and the solver is the only place the halving happens.
  it("drives a circle to HALF the diameter", async () => {
    const c: SketchEntity = { type: "circle", id: "C", c: [0, 0], r: 3 };
    const res = await solveSketch([c], [{ id: "d", type: "diameter", entity: "C", value: 40 }]);
    const solved = res.entities[0];
    if (solved.type !== "circle") throw new Error("expected circle");
    expect(solved.r).toBeCloseTo(20, 4);
    expect(res.hasConflicts).toBe(false);
  });

  it("drives an arc the same way", async () => {
    const a: SketchEntity = { type: "arc", id: "A", c: [0, 0], r: 3, start: 0, end: Math.PI / 2 };
    const res = await solveSketch([a], [{ id: "d", type: "diameter", entity: "A", value: 12 }]);
    const solved = res.entities[0];
    if (solved.type !== "arc") throw new Error("expected arc");
    expect(solved.r).toBeCloseTo(6, 4);
  });

  it("removes the same degree of freedom a radius does", async () => {
    const c: SketchEntity = { type: "circle", id: "C", c: [0, 0], r: 3 };
    const byR = await solveSketch([c], [{ id: "r", type: "radius", entity: "C", value: 20 }]);
    const byD = await solveSketch([c], [{ id: "d", type: "diameter", entity: "C", value: 40 }]);
    expect(byD.dof).toBe(byR.dof);
    expect(byD.hasRedundant).toBe(false);
  });

  it("conflicts with a radius that says something different", async () => {
    // Ø40 and R5 on one circle can't both hold — the pair must be flagged, not
    // silently resolved to whichever the solver reached last.
    const c: SketchEntity = { type: "circle", id: "C", c: [0, 0], r: 3 };
    const res = await solveSketch(
      [c],
      [
        { id: "r", type: "radius", entity: "C", value: 5 },
        { id: "d", type: "diameter", entity: "C", value: 40 },
      ],
    );
    expect(res.hasConflicts || res.status >= 2).toBe(true);
  });

  it("agrees with a radius that says the same thing (redundant, not conflicting)", async () => {
    const c: SketchEntity = { type: "circle", id: "C", c: [0, 0], r: 3 };
    const res = await solveSketch(
      [c],
      [
        { id: "r", type: "radius", entity: "C", value: 20 },
        { id: "d", type: "diameter", entity: "C", value: 40 },
      ],
    );
    expect(res.hasConflicts).toBe(false);
    expect(res.hasRedundant).toBe(true);
  });
});
