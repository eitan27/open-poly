import { describe, expect, it } from "vitest";
import * as THREE from "three";
import {
  chainInteriorPositions,
  faceBoundaryEdges,
  nearestHitInPixels,
  posKey,
  realVertexNear,
  syncBodyGeometry,
} from "./geometryQuery";

const geomWith = (positions: number[], edgeGroups: unknown[]) => {
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  g.userData.edgeGroups = edgeGroups;
  return g;
};

describe("posKey", () => {
  it("rounds to the micron", () => {
    expect(posKey(1.0000001, 2, 3)).toBe(posKey(1.0000002, 2, 3));
  });

  it("distinguishes points beyond that tolerance", () => {
    expect(posKey(1, 2, 3)).not.toBe(posKey(1.01, 2, 3));
  });

  it("does not confuse a shifted coordinate for a different axis", () => {
    expect(posKey(1, 2, 3)).not.toBe(posKey(3, 2, 1));
  });
});

describe("syncBodyGeometry", () => {
  it("builds face and edge geometry from a kernel mesh", () => {
    const g = syncBodyGeometry(
      "b1",
      { vertices: [0, 0, 0, 1, 0, 0, 0, 1, 0], triangles: [0, 1, 2] },
      { lines: [0, 0, 0, 1, 0, 0] },
    );
    expect(g.faces.getAttribute("position").count).toBe(3);
    expect(g.lines.getAttribute("position").count).toBe(2);
  });

  it("re-indexes a TYPED triangle buffer, which the helper's own types don't cover", () => {
    // The documented reason this wrapper exists: syncGeometries declares number[]
    // and mishandles a Uint32Array index, so it is set again afterwards.
    const g = syncBodyGeometry(
      "b1",
      { vertices: [0, 0, 0, 1, 0, 0, 0, 1, 0], triangles: new Uint32Array([0, 1, 2]) },
      { lines: [] },
    );
    const idx = g.faces.getIndex();
    expect(idx).not.toBeNull();
    expect(Array.from({ length: idx!.count }, (_, i) => idx!.getX(i))).toEqual([0, 1, 2]);
  });
});

describe("faceBoundaryEdges", () => {
  it("finds the edge whose every vertex lies on the selected face", () => {
    const faceGeom = new THREE.BufferGeometry();
    faceGeom.setAttribute("position", new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 1, 0], 3));
    faceGeom.addGroup(0, 3, 0);
    faceGeom.userData.faceGroups = [{ faceId: 0 }];
    const edgeGeom = geomWith(
      [0, 0, 0, 1, 0, 0, 5, 5, 5, 6, 6, 6],
      [
        { start: 0, count: 2, edgeId: 5 },
        { start: 2, count: 2, edgeId: 6 },
      ],
    );
    expect(faceBoundaryEdges(faceGeom, edgeGeom, new Set([0]))).toEqual([[0, 2]]);
  });

  it("rejects an edge with only SOME vertices on the face — all of them must be", () => {
    const faceGeom = new THREE.BufferGeometry();
    faceGeom.setAttribute("position", new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 1, 0], 3));
    faceGeom.addGroup(0, 3, 0);
    faceGeom.userData.faceGroups = [{ faceId: 0 }];
    const edgeGeom = geomWith([0, 0, 0, 9, 9, 9], [{ start: 0, count: 2, edgeId: 5 }]);
    expect(faceBoundaryEdges(faceGeom, edgeGeom, new Set([0]))).toEqual([]);
  });

  it("returns nothing for a face id that is not selected", () => {
    const faceGeom = new THREE.BufferGeometry();
    faceGeom.setAttribute("position", new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 1, 0], 3));
    faceGeom.addGroup(0, 3, 0);
    faceGeom.userData.faceGroups = [{ faceId: 0 }];
    const edgeGeom = geomWith([0, 0, 0, 1, 0, 0], [{ start: 0, count: 2, edgeId: 5 }]);
    expect(faceBoundaryEdges(faceGeom, edgeGeom, new Set([99]))).toEqual([]);
  });

  it("returns empty when the userData groups are missing", () => {
    const empty = new THREE.BufferGeometry();
    expect(faceBoundaryEdges(empty, empty, new Set([0]))).toEqual([]);
  });
});

describe("chainInteriorPositions", () => {
  it("flags an endpoint shared by two chords of the same chain as interior", () => {
    const geom = geomWith(
      [0, 0, 0, 1, 0, 0, 1, 0, 0, 2, 0, 0],
      [
        { start: 0, count: 2, edgeId: 1, chainId: 1 },
        { start: 2, count: 2, edgeId: 2, chainId: 1 },
      ],
    );
    const interior = chainInteriorPositions(geom);
    expect(interior.has(posKey(1, 0, 0))).toBe(true);
    expect(interior.has(posKey(0, 0, 0))).toBe(false);
    expect(interior.has(posKey(2, 0, 0))).toBe(false);
  });

  it("does not merge chords of DIFFERENT chains that happen to meet", () => {
    // Two chains touching at (1,0,0): a real corner, not a facet seam.
    const geom = geomWith(
      [0, 0, 0, 1, 0, 0, 1, 0, 0, 2, 0, 0],
      [
        { start: 0, count: 2, edgeId: 1, chainId: 1 },
        { start: 2, count: 2, edgeId: 2, chainId: 2 },
      ],
    );
    expect(chainInteriorPositions(geom).size).toBe(0);
  });

  it("ignores groups with no chainId", () => {
    const geom = geomWith(
      [0, 0, 0, 1, 0, 0, 1, 0, 0, 2, 0, 0],
      [
        { start: 0, count: 2, edgeId: 1 },
        { start: 2, count: 2, edgeId: 2 },
      ],
    );
    expect(chainInteriorPositions(geom).size).toBe(0);
  });

  it("caches on the geometry and reuses until the edgeGroups object is replaced", () => {
    const geom = geomWith(
      [0, 0, 0, 1, 0, 0, 1, 0, 0, 2, 0, 0],
      [
        { start: 0, count: 2, edgeId: 1, chainId: 1 },
        { start: 2, count: 2, edgeId: 2, chainId: 1 },
      ],
    );
    const first = chainInteriorPositions(geom);
    expect(chainInteriorPositions(geom)).toBe(first); // same Set, not recomputed
    geom.userData.edgeGroups = [{ start: 0, count: 2, edgeId: 1, chainId: 9 }];
    expect(chainInteriorPositions(geom)).not.toBe(first);
  });
});

describe("realVertexNear", () => {
  it("returns the nearer end of the hit edge's polyline", () => {
    const geom = geomWith([0, 0, 0, 5, 0, 0, 10, 0, 0], [{ start: 0, count: 3, edgeId: 1 }]);
    const v = realVertexNear(geom, 1, new THREE.Vector3(9, 0, 0));
    expect(v?.x).toBeCloseTo(10);
  });

  it("does NOT offer an interior chord junction as a vertex", () => {
    // The mid point is where two chords of one chain meet — real topologically,
    // meaningless to a user, and it used to make circle rims unpickable.
    const geom = geomWith(
      [0, 0, 0, 5, 0, 0, 5, 0, 0, 10, 0, 0],
      [
        { start: 0, count: 2, edgeId: 1, chainId: 1 },
        { start: 2, count: 2, edgeId: 2, chainId: 1 },
      ],
    );
    const v = realVertexNear(geom, 0, new THREE.Vector3(4.9, 0, 0));
    expect(v?.x).toBeCloseTo(0); // the chain END, not the junction at 5
  });

  it("a closed rim exposes NO vertex at all — nothing on it is a corner", () => {
    // Three chords of one chain forming a loop: every junction is interior.
    const geom = geomWith(
      [0, 0, 0, 5, 0, 0, 5, 0, 0, 5, 5, 0, 5, 5, 0, 0, 0, 0],
      [
        { start: 0, count: 2, edgeId: 1, chainId: 1 },
        { start: 2, count: 2, edgeId: 2, chainId: 1 },
        { start: 4, count: 2, edgeId: 3, chainId: 1 },
      ],
    );
    expect(realVertexNear(geom, 0, new THREE.Vector3(0, 0, 0))).toBeNull();
  });

  it("returns null when the hit index belongs to no edge group", () => {
    const geom = geomWith([0, 0, 0, 1, 0, 0], [{ start: 0, count: 2, edgeId: 1 }]);
    expect(realVertexNear(geom, 99, new THREE.Vector3())).toBeNull();
  });

  it("returns null when there are no edge groups", () => {
    const geom = new THREE.BufferGeometry();
    geom.setAttribute("position", new THREE.Float32BufferAttribute([0, 0, 0], 3));
    expect(realVertexNear(geom, 0, new THREE.Vector3())).toBeNull();
  });
});

describe("nearestHitInPixels", () => {
  // toPx maps world x/y straight to screen for the purposes of these tests.
  const toPx = (p: THREE.Vector3) => ({ x: p.x, y: p.y });
  const hit = (x: number, y: number, distance: number) =>
    ({ point: new THREE.Vector3(x, y, 0), distance }) as unknown as THREE.Intersection;

  it("picks the hit closest to the cursor in SCREEN space, not the first in the list", () => {
    // The bug this exists for: raycaster order is by ray distance, so [0] can be
    // a whole chord away from the cursor on a tessellated curve.
    const r = nearestHitInPixels([hit(50, 0, 1), hit(2, 0, 9)], toPx, 0, 0);
    expect(r?.hit.distance).toBe(9);
    expect(r?.px).toBeCloseTo(2);
  });

  it("breaks an exact pixel tie by depth, so the nearer surface wins", () => {
    const r = nearestHitInPixels([hit(3, 0, 8), hit(3, 0, 2)], toPx, 0, 0);
    expect(r?.hit.distance).toBe(2);
  });

  it("honours maxDistance", () => {
    expect(nearestHitInPixels([hit(1, 0, 100)], toPx, 0, 0, 10)).toBeNull();
  });

  it("returns null for no hits", () => {
    expect(nearestHitInPixels([], toPx, 0, 0)).toBeNull();
  });
});
