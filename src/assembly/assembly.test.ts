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
} from "./assembly";
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
});
