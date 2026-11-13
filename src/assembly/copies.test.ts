import { describe, expect, it } from "vitest";
import { createAssembly } from "./assembly";
import { duplicateInstances, gridMoves, insertLayout, placedBounds } from "./copies";
import { IDENTITY, multiply, translation } from "./placement";
import { rotZ } from "./solve";
import type { AssemblyDoc, Mat4 } from "./types";
import type { ShapeMeshPayload } from "../kernel/types";

/** A box mesh from `o`, sides `s` (only its vertices matter here). */
const boxMesh = (o: [number, number, number], s: [number, number, number]): ShapeMeshPayload =>
  ({
    name: "b",
    faces: {
      vertices: new Float32Array([...o, o[0] + s[0], o[1] + s[1], o[2] + s[2]]),
      triangles: new Uint32Array(),
    },
    edges: { lines: new Float32Array() },
  }) as ShapeMeshPayload;
const at = (m: Mat4): [number, number, number] => [m[12], m[13], m[14]];

describe("gridMoves", () => {
  it("lays n copies in about √n columns, a gap apart", () => {
    const { moves, width } = gridMoves(8, { min: [0, 0, 0], max: [5, 2, 1] }, 100, 10);
    // 3 columns 15 apart, rows 12 apart.
    expect(moves.map(at)).toEqual([
      [100, 0, 0],
      [115, 0, 0],
      [130, 0, 0],
      [100, 12, 0],
      [115, 12, 0],
      [130, 12, 0],
      [100, 24, 0],
      [115, 24, 0],
    ]);
    expect(width).toBe(45);
  });
  it("puts the grid's left edge where asked, whatever the part's own origin", () => {
    expect(at(gridMoves(1, { min: [-7, 0, 0], max: [3, 1, 1] }, 20, 10).moves[0])).toEqual([27, 0, 0]);
  });
});

describe("insertLayout", () => {
  const bolt = { partId: "bolt", name: "Bolt", mesh: boxMesh([0, 0, 0], [4, 4, 20]), count: 1 };
  const nut = { partId: "nut", name: "Nut", mesh: boxMesh([10, 0, 0], [6, 6, 3]), count: 1 };
  const placed = [{ min: [0, 0, 0] as [number, number, number], max: [50, 50, 10] as [number, number, number] }];

  it("keeps the document's arrangement when every part is wanted once", () => {
    const l = insertLayout(placed, [bolt, nut]);
    // One shift for both: past x = 50 by the gap, from the bolt's x = 0.
    expect(l.map((x) => [x.partId, ...at(x.transform)])).toEqual([
      ["bolt", 60, 0, 0],
      ["nut", 60, 0, 0],
    ]);
  });

  it("gives each part's copies a grid, side by side past what's placed", () => {
    const l = insertLayout(placed, [
      { ...bolt, count: 4 },
      { ...nut, count: 2 },
    ]);
    expect(l.map((x) => [x.partId, ...at(x.transform)])).toEqual([
      // Bolts: 2 columns 14 apart, rows 14 apart, from x = 60.
      ["bolt", 60, 0, 0],
      ["bolt", 74, 0, 0],
      ["bolt", 60, 14, 0],
      ["bolt", 74, 14, 0],
      // Nuts after the bolts' 28 wide grid: left edge 88, the nut's own x = 10.
      ["nut", 78, 0, 0],
      ["nut", 94, 0, 0],
    ]);
  });

  it("leaves a part out at 0, and starts where it was modelled with nothing placed", () => {
    const l = insertLayout(
      [],
      [
        { ...bolt, count: 2 },
        { ...nut, count: 0 },
      ],
    );
    expect(l.map((x) => at(x.transform))).toEqual([
      [0, 0, 0],
      [14, 0, 0],
    ]);
  });
});

describe("duplicateInstances", () => {
  const mesh = boxMesh([0, 0, 0], [10, 4, 2]);
  const turned: Mat4 = multiply(translation([100, 0, 0]), rotZ(Math.PI / 2));
  const a: AssemblyDoc = {
    ...createAssembly(),
    instances: [
      { id: "g", name: "Base", source: { docId: "d", partId: "base" }, transform: IDENTITY, grounded: true },
      { id: "b1", name: "Bolt <1>", source: { docId: "d", partId: "bolt" }, transform: turned, color: 0xff0000 },
    ],
  };
  let n = 0;
  const genId = () => `new${++n}`;

  it("puts copies in a grid beside the original, turned as it is, in its colour, not grounded", () => {
    const r = duplicateInstances(
      a,
      ["b1"],
      3,
      (id) => a.instances.find((i) => i.id === id)!.transform,
      () => mesh,
      genId,
    );
    expect(r.ids).toHaveLength(3);
    const copies = r.assembly.instances.slice(2);
    expect(copies.map((c) => c.name)).toEqual(["Bolt <2>", "Bolt <3>", "Bolt <4>"]);
    expect(copies.every((c) => c.color === 0xff0000 && !c.grounded && c.source.partId === "bolt")).toBe(true);
    // Turned a quarter: the original spans x 96..100, y 0..10. Copies start
    // past x = 100 by the gap, 2 columns 14 apart.
    const b = (i: number) => placedBounds(mesh, copies[i].transform)!;
    expect(b(0).min[0]).toBeCloseTo(110);
    expect(b(1).min[0]).toBeCloseTo(124);
    expect(b(2).min[1]).toBeCloseTo(20);
    // Same orientation as the original.
    expect(copies[0].transform.slice(0, 12)).toEqual(turned.slice(0, 12));
  });

  it("goes past everything when something sits beside the original", () => {
    const crowded: AssemblyDoc = {
      ...a,
      instances: [
        ...a.instances,
        { id: "x", name: "Block", source: { docId: "d", partId: "x" }, transform: translation([105, 0, 0]) },
      ],
    };
    const place = (id: string) => crowded.instances.find((i) => i.id === id)!.transform;
    const r = duplicateInstances(crowded, ["b1"], 1, place, () => mesh, genId);
    // The block spans x 105..115: the copy starts past it, at 125, level with
    // the original.
    const b = placedBounds(mesh, r.assembly.instances.at(-1)!.transform)!;
    expect(b.min[0]).toBeCloseTo(125);
    expect(b.min[1]).toBeCloseTo(0);
  });

  it("names copies after the original without its number", () => {
    const named = { ...a, instances: [...a.instances, { ...a.instances[1], id: "arm", name: "Arm" }] };
    const r = duplicateInstances(
      named,
      ["arm"],
      1,
      () => IDENTITY,
      () => mesh,
      genId,
    );
    expect(r.assembly.instances.at(-1)!.name).toBe("Arm <1>");
  });

  it("copies each of several instances", () => {
    const r = duplicateInstances(
      a,
      ["g", "b1"],
      2,
      () => IDENTITY,
      () => mesh,
      genId,
    );
    expect(r.ids).toHaveLength(4);
    expect(r.assembly.instances.slice(2).map((i) => i.name)).toEqual(["Base <1>", "Base <2>", "Bolt <2>", "Bolt <3>"]);
  });
});
