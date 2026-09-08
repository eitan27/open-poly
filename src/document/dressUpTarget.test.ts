import { describe, expect, it } from "vitest";
import {
  dressUpPickBody,
  dressUpTargetFromPicks,
  dressUpTargetsFromPicks,
  toggleDressUpPick,
  type DressUpMesh,
  type DressUpPick,
} from "./dressUpTarget";

// A body with one faceted rim (edges 10–12, one tangent chain) and two straight
// edges (30, 31), plus two named faces. Geometry is deliberately trivial — what
// these tests care about is which names come out, not where they are.
function mesh(id = "body1", opts: { nameEdges?: boolean; nameFaces?: boolean } = {}): DressUpMesh {
  const { nameEdges = true, nameFaces = true } = opts;
  const edge = (edgeId: number, chainId: number | undefined, start: number) => ({
    start,
    count: 2,
    edgeId,
    chainId,
    name: nameEdges ? `E${edgeId}` : undefined,
  });
  return {
    id,
    mesh: {
      edges: {
        // Two points per edge, laid end to end: the i-th edge runs (i,0,0) → (i+1,0,0).
        lines: new Float32Array([0, 1, 2, 3, 4].flatMap((i) => [i, 0, 0, i + 1, 0, 0])),
        edgeGroups: [edge(10, 10, 0), edge(11, 10, 2), edge(12, 10, 4), edge(30, undefined, 6), edge(31, undefined, 8)],
      },
      faces: {
        vertices: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 1, 0, 1, 0, 1, 1]),
        triangles: new Uint32Array([0, 1, 2, 3, 4, 5]),
        faceGroups: [
          { start: 0, count: 3, faceId: 1, name: nameFaces ? "F1" : undefined },
          { start: 3, count: 3, faceId: 2, name: nameFaces ? "F2" : undefined },
        ],
      },
    },
  };
}

const meshes = [mesh("body1"), mesh("body2")];
const edgePick = (edgeId: number, featureId = "body1") => ({ kind: "edge" as const, featureId, edgeId });
const facePick = (faceId: number, featureId = "body1") => ({ kind: "face" as const, featureId, faceId });

describe("dressUpTargetFromPicks", () => {
  it("expands one picked rim chord to its whole tangent chain", () => {
    const t = dressUpTargetFromPicks([edgePick(11)], meshes);
    expect(t?.edges.sort()).toEqual(["E10", "E11", "E12"]);
  });

  it("leaves a straight edge as itself", () => {
    expect(dressUpTargetFromPicks([edgePick(30)], meshes)?.edges).toEqual(["E30"]);
  });

  it("accumulates several picks into one target", () => {
    const t = dressUpTargetFromPicks([edgePick(30), edgePick(31)], meshes);
    expect(t?.edges.sort()).toEqual(["E30", "E31"]);
    expect(t?.targetId).toBe("body1");
  });

  it("carries a face pick through by name, with its fingerprint", () => {
    const t = dressUpTargetFromPicks([facePick(1)], meshes);
    expect(t?.faces).toEqual(["F1"]);
    expect(t?.faceRefs[0].name).toBe("F1");
    expect(t?.edges).toEqual([]);
  });

  it("refuses picks spanning two bodies — a dress-up dresses one body", () => {
    expect(dressUpTargetFromPicks([edgePick(30, "body1"), edgePick(30, "body2")], meshes)).toBeNull();
  });

  it("refuses a list holding anything that isn't an edge or a face", () => {
    expect(dressUpTargetFromPicks([edgePick(30), { kind: "vertex" }], meshes)).toBeNull();
  });

  it("refuses an edge with no persistent name — it can't be referenced stably", () => {
    expect(dressUpTargetFromPicks([edgePick(30)], [mesh("body1", { nameEdges: false })])).toBeNull();
  });

  it("refuses a face with no persistent name, by the same rule", () => {
    expect(dressUpTargetFromPicks([facePick(1)], [mesh("body1", { nameFaces: false })])).toBeNull();
  });

  it("is null with nothing picked (the dialog opens that way on purpose)", () => {
    expect(dressUpTargetFromPicks([], meshes)).toBeNull();
  });

  it("anchors on the edge actually clicked, not the chain's first chord", () => {
    // Edge 12 is the third chord; its midpoint is nowhere near edge 10's.
    const t = dressUpTargetFromPicks([edgePick(12)], meshes);
    expect(t?.anchor?.[0]).toBeCloseTo(2.5);
  });
});

describe("toggleDressUpPick", () => {
  it("adds a pick that isn't there", () => {
    expect(toggleDressUpPick([edgePick(10)], edgePick(11))).toHaveLength(2);
  });

  it("removes the same edge picked twice — clicking a listed edge drops it", () => {
    expect(toggleDressUpPick([edgePick(10), edgePick(11)], edgePick(10))).toEqual([edgePick(11)]);
  });

  it("tells an edge and a face with the same id apart", () => {
    const picks: DressUpPick[] = [edgePick(1)];
    expect(toggleDressUpPick(picks, facePick(1))).toHaveLength(2);
  });

  it("tells the same edge id on two bodies apart", () => {
    expect(toggleDressUpPick([edgePick(10, "body1")], edgePick(10, "body2"))).toHaveLength(2);
  });
});

describe("dressUpPickBody", () => {
  it("reads the body off an edge or face pick", () => {
    expect(dressUpPickBody(edgePick(10))).toBe("body1");
    expect(dressUpPickBody(facePick(1, "body2"))).toBe("body2");
  });

  it("is null for anything else", () => {
    expect(dressUpPickBody({ kind: "sketchFace" })).toBeNull();
  });
});

describe("dressUpTargetsFromPicks", () => {
  it("groups picks by body — one target each, so they commit as one feature each", () => {
    const ts = dressUpTargetsFromPicks([edgePick(30, "body1"), edgePick(30, "body2"), edgePick(31, "body1")], meshes);
    expect(ts.map((t) => t.targetId)).toEqual(["body1", "body2"]);
    expect(ts[0].edges.sort()).toEqual(["E30", "E31"]);
    expect(ts[1].edges).toEqual(["E30"]);
  });

  it("keeps the bodies in the order they were first picked", () => {
    const ts = dressUpTargetsFromPicks([edgePick(30, "body2"), edgePick(30, "body1")], meshes);
    expect(ts.map((t) => t.targetId)).toEqual(["body2", "body1"]);
  });

  it("expands each body's tangent chains independently", () => {
    const ts = dressUpTargetsFromPicks([edgePick(11, "body1"), edgePick(11, "body2")], meshes);
    expect(ts).toHaveLength(2);
    for (const t of ts) expect(t.edges.sort()).toEqual(["E10", "E11", "E12"]);
  });

  it("is a single target for a single body — the ordinary case is unchanged", () => {
    expect(dressUpTargetsFromPicks([edgePick(30), facePick(1)], meshes)).toHaveLength(1);
  });

  it("is empty when ANY body fails to resolve — never dress fewer bodies than were picked", () => {
    const partial = [mesh("body1"), mesh("body2", { nameEdges: false })];
    expect(dressUpTargetsFromPicks([edgePick(30, "body1"), edgePick(30, "body2")], partial)).toEqual([]);
  });

  it("is empty when the list holds something that isn't an edge or a face", () => {
    expect(dressUpTargetsFromPicks([edgePick(30), { kind: "sketchFace" }], meshes)).toEqual([]);
  });

  it("is empty with nothing picked", () => {
    expect(dressUpTargetsFromPicks([], meshes)).toEqual([]);
  });
});
