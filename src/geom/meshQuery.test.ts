import { describe, expect, it } from "vitest";
import type { MeshedEdges, MeshedFaces, ShapeMeshPayload } from "../kernel/types";
import {
  bodyCenter,
  edgeFingerprint,
  edgeIdByName,
  edgeLine,
  edgeMidpoint,
  edgeNameOf,
  faceCentroid,
  faceNameOf,
  faceNormal,
  reflectionMappers,
  reverseWinding,
  rotationMappers,
  transformMeshPayload,
} from "./meshQuery";

// A unit square at z = 1, one triangle-pair face group — one real face plus the
// "missing faceId" case is all most of these need.
function boxFaces(): MeshedFaces {
  return {
    vertices: [0, 0, 1, 1, 0, 1, 1, 1, 1, 0, 1, 1],
    triangles: [0, 1, 2, 0, 2, 3],
    normals: [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1],
    faceGroups: [{ start: 0, count: 6, faceId: 7, name: "top" }],
  };
}

describe("faceCentroid", () => {
  it("averages the vertices of the face's triangle range", () => {
    expect(faceCentroid(boxFaces(), 7)).toEqual([0.5, 0.5, 1]);
  });

  it("returns null for an unknown faceId", () => {
    expect(faceCentroid(boxFaces(), 999)).toBeNull();
  });
});

describe("faceNormal", () => {
  it("returns the averaged per-vertex normal for a planar face", () => {
    const n = faceNormal(boxFaces(), 7);
    expect(n?.[0]).toBeCloseTo(0);
    expect(n?.[1]).toBeCloseTo(0);
    expect(n?.[2]).toBeCloseTo(1);
  });

  it("falls back to the geometric normal when normals are absent", () => {
    const f = boxFaces();
    delete f.normals;
    expect(faceNormal(f, 7)?.[2]).toBeCloseTo(1);
  });

  it("rejects a non-planar face group", () => {
    const f: MeshedFaces = {
      vertices: [0, 0, 0, 1, 0, 0, 1, 1, 5, 0, 1, 0],
      triangles: [0, 1, 2, 0, 2, 3],
      faceGroups: [{ start: 0, count: 6, faceId: 1 }],
    };
    expect(faceNormal(f, 1)).toBeNull();
  });

  it("returns null for an unknown faceId", () => {
    expect(faceNormal(boxFaces(), 999)).toBeNull();
  });
});

describe("bodyCenter", () => {
  it("returns the bounding-box midpoint of the whole mesh", () => {
    expect(bodyCenter(boxFaces())).toEqual([0.5, 0.5, 1]);
  });

  it("ignores the triangle buffer — an unreferenced vertex still counts", () => {
    const f = boxFaces();
    f.vertices = [...(f.vertices as number[]), 10, 0, 1];
    expect(bodyCenter(f)).toEqual([5, 0.5, 1]);
  });

  it("returns the origin for an empty mesh", () => {
    expect(bodyCenter({ vertices: [], triangles: [] })).toEqual([0, 0, 0]);
  });
});

describe("faceNameOf / edgeNameOf", () => {
  it("finds the persistent name of a known face", () => {
    expect(faceNameOf(boxFaces(), 7)).toBe("top");
  });

  it("returns undefined for an unknown face", () => {
    expect(faceNameOf(boxFaces(), 999)).toBeUndefined();
  });

  it("finds the persistent name of a known edge", () => {
    const edges: MeshedEdges = {
      lines: [0, 0, 0, 1, 0, 0],
      edgeGroups: [{ start: 0, count: 2, edgeId: 3, name: "e3" }],
    };
    expect(edgeNameOf(edges, 3)).toBe("e3");
  });
});

describe("edgeIdByName", () => {
  const edges: MeshedEdges = {
    lines: [0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 1, 0],
    edgeGroups: [
      { start: 0, count: 2, edgeId: 3, name: "top|front" },
      { start: 2, count: 2, edgeId: 4 },
    ],
  };

  it("finds the edge carrying a persistent name", () => {
    expect(edgeIdByName(edges, "top|front")).toBe(3);
  });

  it("returns undefined when no edge carries that name", () => {
    expect(edgeIdByName(edges, "top|back")).toBeUndefined();
  });
});

describe("edgeMidpoint", () => {
  it("averages the polyline's points", () => {
    const edges: MeshedEdges = { lines: [0, 0, 0, 10, 0, 0], edgeGroups: [{ start: 0, count: 2, edgeId: 1 }] };
    expect(edgeMidpoint(edges, 1)).toEqual([5, 0, 0]);
  });

  it("returns null for an unknown edge", () => {
    expect(edgeMidpoint({ lines: [], edgeGroups: [] }, 1)).toBeNull();
  });
});

describe("edgeFingerprint", () => {
  it("computes the bbox centre and arc length of a polyline", () => {
    const edges: MeshedEdges = {
      lines: [0, 0, 0, 3, 4, 0], // one 5mm segment
      edgeGroups: [{ start: 0, count: 2, edgeId: 1 }],
    };
    const fp = edgeFingerprint(edges, 1);
    expect(fp?.mid).toEqual([1.5, 2, 0]);
    expect(fp?.length).toBeCloseTo(5);
  });

  it("uses the bbox centre, not the endpoint average, so a closed edge is not on its seam", () => {
    // A square loop starting and ending at the same corner: averaging the two
    // endpoints would land on the seam, the bbox centre lands in the middle.
    const edges: MeshedEdges = {
      lines: [0, 0, 0, 2, 0, 0, 2, 2, 0, 0, 2, 0, 0, 0, 0],
      edgeGroups: [{ start: 0, count: 5, edgeId: 1 }],
    };
    const fp = edgeFingerprint(edges, 1);
    expect(fp?.mid).toEqual([1, 1, 0]);
    expect(fp?.length).toBeCloseTo(8);
  });

  it("returns null for an empty edge group", () => {
    const edges: MeshedEdges = { lines: [], edgeGroups: [{ start: 0, count: 0, edgeId: 1 }] };
    expect(edgeFingerprint(edges, 1)).toBeNull();
  });
});

describe("edgeLine", () => {
  const straight: MeshedEdges = {
    lines: [1, 0, 0, 2, 0, 0, 5, 0, 0], // collinear, three points
    edgeGroups: [{ start: 0, count: 3, edgeId: 1 }],
  };

  it("returns a point on a straight edge and its unit direction", () => {
    const l = edgeLine(straight, 1);
    expect(l?.origin).toEqual([1, 0, 0]);
    expect(l?.dir[0]).toBeCloseTo(1);
    expect(Math.hypot(...(l?.dir ?? [0, 0, 0]))).toBeCloseTo(1);
  });

  it("rejects an edge that bows away from its chord, however few points it has", () => {
    const curved: MeshedEdges = {
      lines: [0, 0, 0, 1, 1, 0, 2, 0, 0],
      edgeGroups: [{ start: 0, count: 3, edgeId: 1 }],
    };
    expect(edgeLine(curved, 1)).toBeNull();
  });

  it("returns null for a closed edge (first point == last)", () => {
    const closed: MeshedEdges = {
      lines: [0, 0, 0, 1, 0, 0, 0, 0, 0],
      edgeGroups: [{ start: 0, count: 3, edgeId: 1 }],
    };
    expect(edgeLine(closed, 1)).toBeNull();
  });

  it("returns null for an edge with fewer than two points", () => {
    expect(edgeLine({ lines: [0, 0, 0], edgeGroups: [{ start: 0, count: 1, edgeId: 1 }] }, 1)).toBeNull();
  });
});

describe("transformMeshPayload", () => {
  const mesh = (): ShapeMeshPayload => ({
    name: "m",
    faces: { vertices: [1, 2, 3], triangles: [0, 1, 2], normals: [0, 0, 1] },
    edges: { lines: [1, 2, 3] },
  });

  it("maps every vertex/normal through the given functions", () => {
    const mapPt = (p: [number, number, number]): [number, number, number] => [p[0] + 10, p[1], p[2]];
    const mapVec = (v: [number, number, number]): [number, number, number] => v;
    const out = transformMeshPayload(mesh(), mapPt, mapVec);
    expect(out.faces.vertices).toEqual([11, 2, 3]);
    expect(out.edges.lines).toEqual([11, 2, 3]);
    expect(out.faces.normals).toEqual([0, 0, 1]);
    expect(out.name).toBe("m");
  });

  it("omits normals when the source mesh has none", () => {
    const bare: ShapeMeshPayload = { name: "m", faces: { vertices: [0, 0, 0], triangles: [0] }, edges: { lines: [] } };
    const id = (p: [number, number, number]) => p;
    expect(transformMeshPayload(bare, id, id).faces.normals).toBeUndefined();
  });

  it("drops the pick groups — a ghost is never picked", () => {
    const picked: ShapeMeshPayload = {
      name: "m",
      faces: { vertices: [0, 0, 0], triangles: [0], faceGroups: [{ start: 0, count: 1, faceId: 1 }] },
      edges: { lines: [], edgeGroups: [{ start: 0, count: 0, edgeId: 1 }] },
    };
    const id = (p: [number, number, number]) => p;
    const out = transformMeshPayload(picked, id, id);
    expect(out.faces.faceGroups).toBeUndefined();
    expect(out.edges.edgeGroups).toBeUndefined();
  });

  it("keeps the winding by default and reverses it when asked (a reflection)", () => {
    const id = (p: [number, number, number]) => p;
    expect(transformMeshPayload(mesh(), id, id).faces.triangles).toEqual([0, 1, 2]);
    expect(transformMeshPayload(mesh(), id, id, true).faces.triangles).toEqual([0, 2, 1]);
  });
});

describe("reverseWinding", () => {
  it("swaps the last two corners of every triangle", () => {
    expect(reverseWinding([0, 1, 2, 3, 4, 5])).toEqual([0, 2, 1, 3, 5, 4]);
  });

  it("is its own inverse", () => {
    expect(reverseWinding(reverseWinding([7, 8, 9]))).toEqual([7, 8, 9]);
  });
});

describe("reflectionMappers", () => {
  it("mirrors a point across the plane and leaves a point on it fixed", () => {
    const { mapPt } = reflectionMappers([0, 0, 0], [0, 0, 1]);
    expect(mapPt([1, 2, 3])).toEqual([1, 2, -3]);
    expect(mapPt([1, 2, 0])).toEqual([1, 2, 0]);
  });

  it("reflects about the plane's origin, not the world's", () => {
    const { mapPt } = reflectionMappers([0, 0, 5], [0, 0, 1]);
    const p = mapPt([0, 0, 7]);
    expect(p[2]).toBeCloseTo(3);
  });

  it("mapVec ignores the origin — it is a direction, not a position", () => {
    const { mapVec } = reflectionMappers([0, 0, 5], [0, 0, 1]);
    expect(mapVec([1, 0, 1])).toEqual([1, 0, -1]);
  });
});

describe("rotationMappers", () => {
  it("rotates a point 90 degrees about the z-axis through the origin", () => {
    const { mapPt } = rotationMappers([0, 0, 0], [0, 0, 1], Math.PI / 2);
    const p = mapPt([1, 0, 0]);
    expect(p[0]).toBeCloseTo(0);
    expect(p[1]).toBeCloseTo(1);
    expect(p[2]).toBeCloseTo(0);
  });

  it("leaves the pivot fixed", () => {
    const { mapPt } = rotationMappers([2, 3, 4], [1, 0, 0], Math.PI / 3);
    const p = mapPt([2, 3, 4]);
    expect(p[0]).toBeCloseTo(2);
    expect(p[1]).toBeCloseTo(3);
    expect(p[2]).toBeCloseTo(4);
  });

  it("preserves vector length under mapVec (pure rotation)", () => {
    const { mapVec } = rotationMappers([0, 0, 0], [0, 1, 0], 1.234);
    const v = mapVec([3, 4, 5]);
    expect(Math.hypot(...v)).toBeCloseTo(Math.hypot(3, 4, 5));
  });

  it("turns a full circle back to where it started", () => {
    const { mapPt } = rotationMappers([1, 1, 1], [0, 0, 1], 2 * Math.PI);
    const p = mapPt([4, 2, 9]);
    expect(p[0]).toBeCloseTo(4);
    expect(p[1]).toBeCloseTo(2);
    expect(p[2]).toBeCloseTo(9);
  });
});
