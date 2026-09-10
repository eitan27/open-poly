import { describe, expect, it } from "vitest";
import { z } from "zod";
import { applyOperation, getSceneSummary, type AgentContext } from "./commands";
import { expandEntities, operationSchema } from "./operations";
import { createDocument, resolveDocument } from "../document/document";
import { applyDerived } from "../document/derived";
import type { Document } from "../document/types";
import { DEFAULT_SECTION_VIEW } from "../document/sectionView";
import type { Selection } from "../viewport/Viewport";

// A minimal in-memory AgentContext. Doc mutations are pure, so no kernel is
// needed. `waitForRegen` stands in for the worker by returning the pure
// document-resolution errors (expressions / references) — the same surface the
// real kernel would also report, minus actual geometry build failures.

/** Workspace stub for tests that don't exercise multi-document ops. */
function stubDocuments(): AgentContext["documents"] {
  return {
    info: () => ({ id: "test-doc", name: "Test" }),
    open: async () => {},
    create: async () => {},
    duplicate: async () => {},
    rename: async () => {},
  };
}

function makeCtx(initial: Document = createDocument()) {
  let doc = initial;
  let selection: Selection[] = [];
  const ctx: AgentContext = {
    getDoc: () => doc,
    setDoc: (n) => {
      doc = n;
    },
    getSelection: () => selection,
    setSelection: (s) => {
      selection = s;
    },
    getSectionView: () => DEFAULT_SECTION_VIEW,
    setSectionView: () => {},
    getMeshes: () => [],
    getErrors: () => resolveDocument(doc).errors,
    waitForRegen: async () => ({ errors: resolveDocument(doc).errors }),
    getViewport: () => null,
    documents: stubDocuments(),
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

  it("arc start/end are given in DEGREES and stored as radians", () => {
    const [arc] = expandEntities([{ shape: "arc", c: [0, 0], r: 5, start: 0, end: 180 }]) as Extract<
      ReturnType<typeof expandEntities>[number],
      { type: "arc" }
    >[];
    expect(arc.start).toBeCloseTo(0);
    expect(arc.end).toBeCloseTo(Math.PI);
    expect(arc.exprs).toBeUndefined(); // plain numbers → no overlay
  });

  it("text rotation is DEGREES → radians (and only present when given)", () => {
    const [t] = expandEntities([{ shape: "text", p: [0, 0], value: "A", height: 8, rotation: 90 }]) as Extract<
      ReturnType<typeof expandEntities>[number],
      { type: "text" }
    >[];
    expect(t.rotation).toBeCloseTo(Math.PI / 2);
    const [t2] = expandEntities([{ shape: "text", p: [0, 0], value: "A", height: 8 }]) as Extract<
      ReturnType<typeof expandEntities>[number],
      { type: "text" }
    >[];
    expect("rotation" in t2).toBe(false);
  });

  it("expression coordinates evaluate against scope and record an exprs overlay", () => {
    const scope = { innerRad: 6, clearance: 0.3 };
    const [circ] = expandEntities([{ shape: "circle", c: [0, 0], r: "innerRad + clearance" }], scope) as Extract<
      ReturnType<typeof expandEntities>[number],
      { type: "circle" }
    >[];
    expect(circ.r).toBeCloseTo(6.3);
    expect(circ.exprs).toEqual({ r: "innerRad + clearance" });
  });

  it("a numeric expression string needs no overlay", () => {
    const [circ] = expandEntities([{ shape: "circle", c: [0, 0], r: "10/2" }]) as Extract<
      ReturnType<typeof expandEntities>[number],
      { type: "circle" }
    >[];
    expect(circ.r).toBeCloseTo(5);
    expect(circ.exprs).toBeUndefined();
  });

  it("a variable rect composes overlays onto every generated line endpoint", () => {
    const lines = expandEntities([{ shape: "rect", center: [0, 0], w: "width", h: 6 }], { width: 10 }) as Extract<
      ReturnType<typeof expandEntities>[number],
      { type: "line" }
    >[];
    expect(lines).toHaveLength(4);
    // First corner x = center.x − width/2 = −5, and it tracks `width`.
    expect(lines[0].a).toEqual([-5, -3]);
    expect(lines[0].exprs?.["a.0"]).toBe("(0)-((width)*0.5)");
    // The literal h axis carries no overlay on that coordinate.
    expect(lines[0].exprs?.["a.1"]).toBeUndefined();
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

  it("setVariable rejects an invalid name (letters-only rule) without creating it", async () => {
    const { ctx, doc } = makeCtx();
    for (const name of ["wall_thickness", "r1", "hole2", "pi", "my var"]) {
      const r = await apply(ctx, { op: "setVariable", name, expression: "5" });
      expect(r.ok).toBe(false);
      expect(r.errorKind).toBe("invalid_op");
    }
    expect(doc().variables).toHaveLength(0); // none of the bad names were created
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

  it("a sketch coordinate expression reflows when its variable changes (end to end)", async () => {
    const { ctx, doc } = makeCtx();
    await apply(ctx, { op: "setVariable", name: "R", expression: "5" });
    const sk = await apply(ctx, {
      op: "addSketch",
      plane: { datum: "top" },
      entities: [{ shape: "circle", c: [0, 0], r: "R" }],
    });
    const circle = () => {
      const d = doc();
      const s = d.features.find((f) => f.id === sk.createdId);
      if (s?.type !== "sketch") throw new Error("sketch missing");
      return applyDerived(s, resolveDocument(d).scope).entities[0];
    };
    expect(circle()).toMatchObject({ type: "circle", r: 5 }); // initial number from scope
    await apply(ctx, { op: "setVariable", name: "R", expression: "12" });
    expect(circle()).toMatchObject({ type: "circle", r: 12 }); // re-driven by the overlay
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

describe("applyOperation — import_dxf", () => {
  const dxf = (...pairs: Array<[number, string | number]>) => {
    const lines = ["0", "SECTION", "2", "ENTITIES"];
    for (const [c, v] of pairs) lines.push(String(c), String(v));
    lines.push("0", "ENDSEC", "0", "EOF");
    return lines.join("\n");
  };

  it("imports a DXF as an editable sketch on the chosen plane, scaled", async () => {
    const { ctx, doc } = makeCtx();
    const source = dxf(
      [0, "LINE"],
      [8, 0],
      [10, 0],
      [20, 0],
      [11, 10],
      [21, 0],
      [0, "CIRCLE"],
      [8, 0],
      [10, 5],
      [20, 5],
      [40, 2],
    );
    const r = await apply(ctx, { op: "importDxf", source, plane: { datum: "front" }, scale: 2, name: "Plate" });
    expect(r.ok).toBe(true);
    const sketch = doc().features.find((f) => f.id === r.createdId);
    expect(sketch?.type).toBe("sketch");
    if (sketch?.type !== "sketch") throw new Error("expected sketch");
    expect(sketch.name).toBe("Plate");
    expect(sketch.plane).toMatchObject({ kind: "datum", id: "plane-front" });
    expect(sketch.entities).toHaveLength(2);
    const circle = sketch.entities.find((e) => e.type === "circle");
    expect(circle && circle.type === "circle" && circle.r).toBe(4); // 2 × scale
  });

  it("rejects a DXF with no importable geometry", async () => {
    const { ctx } = makeCtx();
    const source = dxf([0, "ELLIPSE"], [8, 0], [10, 0], [20, 0], [11, 5], [21, 0], [40, 0.5]);
    const r = await apply(ctx, { op: "importDxf", source, plane: { datum: "top" } });
    expect(r).toMatchObject({ ok: false, errorKind: "invalid_op" });
  });

  it("warns about skipped unsupported entities against the created sketch", async () => {
    const { ctx } = makeCtx();
    const source = dxf(
      [0, "LINE"],
      [8, 0],
      [10, 0],
      [20, 0],
      [11, 10],
      [21, 0],
      [0, "ELLIPSE"],
      [8, 0],
      [10, 0],
      [20, 0],
      [11, 5],
      [21, 0],
      [40, 0.5],
    );
    const r = await apply(ctx, { op: "importDxf", source, plane: { datum: "top" } });
    expect(r.ok).toBe(true);
    expect(r.warnings?.[r.createdId!]).toMatch(/skipped 1 unsupported/i);
    expect(r.warnings?.[r.createdId!]).toMatch(/ELLIPSE/);
  });
});

describe("applyOperation — sketch constraints & dimensions", () => {
  // Add a sketch and return the ctx plus the ids of its entities (in order), so
  // constraint tests can reference the concrete entity ids the agent would read
  // from get_scene_summary.
  const sketchWith = async (entities: { shape: string; [k: string]: unknown }[]) => {
    const { ctx, doc } = makeCtx();
    const sk = await apply(ctx, { op: "addSketch", plane: { datum: "top" }, entities: entities as never });
    const ids = getSceneSummary(ctx).sketches[0].entities.map((e) => e.id);
    return { ctx, doc, sketchId: sk.createdId!, ids };
  };

  it("applies a horizontal constraint and lists it in the summary", async () => {
    const { ctx, sketchId, ids } = await sketchWith([{ shape: "line", a: [0, 0], b: [10, 2] }]);
    const r = await apply(ctx, { op: "addConstraint", sketchId, constraint: { kind: "horizontal", entity: ids[0] } });
    expect(r.ok).toBe(true);
    const sketch = getSceneSummary(ctx).sketches[0];
    expect(sketch.constraints).toHaveLength(1);
    expect(sketch.constraints[0]).toMatchObject({ type: "horizontal", refs: [ids[0]] });
    // The line was pulled horizontal: both endpoints share a v-coordinate.
    const line = ctx.getDoc().features.find((f) => f.id === sketchId);
    if (line?.type !== "sketch" || line.entities[0].type !== "line") throw new Error("no line");
    expect(Math.abs(line.entities[0].a[1] - line.entities[0].b[1])).toBeLessThan(1e-6);
  });

  it("add_dimension length drives the line to a variable value", async () => {
    const { ctx, sketchId, ids } = await sketchWith([{ shape: "line", a: [0, 0], b: [10, 0] }]);
    await apply(ctx, { op: "setVariable", name: "len", expression: 25 });
    const r = await apply(ctx, {
      op: "addDimension",
      sketchId,
      dimension: { kind: "length", entity: ids[0], value: "len" },
    });
    expect(r.ok).toBe(true);
    const summ = getSceneSummary(ctx).sketches[0];
    expect(summ.constraints[0]).toMatchObject({ type: "distance", value: 25 });
    const sk = ctx.getDoc().features.find((f) => f.id === sketchId);
    if (sk?.type !== "sketch" || sk.entities[0].type !== "line") throw new Error("no line");
    const len = Math.hypot(sk.entities[0].b[0] - sk.entities[0].a[0], sk.entities[0].b[1] - sk.entities[0].a[1]);
    expect(len).toBeCloseTo(25, 4);
  });

  it("rejects a conflicting constraint and leaves the sketch unchanged", async () => {
    const { ctx, sketchId, ids } = await sketchWith([{ shape: "line", a: [0, 0], b: [10, 0] }]);
    await apply(ctx, { op: "addConstraint", sketchId, constraint: { kind: "horizontal", entity: ids[0] } });
    // A vertical on the same (now horizontal, origin-anchored) line collapses it —
    // rejected, and the one surviving constraint is still just the horizontal.
    const r = await apply(ctx, { op: "addConstraint", sketchId, constraint: { kind: "vertical", entity: ids[0] } });
    expect(r.ok).toBe(false);
    expect(r.errorKind).toBe("invalid_op");
    expect(getSceneSummary(ctx).sketches[0].constraints).toHaveLength(1);
  });

  it("remove_constraint deletes by id", async () => {
    const { ctx, sketchId, ids } = await sketchWith([{ shape: "line", a: [0, 0], b: [10, 2] }]);
    const add = await apply(ctx, { op: "addConstraint", sketchId, constraint: { kind: "horizontal", entity: ids[0] } });
    await apply(ctx, { op: "removeConstraint", sketchId, constraintId: add.createdId! });
    expect(getSceneSummary(ctx).sketches[0].constraints).toHaveLength(0);
  });

  it("add_dimension diameter sizes the circle to half of it", async () => {
    // The agent states Ø like a drawing does; the stored value is the diameter
    // and only the solver sees the radius.
    const { ctx, sketchId, ids } = await sketchWith([{ shape: "circle", c: [0, 0], r: 3 }]);
    const r = await apply(ctx, {
      op: "addDimension",
      sketchId,
      dimension: { kind: "diameter", entity: ids[0], value: 40 },
    });
    expect(r.ok).toBe(true);
    expect(getSceneSummary(ctx).sketches[0].constraints[0]).toMatchObject({ type: "diameter", value: 40 });
    const sk = ctx.getDoc().features.find((f) => f.id === sketchId);
    if (sk?.type !== "sketch" || sk.entities[0].type !== "circle") throw new Error("no circle");
    expect(sk.entities[0].r).toBeCloseTo(20, 4);
  });

  it("a diameter typed as a variable follows it", async () => {
    const { ctx, sketchId, ids } = await sketchWith([{ shape: "circle", c: [0, 0], r: 3 }]);
    await apply(ctx, { op: "setVariable", name: "bore", expression: 12 });
    await apply(ctx, {
      op: "addDimension",
      sketchId,
      dimension: { kind: "diameter", entity: ids[0], value: "bore" },
    });
    expect(getSceneSummary(ctx).sketches[0].constraints[0]).toMatchObject({ type: "diameter", value: 12 });
    const sk = ctx.getDoc().features.find((f) => f.id === sketchId);
    if (sk?.type !== "sketch" || sk.entities[0].type !== "circle") throw new Error("no circle");
    expect(sk.entities[0].r).toBeCloseTo(6, 4);
  });

  it("errors on a wrong-kind entity (diameter on a line)", async () => {
    const { ctx, sketchId, ids } = await sketchWith([{ shape: "line", a: [0, 0], b: [10, 0] }]);
    const r = await apply(ctx, {
      op: "addDimension",
      sketchId,
      dimension: { kind: "diameter", entity: ids[0], value: 5 },
    });
    expect(r.ok).toBe(false);
    expect(r.errorKind).toBe("invalid_op");
  });

  it("errors on a wrong-kind entity (radius on a line)", async () => {
    const { ctx, sketchId, ids } = await sketchWith([{ shape: "line", a: [0, 0], b: [10, 0] }]);
    const r = await apply(ctx, {
      op: "addDimension",
      sketchId,
      dimension: { kind: "radius", entity: ids[0], value: 5 },
    });
    expect(r.ok).toBe(false);
    expect(r.errorKind).toBe("invalid_op");
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
    const sk = await apply(ctx, {
      op: "addSketch",
      plane: { datum: "top" },
      entities: [{ shape: "rect", center: [0, 0], w: 20, h: 20 }],
    });
    const ex = await apply(ctx, {
      op: "addExtrude",
      profile: { sketchId: sk.createdId! },
      distance: 10,
      extent: "symmetric",
    });
    const f = doc().features.find((x) => x.id === ex.createdId);
    expect(f && f.type === "extrude" && f.extent).toBe("symmetric");
  });

  it("addExtrude upToFace resolves the target face's name + centroid", async () => {
    // ctx with one body exposing a named planar face (the up-to-face target).
    let d = createDocument();
    let sel: Selection[] = [];
    const ctx: AgentContext = {
      getDoc: () => d,
      setDoc: (n) => {
        d = n;
      },
      getSelection: () => sel,
      setSelection: (s) => {
        sel = s;
      },
      getSectionView: () => DEFAULT_SECTION_VIEW,
      setSectionView: () => {},
      getMeshes: () => [
        {
          id: "target-body",
          mesh: {
            name: "target-body",
            faces: {
              vertices: [0, 0, 30, 10, 0, 30, 0, 10, 30],
              triangles: [0, 1, 2],
              normals: [0, 0, -1, 0, 0, -1, 0, 0, -1],
              faceGroups: [{ start: 0, count: 3, faceId: 7, name: "target-body/-z" }],
            },
            edges: { lines: [] },
          },
        },
      ],
      getErrors: () => resolveDocument(d).errors,
      waitForRegen: async () => ({ errors: resolveDocument(d).errors }),
      getViewport: () => null,
      documents: stubDocuments(),
    };
    const sk = await apply(ctx, {
      op: "addSketch",
      plane: { datum: "top" },
      entities: [{ shape: "rect", center: [0, 0], w: 10, h: 10 }],
    });
    const ex = await apply(ctx, {
      op: "addExtrude",
      profile: { sketchId: sk.createdId! },
      distance: 1,
      extent: "upToFace",
      upTo: { bodyId: "target-body", faceName: "target-body/-z" },
    });
    const f = d.features.find((x) => x.id === ex.createdId);
    expect(f && f.type === "extrude" && f.extent).toBe("upToFace");
    expect(f && f.type === "extrude" && f.upTo).toMatchObject({
      featureId: "target-body",
      faceName: "target-body/-z",
    });
    // Centroid of the three sample verts, all at z=30.
    expect(f && f.type === "extrude" && f.upTo?.center[2]).toBeCloseTo(30, 5);
  });

  it("addExtrude upToFace errors without a target face", async () => {
    const { ctx } = makeCtx();
    const sk = await apply(ctx, {
      op: "addSketch",
      plane: { datum: "top" },
      entities: [{ shape: "rect", center: [0, 0], w: 10, h: 10 }],
    });
    const r = await apply(ctx, {
      op: "addExtrude",
      profile: { sketchId: sk.createdId! },
      distance: 1,
      extent: "upToFace",
    });
    expect(r.ok).toBe(false);
    expect(r.errorKind).toBe("invalid_op");
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
    const e = expandEntities([
      {
        shape: "spline",
        points: [
          [0, 0],
          [10, 5],
          [20, 0],
        ],
      },
    ]);
    expect(e).toEqual([
      {
        type: "spline",
        id: expect.any(String),
        points: [
          [0, 0],
          [10, 5],
          [20, 0],
        ],
      },
    ]);
  });

  it("addSweep sweeps a region along a spline path", async () => {
    const { ctx, doc } = makeCtx();
    const sk = await apply(ctx, {
      op: "addSketch",
      plane: { datum: "top" },
      entities: [
        { shape: "circle", c: [0, 0], r: 4 },
        {
          shape: "spline",
          points: [
            [0, 0],
            [20, 10],
            [40, -5],
          ],
        },
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
      entities: [
        { shape: "rect", center: [0, 0], w: 8, h: 8 },
        { shape: "circle", c: [30, 0], r: 3 },
      ],
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
    const s1 = await apply(ctx, {
      op: "addSketch",
      plane: { datum: "top" },
      entities: [{ shape: "circle", c: [0, 0], r: 10 }],
    });
    const pl = await apply(ctx, { op: "addPlane", base: { datum: "top" }, offset: 30 });
    const s2 = await apply(ctx, {
      op: "addSketch",
      plane: { planeId: pl.createdId! },
      entities: [{ shape: "circle", c: [0, 0], r: 4 }],
    });
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

describe("applyOperation — revolve options, text, offset, mirror", () => {
  it("addRevolve carries the symmetric flag", async () => {
    const { ctx, doc } = makeCtx();
    const sk = await apply(ctx, {
      op: "addSketch",
      plane: { datum: "front" },
      entities: [
        { shape: "rect", corner: [10, 0], w: 5, h: 20 },
        { shape: "line", a: [0, 0], b: [0, 20], construction: true },
      ],
    });
    const axis = getSceneSummary(ctx).sketches[0].entities.find((e) => e.type === "line" && e.construction);
    const rev = await apply(ctx, {
      op: "addRevolve",
      profile: { sketchId: sk.createdId! },
      axis: { sketchId: sk.createdId!, entityId: axis!.id },
      angle: 90,
      symmetric: true,
    });
    expect(rev.ok).toBe(true);
    const f = doc().features.find((x) => x.id === rev.createdId);
    expect(f && f.type === "revolve" && f.symmetric).toBe(true);
  });

  it("addRevolve accepts a plane as the axis", async () => {
    const { ctx, doc } = makeCtx();
    const sk = await apply(ctx, {
      op: "addSketch",
      plane: { datum: "front" },
      entities: [{ shape: "rect", corner: [10, 0], w: 5, h: 20 }],
    });
    const rev = await apply(ctx, {
      op: "addRevolve",
      profile: { sketchId: sk.createdId! },
      axis: { plane: { datum: "right" } },
    });
    expect(rev.ok).toBe(true);
    const f = doc().features.find((x) => x.id === rev.createdId);
    expect(f && f.type === "revolve" && "plane" in f.axis).toBe(true);
  });

  it("places a text entity and extrudes it via a sketchText profile", async () => {
    const { ctx, doc } = makeCtx();
    const sk = await apply(ctx, {
      op: "addSketch",
      plane: { datum: "top" },
      entities: [{ shape: "text", p: [0, 0], value: "AB", height: 8 }],
    });
    const txt = getSceneSummary(ctx).sketches[0].entities.find((e) => e.type === "text");
    expect(txt).toBeTruthy();
    const ex = await apply(ctx, {
      op: "addExtrude",
      profile: { sketchId: sk.createdId!, textId: txt!.id },
      distance: 3,
    });
    expect(ex.ok).toBe(true);
    const f = doc().features.find((x) => x.id === ex.createdId);
    expect(f && f.type === "extrude" && f.profiles[0].kind).toBe("sketchText");
  });

  it("addOffset appends an associative offset op and the output shows up", async () => {
    const { ctx, doc } = makeCtx();
    const sk = await apply(ctx, {
      op: "addSketch",
      plane: { datum: "top" },
      entities: [{ shape: "circle", c: [0, 0], r: 10 }],
    });
    const circ = getSceneSummary(ctx).sketches[0].entities.find((e) => e.type === "circle");
    const off = await apply(ctx, { op: "addOffset", sketchId: sk.createdId!, sourceIds: [circ!.id], distance: 2 });
    expect(off.ok).toBe(true);
    const s = doc().features.find((x) => x.id === sk.createdId);
    expect(s && s.type === "sketch" && s.derived?.[0].kind).toBe("offset");
    // The driven offset circle is visible in the summary (a 2nd region) marked derived.
    const summary = getSceneSummary(ctx).sketches[0];
    expect(summary.regions.length).toBe(2);
    expect(summary.entities.some((e) => e.derived)).toBe(true);
  });

  it("addOffset rejects a non-offsettable source (spline)", async () => {
    const { ctx } = makeCtx();
    const sk = await apply(ctx, {
      op: "addSketch",
      plane: { datum: "top" },
      entities: [
        {
          shape: "spline",
          points: [
            [0, 0],
            [10, 5],
            [20, 0],
          ],
        },
      ],
    });
    const sp = getSceneSummary(ctx).sketches[0].entities.find((e) => e.type === "spline");
    const off = await apply(ctx, { op: "addOffset", sketchId: sk.createdId!, sourceIds: [sp!.id], distance: 2 });
    expect(off).toMatchObject({ ok: false, errorKind: "invalid_op" });
  });

  it("addSketchMirror appends a mirror op across a sketch line", async () => {
    const { ctx, doc } = makeCtx();
    const sk = await apply(ctx, {
      op: "addSketch",
      plane: { datum: "top" },
      entities: [
        { shape: "line", a: [0, -10], b: [0, 10], construction: true },
        { shape: "circle", c: [5, 0], r: 2 },
      ],
    });
    const ents = getSceneSummary(ctx).sketches[0].entities;
    const axis = ents.find((e) => e.type === "line");
    const circ = ents.find((e) => e.type === "circle");
    const m = await apply(ctx, {
      op: "addSketchMirror",
      sketchId: sk.createdId!,
      axisId: axis!.id,
      sourceIds: [circ!.id],
    });
    expect(m.ok).toBe(true);
    const s = doc().features.find((x) => x.id === sk.createdId);
    expect(s && s.type === "sketch" && s.derived?.[0].kind).toBe("mirror");
  });

  it("addSketchMirror rejects a non-line axis", async () => {
    const { ctx } = makeCtx();
    const sk = await apply(ctx, {
      op: "addSketch",
      plane: { datum: "top" },
      entities: [{ shape: "circle", c: [0, 0], r: 4 }],
    });
    const circ = getSceneSummary(ctx).sketches[0].entities.find((e) => e.type === "circle");
    const m = await apply(ctx, {
      op: "addSketchMirror",
      sketchId: sk.createdId!,
      axisId: circ!.id,
      sourceIds: [circ!.id],
    });
    expect(m).toMatchObject({ ok: false, errorKind: "invalid_op" });
  });

  it("addSketchPattern (circular) appends the op and generates driven copies", async () => {
    const { ctx, doc } = makeCtx();
    const sk = await apply(ctx, {
      op: "addSketch",
      plane: { datum: "top" },
      entities: [{ shape: "circle", c: [20, 0], r: 3 }],
    });
    const circ = getSceneSummary(ctx).sketches[0].entities.find((e) => e.type === "circle");
    const p = await apply(ctx, {
      op: "addSketchPattern",
      sketchId: sk.createdId!,
      kind: "circular",
      sourceIds: [circ!.id],
      count: 6,
      center: [0, 0],
    });
    expect(p.ok).toBe(true);
    const s = doc().features.find((x) => x.id === sk.createdId);
    expect(s && s.type === "sketch" && s.derived?.[0].kind).toBe("circularPattern");
    // 6 total = the seed + 5 driven copies ⇒ 6 extrudable regions.
    const summary = getSceneSummary(ctx).sketches[0];
    expect(summary.regions.length).toBe(6);
    expect(summary.entities.filter((e) => e.derived).length).toBe(5);
    // A DERIVED region is extrudable: resolveProfile must accept any region the
    // summary lists (it detects regions on the derived-applied sketch).
    const derivedRegion = summary.regions[summary.regions.length - 1];
    const ex = await apply(ctx, {
      op: "addExtrude",
      profile: { sketchId: sk.createdId!, regionId: derivedRegion.id },
      distance: 5,
    });
    expect(ex.ok).toBe(true);
  });

  it("addSketchPattern (linear) translates copies by count × step", async () => {
    const { ctx } = makeCtx();
    const sk = await apply(ctx, {
      op: "addSketch",
      plane: { datum: "top" },
      entities: [{ shape: "circle", c: [0, 0], r: 2 }],
    });
    const circ = getSceneSummary(ctx).sketches[0].entities.find((e) => e.type === "circle");
    const p = await apply(ctx, {
      op: "addSketchPattern",
      sketchId: sk.createdId!,
      kind: "linear",
      sourceIds: [circ!.id],
      count: 3,
      dx: 10,
      dy: 0,
    });
    expect(p.ok).toBe(true);
    expect(getSceneSummary(ctx).sketches[0].regions.length).toBe(3);
  });

  it("addSketchPattern rejects a missing source and a missing center", async () => {
    const { ctx } = makeCtx();
    const sk = await apply(ctx, {
      op: "addSketch",
      plane: { datum: "top" },
      entities: [{ shape: "circle", c: [10, 0], r: 2 }],
    });
    const circ = getSceneSummary(ctx).sketches[0].entities.find((e) => e.type === "circle");
    const bad = await apply(ctx, {
      op: "addSketchPattern",
      sketchId: sk.createdId!,
      kind: "linear",
      sourceIds: ["nope"],
      count: 2,
      dx: 5,
    });
    expect(bad).toMatchObject({ ok: false, errorKind: "not_found" });
    const noCenter = await apply(ctx, {
      op: "addSketchPattern",
      sketchId: sk.createdId!,
      kind: "circular",
      sourceIds: [circ!.id],
      count: 4,
    });
    expect(noCenter).toMatchObject({ ok: false, errorKind: "invalid_op" });
  });
});

describe("applyOperation — body pattern", () => {
  it("addPattern (linear, world axis) creates the feature and bakes offsets", async () => {
    const { ctx, doc } = makeCtx();
    const box = await apply(ctx, { op: "addPrimitive", kind: "box" });
    const p = await apply(ctx, {
      op: "addPattern",
      targetId: box.createdId!,
      kind: "linear",
      dir1: { world: "x" },
      count1: 4,
      spacing1: 25,
    });
    expect(p.ok).toBe(true);
    const f = doc().features.find((x) => x.id === p.createdId);
    expect(f?.type).toBe("pattern");
    const rp = resolveDocument(doc()).features.find((x) => x.id === p.createdId);
    expect(rp?.type === "pattern" && rp.offsets).toEqual([
      [25, 0, 0],
      [50, 0, 0],
      [75, 0, 0],
    ]);
  });

  it("addPattern (circular, world axis) bakes the angles", async () => {
    const { ctx, doc } = makeCtx();
    const box = await apply(ctx, { op: "addPrimitive", kind: "box", params: { x: 30 } });
    const p = await apply(ctx, {
      op: "addPattern",
      targetId: box.createdId!,
      kind: "circular",
      axis: { world: "z" },
      count: 6,
    });
    expect(p.ok).toBe(true);
    const rp = resolveDocument(doc()).features.find((x) => x.id === p.createdId);
    expect(rp?.type === "pattern" && rp.angles?.length).toBe(5);
  });

  it("addPattern validates its per-kind required fields", async () => {
    const { ctx } = makeCtx();
    const box = await apply(ctx, { op: "addPrimitive", kind: "box" });
    expect(
      await apply(ctx, { op: "addPattern", targetId: box.createdId!, kind: "linear", count1: 3, spacing1: 10 }),
    ).toMatchObject({ ok: false, errorKind: "invalid_op" }); // no dir1
    expect(await apply(ctx, { op: "addPattern", targetId: box.createdId!, kind: "circular", count: 4 })).toMatchObject({
      ok: false,
      errorKind: "invalid_op",
    }); // no axis
  });
});

describe("applyOperation — reference plane methods", () => {
  const frame = (ctx: AgentContext, id: string) => resolveDocument(ctx.getDoc()).planeFrames.get(id);

  it("offset (default method) is parallel to the base at a distance", async () => {
    const { ctx } = makeCtx();
    const r = await apply(ctx, { op: "addPlane", base: { datum: "top" }, offset: 40 });
    const f = frame(ctx, r.createdId!);
    expect(f?.origin[2]).toBeCloseTo(40);
    expect(f?.normal).toEqual([0, 0, 1]);
  });

  it("midplane sits halfway between the two references", async () => {
    const { ctx } = makeCtx();
    const top = await apply(ctx, { op: "addPlane", base: { datum: "top" }, offset: 40 });
    const mid = await apply(ctx, {
      op: "addPlane",
      method: "midplane",
      base: { datum: "top" },
      refB: { planeId: top.createdId! },
    });
    expect(frame(ctx, mid.createdId!)?.origin[2]).toBeCloseTo(20);
  });

  it("angle tilts the base about its u-axis", async () => {
    const { ctx } = makeCtx();
    const r = await apply(ctx, { op: "addPlane", method: "angle", base: { datum: "top" }, angleAxis: "u", angle: 45 });
    const n = frame(ctx, r.createdId!)!.normal;
    expect(n[1]).toBeCloseTo(-Math.SQRT1_2);
    expect(n[2]).toBeCloseTo(Math.SQRT1_2);
  });

  it("through-3-points builds the plane those points span", async () => {
    const { ctx } = makeCtx();
    const r = await apply(ctx, {
      op: "addPlane",
      method: "through",
      points: [
        [0, 0, 5],
        [10, 0, 5],
        [0, 10, 5],
      ],
    });
    const f = frame(ctx, r.createdId!)!;
    expect(f.origin[2]).toBeCloseTo(5);
    expect(Math.abs(f.normal[2])).toBeCloseTo(1);
  });

  it("rejects midplane without refB and through without 3 points", async () => {
    const { ctx } = makeCtx();
    const noRefB = await apply(ctx, { op: "addPlane", method: "midplane", base: { datum: "top" } });
    expect(noRefB).toMatchObject({ ok: false, errorKind: "invalid_op" });
    const badPts = await apply(ctx, {
      op: "addPlane",
      method: "through",
      points: [
        [0, 0, 0],
        [1, 0, 0],
      ],
    });
    expect(badPts).toMatchObject({ ok: false, errorKind: "invalid_op" });
  });
});

describe("applyOperation — dressUp edge fingerprints", () => {
  it("bakes mid + length for known edge names, name-only for unknown", async () => {
    // Create the target first (plain ctx), then rebuild a ctx whose mesh is
    // keyed to that feature id and exposes one named edge polyline: a straight
    // 10 mm edge from (0,0,10) to (10,0,10).
    const base = makeCtx();
    const box = await apply(base.ctx, { op: "addPrimitive", kind: "box" });
    const bodyId = box.createdId!;
    const known = `${bodyId}/+z∩${bodyId}/f0`;
    let d = base.doc();
    let sel: Selection[] = [];
    const ctx: AgentContext = {
      getDoc: () => d,
      setDoc: (n) => {
        d = n;
      },
      getSelection: () => sel,
      setSelection: (s) => {
        sel = s;
      },
      getSectionView: () => DEFAULT_SECTION_VIEW,
      setSectionView: () => {},
      getMeshes: () => [
        {
          id: bodyId,
          mesh: {
            name: bodyId,
            faces: { vertices: [], triangles: [] },
            edges: {
              lines: [0, 0, 10, 10, 0, 10],
              edgeGroups: [{ start: 0, count: 2, edgeId: 3, name: known }],
            },
          },
        },
      ],
      getErrors: () => resolveDocument(d).errors,
      waitForRegen: async () => ({ errors: resolveDocument(d).errors }),
      getViewport: () => null,
      documents: stubDocuments(),
    };

    const r = await apply(ctx, {
      op: "dressUp",
      kind: "fillet",
      targetId: bodyId,
      edges: [known, "bogus/name"],
      size: 2,
    });
    expect(r.ok).toBe(true);
    const f = d.features.find((x) => x.id === r.createdId);
    expect(f?.type).toBe("dressup");
    if (f?.type !== "dressup") return;
    expect(f.targets[0].edgeRefs).toHaveLength(2);
    expect(f.targets[0].edgeRefs![0]).toMatchObject({ name: known, mid: [5, 0, 10], length: 10 });
    expect(f.targets[0].edgeRefs![1]).toEqual({ name: "bogus/name" }); // no polyline → name-only
  });
});

describe("applyOperation — regen warnings surface in the result", () => {
  it("passes non-fatal regen warnings through (and omits when empty)", async () => {
    let d = createDocument();
    let sel: Selection[] = [];
    let pendingWarnings: Record<string, string> = {};
    const ctx: AgentContext = {
      getDoc: () => d,
      setDoc: (n) => {
        d = n;
      },
      getSelection: () => sel,
      setSelection: (s) => {
        sel = s;
      },
      getSectionView: () => DEFAULT_SECTION_VIEW,
      setSectionView: () => {},
      getMeshes: () => [],
      getErrors: () => resolveDocument(d).errors,
      waitForRegen: async () => ({ errors: resolveDocument(d).errors, warnings: pendingWarnings }),
      getViewport: () => null,
      documents: stubDocuments(),
    };
    const clean = await apply(ctx, { op: "addPrimitive", kind: "box" });
    expect(clean.ok).toBe(true);
    expect(clean.warnings).toBeUndefined(); // empty map → omitted

    pendingWarnings = { "some-fillet": 'edge "a/+z∩a/f0" was renamed by an upstream edit; re-matched geometrically' };
    const warned = await apply(ctx, { op: "setParam", featureId: clean.createdId!, name: "width", value: "20" });
    expect(warned.ok).toBe(true);
    expect(warned.warnings).toEqual(pendingWarnings);
  });
});

describe("applyOperation — multi-document ops", () => {
  // A ctx whose workspace stub RECORDS calls and simulates one stored doc
  // ("existing") via a mocked listMeta — but listMeta comes from ../storage/db,
  // so simulate through fake-indexeddb instead: seed the real (fake) DB.
  async function seedDb(ids: string[]) {
    const { IDBFactory } = await import("fake-indexeddb");
    globalThis.indexedDB = new IDBFactory();
    const { __resetDBForTests, putDoc } = await import("../storage/db");
    __resetDBForTests();
    for (const id of ids) {
      await putDoc({ id, name: `Doc ${id}`, doc: createDocument(), updatedAt: 1, createdAt: 1 });
    }
  }

  function recordingCtx(activeId: string) {
    const calls: string[] = [];
    const { ctx } = makeCtx();
    ctx.documents = {
      info: () => ({ id: activeId, name: `Doc ${activeId}` }),
      open: async (id) => void calls.push(`open:${id}`),
      create: async () => {
        calls.push("create");
        activeId = "fresh";
      },
      duplicate: async (id) => {
        calls.push(`duplicate:${id}`);
        activeId = "copy";
      },
      rename: async (id, name) => void calls.push(`rename:${id}:${name}`),
    };
    return { ctx, calls };
  }

  it("openDocument switches via the workspace API and settles regen", async () => {
    await seedDb(["a", "b"]);
    const { ctx, calls } = recordingCtx("a");
    const r = await apply(ctx, { op: "openDocument", id: "b" });
    expect(r).toMatchObject({ ok: true, createdId: "b" });
    expect(calls).toEqual(["open:b"]);
  });

  it("openDocument of the active doc is a no-op; unknown id errors", async () => {
    await seedDb(["a"]);
    const { ctx, calls } = recordingCtx("a");
    expect(await apply(ctx, { op: "openDocument", id: "a" })).toMatchObject({ ok: true });
    expect(calls).toEqual([]);
    const missing = await apply(ctx, { op: "openDocument", id: "ghost" });
    expect(missing).toMatchObject({ ok: false, errorKind: "not_found" });
  });

  it("newDocument creates, then renames when a name is given", async () => {
    await seedDb([]);
    const { ctx, calls } = recordingCtx("a");
    const r = await apply(ctx, { op: "newDocument", name: "Bracket" });
    expect(r).toMatchObject({ ok: true, createdId: "fresh" });
    expect(calls).toEqual(["create", "rename:fresh:Bracket"]);
  });

  it("duplicateDocument defaults to the active doc and reports the copy", async () => {
    await seedDb(["a"]);
    const { ctx, calls } = recordingCtx("a");
    const r = await apply(ctx, { op: "duplicateDocument" });
    expect(r).toMatchObject({ ok: true, createdId: "copy" });
    expect(calls).toEqual(["duplicate:a"]);
  });

  it("listDocuments flags the active document", async () => {
    await seedDb(["a", "b"]);
    const { ctx } = recordingCtx("b");
    const { listDocuments } = await import("./commands");
    const docs = await listDocuments(ctx);
    expect(docs).toHaveLength(2);
    expect(docs.find((d) => d.id === "b")?.active).toBe(true);
    expect(docs.find((d) => d.id === "a")?.active).toBe(false);
  });
});
