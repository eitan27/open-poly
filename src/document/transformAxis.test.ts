import { describe, it, expect } from "vitest";
import { addSketch, addSketchEntities, addTransform, createDocument, resolveDocument, setTransform } from "./document";
import { transformAxisLabel, transformAxisLine, type AxisMesh } from "./transformAxis";
import type { Document, TransformFeature } from "./types";
import type { MeshedEdges } from "../kernel/types";

/** A meshed body carrying one polyline edge, named. */
function bodyWithEdge(id: string, name: string, pts: number[][]): AxisMesh {
  const lines = new Float32Array(pts.flat());
  const edges: MeshedEdges = {
    lines,
    edgeGroups: [{ edgeId: 7, start: 0, count: pts.length, name }],
  } as unknown as MeshedEdges;
  return { id, mesh: { edges } };
}

const PIVOT: [number, number, number] = [10, 20, 30];
const resolvedTransform = (doc: Document, id: string) =>
  resolveDocument(doc).features.find((f) => f.id === id) as Extract<
    ReturnType<typeof resolveDocument>["features"][number],
    { type: "transform" }
  >;

describe("transformAxisLine (the gizmo's view of the axis)", () => {
  const empty = createDocument();

  it("puts a world axis through the pivot, so the body spins on the spot", () => {
    expect(transformAxisLine("x", PIVOT, empty, new Map(), [])).toEqual({ origin: PIVOT, dir: [1, 0, 0] });
    expect(transformAxisLine("y", PIVOT, empty, new Map(), [])).toEqual({ origin: PIVOT, dir: [0, 1, 0] });
    expect(transformAxisLine("z", PIVOT, empty, new Map(), [])).toEqual({ origin: PIVOT, dir: [0, 0, 1] });
  });

  it("gives a body edge its OWN line — the axis is the edge, not the pivot", () => {
    const meshes = [
      bodyWithEdge("b1", "b1/e", [
        [0, 5, 0],
        [4, 5, 0],
      ]),
    ];
    const line = transformAxisLine(
      { edge: { featureId: "b1", edgeId: 7, edgeName: "b1/e" } },
      PIVOT,
      empty,
      new Map(),
      meshes,
    );
    expect(line).toEqual({ origin: [0, 5, 0], dir: [1, 0, 0] });
    expect(line!.origin).not.toEqual(PIVOT); // the difference between a hinge and a spin
  });

  it("finds the edge by NAME even when its id has churned", () => {
    const meshes = [
      bodyWithEdge("b1", "b1/e", [
        [0, 0, 0],
        [0, 0, 2],
      ]),
    ];
    const stale = { edge: { featureId: "b1", edgeId: 999, edgeName: "b1/e" } } as const;
    expect(transformAxisLine(stale, PIVOT, empty, new Map(), meshes)?.dir).toEqual([0, 0, 1]);
  });

  it("refuses a curved edge — it has no single direction to turn about", () => {
    const arc = bodyWithEdge("b1", "b1/arc", [
      [0, 0, 0],
      [1, 1, 0],
      [2, 0, 0],
    ]);
    expect(
      transformAxisLine({ edge: { featureId: "b1", edgeId: 7, edgeName: "b1/arc" } }, PIVOT, empty, new Map(), [arc]),
    ).toBeNull();
  });

  it("returns null for a reference that no longer resolves", () => {
    expect(transformAxisLine({ edge: { featureId: "gone", edgeId: 7 } }, PIVOT, empty, new Map(), [])).toBeNull();
    expect(transformAxisLine({ sketchId: "gone", entityId: "e" }, PIVOT, empty, new Map(), [])).toBeNull();
  });

  it("reads a sketch line as the world line it draws", () => {
    const { doc: base, id: sketchId } = addSketch(createDocument(), { kind: "datum", id: "plane-top" });
    const doc = addSketchEntities(base, sketchId, [{ type: "line", id: "L", a: [0, 0], b: [0, 4] }]);
    const line = transformAxisLine({ sketchId, entityId: "L" }, PIVOT, doc, new Map(), []);
    expect(line?.origin).toEqual([0, 0, 0]);
    expect(line?.dir).toEqual([0, 1, 0]); // +v on the top plane is world +Y
  });

  it("labels a picked axis by its owner, and leaves a world axis to the buttons", () => {
    const meshes = [
      bodyWithEdge("b1", "b1/e", [
        [0, 0, 0],
        [1, 0, 0],
      ]),
    ];
    const doc = { ...createDocument(), features: [{ id: "b1", name: "Bracket" } as never] };
    expect(transformAxisLabel("z", doc)).toBeNull();
    expect(transformAxisLabel({ edge: { featureId: "b1", edgeId: 7 } }, doc)).toBe("Bracket · edge");
    expect(meshes.length).toBe(1);
  });
});

describe("transform axis → the kernel", () => {
  it("bakes a world axis to the pivot plus that direction", () => {
    const { doc, id } = addTransform(createDocument(), "b1", PIVOT, { angle: "90", axis: "y" });
    const r = resolvedTransform(doc, id);
    expect(r.axisOrigin).toEqual(PIVOT);
    expect(r.axisDir).toEqual([0, 1, 0]);
    expect(r.axisEdge).toBeUndefined();
  });

  it("bakes a sketch line to its own world line, NOT through the pivot", () => {
    const base = addSketch(createDocument(), { kind: "datum", id: "plane-top" });
    const withLine = addSketchEntities(base.doc, base.id, [{ type: "line", id: "L", a: [3, 0], b: [3, 5] }]);
    const { doc, id } = addTransform(withLine, "b1", PIVOT, {
      angle: "90",
      axis: { sketchId: base.id, entityId: "L" },
    });
    const r = resolvedTransform(doc, id);
    expect(r.axisOrigin).toEqual([3, 0, 0]);
    expect(r.axisDir).toEqual([0, 5, 0]);
  });

  it("carries a body edge through for the worker to read out of the B-rep", () => {
    const { doc, id } = addTransform(createDocument(), "b1", PIVOT, {
      angle: "90",
      axis: { edge: { featureId: "b1", edgeId: 7, edgeName: "b1/e", mid: [0, 0, 0], length: 4 } },
    });
    const r = resolvedTransform(doc, id);
    expect(r.axisEdge).toEqual({ sourceId: "b1", edgeName: "b1/e", mid: [0, 0, 0], length: 4 });
    expect(r.axisOrigin).toBeUndefined();
  });

  it("errors on a sketch-line axis whose entity is not a line", () => {
    const base = addSketch(createDocument(), { kind: "datum", id: "plane-top" });
    const withCircle = addSketchEntities(base.doc, base.id, [{ type: "circle", id: "C", c: [0, 0], r: 2 }]);
    const { doc, id } = addTransform(withCircle, "b1", PIVOT, { axis: { sketchId: base.id, entityId: "C" } });
    const res = resolveDocument(doc);
    expect(res.features.find((f) => f.id === id)).toBeUndefined();
    expect(res.errors[id]).toMatch(/must be a line/);
  });

  it("keeps a legacy document's bare-string axis working", () => {
    const { doc, id } = addTransform(createDocument(), "b1", PIVOT, {});
    expect((doc.features.find((f) => f.id === id) as TransformFeature).axis).toBe("z");
    expect(resolvedTransform(doc, id).axisDir).toEqual([0, 0, 1]);
  });

  it("switches between a world axis and a picked one through setTransform", () => {
    const { doc, id } = addTransform(createDocument(), "b1", PIVOT, {});
    const picked = setTransform(doc, id, { axis: { edge: { featureId: "b1", edgeId: 7, edgeName: "b1/e" } } });
    expect(resolvedTransform(picked, id).axisEdge?.edgeName).toBe("b1/e");
    const back = setTransform(picked, id, { axis: "x" });
    expect(resolvedTransform(back, id).axisDir).toEqual([1, 0, 0]);
  });
});
