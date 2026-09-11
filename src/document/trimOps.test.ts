import { describe, expect, it } from "vitest";
import { extendSketchEntity, planExtend, planTrim, trimSketchEntity } from "./trimOps";
import type { Document, SketchConstraint, SketchEntity, SketchFeature, Vec2 } from "./types";

const line = (id: string, a: Vec2, b: Vec2): SketchEntity => ({ type: "line", id, a, b });

const docWith = (entities: SketchEntity[], constraints: SketchConstraint[] = []): Document => ({
  features: [
    {
      id: "s1",
      type: "sketch",
      name: "Sketch 1",
      suppressed: false,
      plane: { kind: "datum", id: "plane-top" },
      entities,
      constraints,
    } as SketchFeature,
  ],
  variables: [],
  rollbackIndex: 1,
});
const sk = (d: Document): SketchFeature => d.features[0] as SketchFeature;
const ent = (d: Document, id: string) => sk(d).entities.find((e) => e.id === id);
const cons = (d: Document) => sk(d).constraints;

// A horizontal line crossed twice, which is the shape every interesting case
// below is a variation of.
const crossed = () => [line("L", [0, 0], [10, 0]), line("A", [3, -5], [3, 5]), line("B", [7, -5], [7, 5])];

describe("trimSketchEntity — geometry", () => {
  it("shortens to the cut when the piece is at an end", () => {
    const d = trimSketchEntity(docWith(crossed()), "s1", "L", [9, 0]);
    const l = ent(d, "L");
    expect(l?.type === "line" && l.b).toEqual([7, 0]);
    expect(sk(d).entities).toHaveLength(3); // nothing added or lost
  });

  it("splits into two when the piece is in the middle", () => {
    const d = trimSketchEntity(docWith(crossed()), "s1", "L", [5, 0]);
    expect(sk(d).entities).toHaveLength(4);
    const keep = ent(d, "L");
    expect(keep?.type === "line" && keep.b).toEqual([3, 0]);
    const rest = sk(d).entities.find((e) => e.id !== "L" && e.id !== "A" && e.id !== "B");
    expect(rest?.type === "line" && rest.a).toEqual([7, 0]);
    expect(rest?.type === "line" && rest.b).toEqual([10, 0]);
  });

  it("removes an entity nothing crosses, with the constraints that named it", () => {
    const d = trimSketchEntity(
      docWith([line("L", [0, 0], [10, 0])], [{ id: "h", type: "horizontal", entity: "L" }]),
      "s1",
      "L",
      [5, 0],
    );
    expect(sk(d).entities).toHaveLength(0);
    expect(cons(d)).toHaveLength(0);
  });

  it("leaves the document alone for something it can't trim", () => {
    const d = docWith([{ type: "spline", id: "S", points: [[0, 0]] }]);
    expect(trimSketchEntity(d, "s1", "S", [0, 0])).toBe(d);
    expect(trimSketchEntity(d, "s1", "nope", [0, 0])).toBe(d);
  });
});

describe("trimSketchEntity — what becomes of the constraints", () => {
  it("drops a joint pinned to the end that was cut away", () => {
    const constraints: SketchConstraint[] = [
      { id: "j", type: "coincident", a: { entity: "L", at: "b" }, b: { entity: "B", at: "a" } },
      { id: "h", type: "horizontal", entity: "L" },
    ];
    const d = trimSketchEntity(docWith(crossed(), constraints), "s1", "L", [9, 0]);
    expect(cons(d).map((c) => c.id)).toEqual(["h"]); // the joint on `b` went, the shape held
  });

  it("keeps a joint on the end that DIDN'T move", () => {
    const constraints: SketchConstraint[] = [
      { id: "j", type: "coincident", a: { entity: "L", at: "a" }, b: { entity: "A", at: "a" } },
    ];
    const d = trimSketchEntity(docWith(crossed(), constraints), "s1", "L", [9, 0]);
    expect(cons(d).map((c) => c.id)).toEqual(["j"]);
  });

  it("drops a length dimension the trim just invalidated", () => {
    // Keeping it would stretch the line back to 10 on the next solve and undo
    // the trim.
    const constraints: SketchConstraint[] = [{ id: "d", type: "distance", entity: "L", value: 10 }];
    const d = trimSketchEntity(docWith(crossed(), constraints), "s1", "L", [9, 0]);
    expect(cons(d)).toHaveLength(0);
  });

  it("re-points a joint on `b` to the fragment that inherited it", () => {
    const constraints: SketchConstraint[] = [
      { id: "j", type: "coincident", a: { entity: "L", at: "b" }, b: { entity: "X", at: "a" } },
    ];
    const d = trimSketchEntity(docWith([...crossed(), line("X", [10, 0], [10, 5])], constraints), "s1", "L", [5, 0]);
    const restId = sk(d).entities.find((e) => !["L", "A", "B", "X"].includes(e.id))!.id;
    const j = cons(d).find((c) => c.id === "j");
    expect(j?.type === "coincident" && j.a).toEqual({ entity: restId, at: "b" });
  });

  it("carries horizontal onto the new fragment — a collinear piece is still horizontal", () => {
    const constraints: SketchConstraint[] = [{ id: "h", type: "horizontal", entity: "L" }];
    const d = trimSketchEntity(docWith(crossed(), constraints), "s1", "L", [5, 0]);
    const restId = sk(d).entities.find((e) => !["L", "A", "B"].includes(e.id))!.id;
    const hs = cons(d).filter((c) => c.type === "horizontal");
    expect(hs.map((c) => (c as { entity: string }).entity).sort()).toEqual(["L", restId].sort());
  });

  it("does NOT carry constraints that may no longer hold of the fragment", () => {
    // Equal-length and a tangency say things about the whole line that a piece
    // of it needn't satisfy.
    const constraints: SketchConstraint[] = [
      { id: "e", type: "equal", a: "L", b: "A" },
      { id: "p", type: "parallel", a: "L", b: "A" },
    ];
    const d = trimSketchEntity(docWith(crossed(), constraints), "s1", "L", [5, 0]);
    expect(
      cons(d)
        .map((c) => c.id)
        .sort(),
    ).toEqual(["e", "p"]); // still on L only, not duplicated
  });

  it("keeps everything when a circle merely opens into an arc", () => {
    const entities = [{ type: "circle", id: "C", c: [0, 0], r: 10 } as SketchEntity, line("H", [-20, 0], [20, 0])];
    const constraints: SketchConstraint[] = [{ id: "r", type: "radius", entity: "C", value: 10 }];
    const d = trimSketchEntity(docWith(entities, constraints), "s1", "C", [0, -10]);
    expect(ent(d, "C")?.type).toBe("arc");
    expect(cons(d).map((c) => c.id)).toEqual(["r"]); // the radius still means what it did
  });
});

describe("extendSketchEntity", () => {
  const short = () => [line("L", [0, 0], [5, 0]), line("W", [9, -5], [9, 5])];

  it("grows the end out to what's ahead of it", () => {
    const d = extendSketchEntity(docWith(short()), "s1", "L", [4.9, 0]);
    const l = ent(d, "L");
    expect(l?.type === "line" && l.b).toEqual([9, 0]);
  });

  it("records the meeting as a point-on, so it lasts", () => {
    const d = extendSketchEntity(docWith(short()), "s1", "L", [4.9, 0]);
    const j = cons(d)[0];
    expect(j?.type).toBe("pointOnLine");
    expect(j?.type === "pointOnLine" && j.line).toBe("W");
    expect(j?.type === "pointOnLine" && j.point).toEqual({ entity: "L", at: "b" });
  });

  it("records a coincidence when it lands on the other entity's own end", () => {
    const d = extendSketchEntity(docWith([line("L", [0, 0], [5, 0]), line("V", [9, 0], [9, 5])]), "s1", "L", [4.9, 0]);
    const j = cons(d)[0];
    expect(j?.type).toBe("coincident");
    expect(j?.type === "coincident" && j.b).toEqual({ entity: "V", at: "a" });
  });

  it("grows the end you clicked nearest", () => {
    const d = extendSketchEntity(
      docWith([line("L", [0, 0], [5, 0]), line("W", [-4, -5], [-4, 5])]),
      "s1",
      "L",
      [0.1, 0],
    );
    const l = ent(d, "L");
    expect(l?.type === "line" && l.a).toEqual([-4, 0]);
  });

  it("changes nothing when there's nothing ahead", () => {
    const d = docWith([line("L", [0, 0], [5, 0])]);
    expect(extendSketchEntity(d, "s1", "L", [4.9, 0])).toBe(d);
    expect(planExtend(d, "s1", "L", [4.9, 0])).toBeNull();
  });

  it("drops the length dimension it just invalidated", () => {
    const constraints: SketchConstraint[] = [{ id: "d", type: "distance", entity: "L", value: 5 }];
    const d = extendSketchEntity(docWith(short(), constraints), "s1", "L", [4.9, 0]);
    expect(cons(d).some((c) => c.type === "distance")).toBe(false);
  });
});

describe("planTrim reports the piece without changing anything", () => {
  it("hands back the span that would go", () => {
    const d = docWith(crossed());
    const plan = planTrim(d, "s1", "L", [9, 0]);
    expect(plan?.kind).toBe("shorten");
    expect(plan!.span[0]).toEqual([7, 0]);
    expect(plan!.span[plan!.span.length - 1]).toEqual([10, 0]);
    expect(sk(d).entities).toHaveLength(3); // untouched
  });
});
