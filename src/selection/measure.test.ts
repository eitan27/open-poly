import { describe, it, expect } from "vitest";
import { measureSelection } from "./measure";
import { detectSketchRegions } from "../document/regions";
import type { Document, SketchEntity } from "../document/types";
import type { FaceSurface } from "../kernel/types";
import type { FeatureMesh, Selection } from "../viewport/Viewport";

const doc: Document = { features: [] } as unknown as Document;

/** A body whose edges are the given polylines, as a line-segment buffer (the
 *  format the tessellator emits: consecutive vertex PAIRS per segment). */
function body(id: string, polylines: [number, number, number][][]): FeatureMesh {
  const lines: number[] = [];
  const edgeGroups: { start: number; count: number; edgeId: number }[] = [];
  polylines.forEach((pts, edgeId) => {
    const start = lines.length / 3;
    for (let i = 0; i + 1 < pts.length; i++) lines.push(...pts[i], ...pts[i + 1]);
    edgeGroups.push({ start, count: lines.length / 3 - start, edgeId });
  });
  return {
    id,
    mesh: { name: id, faces: { vertices: [], triangles: [] }, edges: { lines, edgeGroups } },
    color: 0,
    opacity: 1,
  } as unknown as FeatureMesh;
}

const pick = (featureId: string, edgeId: number): Selection => ({ kind: "edge", featureId, edgeId });
const distanceOf = (meshes: FeatureMesh[], sel: Selection[]) =>
  measureSelection(sel, doc, meshes)?.rows.find((r) => r.label === "Parallel distance")?.value;

/** A body with one face carrying the given analytic surface (or none). The
 *  surface comes from the kernel, so here we just assert how it's read out. */
function faceBody(surface?: FaceSurface): FeatureMesh {
  return {
    id: "f",
    mesh: {
      name: "f",
      // One unit triangle, so Area is a real number rather than a special case.
      faces: {
        vertices: [0, 0, 0, 1, 0, 0, 0, 1, 0],
        triangles: [0, 1, 2],
        faceGroups: [{ start: 0, count: 3, faceId: 7, surface }],
      },
      edges: { lines: [], edgeGroups: [] },
    },
    color: 0,
    opacity: 1,
  } as unknown as FeatureMesh;
}
const faceRows = (surface?: FaceSurface) =>
  measureSelection([{ kind: "face", featureId: "f", faceId: 7 }], doc, [faceBody(surface)])?.rows;

/** A doc holding one sketch (id "sk") with the given entities. */
function sketchDoc(entities: SketchEntity[]): Document {
  return { features: [{ id: "sk", type: "sketch", plane: { datum: "top" }, entities }] } as unknown as Document;
}
/** The sketchFace selection for the first region these entities enclose. */
const firstRegionSel = (entities: SketchEntity[]): Selection =>
  ({ kind: "sketchFace", sketchId: "sk", regionId: detectSketchRegions(entities)[0].id }) as unknown as Selection;

describe("sketch circle entity", () => {
  const sel = { kind: "sketchEntity", sketchId: "sk", entityId: "c" } as unknown as Selection;
  it("shows the diameter only, not the radius", () => {
    const d = sketchDoc([{ type: "circle", id: "c", c: [0, 0], r: 4 }]);
    expect(measureSelection([sel], d, [])).toEqual({ title: "Circle", rows: [{ label: "Diameter", value: "8" }] });
  });
});

describe("circular sketch face", () => {
  it("shows area and diameter for a region bounded by one circle", () => {
    const entities: SketchEntity[] = [{ type: "circle", id: "c", c: [0, 0], r: 5 }];
    const info = measureSelection([firstRegionSel(entities)], sketchDoc(entities), []);
    expect(info?.title).toBe("Sketch face");
    expect(info?.rows).toContainEqual({ label: "Diameter", value: "10" });
    expect(info?.rows.some((r) => r.label === "Area")).toBe(true);
  });

  it("shows only area for a non-circular region", () => {
    // A triangle — three lines, no circular boundary.
    const entities: SketchEntity[] = [
      { type: "line", id: "l1", a: [0, 0], b: [10, 0] },
      { type: "line", id: "l2", a: [10, 0], b: [0, 10] },
      { type: "line", id: "l3", a: [0, 10], b: [0, 0] },
    ];
    const info = measureSelection([firstRegionSel(entities)], sketchDoc(entities), []);
    expect(info?.rows.every((r) => r.label !== "Diameter")).toBe(true);
    expect(info?.rows.some((r) => r.label === "Area")).toBe(true);
  });
});

/** A body with one named face (no analytic surface — like a faceted extrude). */
function namedFaceBody(id: string, faceName: string): FeatureMesh {
  return {
    id,
    mesh: {
      name: id,
      faces: {
        vertices: [0, 0, 0, 1, 0, 0, 0, 1, 0],
        triangles: [0, 1, 2],
        faceGroups: [{ start: 0, count: 3, faceId: 7, name: faceName }],
      },
      edges: { lines: [], edgeGroups: [] },
    },
    color: 0,
    opacity: 1,
  } as unknown as FeatureMesh;
}
/** A doc with a circle sketch (id "sk") and an extrude of it (id "ext"). */
function circleExtrudeDoc(entity: SketchEntity, vars: { name: string; value: number }[] = []): Document {
  const regionId = detectSketchRegions([entity])[0].id;
  return {
    features: [
      { id: "sk", type: "sketch", plane: { datum: "top" }, entities: [entity] },
      { id: "ext", type: "extrude", profile: { kind: "sketchRegion", sketchId: "sk", regionId } },
    ],
    variables: vars,
  } as unknown as Document;
}
const traceDiameter = (d: Document, faceName: string, scope = {}) =>
  measureSelection([{ kind: "face", featureId: "body", faceId: 7 } as unknown as Selection], d, [namedFaceBody("body", faceName)], scope)
    ?.rows.find((r) => r.label === "Diameter")?.value;

describe("faceted extruded-circle diameter (traced to the sketch)", () => {
  const d = circleExtrudeDoc({ type: "circle", id: "c", c: [0, 0], r: 5 });
  it("shows a diameter on the start cap", () => expect(traceDiameter(d, "ext/start")).toBe("10"));
  it("shows a diameter on the end cap", () => expect(traceDiameter(d, "ext/end")).toBe("10"));
  it("shows a diameter on a wall facet", () => expect(traceDiameter(d, "ext/side7")).toBe("10"));
  it("shows a diameter on a re-matched (suffixed) name", () => expect(traceDiameter(d, "ext/side7#1")).toBe("10"));
  it("shows nothing when the face belongs to another feature", () =>
    expect(traceDiameter(d, "otherFeature/+z")).toBeUndefined());
  it("shows nothing for a name without a feature prefix", () => expect(traceDiameter(d, "f3")).toBeUndefined());

  it("re-evaluates a variable-driven radius against the scope", () => {
    // r = "dia/2"; the stored literal (5) is stale — the scope drives it.
    const dv = circleExtrudeDoc({ type: "circle", id: "c", c: [0, 0], r: 5, exprs: { r: "dia/2" } });
    expect(traceDiameter(dv, "ext/start", { dia: 20 })).toBe("20");
  });

  it("does not trace a non-circular extrude", () => {
    const rect: SketchEntity[] = [
      { type: "line", id: "l1", a: [0, 0], b: [10, 0] },
      { type: "line", id: "l2", a: [10, 0], b: [0, 10] },
      { type: "line", id: "l3", a: [0, 10], b: [0, 0] },
    ];
    const rd = {
      features: [
        { id: "sk", type: "sketch", plane: { datum: "top" }, entities: rect },
        { id: "ext", type: "extrude", profile: { kind: "sketchRegion", sketchId: "sk", regionId: detectSketchRegions(rect)[0].id } },
      ],
    } as unknown as Document;
    expect(traceDiameter(rd, "ext/start")).toBeUndefined();
  });
});

describe("diameter of a circular face", () => {
  it("shows the diameter of a cylindrical face (a hole's bore)", () => {
    expect(faceRows({ kind: "cylinder", radius: 4 })).toContainEqual({ label: "Diameter", value: "8" });
  });

  it("shows the diameter of a flat disc face", () => {
    expect(faceRows({ kind: "disc", radius: 6 })).toContainEqual({ label: "Diameter", value: "12" });
  });

  it("shows both diameters of an annulus, outer first", () => {
    expect(faceRows({ kind: "annulus", radius: 13, innerRadius: 9 })).toEqual([
      { label: "Area", value: "0.5" },
      { label: "Outer diameter", value: "26" },
      { label: "Inner diameter", value: "18" },
    ]);
  });

  it("shows only the area for a face with no analytic surface", () => {
    expect(faceRows(undefined)).toEqual([{ label: "Area", value: "0.5" }]);
  });

  it("keeps showing the area alongside a diameter", () => {
    expect(faceRows({ kind: "cylinder", radius: 4 })).toEqual([
      { label: "Area", value: "0.5" },
      { label: "Diameter", value: "8" },
    ]);
  });

  it("formats a fractional diameter", () => {
    expect(faceRows({ kind: "cylinder", radius: 1.6 })).toContainEqual({ label: "Diameter", value: "3.2" });
  });
});

describe("distance between two parallel edges", () => {
  it("measures two parallel edges of a box", () => {
    // Two bottom edges of a 10-wide box, 10 apart in Y.
    const b = body("b", [
      [[0, 0, 0], [10, 0, 0]],
      [[0, 10, 0], [10, 10, 0]],
    ]);
    expect(distanceOf([b], [pick("b", 0), pick("b", 1)])).toBe("10");
  });

  it("measures parallel edges that do not overlap along their direction", () => {
    // Offset along X too — the perpendicular distance is unaffected.
    const b = body("b", [
      [[0, 0, 0], [10, 0, 0]],
      [[50, 3, 4], [60, 3, 4]],
    ]);
    expect(distanceOf([b], [pick("b", 0), pick("b", 1)])).toBe("5"); // hypot(3,4)
  });

  it("measures anti-parallel edges (opposite direction, same axis)", () => {
    // Edge loops wind consistently, so facing edges of a face often oppose.
    const b = body("b", [
      [[0, 0, 0], [10, 0, 0]],
      [[10, 7, 0], [0, 7, 0]],
    ]);
    expect(distanceOf([b], [pick("b", 0), pick("b", 1)])).toBe("7");
  });

  it("measures across two different bodies", () => {
    const a = body("a", [[[0, 0, 0], [10, 0, 0]]]);
    const c = body("c", [[[0, 0, 6], [10, 0, 6]]]);
    expect(distanceOf([a, c], [pick("a", 0), pick("c", 0)])).toBe("6");
  });

  it("reports 0 for collinear edges", () => {
    const b = body("b", [
      [[0, 0, 0], [10, 0, 0]],
      [[20, 0, 0], [30, 0, 0]],
    ]);
    expect(distanceOf([b], [pick("b", 0), pick("b", 1)])).toBe("0");
  });

  it("omits the distance for non-parallel edges", () => {
    const b = body("b", [
      [[0, 0, 0], [10, 0, 0]],
      [[0, 0, 0], [0, 10, 0]],
    ]);
    expect(distanceOf([b], [pick("b", 0), pick("b", 1)])).toBeUndefined();
  });

  it("omits the distance for skew (non-parallel, non-intersecting) edges", () => {
    const b = body("b", [
      [[0, 0, 0], [10, 0, 0]],
      [[0, 0, 5], [0, 10, 5]],
    ]);
    expect(distanceOf([b], [pick("b", 0), pick("b", 1)])).toBeUndefined();
  });

  it("omits the distance when an edge is curved", () => {
    // A tessellated quarter arc — parallel to nothing.
    const arc: [number, number, number][] = [];
    for (let i = 0; i <= 8; i++) {
      const t = (i / 8) * (Math.PI / 2);
      arc.push([10 * Math.cos(t), 10 * Math.sin(t), 0]);
    }
    const b = body("b", [[[0, -5, 0], [10, -5, 0]], arc]);
    expect(distanceOf([b], [pick("b", 0), pick("b", 1)])).toBeUndefined();
  });

  it("treats a multi-segment straight edge as straight", () => {
    // A straight edge may tessellate into several collinear segments.
    const b = body("b", [
      [[0, 0, 0], [5, 0, 0], [10, 0, 0]],
      [[0, 4, 0], [10, 4, 0]],
    ]);
    expect(distanceOf([b], [pick("b", 0), pick("b", 1)])).toBe("4");
  });

  it("omits the distance unless exactly two edges are selected", () => {
    const b = body("b", [
      [[0, 0, 0], [10, 0, 0]],
      [[0, 4, 0], [10, 4, 0]],
      [[0, 8, 0], [10, 8, 0]],
    ]);
    expect(distanceOf([b], [pick("b", 0), pick("b", 1), pick("b", 2)])).toBeUndefined();
  });

  it("reports just the count and the distance, nothing else", () => {
    const b = body("b", [
      [[0, 0, 0], [10, 0, 0]],
      [[0, 4, 0], [10, 4, 0]],
    ]);
    const rows = measureSelection([pick("b", 0), pick("b", 1)], doc, [b])!.rows;
    expect(rows).toEqual([
      { label: "Selected", value: "2" },
      { label: "Parallel distance", value: "4" },
    ]);
  });
});
