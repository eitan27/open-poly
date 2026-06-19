import { describe, expect, it } from "vitest";
import { z } from "zod";
import { applyOperation, getSceneSummary, type AgentContext } from "./commands";
import { expandEntities, operationSchema } from "./operations";
import { createDocument } from "../document/document";
import type { Document } from "../document/types";
import type { Selection } from "../viewport/Viewport";

// A minimal in-memory AgentContext. Doc mutations are pure, so no kernel is
// needed — meshes are empty (face/body refs aren't exercised here).
function makeCtx(initial: Document = createDocument()) {
  let doc = initial;
  let selection: Selection[] = [];
  const ctx: AgentContext = {
    getDoc: () => doc,
    setDoc: (n) => { doc = n; },
    getSelection: () => selection,
    setSelection: (s) => { selection = s; },
    getMeshes: () => [],
    getErrors: () => ({}),
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
  it("adds a box with overridden params and name", () => {
    const { ctx, doc } = makeCtx();
    const r = apply(ctx, { op: "addPrimitive", kind: "box", params: { width: "50" }, name: "Base" });
    expect(r.ok).toBe(true);
    const f = doc().features.find((x) => x.id === r.createdId);
    expect(f?.type).toBe("primitive");
    expect(f?.name).toBe("Base");
    expect(f && f.type === "primitive" && f.params.width).toBe("50");
    // untouched defaults remain
    expect(f && f.type === "primitive" && f.params.height).toBe("20");
  });

  it("setParam updates an existing feature, errors on unknown id", () => {
    const { ctx, doc } = makeCtx();
    const r = apply(ctx, { op: "addPrimitive", kind: "box" });
    apply(ctx, { op: "setParam", featureId: r.createdId!, name: "width", value: "99" });
    const f = doc().features.find((x) => x.id === r.createdId);
    expect(f && f.type === "primitive" && f.params.width).toBe("99");

    const bad = apply(ctx, { op: "setParam", featureId: "nope", name: "width", value: "1" });
    expect(bad.ok).toBe(false);
    expect(bad.errorKind).toBe("not_found");
  });
});

describe("applyOperation — variables", () => {
  it("setVariable creates then updates by name", () => {
    const { ctx, doc } = makeCtx();
    const a = apply(ctx, { op: "setVariable", name: "width", expression: "40" });
    expect(doc().variables).toHaveLength(1);
    expect(doc().variables[0]).toMatchObject({ name: "width", expression: "40" });

    const b = apply(ctx, { op: "setVariable", name: "width", expression: "60" });
    expect(b.createdId).toBe(a.createdId); // same variable
    expect(doc().variables).toHaveLength(1);
    expect(doc().variables[0].expression).toBe("60");
  });
});

describe("applyOperation — sketch + extrude (no kernel)", () => {
  it("sketches a rect on Top and extrudes its sole region", () => {
    const { ctx, doc } = makeCtx();
    const sk = apply(ctx, {
      op: "addSketch",
      plane: { datum: "top" },
      entities: [{ shape: "rect", center: [0, 0], w: 40, h: 40 }],
      name: "Profile",
    });
    expect(sk.ok).toBe(true);
    const sketch = doc().features.find((f) => f.id === sk.createdId);
    expect(sketch?.type).toBe("sketch");
    expect(sketch && sketch.type === "sketch" && sketch.entities).toHaveLength(4);

    const ex = apply(ctx, { op: "addExtrude", profile: { sketchId: sk.createdId! }, distance: 10 });
    expect(ex.ok).toBe(true);
    expect(ex.featureErrors).toBeUndefined(); // resolves cleanly without the kernel
    const extrude = doc().features.find((f) => f.id === ex.createdId);
    expect(extrude?.type).toBe("extrude");
  });

  it("errors when a sketch has no closed region to extrude", () => {
    const { ctx } = makeCtx();
    const sk = apply(ctx, {
      op: "addSketch",
      plane: { datum: "top" },
      entities: [{ shape: "line", a: [0, 0], b: [10, 0] }],
    });
    const ex = apply(ctx, { op: "addExtrude", profile: { sketchId: sk.createdId! }, distance: 5 });
    expect(ex.ok).toBe(false);
    expect(ex.errorKind).toBe("invalid_op");
  });
});

describe("applyOperation — delete & rollback", () => {
  it("deletes a feature", () => {
    const { ctx, doc } = makeCtx();
    const r = apply(ctx, { op: "addPrimitive", kind: "cylinder" });
    expect(doc().features).toHaveLength(1);
    apply(ctx, { op: "delete", featureId: r.createdId! });
    expect(doc().features).toHaveLength(0);
  });

  it("clamps rollback index", () => {
    const { ctx, doc } = makeCtx();
    apply(ctx, { op: "addPrimitive", kind: "box" });
    apply(ctx, { op: "setRollback", index: 99 });
    expect(doc().rollbackIndex).toBe(1);
  });
});

describe("getSceneSummary", () => {
  it("digests sketches, variables, and selection (bodies need the kernel)", () => {
    const { ctx } = makeCtx();
    apply(ctx, { op: "setVariable", name: "w", expression: "40" });
    apply(ctx, {
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
