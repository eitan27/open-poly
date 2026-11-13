import { describe, expect, it } from "vitest";
import {
  createAssembly,
  insertInstances,
  isStarterAssembly,
  migrateAssembly,
  moveInstance,
  nextInstanceName,
  referencedDocIds,
  removeInstances,
  updateInstance,
  addMate,
  connectorWarnings,
  keepPlacements,
  nextMateName,
  removeMates,
  updateMate,
} from "./assembly";
import type { Mate } from "./types";
import { IDENTITY, translation } from "./placement";

let n = 0;
const genId = () => `i${++n}`;
const insert = (a = createAssembly(), docId = "d1", names = ["Bracket"]) =>
  insertInstances(
    a,
    docId,
    names.map((name, k) => ({ partId: `p${k}`, name, transform: IDENTITY })),
    genId,
  );

describe("inserting", () => {
  it("names copies of a part <1>, <2>, … and grounds only the very first instance", () => {
    const one = insert().assembly;
    const two = insert(one).assembly;
    expect(two.instances.map((i) => i.name)).toEqual(["Bracket <1>", "Bracket <2>"]);
    expect(two.instances.map((i) => !!i.grounded)).toEqual([true, false]);
  });

  it("a multi-part document becomes one instance per part, numbered among themselves", () => {
    const { assembly, ids } = insert(createAssembly(), "gears", ["Gear", "Gear", "Shaft"]);
    expect(ids).toHaveLength(3);
    expect(assembly.instances.map((i) => i.name)).toEqual(["Gear <1>", "Gear <2>", "Shaft <1>"]);
    expect(assembly.instances.every((i) => i.source.docId === "gears")).toBe(true);
  });

  it("reuses the lowest free number after a removal", () => {
    let a = insert(insert(insert().assembly).assembly).assembly;
    a = removeInstances(a, [a.instances[1].id]);
    expect(nextInstanceName(a, "Bracket")).toBe("Bracket <2>");
  });

  it("lists each source document once", () => {
    let a = insert(createAssembly(), "d1").assembly;
    a = insert(a, "d2").assembly;
    a = insert(a, "d1").assembly;
    expect(referencedDocIds(a)).toEqual(["d1", "d2"]);
  });

  it("an assembly with an instance is no longer a starter", () => {
    expect(isStarterAssembly(createAssembly())).toBe(true);
    expect(isStarterAssembly(insert().assembly)).toBe(false);
  });
});

describe("editing instances", () => {
  it("moves by a world motion applied after the current placement", () => {
    let a = insert(insert().assembly).assembly;
    const free = a.instances[1].id;
    a = moveInstance(a, free, translation([10, 0, 0]));
    a = moveInstance(a, free, translation([0, 5, 0]));
    expect(a.instances[1].transform.slice(12, 15)).toEqual([10, 5, 0]);
  });

  it("won't move a grounded instance", () => {
    const a = insert().assembly;
    expect(moveInstance(a, a.instances[0].id, translation([1, 0, 0]))).toBe(a);
  });

  it("drops cleared flags rather than saving them as false", () => {
    let a = insert().assembly;
    const id = a.instances[0].id;
    a = updateInstance(a, id, { grounded: false, hidden: true });
    expect("grounded" in a.instances[0]).toBe(false);
    expect(a.instances[0].hidden).toBe(true);
    a = updateInstance(a, id, { hidden: false });
    expect("hidden" in a.instances[0]).toBe(false);
  });
});

describe("migrateAssembly", () => {
  it("fills arrays older saves lack", () => {
    expect(migrateAssembly({ instances: [] })).toEqual(createAssembly());
  });

  it("rejects an instance without a placement", () => {
    const bad = { instances: [{ id: "x", name: "X", source: { docId: "d", partId: "p" }, transform: [1, 2] }] };
    expect(() => migrateAssembly(bad)).toThrow(/corrupt/);
  });

  it("rejects a mate of an unknown type", () => {
    const m = { id: "m", name: "M", type: "glue", a: side("x"), b: side("y") };
    expect(() => migrateAssembly({ instances: [], mates: [m] })).toThrow(/corrupt/);
  });

  it("requires a width mate's second faces", () => {
    const m = { ...mateOf("m", "x", "y"), type: "width" as const };
    expect(() => migrateAssembly({ instances: [], mates: [m] })).toThrow(/corrupt/);
    const both = { ...m, a: { ...m.a, ref2: { kind: "face" as const, name: "g" } }, b: { ...m.b, ref2: m.a.ref } };
    expect(migrateAssembly({ instances: [], mates: [both] }).mates).toEqual([both]);
  });

  it("keeps well-formed mates", () => {
    const m = mateOf("m", "x", "y");
    expect(migrateAssembly({ instances: [], mates: [m] }).mates).toEqual([m]);
  });
});

const side = (instanceId: string) => ({
  instanceId,
  ref: { kind: "face" as const, name: "f" },
  anchor: "center" as const,
});
const mateOf = (id: string, a: string, b: string): Mate => ({
  id,
  name: id,
  type: "revolute",
  a: side(a),
  b: side(b),
});

describe("mates", () => {
  it("names mates by type, lowest number free", () => {
    let a = addMate(createAssembly(), { ...mateOf("m1", "x", "y"), name: "Revolute 1" });
    a = addMate(a, { ...mateOf("m2", "x", "y"), name: "Revolute 3" });
    expect(nextMateName(a, "revolute")).toBe("Revolute 2");
    expect(nextMateName(a, "slider")).toBe("Slider 1");
  });

  it("updates and removes mates by id", () => {
    let a = addMate(createAssembly(), mateOf("m1", "x", "y"));
    a = updateMate(a, { ...a.mates[0], values: { rz: "45" } });
    expect(a.mates[0].values).toEqual({ rz: "45" });
    expect(updateMate(a, mateOf("nope", "x", "y"))).toBe(a);
    expect(removeMates(a, ["m1"]).mates).toEqual([]);
  });

  it("removing an instance removes its mates", () => {
    let { assembly: a } = insert(createAssembly(), "d1", ["A", "B", "C"]);
    const [x, y, z] = a.instances.map((i) => i.id);
    a = addMate(addMate(a, mateOf("m1", x, y)), mateOf("m2", y, z));
    a = removeInstances(a, [x]);
    expect(a.mates.map((m) => m.id)).toEqual(["m2"]);
  });

  it("keeps solved placements as the instances' own", () => {
    const { assembly: a } = insert(createAssembly(), "d1", ["A", "B"]);
    const moved = translation([0, 0, 20]);
    const kept = keepPlacements(a, new Map([[a.instances[1].id, moved]]));
    expect(kept.instances[1].transform).toEqual(moved);
    expect(kept.instances[0]).toBe(a.instances[0]);
    // Nothing moved: the same object back.
    expect(keepPlacements(a, new Map([[a.instances[0].id, IDENTITY]]))).toBe(a);
  });
});

describe("connectorWarnings", () => {
  const c = (instanceId: string, name: string, extra = {}) => ({
    instanceId,
    ref: { kind: "face" as const, name },
    anchor: "center" as const,
    ...extra,
  });
  const a = {
    instances: [
      { id: "A", name: "Base <1>", source: { docId: "d", partId: "p" }, transform: [] },
      { id: "B", name: "Arm <1>", source: { docId: "d", partId: "p" }, transform: [] },
    ],
    mates: [
      { id: "m1", name: "Planar 1", type: "planar" as const, a: c("A", "top"), b: c("B", "bottom") },
      {
        id: "m2",
        name: "Width 1",
        type: "width" as const,
        a: c("A", "f1", { ref2: { kind: "face", name: "f2" } }),
        b: c("B", "g1"),
      },
    ],
    variables: [],
  };

  it("flags each mate with a re-found connector once, naming the part", () => {
    const w = connectorWarnings(a, (_id, ref) => ref.name === "bottom" || ref.name === "f2");
    expect([...w.keys()]).toEqual(["m1", "m2"]);
    expect(w.get("m1")).toMatch(/face on Arm <1>/);
    // A width mate's second face counts too.
    expect(w.get("m2")).toMatch(/face on Base <1>/);
  });

  it("is empty when every connector resolved by name", () => {
    expect(connectorWarnings(a, () => false).size).toBe(0);
  });
});
