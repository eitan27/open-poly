// The agent's assembly ops end to end through applyOperation, against an
// in-memory assembly whose context solves it the way the app does (connector
// frames fitted from a real box mesh, named as the kernel names a box's).
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createDocument } from "../document/document";
import { DEFAULT_SECTION_VIEW } from "../document/sectionView";
import { createAssembly } from "../assembly/assembly";
import { connectorMatrix, midplaneShape, resolveConnector } from "../assembly/frames";
import { applyPoint } from "../assembly/placement";
import { solve } from "../assembly/solve";
import type { AssemblyDoc, MateConnector } from "../assembly/types";
import type { SourceState } from "../assembly/useAssemblySources";
import type { ShapeMeshPayload } from "../kernel/types";
import { animateMate, applyOperation, type AgentContext } from "./commands";
import { operationSchema } from "./operations";

type V = [number, number, number];

/** An axis-aligned box from the origin, its six faces and twelve edges named
 *  "box/±x…" and "box/e<n>", as a part's mesh. */
function boxMesh(w: number, d: number, h: number): ShapeMeshPayload {
  const P = (x: number, y: number, z: number): V => [x * w, y * d, z * h];
  const quads: [string, V[]][] = [
    ["box/-z", [P(0, 0, 0), P(0, 1, 0), P(1, 1, 0), P(1, 0, 0)]],
    ["box/+z", [P(0, 0, 1), P(1, 0, 1), P(1, 1, 1), P(0, 1, 1)]],
    ["box/-y", [P(0, 0, 0), P(1, 0, 0), P(1, 0, 1), P(0, 0, 1)]],
    ["box/+y", [P(0, 1, 0), P(0, 1, 1), P(1, 1, 1), P(1, 1, 0)]],
    ["box/-x", [P(0, 0, 0), P(0, 0, 1), P(0, 1, 1), P(0, 1, 0)]],
    ["box/+x", [P(1, 0, 0), P(1, 1, 0), P(1, 1, 1), P(1, 0, 1)]],
  ];
  const vertices: number[] = [];
  const triangles: number[] = [];
  const faceGroups: NonNullable<ShapeMeshPayload["faces"]["faceGroups"]> = [];
  quads.forEach(([name, q], faceId) => {
    const base = vertices.length / 3;
    for (const p of q) vertices.push(...p);
    faceGroups.push({ start: triangles.length, count: 6, faceId, name });
    triangles.push(base, base + 1, base + 2, base, base + 2, base + 3);
  });
  const corners: [V, V][] = [];
  for (const [a, b] of [
    [0, 1],
    [1, 2],
    [2, 3],
    [3, 0],
  ]) {
    const f = (z: number, i: number): V => P([0, 1, 1, 0][i], [0, 0, 1, 1][i], z);
    corners.push([f(0, a), f(0, b)], [f(1, a), f(1, b)], [f(0, a), f(1, a)]);
  }
  const lines: number[] = [];
  const edgeGroups: NonNullable<ShapeMeshPayload["edges"]["edgeGroups"]> = [];
  corners.forEach(([a, b], edgeId) => {
    edgeGroups.push({ start: lines.length / 3, count: 2, edgeId, name: `box/e${edgeId}` });
    lines.push(...a, ...b);
  });
  return {
    name: "box",
    faces: { vertices: new Float32Array(vertices), triangles: new Uint32Array(triangles), faceGroups },
    edges: { lines: new Float32Array(lines), edgeGroups },
  } as ShapeMeshPayload;
}

const CUBE = boxMesh(10, 10, 10);
const PLATE = boxMesh(40, 20, 4);
const source = (name: string, mesh: ShapeMeshPayload): SourceState => ({
  status: "ready",
  name,
  updatedAt: 1,
  parts: [{ partId: "p", name, color: 0, opacity: 1, mesh }],
});
const SOURCES = new Map<string, SourceState>([
  ["cube", source("Cube", CUBE)],
  ["plate", source("Plate", PLATE)],
  [
    "pair",
    {
      status: "ready",
      name: "Pair",
      updatedAt: 1,
      parts: [
        { partId: "p1", name: "Left", color: 0, opacity: 1, mesh: CUBE },
        { partId: "p2", name: "Right", color: 0, opacity: 1, mesh: CUBE },
      ],
    },
  ],
]);

/** A context with an assembly open, solved as the app solves it. */
function assemblyCtx(start: AssemblyDoc = createAssembly()) {
  let assembly = start;
  let commits = 0;
  const meshOf = (c: MateConnector) => {
    const i = assembly.instances.find((x) => x.id === c.instanceId)!;
    const src = SOURCES.get(i.source.docId);
    return src?.status === "ready" ? src.parts.find((p) => p.partId === i.source.partId)!.mesh : CUBE;
  };
  const frameOf = (c: MateConnector) => {
    const mesh = meshOf(c);
    const p = resolveConnector(mesh, c.ref)?.shape;
    const q = c.ref2 ? resolveConnector(mesh, c.ref2)?.shape : undefined;
    const shape = p && q ? midplaneShape(p, q) : p;
    return shape ? connectorMatrix(shape, c.anchor, c.offset, {}) : "gone";
  };
  const ctx: AgentContext = {
    getDoc: () => createDocument(),
    setDoc: () => {},
    getSelection: () => [],
    setSelection: () => {},
    getSectionView: () => DEFAULT_SECTION_VIEW,
    setSectionView: () => {},
    getMeshes: () => [],
    getErrors: () => ({}),
    waitForRegen: async () => ({ errors: {} }),
    getAssembly: () => ({
      assembly,
      solution: solve(assembly, frameOf),
      sources: SOURCES,
      settled: true,
      warnings: new Map(),
      selection: [],
    }),
    assemblyEdit: {
      commit: (next) => {
        assembly = next;
        commits++;
      },
      readSource: async (id) => SOURCES.get(id) ?? { status: "missing" },
      settle: async () => ({}),
      frameOf,
    },
    getViewport: () => null,
    documents: {
      info: () => ({ id: "asm", name: "Asm", kind: "assembly" }),
      open: async () => {},
      create: async () => {},
      duplicate: async () => {},
      rename: async () => {},
    },
  };
  const apply = (op: z.input<typeof operationSchema>) => applyOperation(ctx, operationSchema.parse(op));
  return { ctx, apply, assembly: () => assembly, commits: () => commits, frameOf };
}

/** Insert a plate (grounded, first) and a cube; their instance ids. */
async function plateAndCube() {
  const t = assemblyCtx();
  const plate = (await t.apply({ op: "insertInstance", documentId: "plate" })).createdId!;
  const cube = (await t.apply({ op: "insertInstance", documentId: "cube" })).createdId!;
  return { ...t, plate, cube };
}
const at = (t: ReturnType<typeof assemblyCtx>, id: string, p: V) =>
  applyPoint(t.ctx.getAssembly()!.solution!.placements.get(id)!, p);

describe("insert_instance", () => {
  it("places a part, grounding the first, and the next beside it", async () => {
    const t = assemblyCtx();
    const r1 = await t.apply({ op: "insertInstance", documentId: "plate" });
    const r2 = await t.apply({ op: "insertInstance", documentId: "cube" });
    expect(r1).toMatchObject({ ok: true });
    expect(r2).toMatchObject({ ok: true });
    const [a, b] = t.assembly().instances;
    expect(a).toMatchObject({ id: r1.createdId, grounded: true, source: { docId: "plate", partId: "p" } });
    expect(b.grounded).toBeUndefined();
    // Past the plate's +X end (40) by the 10 mm gap.
    expect(b.transform[12]).toBe(50);
    expect(t.commits()).toBe(2);
  });

  it("places every part of a document, together, or the ones asked for", async () => {
    const t = assemblyCtx();
    const all = await t.apply({ op: "insertInstance", documentId: "pair" });
    expect(all.createdIds).toHaveLength(2);
    const one = await t.apply({ op: "insertInstance", documentId: "pair", partIds: ["p2"], name: "Spare" });
    expect(one.createdIds).toBeUndefined();
    expect(t.assembly().instances[2]).toMatchObject({ name: "Spare", source: { partId: "p2" } });
  });

  it("puts the part's origin at a position", async () => {
    const t = assemblyCtx();
    await t.apply({ op: "insertInstance", documentId: "cube", position: [1, 2, 3] });
    expect(t.assembly().instances[0].transform.slice(12, 15)).toEqual([1, 2, 3]);
  });

  it("says what's wrong", async () => {
    const t = assemblyCtx();
    expect(await t.apply({ op: "insertInstance", documentId: "nope" })).toMatchObject({
      ok: false,
      errorKind: "not_found",
    });
    const bad = await t.apply({ op: "insertInstance", documentId: "pair", partIds: ["p9"] });
    expect(bad.error).toMatch(/no part "p9".*"p1" \(Left\)/);
    const named = await t.apply({ op: "insertInstance", documentId: "pair", name: "X" });
    expect(named.error).toMatch(/only when inserting one part/);
    expect(t.commits()).toBe(0);
  });
});

describe("ground_instance", () => {
  it("grounds and frees an instance", async () => {
    const t = await plateAndCube();
    expect(await t.apply({ op: "groundInstance", instanceId: t.cube })).toMatchObject({
      ok: true,
      createdId: t.cube,
    });
    expect(t.assembly().instances[1].grounded).toBe(true);
    await t.apply({ op: "groundInstance", instanceId: t.plate, grounded: false });
    expect(t.assembly().instances[0].grounded).toBeFalsy();
    expect(await t.apply({ op: "groundInstance", instanceId: "ghost" })).toMatchObject({ errorKind: "not_found" });
  });
});

describe("add_mate", () => {
  it("seats one face on another, as the Mate dialog would", async () => {
    const t = await plateAndCube();
    const r = await t.apply({
      op: "addMate",
      type: "fastened",
      a: { instanceId: t.plate, face: "box/+z" },
      b: { instanceId: t.cube, face: "box/-z" },
    });
    expect(r).toMatchObject({ ok: true });
    const m = t.assembly().mates[0];
    expect(m).toMatchObject({ id: r.createdId, name: "Fastened 1", type: "fastened", a: { anchor: "center" } });
    // The fingerprint a pick stores, so it's re-found after a part edit.
    expect(m.a.ref).toMatchObject({ kind: "face", name: "box/+z", normal: [0, 0, 1] });
    [20, 10, 4].forEach((v, i) => expect(m.a.ref.center![i]).toBeCloseTo(v));
    // The cube's bottom centre on the plate's top centre.
    const p = at(t, t.cube, [5, 5, 0]);
    [20, 10, 4].forEach((v, i) => expect(p[i]).toBeCloseTo(v));
  });

  it("joins edges and vertices, with anchors and offsets", async () => {
    const t = await plateAndCube();
    const r = await t.apply({
      op: "addMate",
      type: "fastened",
      a: { instanceId: t.plate, vertex: { edge: "box/e1", end: "start" }, offset: { z: 1 } },
      b: { instanceId: t.cube, vertex: { edge: "box/e0", end: "start" } },
      name: "Corner",
    });
    expect(r.ok).toBe(true);
    const m = t.assembly().mates[0];
    expect(m.name).toBe("Corner");
    expect(m.a.ref).toMatchObject({ kind: "vertex", name: "box/e1" });
    expect(m.a.offset).toEqual({ z: "1" });
    const e = await t.apply({
      op: "addMate",
      type: "slider",
      a: { instanceId: t.plate, edge: "box/e0" },
      b: { instanceId: t.cube, edge: "box/e0", anchor: "end" },
    });
    expect(e.error).toMatch(/"end" isn't an anchor here; it offers center/);
  });

  it("sets free values, and refuses values the type doesn't leave free", async () => {
    const t = await plateAndCube();
    const r = await t.apply({
      op: "addMate",
      type: "planar",
      a: { instanceId: t.plate, face: "box/+z" },
      b: { instanceId: t.cube, face: "box/-z" },
      values: { tx: 5, rz: "45" },
    });
    expect(r.ok).toBe(true);
    expect(t.assembly().mates[0].values).toEqual({ tx: "5", rz: "45" });
    const bad = await t.apply({
      op: "addMate",
      type: "revolute",
      a: { instanceId: t.plate, face: "box/+z" },
      b: { instanceId: t.cube, face: "box/-z" },
      values: { tz: 3 },
    });
    expect(bad.error).toMatch(/revolute mate leaves rz free, not tz/);
  });

  it("makes a width mate from two faces a side", async () => {
    const t = await plateAndCube();
    const r = await t.apply({
      op: "addMate",
      type: "width",
      a: { instanceId: t.plate, face: "box/-y", face2: "box/+y" },
      b: { instanceId: t.cube, face: "box/-y", face2: "box/+y" },
    });
    expect(r.ok).toBe(true);
    expect(t.assembly().mates[0].a.ref2?.name).toBe("box/+y");
    const half = await t.apply({
      op: "addMate",
      type: "width",
      a: { instanceId: t.plate, face: "box/-y" },
      b: { instanceId: t.cube, face: "box/-y", face2: "box/+y" },
    });
    expect(half.error).toMatch(/a: a width mate needs two parallel faces/);
    const tilted = await t.apply({
      op: "addMate",
      type: "width",
      a: { instanceId: t.plate, face: "box/-y", face2: "box/+x" },
      b: { instanceId: t.cube, face: "box/-y", face2: "box/+y" },
    });
    expect(tilted.error).toMatch(/flat and parallel/);
  });

  it("names what it can't find", async () => {
    const t = await plateAndCube();
    const mate = (a: object, b: object) => t.apply({ op: "addMate", type: "fastened", a: a as never, b: b as never });
    expect((await mate({ instanceId: "x", face: "box/+z" }, { instanceId: t.cube, face: "box/-z" })).error).toMatch(
      /a: no instance "x"/,
    );
    expect(
      (await mate({ instanceId: t.plate, face: "box/top" }, { instanceId: t.cube, face: "box/-z" })).error,
    ).toMatch(/a: No face "box\/top" on this part/);
    expect(
      (await mate({ instanceId: t.plate, face: "box/+z", edge: "box/e0" }, { instanceId: t.cube, face: "box/-z" }))
        .error,
    ).toMatch(/exactly one of face, edge or vertex/);
    expect((await mate({ instanceId: t.cube, face: "box/+z" }, { instanceId: t.cube, face: "box/-z" })).error).toMatch(
      /two different instances/,
    );
    expect(t.commits()).toBe(2); // the two inserts
  });

  it("reports a mate the solver can't hold as the op's failure, keeping it to delete", async () => {
    const t = await plateAndCube();
    await t.apply({ op: "groundInstance", instanceId: t.cube });
    // Both grounded where they are, 50 mm apart: fastening them can't hold.
    const r = await t.apply({
      op: "addMate",
      type: "fastened",
      a: { instanceId: t.plate, face: "box/+z" },
      b: { instanceId: t.cube, face: "box/-z" },
    });
    expect(r.ok).toBe(false);
    expect(r.createdId).toBe(t.assembly().mates[0].id);
    expect(r.featureErrors?.[r.createdId!]).toBeTruthy();
    expect(await t.apply({ op: "delete", featureId: r.createdId! })).toMatchObject({ ok: true });
    expect(t.assembly().mates).toHaveLength(0);
  });
});

describe("delete on an assembly", () => {
  it("removes an instance with its mates, leaving the rest where they are", async () => {
    const t = await plateAndCube();
    await t.apply({
      op: "addMate",
      type: "fastened",
      a: { instanceId: t.plate, face: "box/+z" },
      b: { instanceId: t.cube, face: "box/-z" },
    });
    await t.apply({ op: "delete", featureId: t.plate });
    expect(t.assembly().instances.map((i) => i.id)).toEqual([t.cube]);
    expect(t.assembly().mates).toHaveLength(0);
    // Kept where the mate had put it.
    [15, 5, 4].forEach((v, i) => expect(t.assembly().instances[0].transform[12 + i]).toBeCloseTo(v));
    expect(await t.apply({ op: "delete", featureId: "ghost" })).toMatchObject({ errorKind: "not_found" });
  });
});

describe("which document the ops work on", () => {
  it("refuses part modelling on an assembly, naming what works", async () => {
    const t = assemblyCtx();
    const r = await t.apply({ op: "addPrimitive", kind: "box" });
    expect(r.error).toMatch(/addPrimitive models a part.*insert_instance.*add_mate/);
  });

  it("refuses assembly ops on a part", async () => {
    const t = assemblyCtx();
    t.ctx.documents = { ...t.ctx.documents, info: () => ({ id: "p", name: "Part" }) };
    t.ctx.getAssembly = () => null;
    const r = await t.apply({ op: "insertInstance", documentId: "cube" });
    expect(r.error).toMatch(/works on an assembly; the open document is a part/);
  });
});

/** A plate with two cubes hinged on its top: revolutes r1 (left) and r2
 *  (right), each about its own vertical axis. */
async function twoHinges() {
  const t = assemblyCtx();
  const plate = (await t.apply({ op: "insertInstance", documentId: "plate" })).createdId!;
  const c1 = (await t.apply({ op: "insertInstance", documentId: "cube" })).createdId!;
  const c2 = (await t.apply({ op: "insertInstance", documentId: "cube" })).createdId!;
  const hinge = async (cube: string, x: number) =>
    (
      await t.apply({
        op: "addMate",
        type: "revolute",
        a: { instanceId: plate, face: "box/+z", offset: { x } },
        b: { instanceId: cube, face: "box/-z" },
      })
    ).createdId!;
  const r1 = await hinge(c1, -12);
  const r2 = await hinge(c2, 12);
  return { ...t, plate, c1, c2, r1, r2 };
}
const value = (t: ReturnType<typeof assemblyCtx>, mateId: string, dof = "rz") =>
  t.ctx.getAssembly()!.solution!.values.get(mateId)?.[dof as "rz"];

describe("set_mate_value", () => {
  it("sets a free DOF to a number or an expression, and clears it", async () => {
    const t = await twoHinges();
    expect(await t.apply({ op: "setMateValue", mateId: t.r1, dof: "rz", value: 45 })).toMatchObject({
      ok: true,
      createdId: t.r1,
    });
    expect(value(t, t.r1)).toBe(45);
    await t.apply({ op: "setVariable", name: "turn", expression: "20" });
    await t.apply({ op: "setMateValue", mateId: t.r1, dof: "rz", value: "turn * 2" });
    expect(value(t, t.r1)).toBe(40);
    await t.apply({ op: "setMateValue", mateId: t.r1, dof: "rz", value: "" });
    expect(t.assembly().mates.find((m) => m.id === t.r1)?.values).toBeUndefined();
  });

  it("refuses a DOF the mate doesn't leave free, or a mate that isn't there", async () => {
    const t = await twoHinges();
    expect((await t.apply({ op: "setMateValue", mateId: t.r1, dof: "tz", value: 3 })).error).toMatch(
      /revolute: it leaves rz free, not tz/,
    );
    expect(await t.apply({ op: "setMateValue", mateId: "ghost", dof: "rz", value: 3 })).toMatchObject({
      errorKind: "not_found",
    });
  });
});

describe("add_relation", () => {
  it("gears one hinge to another, and a value typed on the driven one turns its driver", async () => {
    const t = await twoHinges();
    const g = await t.apply({
      op: "addRelation",
      type: "gear",
      driver: { mateId: t.r1, dof: "rz" },
      driven: { mateId: t.r2, dof: "rz" },
      value: 2,
    });
    expect(g).toMatchObject({ ok: true });
    expect(t.assembly().relations?.[0]).toMatchObject({ id: g.createdId, name: "Gear 1", type: "gear", value: "2" });
    await t.apply({ op: "setMateValue", mateId: t.r1, dof: "rz", value: 30 });
    expect(value(t, t.r2)).toBeCloseTo(-60);
    // The driven gear's angle drives its driver: −20 needs 10 on r1.
    expect(await t.apply({ op: "setMateValue", mateId: t.r2, dof: "rz", value: -20 })).toMatchObject({ ok: true });
    expect(t.assembly().mates.find((m) => m.id === t.r1)?.values).toEqual({ rz: "10" });
    expect(t.assembly().mates.find((m) => m.id === t.r2)?.values).toBeUndefined();
    // …but not to an expression, which would be the driven DOF's own.
    expect((await t.apply({ op: "setMateValue", mateId: t.r2, dof: "rz", value: "nope + 1" })).error).toMatch(
      /Not a number/,
    );
  });

  it("refuses ends that don't fit, before making anything", async () => {
    const t = await twoHinges();
    const rel = (driven: { mateId: string; dof: "rz" | "tz" }, type: "gear" | "rack" = "gear") =>
      t.apply({ op: "addRelation", type, driver: { mateId: t.r1, dof: "rz" }, driven, value: 1 });
    expect((await rel({ mateId: "ghost", dof: "rz" })).error).toMatch(/driven: no mate "ghost"/);
    expect((await rel({ mateId: t.r2, dof: "tz" })).error).toMatch(/driven: .* revolute; it leaves rz free, not tz/);
    expect((await rel({ mateId: t.r2, dof: "rz" }, "rack")).error).toMatch(/rack couples a rotation and a translation/);
    expect(t.assembly().relations).toBeUndefined();
  });

  it("reports a relation the solver refuses as the op's failure, keeping it to delete", async () => {
    const t = await twoHinges();
    await t.apply({
      op: "addRelation",
      type: "gear",
      driver: { mateId: t.r1, dof: "rz" },
      driven: { mateId: t.r2, dof: "rz" },
      value: 1,
    });
    const loop = await t.apply({
      op: "addRelation",
      type: "gear",
      driver: { mateId: t.r2, dof: "rz" },
      driven: { mateId: t.r1, dof: "rz" },
      value: 1,
    });
    expect(loop.ok).toBe(false);
    expect(loop.error).toMatch(/loop of relations/);
    expect(await t.apply({ op: "delete", featureId: loop.createdId! })).toMatchObject({ ok: true });
    expect(t.assembly().relations).toHaveLength(1);
  });
});

describe("set_variable on an assembly", () => {
  it("makes and updates the assembly's own variables", async () => {
    const t = assemblyCtx();
    const r = await t.apply({ op: "setVariable", name: "gap", expression: "4" });
    expect(r.ok).toBe(true);
    expect(t.assembly().variables).toEqual([{ id: r.createdId, name: "gap", expression: "4" }]);
    await t.apply({ op: "setVariable", name: "gap", expression: "5" });
    expect(t.assembly().variables).toEqual([{ id: r.createdId, name: "gap", expression: "5" }]);
    expect((await t.apply({ op: "setVariable", name: "gap2", expression: "1" })).error).toMatch(/letters only/);
  });
});

describe("animate_mate", () => {
  /** A viewport that records each pose it's given and "captures" a frame by
   *  numbering it. */
  function recordingViewport(t: ReturnType<typeof assemblyCtx>) {
    const poses: (ReadonlyMap<string, readonly number[]> | null)[] = [];
    const views: string[] = [];
    t.ctx.getViewport = () => ({
      setView: (v) => void views.push(v),
      capturePNG: () => `data:image/png;base64,frame${poses.length}`,
      poseBodies: (p) => void poses.push(p),
    });
    return { poses, views };
  }
  const turnOf = (m: readonly number[]) => (Math.atan2(m[1], m[0]) * 180) / Math.PI;

  it("captures a full turn in four quarter turns, posing the part each time, then lets go", async () => {
    const t = await twoHinges();
    const vp = recordingViewport(t);
    const r = animateMate(t.ctx, { mateId: t.r1, view: "top" });
    expect(r).toMatchObject({ mateId: t.r1, dof: "rz", from: 0, to: 360 });
    expect(r.frames.map((f) => f.value)).toEqual([0, 90, 180, 270]);
    expect(r.frames.map((f) => f.image)).toEqual([1, 2, 3, 4].map((n) => `data:image/png;base64,frame${n}`));
    expect(vp.views).toEqual(["top"]);
    // Each frame turns the hinged cube by its value; the other stays put.
    vp.poses.slice(0, 4).forEach((p, i) => {
      expect(Math.round(turnOf(p!.get(t.c1)!) + 360) % 360).toBe([0, 90, 180, 270][i]);
      expect(turnOf(p!.get(t.c2)!)).toBeCloseTo(0);
    });
    expect(vp.poses.at(-1)).toBeNull();
    // Nothing was written.
    expect(t.assembly().mates.find((m) => m.id === t.r1)?.values).toBeUndefined();
  });

  it("sweeps from and to inclusive, turning what a relation drives too", async () => {
    const t = await twoHinges();
    await t.apply({
      op: "addRelation",
      type: "gear",
      driver: { mateId: t.r1, dof: "rz" },
      driven: { mateId: t.r2, dof: "rz" },
      value: 1,
    });
    const vp = recordingViewport(t);
    const r = animateMate(t.ctx, { mateId: t.r1, from: 0, to: 60, frames: 3 });
    expect(r.frames.map((f) => f.value)).toEqual([0, 30, 60]);
    expect(turnOf(vp.poses[2]!.get(t.c2)!)).toBeCloseTo(-60);
  });

  it("refuses what it can't sweep, saying what to do instead", async () => {
    const t = await twoHinges();
    recordingViewport(t);
    await t.apply({
      op: "addRelation",
      type: "gear",
      driver: { mateId: t.r1, dof: "rz" },
      driven: { mateId: t.r2, dof: "rz" },
      value: 1,
    });
    expect(() => animateMate(t.ctx, { mateId: t.r2 })).toThrow(/driven by relations \(Gear 1\): animate the driver/);
    expect(() => animateMate(t.ctx, { mateId: t.r1, dof: "tz" })).toThrow(/revolute: it leaves rz free, not tz/);
    expect(() => animateMate(t.ctx, { mateId: "ghost" })).toThrow(/No mate "ghost"/);
    const fastened = await t.apply({
      op: "addMate",
      type: "fastened",
      a: { instanceId: t.c1, face: "box/+z" },
      b: { instanceId: (await t.apply({ op: "insertInstance", documentId: "cube" })).createdId!, face: "box/-z" },
    });
    expect(() => animateMate(t.ctx, { mateId: fastened.createdId! })).toThrow(/fastened: nothing moves/);
    t.ctx.getAssembly = () => null;
    expect(() => animateMate(t.ctx, { mateId: t.r1 })).toThrow(/works on an assembly/);
  });
});
