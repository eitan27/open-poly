import { describe, expect, it } from "vitest";
import { z } from "zod";
import { applyOperation, getSceneSummary, type AgentContext } from "./commands";
import { expandEntities, operationSchema } from "./operations";
import { createDocument, resolveDocument } from "../document/document";
import type { Document } from "../document/types";
import type { Selection } from "../viewport/Viewport";

// A minimal in-memory AgentContext. Doc mutations are pure, so no kernel is
// needed. `waitForRegen` stands in for the worker by returning the pure
// document-resolution errors (expressions / references) — the same surface the
// real kernel would also report, minus actual geometry build failures.
function makeCtx(initial: Document = createDocument()) {
  let doc = initial;
  let selection: Selection[] = [];
  const ctx: AgentContext = {
    getDoc: () => doc,
    setDoc: (n) => { doc = n; },
    getSelection: () => selection,
    setSelection: (s) => { selection = s; },
    getMeshes: () => [],
    getErrors: () => resolveDocument(doc).errors,
    waitForRegen: async () => ({ errors: resolveDocument(doc).errors }),
    getViewport: () => null,
  };
  return { ctx, doc: () => doc };
}

// Route through the zod schema, exactly like window.__openpoly / the MCP server
// do — so number→string expression coercion is exercised too.
const apply = (ctx: AgentContext, op: z.input<typeof operationSchema>) =>
  applyOperation(ctx, operationSchema.parse(op));

describe("expandEntities", () => {
  it("expands sugar shapes into entities", () => {
    expect(expandEntities([{ shape: "rect", center: [0, 0], w: 40, h: 20 }])).toHaveLength(4);
    expect(expandEntities([{ shape: "polygon", c: [0, 0], r: 10, n: 6 }])).toHaveLength(6);
    const circ = expandEntities([{ shape: "circle", c: [1, 2], r: 5 }]);
    expect(circ).toEqual([{ type: "circle", id: expect.any(String), c: [1, 2], r: 5 }]);
  });

  it("a centered rect is symmetric about its center", () => {
    const [l0] = expandEntities([{ shape: "rect", center: [0, 0], w: 10, h: 6 }]) as Extract<
      ReturnType<typeof expandEntities>[number],
      { type: "line" }
    >[];
    expect(l0.a).toEqual([-5, -3]);
  });
});

describe("applyOperation — primitives & params", () => {
  it("adds a box with overridden params and name", async () => {
    const { ctx, doc } = makeCtx();
    const r = await apply(ctx, { op: "addPrimitive", kind: "box", params: { width: "50" }, name: "Base" });
    expect(r.ok).toBe(true);
    const f = doc().features.find((x) => x.id === r.createdId);
    expect(f?.type).toBe("primitive");
    expect(f?.name).toBe("Base");
    expect(f && f.type === "primitive" && f.params.width).toBe("50");
    // untouched defaults remain
    expect(f && f.type === "primitive" && f.params.height).toBe("20");
  });

  it("setParam updates an existing feature, errors on unknown id", async () => {
    const { ctx, doc } = makeCtx();
    const r = await apply(ctx, { op: "addPrimitive", kind: "box" });
    await apply(ctx, { op: "setParam", featureId: r.createdId!, name: "width", value: "99" });
    const f = doc().features.find((x) => x.id === r.createdId);
    expect(f && f.type === "primitive" && f.params.width).toBe("99");

    const bad = await apply(ctx, { op: "setParam", featureId: "nope", name: "width", value: "1" });
    expect(bad.ok).toBe(false);
    expect(bad.errorKind).toBe("not_found");
  });
});

describe("applyOperation — variables", () => {
  it("setVariable creates then updates by name", async () => {
    const { ctx, doc } = makeCtx();
    const a = await apply(ctx, { op: "setVariable", name: "width", expression: "40" });
    expect(doc().variables).toHaveLength(1);
    expect(doc().variables[0]).toMatchObject({ name: "width", expression: "40" });

    const b = await apply(ctx, { op: "setVariable", name: "width", expression: "60" });
    expect(b.createdId).toBe(a.createdId); // same variable
    expect(doc().variables).toHaveLength(1);
    expect(doc().variables[0].expression).toBe("60");
  });
});

describe("applyOperation — sketch + extrude (no kernel)", () => {
  it("sketches a rect on Top and extrudes its sole region", async () => {
    const { ctx, doc } = makeCtx();
    const sk = await apply(ctx, {
      op: "addSketch",
      plane: { datum: "top" },
      entities: [{ shape: "rect", center: [0, 0], w: 40, h: 40 }],
      name: "Profile",
    });
    expect(sk.ok).toBe(true);
    const sketch = doc().features.find((f) => f.id === sk.createdId);
    expect(sketch?.type).toBe("sketch");
    expect(sketch && sketch.type === "sketch" && sketch.entities).toHaveLength(4);

    const ex = await apply(ctx, { op: "addExtrude", profile: { sketchId: sk.createdId! }, distance: 10 });
    expect(ex.ok).toBe(true);
    expect(ex.featureErrors).toBeUndefined(); // resolves cleanly (no geometry build in tests)
    const extrude = doc().features.find((f) => f.id === ex.createdId);
    expect(extrude?.type).toBe("extrude");
  });

  it("errors when a sketch has no closed region to extrude", async () => {
    const { ctx } = makeCtx();
    const sk = await apply(ctx, {
      op: "addSketch",
      plane: { datum: "top" },
      entities: [{ shape: "line", a: [0, 0], b: [10, 0] }],
    });
    const ex = await apply(ctx, { op: "addExtrude", profile: { sketchId: sk.createdId! }, distance: 5 });
    expect(ex.ok).toBe(false);
    expect(ex.errorKind).toBe("invalid_op");
  });
});

describe("applyOperation — delete & rollback", () => {
  it("deletes a feature", async () => {
    const { ctx, doc } = makeCtx();
    const r = await apply(ctx, { op: "addPrimitive", kind: "cylinder" });
    expect(doc().features).toHaveLength(1);
    await apply(ctx, { op: "delete", featureId: r.createdId! });
    expect(doc().features).toHaveLength(0);
  });

  it("clamps rollback index", async () => {
    const { ctx, doc } = makeCtx();
    await apply(ctx, { op: "addPrimitive", kind: "box" });
    await apply(ctx, { op: "setRollback", index: 99 });
    expect(doc().rollbackIndex).toBe(1);
  });
});

describe("applyOperation — construction, extent, revolve, mirror", () => {
  it("expandEntities marks construction geometry (only when true)", () => {
    const c = expandEntities([{ shape: "line", a: [0, 0], b: [0, 10], construction: true }]);
    expect(c[0]).toMatchObject({ type: "line", construction: true });
    const n = expandEntities([{ shape: "line", a: [0, 0], b: [0, 10] }]);
    expect("construction" in n[0]).toBe(false);
  });

  it("addExtrude passes through the extent", async () => {
    const { ctx, doc } = makeCtx();
    const sk = await apply(ctx, { op: "addSketch", plane: { datum: "top" }, entities: [{ shape: "rect", center: [0, 0], w: 20, h: 20 }] });
    const ex = await apply(ctx, { op: "addExtrude", profile: { sketchId: sk.createdId! }, distance: 10, extent: "symmetric" });
    const f = doc().features.find((x) => x.id === ex.createdId);
    expect(f && f.type === "extrude" && f.extent).toBe("symmetric");
  });

  it("addRevolve revolves a region around a construction axis line", async () => {
    const { ctx, doc } = makeCtx();
    const sk = await apply(ctx, {
      op: "addSketch",
      plane: { datum: "front" },
      entities: [
        { shape: "rect", corner: [10, 0], w: 5, h: 20 },
        { shape: "line", a: [0, 0], b: [0, 20], construction: true }, // axis (off the region)
      ],
    });
    // The agent gets the axis entity id from the scene summary's new `entities`.
    const axis = getSceneSummary(ctx).sketches[0].entities.find((e) => e.type === "line" && e.construction);
    expect(axis).toBeTruthy();
    const rev = await apply(ctx, {
      op: "addRevolve",
      profile: { sketchId: sk.createdId! },
      axis: { sketchId: sk.createdId!, entityId: axis!.id },
      angle: 270,
    });
    expect(rev.ok).toBe(true);
    const f = doc().features.find((x) => x.id === rev.createdId);
    expect(f?.type).toBe("revolve");
    expect(f && f.type === "revolve" && f.angle).toBe("270");
  });

  it("addRevolve rejects a non-line axis", async () => {
    const { ctx } = makeCtx();
    const sk = await apply(ctx, {
      op: "addSketch",
      plane: { datum: "front" },
      entities: [
        { shape: "rect", corner: [10, 0], w: 5, h: 20 },
        { shape: "circle", c: [0, 0], r: 2, construction: true },
      ],
    });
    const circ = getSceneSummary(ctx).sketches[0].entities.find((e) => e.type === "circle");
    const rev = await apply(ctx, {
      op: "addRevolve",
      profile: { sketchId: sk.createdId! },
      axis: { sketchId: sk.createdId!, entityId: circ!.id },
    });
    expect(rev.ok).toBe(false);
    expect(rev.errorKind).toBe("invalid_op");
  });

  it("addMirror mirrors a body across a datum plane", async () => {
    const { ctx, doc } = makeCtx();
    const box = await apply(ctx, { op: "addPrimitive", kind: "box" });
    const m = await apply(ctx, { op: "addMirror", targetId: box.createdId!, plane: { datum: "right" } });
    expect(m.ok).toBe(true);
    expect(doc().features.find((x) => x.id === m.createdId)?.type).toBe("mirror");
  });

  it("expandEntities expands a spline through its points", () => {
    const e = expandEntities([{ shape: "spline", points: [[0, 0], [10, 5], [20, 0]] }]);
    expect(e).toEqual([{ type: "spline", id: expect.any(String), points: [[0, 0], [10, 5], [20, 0]] }]);
  });

  it("addSweep sweeps a region along a spline path", async () => {
    const { ctx, doc } = makeCtx();
    const sk = await apply(ctx, {
      op: "addSketch",
      plane: { datum: "top" },
      entities: [
        { shape: "circle", c: [0, 0], r: 4 },
        { shape: "spline", points: [[0, 0], [20, 10], [40, -5]] },
      ],
    });
    const path = getSceneSummary(ctx).sketches[0].entities.find((e) => e.type === "spline");
    expect(path).toBeTruthy();
    const sw = await apply(ctx, {
      op: "addSweep",
      profile: { sketchId: sk.createdId! },
      path: { sketchId: sk.createdId!, entityId: path!.id },
    });
    expect(sw.ok).toBe(true);
    expect(doc().features.find((x) => x.id === sw.createdId)?.type).toBe("sweep");
  });

  it("addSweep rejects a non-curve path (e.g. a circle)", async () => {
    const { ctx } = makeCtx();
    const sk = await apply(ctx, {
      op: "addSketch",
      plane: { datum: "top" },
      entities: [{ shape: "rect", center: [0, 0], w: 8, h: 8 }, { shape: "circle", c: [30, 0], r: 3 }],
    });
    const circ = getSceneSummary(ctx).sketches[0].entities.find((e) => e.type === "circle");
    const sw = await apply(ctx, {
      op: "addSweep",
      profile: { sketchId: sk.createdId! },
      path: { sketchId: sk.createdId!, entityId: circ!.id },
    });
    expect(sw.ok).toBe(false);
    expect(sw.errorKind).toBe("invalid_op");
  });

  it("addLoft lofts through two regions on different planes", async () => {
    const { ctx, doc } = makeCtx();
    const s1 = await apply(ctx, { op: "addSketch", plane: { datum: "top" }, entities: [{ shape: "circle", c: [0, 0], r: 10 }] });
    const pl = await apply(ctx, { op: "addPlane", base: { datum: "top" }, offset: 30 });
    const s2 = await apply(ctx, { op: "addSketch", plane: { planeId: pl.createdId! }, entities: [{ shape: "circle", c: [0, 0], r: 4 }] });
    const lf = await apply(ctx, {
      op: "addLoft",
      profiles: [{ sketchId: s1.createdId! }, { sketchId: s2.createdId! }],
    });
    expect(lf.ok).toBe(true);
    expect(doc().features.find((x) => x.id === lf.createdId)?.type).toBe("loft");
  });
});

describe("getSceneSummary", () => {
  it("digests sketches, variables, and selection (bodies need the kernel)", async () => {
    const { ctx } = makeCtx();
    await apply(ctx, { op: "setVariable", name: "w", expression: "40" });
    await apply(ctx, {
      op: "addSketch",
      plane: { datum: "top" },
      entities: [{ shape: "circle", c: [0, 0], r: 5 }],
      name: "Hole",
    });
    const s = getSceneSummary(ctx);
    expect(s.bodies).toHaveLength(0); // no meshes in the test ctx
    expect(s.sketches).toHaveLength(1);
    expect(s.sketches[0].name).toBe("Hole");
    expect(s.sketches[0].regions).toHaveLength(1);
    expect(s.variables).toEqual([{ name: "w", expression: "40", value: 40 }]);
    expect(s.featureCount).toBe(1);
  });
});
