import { strFromU8, unzipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { exportAssemblyFile, exportPieces, partFiles, to3mf, toStl, weld, type ExportPiece } from "./exportAssembly";
import { IDENTITY, translation } from "./placement";
import type { AssemblyDoc, Instance } from "./types";
import type { SourceState } from "./useAssemblySources";
import type { ShapeMeshPayload } from "../kernel/types";

/** A `s` mm cube, tessellated face by face as the kernel does: each face has
 *  its own four vertices, so every edge's corners appear twice. */
function cube(s: number): ShapeMeshPayload {
  const P = (x: number, y: number, z: number) => [x * s, y * s, z * s];
  const quads = [
    [P(0, 0, 0), P(0, 1, 0), P(1, 1, 0), P(1, 0, 0)],
    [P(0, 0, 1), P(1, 0, 1), P(1, 1, 1), P(0, 1, 1)],
    [P(0, 0, 0), P(1, 0, 0), P(1, 0, 1), P(0, 0, 1)],
    [P(0, 1, 0), P(0, 1, 1), P(1, 1, 1), P(1, 1, 0)],
    [P(0, 0, 0), P(0, 0, 1), P(0, 1, 1), P(0, 1, 0)],
    [P(1, 0, 0), P(1, 1, 0), P(1, 1, 1), P(1, 0, 1)],
  ];
  const vertices: number[] = [];
  const triangles: number[] = [];
  quads.forEach((q) => {
    const b = vertices.length / 3;
    for (const p of q) vertices.push(...p);
    triangles.push(b, b + 1, b + 2, b, b + 2, b + 3);
  });
  return {
    name: "cube",
    faces: { vertices: new Float32Array(vertices), triangles: new Uint32Array(triangles) },
    edges: { lines: new Float32Array() },
  } as ShapeMeshPayload;
}

const inst = (id: string, partId: string, extra: Partial<Instance> = {}): Instance => ({
  id,
  name: id,
  source: { docId: "d", partId },
  transform: IDENTITY,
  ...extra,
});
const sources = new Map<string, SourceState>([
  [
    "d",
    {
      status: "ready",
      name: "Hardware",
      updatedAt: 1,
      parts: [
        { partId: "bolt", name: "Bolt", color: 0xff0000, opacity: 1, mesh: cube(2) },
        { partId: "plate", name: "Plate", color: 0x00ff00, opacity: 1, mesh: cube(10) },
      ],
    },
  ],
]);
const assembly: AssemblyDoc = {
  instances: [
    inst("Plate <1>", "plate"),
    inst("Bolt <1>", "bolt", { transform: translation([20, 0, 0]) }),
    inst("Bolt <2>", "bolt", { transform: translation([30, 0, 0]), color: 0x0000ff }),
    inst("Bolt <3>", "bolt", { hidden: true }),
    inst("Gone <1>", "missing"),
  ],
  mates: [],
  variables: [],
};
const pieces = (): ExportPiece[] => exportPieces(assembly, sources, new Map([["Bolt <1>", translation([25, 0, 0])]]));

describe("exportPieces", () => {
  it("takes the visible instances whose part has loaded, where the solver put them", () => {
    const p = pieces();
    expect(p.map((x) => x.name)).toEqual(["Plate <1>", "Bolt <1>", "Bolt <2>"]);
    expect(p[1].transform[12]).toBe(25); // solved
    expect(p[2].transform[12]).toBe(30); // its own
    expect(p.map((x) => x.color)).toEqual([0x00ff00, 0xff0000, 0x0000ff]);
  });
});

describe("weld", () => {
  it("shares each corner once, so every edge joins exactly two triangles", () => {
    const w = weld(cube(10), translation([5, 0, 0]));
    expect(w.positions.length / 3).toBe(8);
    expect(w.indices.length / 3).toBe(12);
    const edges = new Map<string, number>();
    for (let k = 0; k < w.indices.length; k += 3)
      for (const [a, b] of [
        [w.indices[k], w.indices[k + 1]],
        [w.indices[k + 1], w.indices[k + 2]],
        [w.indices[k + 2], w.indices[k]],
      ]) {
        const key = a < b ? `${a}-${b}` : `${b}-${a}`;
        edges.set(key, (edges.get(key) ?? 0) + 1);
      }
    expect([...edges.values()].every((n) => n === 2)).toBe(true);
    // Moved by the placement.
    expect(Math.min(...Array.from(w.positions).filter((_, i) => i % 3 === 0))).toBe(5);
  });
});

describe("toStl", () => {
  it("writes a binary STL of every triangle", () => {
    const b = toStl([weld(cube(1)), weld(cube(1), translation([3, 0, 0]))], "Two");
    const dv = new DataView(b.buffer);
    expect(dv.getUint32(80, true)).toBe(24);
    expect(b.length).toBe(84 + 50 * 24);
    expect(strFromU8(b.subarray(0, 3))).toBe("Two");
    // The first triangle's normal is a unit vector.
    const n = [0, 1, 2].map((i) => dv.getFloat32(84 + 4 * i, true));
    expect(Math.hypot(...n)).toBeCloseTo(1);
  });
});

describe("to3mf", () => {
  it("packages each instance as a named, coloured object where it sits", () => {
    const files = unzipSync(to3mf(pieces(), "Bracket & bolts"));
    expect(Object.keys(files).sort()).toEqual(["3D/3dmodel.model", "[Content_Types].xml", "_rels/.rels"]);
    const model = strFromU8(files["3D/3dmodel.model"]);
    expect(model).toContain('unit="millimeter"');
    expect(model).toContain('<metadata name="Title">Bracket &amp; bolts</metadata>');
    expect(model.match(/<object /g)).toHaveLength(3);
    expect(model.match(/<item /g)).toHaveLength(3);
    expect(model).toContain('name="Bolt &lt;1&gt;"');
    // Three colours, each object pointing at its own.
    expect(model).toContain('displaycolor="#00FF00FF"');
    expect(model).toContain('displaycolor="#0000FFFF"');
    expect(model).toMatch(/name="Bolt &lt;2&gt;" pid="1" pindex="2"/);
    // The solved bolt's vertices start at x = 25: its placement baked in.
    const bolt = model.split('name="Bolt &lt;1&gt;"')[1].split("</object>")[0];
    const xs = [...bolt.matchAll(/<vertex x="([-\d.]+)"/g)].map((m) => Number(m[1]));
    expect(Math.min(...xs)).toBe(25);
    expect(xs).toHaveLength(8);
  });
});

describe("partFiles and the parts zip", () => {
  it("names each distinct part once, with how many", () => {
    expect(partFiles(pieces()).map((f) => [f.name, f.count])).toEqual([
      ["Plate.stl", 1],
      ["Bolt ×2.stl", 2],
    ]);
  });

  it("keeps names safe and unique", () => {
    const p = pieces();
    const odd = [
      { ...p[0], partKey: "a", partName: "A/B" },
      { ...p[0], partKey: "b", partName: "a:b" },
    ];
    expect(partFiles(odd).map((f) => f.name)).toEqual(["A-B.stl", "a-b (2).stl"]);
  });

  it("zips one STL per part, each in its own coordinates", () => {
    const f = exportAssemblyFile("stl-parts", pieces(), "Bracket");
    expect(f).toMatchObject({ type: "application/zip", extension: "zip" });
    const files = unzipSync(f.bytes);
    expect(Object.keys(files)).toEqual(["Plate.stl", "Bolt ×2.stl"]);
    const bolt = new DataView(files["Bolt ×2.stl"].buffer, files["Bolt ×2.stl"].byteOffset);
    expect(bolt.getUint32(80, true)).toBe(12);
    // Unplaced: its x stays within its own 2 mm.
    const x = bolt.getFloat32(84 + 12, true);
    expect(x).toBeGreaterThanOrEqual(0);
    expect(x).toBeLessThanOrEqual(2);
  });

  it("merges the assembled STL", () => {
    const f = exportAssemblyFile("stl", pieces(), "Bracket");
    expect(f.extension).toBe("stl");
    expect(new DataView(f.bytes.buffer).getUint32(80, true)).toBe(36);
  });
});
