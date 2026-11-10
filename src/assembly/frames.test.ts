import { describe, expect, it } from "vitest";
import type { ShapeMeshPayload } from "../kernel/types";
import type { Vec3 } from "./placement";
import {
  connectorMatrix,
  connectorRefOf,
  edgeShape,
  faceShape,
  midplaneShape,
  resolveConnector,
  shapeFrame,
} from "./frames";

/** A tiny mesh builder: faces as polygons (fan-triangulated, wound so the
 *  normal follows the right-hand rule), edges as polylines. */
function builder() {
  const vertices: number[] = [];
  const triangles: number[] = [];
  const faceGroups: NonNullable<ShapeMeshPayload["faces"]["faceGroups"]> = [];
  const lines: number[] = [];
  const edgeGroups: NonNullable<ShapeMeshPayload["edges"]["edgeGroups"]> = [];
  let nextId = 1;
  return {
    face(poly: Vec3[], name: string, clusterId?: number) {
      const base = vertices.length / 3;
      for (const p of poly) vertices.push(...p);
      const start = triangles.length;
      for (let i = 1; i + 1 < poly.length; i++) triangles.push(base, base + i, base + i + 1);
      const faceId = nextId++;
      faceGroups.push({ start, count: triangles.length - start, faceId, name, clusterId });
      return faceId;
    },
    edge(pts: Vec3[], name: string, chainId?: number) {
      const start = lines.length / 3;
      for (let i = 0; i + 1 < pts.length; i++) lines.push(...pts[i], ...pts[i + 1]);
      const edgeId = nextId++;
      edgeGroups.push({ start, count: lines.length / 3 - start, edgeId, name, chainId });
      return edgeId;
    },
    mesh(): ShapeMeshPayload {
      return { name: "p", faces: { vertices, triangles, faceGroups }, edges: { lines, edgeGroups } };
    },
  };
}

/** A faceted cylinder (n-gon prism) on the axis through `c` along +Z, as the
 *  kernel builds them: each side facet a face sharing one cluster, rim chords
 *  chained, flat top and bottom discs. */
function cylinder(n: number, r: number, h: number, c: Vec3 = [0, 0, 0]) {
  const b = builder();
  const p = (i: number, z: number): Vec3 => [
    c[0] + r * Math.cos((i * 2 * Math.PI) / n),
    c[1] + r * Math.sin((i * 2 * Math.PI) / n),
    c[2] + z,
  ];
  const sides: number[] = [];
  for (let i = 0; i < n; i++) sides.push(b.face([p(i, 0), p(i + 1, 0), p(i + 1, h), p(i, h)], `cyl/side${i}`, 99));
  const top = b.face(
    Array.from({ length: n }, (_, i) => p(i, h)),
    "cyl/top",
  );
  const bottom = b.face(
    Array.from({ length: n }, (_, i) => p(n - i, 0)),
    "cyl/bottom",
  );
  const rims: number[] = [];
  for (let i = 0; i < n; i++) rims.push(b.edge([p(i, h), p(i + 1, h)], i === 0 ? "cyl/side0∩cyl/top" : `rimT${i}`, 7));
  for (let i = 0; i < n; i++) b.edge([p(i, 0), p(i + 1, 0)], i === 0 ? "cyl/bottom∩cyl/side0" : `rimB${i}`, 8);
  return { mesh: b.mesh(), sides, top, bottom, rims };
}

const close = (a: Vec3, b: Vec3, digits = 6) => a.forEach((v, i) => expect(v).toBeCloseTo(b[i], digits));

describe("faceShape", () => {
  it("reads a flat face as a plane: centroid and outward normal", () => {
    const b = builder();
    const f = b.face(
      [
        [0, 0, 10],
        [20, 0, 10],
        [20, 30, 10],
        [0, 30, 10],
      ],
      "box/+z",
    );
    const s = faceShape(b.mesh().faces, f)!;
    expect(s.kind).toBe("plane");
    if (s.kind !== "plane") return;
    close(s.origin, [10, 15, 10]);
    close(s.normal, [0, 0, 1]);
  });

  it("reads any facet of a faceted cylinder as the cylinder's axis", () => {
    const { mesh, sides } = cylinder(96, 5, 40, [100, -20, 3]);
    const s = faceShape(mesh.faces, sides[17])!;
    expect(s.kind).toBe("cylinder");
    if (s.kind !== "cylinder") return;
    expect(s.radius).toBeCloseTo(5, 5);
    close(s.dir, [0, 0, 1]);
    const mid = shapeFrame(s, "center").origin;
    close(mid, [100, -20, 23], 5);
    close(shapeFrame(s, "start").origin, [100, -20, 3], 5);
    close(shapeFrame(s, "end").origin, [100, -20, 43], 5);
  });

  it("finds the axis of a half-round wall too (an arc, not a ring)", () => {
    const { mesh, sides } = cylinder(96, 8, 10);
    const half = {
      ...mesh.faces,
      faceGroups: mesh.faces.faceGroups!.filter((g) => sides.slice(0, 48).includes(g.faceId)),
    };
    const s = faceShape(half, sides[3])!;
    expect(s.kind).toBe("cylinder");
    if (s.kind === "cylinder") expect(s.radius).toBeCloseTo(8, 5);
  });

  it("grows the round part out of a cluster that also holds tangent flats", () => {
    // Half a cylinder (the round end of a slot) whose cluster also takes in the
    // flat side it runs tangent into.
    const b = builder();
    const n = 96,
      r = 4;
    const p = (i: number, z: number): Vec3 => [r * Math.cos((i * Math.PI) / n), r * Math.sin((i * Math.PI) / n), z];
    const facets: number[] = [];
    for (let i = 0; i < n; i++) facets.push(b.face([p(i, 0), p(i + 1, 0), p(i + 1, 6), p(i, 6)], `s${i}`, 5));
    // The flat side, tangent at angle 0 (x = 4), running off along -y.
    b.face(
      [
        [4, -30, 0],
        [4, 0, 0],
        [4, 0, 6],
        [4, -30, 6],
      ],
      "flat",
      5,
    );
    const s = faceShape(b.mesh().faces, facets[40])!;
    expect(s.kind).toBe("cylinder");
    if (s.kind === "cylinder") expect(s.radius).toBeCloseTo(4, 5);
  });

  it("still reads a flat face as a plane when its cluster takes in a fillet", () => {
    const b = builder();
    const top = b.face(
      [
        [0, 0, 10],
        [20, 0, 10],
        [20, 20, 10],
        [0, 20, 10],
      ],
      "top",
      3,
    );
    // A quarter-round blend off the top's +x edge, sharing its cluster.
    const n = 12;
    const q = (i: number, y: number): Vec3 => [
      20 + 2 * Math.sin((i * Math.PI) / 2 / n),
      y,
      8 + 2 * Math.cos((i * Math.PI) / 2 / n),
    ];
    for (let i = 0; i < n; i++) b.face([q(i, 0), q(i + 1, 0), q(i + 1, 20), q(i, 20)], `f${i}`, 3);
    const s = faceShape(b.mesh().faces, top)!;
    expect(s.kind).toBe("plane");
  });
});

describe("edgeShape", () => {
  it("reads a rim's chain as a circle, Z facing like the flat face it bounds", () => {
    const { mesh, rims } = cylinder(96, 5, 40);
    const s = edgeShape(mesh.edges, rims[10], mesh.faces)!;
    expect(s.kind).toBe("circle");
    if (s.kind !== "circle") return;
    close(s.center, [0, 0, 40], 5);
    expect(s.radius).toBeCloseTo(5, 5);
    close(s.normal, [0, 0, 1]);
  });

  it("points a bottom rim's Z down, out of the bottom face", () => {
    const { mesh } = cylinder(96, 5, 40);
    const bottom = mesh.edges.edgeGroups!.find((g) => g.name === "cyl/bottom∩cyl/side0")!;
    const s = edgeShape(mesh.edges, bottom.edgeId, mesh.faces)!;
    expect(s.kind).toBe("circle");
    if (s.kind === "circle") close(s.normal, [0, 0, -1]);
  });

  it("reads a straight edge as a line through its midpoint", () => {
    const b = builder();
    const e = b.edge(
      [
        [0, 0, 0],
        [0, 5, 0],
        [0, 10, 0],
      ],
      "a∩b",
    );
    const s = edgeShape(b.mesh().edges, e)!;
    expect(s.kind).toBe("line");
    if (s.kind === "line") {
      close(s.mid, [0, 5, 0]);
      close(s.dir, [0, 1, 0]);
    }
  });
});

describe("midplaneShape", () => {
  const plane = (origin: Vec3, normal: Vec3) => ({ kind: "plane" as const, origin, normal });

  it("lies midway between two facing walls, its normal the same whichever is first", () => {
    const left = plane([0, 3, 7], [1, 0, 0]);
    const right = plane([10, -1, 7], [-1, 0, 0]);
    for (const [p, q] of [
      [left, right],
      [right, left],
    ]) {
      const m = midplaneShape(p, q)!;
      expect(m.kind).toBe("plane");
      if (m.kind !== "plane") continue;
      close(m.origin, [5, 1, 7]);
      close(m.normal, [1, 0, 0]);
    }
  });

  it("refuses faces that aren't parallel, are the same plane, or aren't flat", () => {
    expect(midplaneShape(plane([0, 0, 0], [1, 0, 0]), plane([5, 0, 0], [0, 1, 0]))).toBeNull();
    expect(midplaneShape(plane([0, 0, 0], [1, 0, 0]), plane([0, 9, 0], [-1, 0, 0]))).toBeNull();
    expect(midplaneShape(plane([0, 0, 0], [1, 0, 0]), { kind: "line", mid: [5, 0, 0], dir: [0, 0, 1] })).toBeNull();
  });
});

describe("connectors", () => {
  it("stores a pick by name and resolves it back", () => {
    const { mesh, top } = cylinder(48, 5, 40);
    const c = connectorRefOf(mesh, { kind: "face", faceId: top })!;
    expect(c.ref).toMatchObject({ kind: "face", name: "cyl/top" });
    const r = resolveConnector(mesh, c.ref)!;
    expect(r.rematched).toBe(false);
    expect(r.shape.kind).toBe("plane");
  });

  it("re-finds a renamed face by its fingerprint", () => {
    const { mesh, top } = cylinder(48, 5, 40);
    const c = connectorRefOf(mesh, { kind: "face", faceId: top })!;
    const renamed: ShapeMeshPayload = {
      ...mesh,
      faces: {
        ...mesh.faces,
        faceGroups: mesh.faces.faceGroups!.map((g) => (g.name === "cyl/top" ? { ...g, name: "cyl/top#2" } : g)),
      },
    };
    const r = resolveConnector(renamed, c.ref)!;
    expect(r.rematched).toBe(true);
    if (r.shape.kind === "plane") close(r.shape.origin, [0, 0, 40], 5);
  });

  it("gives up rather than guess when nothing sits where the face was", () => {
    const { mesh, top } = cylinder(48, 5, 40);
    const c = connectorRefOf(mesh, { kind: "face", faceId: top })!;
    const other = cylinder(48, 5, 60).mesh; // the top moved 20 mm up and has a new name
    other.faces.faceGroups!.forEach((g) => (g.name = `x/${g.name}`));
    expect(resolveConnector(other, c.ref)).toBeNull();
  });
});

describe("vertex connectors", () => {
  /** Three edges of a box corner meeting at (10, 10, 10), as polylines. */
  const corner = () => {
    const b = builder();
    b.edge(
      [
        [0, 10, 10],
        [10, 10, 10],
      ],
      "top∩back",
    );
    b.edge(
      [
        [10, 0, 10],
        [10, 10, 10],
      ],
      "top∩right",
    );
    b.edge(
      [
        [10, 10, 0],
        [10, 10, 10],
      ],
      "back∩right",
    );
    return b.mesh();
  };

  it("stores a picked vertex as the end of an edge it meets, and resolves it back", () => {
    const mesh = corner();
    const c = connectorRefOf(mesh, { kind: "vertex", point: [10, 10, 10.00001] })!;
    expect(c.ref.kind).toBe("vertex");
    close(c.ref.center!, [10, 10, 10]);
    const r = resolveConnector(mesh, c.ref)!;
    expect(r.rematched).toBe(false);
    expect(r.shape).toEqual({ kind: "point", origin: [10, 10, 10] });
  });

  it("frames a vertex with the part's own axes", () => {
    const f = shapeFrame({ kind: "point", origin: [1, 2, 3] }, "center");
    expect(f).toEqual({ origin: [1, 2, 3], z: [0, 0, 1], x: [1, 0, 0] });
  });

  it("refuses a point where no edge ends", () => {
    expect(connectorRefOf(corner(), { kind: "vertex", point: [5, 5, 5] })).toBeNull();
  });

  it("follows its edge's end when the part changes, and re-finds it by position if the edge is renamed", () => {
    const c = connectorRefOf(corner(), { kind: "vertex", point: [10, 10, 10] })!;
    // The edge grows 5 mm longer: the end nearest where the vertex was.
    const b = builder();
    b.edge(
      [
        [0, 10, 10],
        [10, 10, 10],
      ],
      "top∩back",
    );
    b.edge(
      [
        [10, -5, 10],
        [10, 10, 10],
      ],
      "top∩right",
    );
    b.edge(
      [
        [10, 10, -5],
        [10, 10, 10],
      ],
      "back∩right",
    );
    const grown = b.mesh();
    expect(resolveConnector(grown, c.ref)).toMatchObject({ shape: { origin: [10, 10, 10] }, rematched: false });
    const renamed = {
      ...grown,
      edges: { ...grown.edges, edgeGroups: grown.edges.edgeGroups!.map((g) => ({ ...g, name: `x/${g.name}` })) },
    };
    expect(resolveConnector(renamed, c.ref)).toMatchObject({ shape: { origin: [10, 10, 10] }, rematched: true });
  });
});

describe("connectorMatrix", () => {
  const point = { kind: "point" as const, origin: [1, 2, 3] as Vec3 };
  it("is the entity's frame with no offset", () => {
    expect(connectorMatrix(point, "center", undefined, {})).toEqual([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 1, 2, 3, 1]);
  });
  it("moves along the frame's own axes by the offset, which may name variables", () => {
    const m = connectorMatrix(point, "center", { x: "5", z: "inset * 2" }, { inset: 1.5 });
    expect(m.slice(12, 15)).toEqual([6, 2, 6]);
  });
  it("throws on a bad offset", () => {
    expect(() => connectorMatrix(point, "center", { y: "nope" }, {})).toThrow();
  });
});
