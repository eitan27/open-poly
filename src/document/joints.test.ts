import { describe, expect, it } from "vitest";
import { coordKey, entityVertices, missingJoints } from "./joints";
import { migrateDocument } from "./document";
import type { Document, SketchConstraint, SketchEntity } from "./types";

let n = 0;
const genId = () => `j${++n}`;
const joints = (entities: SketchEntity[], constraints: SketchConstraint[] = []) => {
  n = 0;
  return missingJoints(entities, constraints, genId);
};
// The pair a joint connects, order-independent, as "L:b~R:a".
const pair = (c: SketchConstraint) => {
  if (c.type !== "coincident" || !("entity" in c.a) || !("entity" in c.b)) throw new Error("not a vertex joint");
  return [`${c.a.entity}:${c.a.at}`, `${c.b.entity}:${c.b.at}`].sort().join("~");
};
const pairs = (cs: SketchConstraint[]) => cs.map(pair).sort();

const line = (id: string, a: [number, number], b: [number, number]): SketchEntity => ({ type: "line", id, a, b });

describe("entityVertices", () => {
  it("gives a line two ends, a circle its centre", () => {
    expect(entityVertices(line("L", [0, 1], [2, 3])).map((v) => v.at)).toEqual(["a", "b"]);
    expect(entityVertices({ type: "circle", id: "C", c: [1, 2], r: 3 }).map((v) => v.at)).toEqual(["c"]);
  });

  it("gives an arc its centre and its two computed endpoints", () => {
    const vs = entityVertices({ type: "arc", id: "A", c: [0, 0], r: 5, start: 0, end: Math.PI / 2 });
    expect(vs.map((v) => v.at)).toEqual(["c", "a", "b"]);
    expect(vs[1].p[0]).toBeCloseTo(5, 6); // start endpoint at 0°
    expect(vs[2].p[1]).toBeCloseTo(5, 6); // end endpoint at 90°
  });

  it("gives derived geometry none — it never enters the solver", () => {
    expect(entityVertices({ ...line("D", [0, 0], [1, 1]), derivedFrom: "op1" })).toEqual([]);
  });

  it("gives splines, points and text none (unmapped in the solver)", () => {
    expect(entityVertices({ type: "spline", id: "S", points: [[0, 0]] })).toEqual([]);
    expect(entityVertices({ type: "point", id: "P", p: [1, 1] })).toEqual([]);
  });
});

describe("missingJoints", () => {
  it("joins a chained polyline at each shared corner", () => {
    const cs = joints([line("A", [1, 1], [10, 1]), line("B", [10, 1], [10, 9])]);
    expect(pairs(cs)).toEqual(["A:b~B:a"]);
  });

  it("gives a rectangle four joints, not six", () => {
    // Every corner is shared by exactly two edges; a fifth constraint would be
    // dead weight the solver reports as redundant.
    const rect = [
      line("B", [0, 2], [10, 2]),
      line("R", [10, 2], [10, 12]),
      line("T", [10, 12], [0, 12]),
      line("L", [0, 12], [0, 2]),
    ];
    expect(pairs(joints(rect))).toEqual(["B:a~L:b", "B:b~R:a", "R:b~T:a", "L:a~T:b"].sort());
  });

  it("joins three vertices at one point with two constraints, not three", () => {
    const cs = joints([line("A", [5, 5], [9, 9]), line("B", [5, 5], [1, 9]), line("C", [5, 5], [5, 9])]);
    expect(cs).toHaveLength(2);
  });

  it("leaves vertices on the ORIGIN alone — the solver pins each of them there", () => {
    expect(joints([line("A", [0, 0], [10, 0]), line("B", [0, 0], [0, 10])])).toEqual([]);
  });

  it("says nothing about geometry that doesn't touch", () => {
    expect(joints([line("A", [1, 1], [10, 1]), line("B", [10.01, 1], [10, 9])])).toEqual([]);
  });

  it("doesn't repeat a joint the sketch already records", () => {
    const existing: SketchConstraint[] = [
      { id: "c1", type: "coincident", a: { entity: "A", at: "b" }, b: { entity: "B", at: "a" } },
    ];
    expect(joints([line("A", [1, 1], [10, 1]), line("B", [10, 1], [10, 9])], existing)).toEqual([]);
  });

  it("doesn't add one that already holds TRANSITIVELY", () => {
    // A–B and B–C are recorded, so A–C needs nothing even though all three meet.
    const existing: SketchConstraint[] = [
      { id: "c1", type: "coincident", a: { entity: "A", at: "a" }, b: { entity: "B", at: "a" } },
      { id: "c2", type: "coincident", a: { entity: "B", at: "a" }, b: { entity: "C", at: "a" } },
    ];
    const cs = joints([line("A", [5, 5], [9, 9]), line("B", [5, 5], [1, 9]), line("C", [5, 5], [5, 9])], existing);
    expect(cs).toEqual([]);
  });

  it("joins a line to an arc's endpoint", () => {
    const arc: SketchEntity = { type: "arc", id: "A", c: [10, 5], r: 5, start: -Math.PI / 2, end: 0 };
    expect(pairs(joints([line("L", [1, 0], [10, 0]), arc]))).toEqual(["A:a~L:b"]);
  });

  it("joins two circles that share a centre (what the old merge did silently)", () => {
    const cs = joints([
      { type: "circle", id: "C1", c: [4, 4], r: 3 },
      { type: "circle", id: "C2", c: [4, 4], r: 8 },
    ]);
    expect(pairs(cs)).toEqual(["C1:c~C2:c"]);
  });

  it("ignores derived output entirely", () => {
    const cs = joints([line("A", [1, 1], [10, 1]), { ...line("D", [10, 1], [10, 9]), derivedFrom: "op1" }]);
    expect(cs).toEqual([]);
  });

  it("is idempotent — running it on its own output adds nothing", () => {
    const rect = [
      line("B", [0, 2], [10, 2]),
      line("R", [10, 2], [10, 12]),
      line("T", [10, 12], [0, 12]),
      line("L", [0, 12], [0, 2]),
    ];
    const once = joints(rect);
    expect(missingJoints(rect, once, genId)).toEqual([]);
  });
});

describe("coordKey", () => {
  it("rounds to 4dp and normalizes negative zero", () => {
    expect(coordKey([0, 0])).toBe(coordKey([-0.00001, 0]));
    expect(coordKey([1.00001, 2])).toBe(coordKey([1.00002, 2]));
    expect(coordKey([1.001, 2])).not.toBe(coordKey([1.002, 2]));
  });
});

describe("migrateDocument backfills joints", () => {
  // A sketch drawn before point identity became referential: its corners were
  // held by coordinate alone, so nothing in the document records them. On load
  // they have to become real constraints or the shape comes apart.
  const legacy = (): Document => ({
    features: [
      {
        id: "s1",
        type: "sketch",
        name: "Sketch 1",
        suppressed: false,
        plane: { kind: "datum", id: "plane-top" },
        entities: [line("A", [5, 5], [25, 5]), line("B", [25, 5], [25, 25])],
        constraints: [{ id: "h", type: "horizontal", entity: "A" }],
      },
    ],
    variables: [],
    rollbackIndex: 1,
  });

  it("writes the joint the old coordinate merge implied", () => {
    const sk = migrateDocument(legacy()).features[0];
    if (sk.type !== "sketch") throw new Error("expected sketch");
    const js = sk.constraints.filter((c) => c.type === "coincident");
    expect(js).toHaveLength(1);
    expect(pair(js[0])).toBe("A:b~B:a");
    expect(sk.constraints.find((c) => c.type === "horizontal")).toBeTruthy(); // kept
  });

  it("leaves an already-migrated document untouched (same object back)", () => {
    const once = migrateDocument(legacy());
    expect(migrateDocument(once)).toBe(once);
  });
});
