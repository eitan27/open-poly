import { describe, expect, it } from "vitest";
import { defaultX, frameMatrix } from "../assembly/frames";
import { IDENTITY, translation, type Vec3 } from "../assembly/placement";
import { solve } from "../assembly/solve";
import type { AssemblyDoc, Instance, Mat4, Mate, MateConnector } from "../assembly/types";
import type { SourceState } from "../assembly/useAssemblySources";
import type { ShapeMeshPayload } from "../kernel/types";
import { assemblySummary, partKey, type AssemblyAgentState } from "./assemblySummary";

// A 10 mm cube's mesh, as far as the summary reads one: its vertices, and
// named face and edge groups (the triangles don't matter here).
const cube: ShapeMeshPayload = {
  name: "cube",
  faces: {
    vertices: new Float32Array([0, 0, 0, 10, 0, 0, 10, 10, 0, 0, 10, 10]),
    triangles: new Uint32Array([0, 1, 2, 0, 2, 3]),
    faceGroups: [
      { start: 0, count: 3, faceId: 0, name: "box/+z" },
      { start: 3, count: 3, faceId: 1, name: "box/-z" },
      { start: 3, count: 0, faceId: 2, name: "box/-z" },
    ],
  },
  edges: {
    lines: new Float32Array(),
    edgeGroups: [{ start: 0, count: 2, edgeId: 0, name: "box/e1" }],
  },
} as ShapeMeshPayload;

const inst = (id: string, extra: Partial<Instance> = {}): Instance => ({
  id,
  name: id,
  source: { docId: "d", partId: "box" },
  transform: IDENTITY,
  ...extra,
});
const conn = (instanceId: string, name: string): MateConnector => ({
  instanceId,
  ref: { kind: "face", name },
  anchor: "center",
});
const z: Vec3 = [0, 0, 1];
const frames: Record<string, Mat4> = {
  "box/+z": frameMatrix({ origin: [5, 5, 10], z, x: defaultX(z) }),
  "box/-z": frameMatrix({ origin: [5, 5, 0], z: [0, 0, -1], x: defaultX([0, 0, -1]) }),
};
const lookup = (c: MateConnector) => frames[c.ref.name] ?? `No ${c.ref.name}`;

const sources = new Map<string, SourceState>([
  [
    "d",
    {
      status: "ready",
      name: "Cube doc",
      updatedAt: 1,
      parts: [{ partId: "box", name: "Cube", color: 0, opacity: 1, mesh: cube }],
    },
  ],
  ["gone", { status: "missing" }],
]);

function state(assembly: AssemblyDoc, extra: Partial<AssemblyAgentState> = {}): AssemblyAgentState {
  return {
    assembly,
    solution: solve(assembly, lookup),
    sources,
    warnings: new Map(),
    selection: [],
    ...extra,
  };
}

const stack: AssemblyDoc = {
  instances: [inst("A", { grounded: true }), inst("B", { transform: translation([30, 0, 0]) }), inst("C")],
  mates: [
    {
      id: "m1",
      name: "Cylindrical 1",
      type: "cylindrical",
      a: conn("A", "box/+z"),
      b: { ...conn("B", "box/-z"), offset: { x: "gap" } },
      values: { tz: "lift", rz: "15" },
      limits: { tz: { min: "0", max: "20" } },
    } as Mate,
    { id: "m2", name: "Revolute 1", type: "revolute", a: conn("A", "box/+z"), b: conn("C", "box/-z"), flip: true },
  ],
  variables: [
    { id: "v1", name: "lift", expression: "3" },
    { id: "v2", name: "gap", expression: "0" },
  ] as AssemblyDoc["variables"],
  relations: [
    {
      id: "g",
      name: "Gear 1",
      type: "gear",
      driver: { mateId: "m1", dof: "rz" },
      driven: { mateId: "m2", dof: "rz" },
      value: "2",
    },
  ],
};

describe("assemblySummary", () => {
  const s = assemblySummary(state(stack, { selection: ["B"] }), { id: "asm", name: "Stack" });

  it("names the document and says it's an assembly", () => {
    expect(s).toMatchObject({ kind: "assembly", documentId: "asm", documentName: "Stack", selection: ["B"] });
  });

  it("lists each part once, with the names a connector can use", () => {
    expect(s.parts).toEqual([
      {
        key: partKey("d", "box"),
        documentId: "d",
        documentName: "Cube doc",
        partId: "box",
        name: "Cube",
        faces: ["box/+z", "box/-z"],
        edges: ["box/e1"],
      },
    ]);
  });

  it("lists instances with their part, grounding, whether a mate places them, and where they are", () => {
    expect(s.instances.map((i) => [i.id, i.part, !!i.grounded, !!i.mated])).toEqual([
      ["A", "d/box", true, false],
      ["B", "d/box", false, true],
      ["C", "d/box", false, true],
    ]);
    // B sits on A's top, lifted 3 by the expression.
    expect(s.instances[1].bbox?.min[2]).toBeCloseTo(13);
    expect(s.instances[1].bbox?.max[2]).toBeCloseTo(13 + 10);
  });

  it("lists mates with their connectors and what they leave free", () => {
    const m1 = s.mates[0];
    expect(m1).toMatchObject({
      id: "m1",
      type: "cylindrical",
      a: { instanceId: "A", kind: "face", name: "box/+z", anchor: "center" },
      b: { instanceId: "B", name: "box/-z", offset: { x: "gap" } },
    });
    expect(m1.free).toEqual([
      { dof: "tz", label: "Distance (mm)", value: 3, expression: "lift", min: "0", max: "20" },
      { dof: "rz", label: "Angle (°)", value: 15 },
    ]);
    expect(s.mates[1].flip).toBe(true);
  });

  it("marks a DOF a relation drives, and lists the relation", () => {
    expect(s.mates[1].free[0]).toMatchObject({ dof: "rz", value: -30, drivenBy: "g" });
    expect(s.relations).toEqual([
      {
        id: "g",
        name: "Gear 1",
        type: "gear",
        driver: { mateId: "m1", dof: "rz" },
        driven: { mateId: "m2", dof: "rz" },
        value: "2",
      },
    ]);
  });

  it("lists the variables, evaluated", () => {
    expect(s.variables).toEqual([
      { name: "lift", expression: "3", value: 3 },
      { name: "gap", expression: "0", value: 0 },
    ]);
  });

  it("says what's wrong: a missing part, a broken mate, a broken relation, a re-found connector", () => {
    const broken: AssemblyDoc = {
      ...stack,
      instances: [...stack.instances, inst("D", { source: { docId: "gone", partId: "x" } })],
      mates: [...stack.mates, { ...stack.mates[1], id: "m3", b: conn("B", "nope") }],
      relations: [{ ...stack.relations![0], id: "r2", value: "0", driven: { mateId: "m1", dof: "tz" } }],
    };
    const t = assemblySummary(state(broken, { warnings: new Map([["m1", "Check its face."]]) }), {
      id: "asm",
      name: "Stack",
    });
    expect(t.parts.find((p) => p.documentId === "gone")).toMatchObject({ problem: "Its document was deleted." });
    expect(t.instances.find((i) => i.id === "D")?.bbox).toBeUndefined();
    expect(t.mates.find((m) => m.id === "m3")?.problem).toMatch(/nope/);
    expect(t.mates[0].warning).toBe("Check its face.");
    expect(t.relations[0].problem).toBeTruthy();
  });

  it("lists loop groups", () => {
    const loop: AssemblyDoc = {
      ...stack,
      relations: undefined,
      mates: [
        ...stack.mates,
        { id: "p", name: "Planar 1", type: "planar", a: conn("A", "box/+z"), b: conn("C", "box/-z") },
      ],
    };
    const t = assemblySummary(state(loop), { id: "asm", name: "Stack" });
    expect(t.loops).toEqual([{ instanceIds: ["C"], mateIds: expect.arrayContaining(["m2", "p"]) }]);
  });

  it("reads without a solution, while the sources load", () => {
    const t = assemblySummary(state(stack, { solution: null, sources: new Map() }), { id: "asm", name: "Stack" });
    expect(t.parts[0]).toMatchObject({ problem: "Still loading." });
    expect(t.instances[0].mated).toBeUndefined();
    expect(t.mates[0].free[0].value).toBe(0);
  });
});
