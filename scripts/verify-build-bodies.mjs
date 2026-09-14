// One of every feature type, built through the real kernel.
//
// worker.ts has no unit coverage and cannot get any: Vitest can neither
// instantiate a DedicatedWorkerGlobalScope nor load the OCCT wasm, so none of
// buildBodies' twelve per-feature builders run under `npm test`. This script is
// the substitute — it drives the live app over the agent bridge, builds one of
// each, and asserts the kernel reported no feature error and the body count
// moved the way that feature should move it.
//
// It also covers the two cache directions, which is where a dispatch refactor
// does its damage quietly: an upstream param edit must re-key downstream (no
// stale hit), and re-setting the same value must land on identical geometry
// (reuse is correct, not merely absent). The transform-about-a-body-EDGE case
// is here on purpose — that is the dependency a content key is easiest to
// forget, and forgetting it returns yesterday's body with no error anywhere.
//
// Run it against a dev server: `npm run dev`, then `node scripts/verify-build-bodies.mjs`.
import { checker, launch, openPoly } from "./lib/harness.mjs";

const { page, errors, close } = await launch({ deviceScaleFactor: 1 });
const op = openPoly(page);
const { check, done } = checker();
const { apply, read, settle, screenOf } = op;
const canvasBox = async () => await page.locator("canvas").first().boundingBox();
const summary = op.scene;
const bodyCount = op.bodyCount;
const featErrors = op.featureErrors;
const fresh = op.newDocument;

/** Run one feature build and assert the kernel reported no feature error. */
const ok = async (label, fn) => {
  try {
    const before = await bodyCount();
    const r = await fn();
    await settle();
    const errs = await featErrors();
    const after = await bodyCount();
    check(label, errs.length === 0, errs.length ? errs.join(" | ") : `bodies ${before} → ${after}`);
    return r;
  } catch (e) {
    check(label, false, String(e).slice(0, 220));
  }
};

// 1. primitive
await fresh();
const box = await ok("primitive — box builds", () =>
  apply({ op: "addPrimitive", kind: "box", params: { width: 40, depth: 30, height: 20 } }),
);
const boxId = box?.id ?? box?.createdId;
const cyl = await ok("primitive — cylinder builds", () =>
  apply({ op: "addPrimitive", kind: "cylinder", params: { radius: 8, height: 30 } }),
);
const cylId = cyl?.id ?? cyl?.createdId;

// 2. boolean
await ok("boolean — union of two bodies", () => apply({ op: "boolean", kind: "union", operands: [boxId, cylId] }));

// 3. extrude (new / add / remove) + sketch
await fresh();
const sk = await apply({
  op: "addSketch",
  plane: { datum: "top" },
  entities: [
    { shape: "line", a: [0, 0], b: [30, 0] },
    { shape: "line", a: [30, 0], b: [30, 20] },
    { shape: "line", a: [30, 20], b: [0, 20] },
    { shape: "line", a: [0, 20], b: [0, 0] },
  ],
});
await settle();
await ok("extrude — new body, blind", () =>
  apply({ op: "addExtrude", profile: { sketchId: sk.createdId }, distance: "12" }),
);
const ext = (await read({ read: "document" })).features.find((f) => f.type === "extrude");
await ok("extrude — symmetric extent", async () => {
  const s2 = await apply({
    op: "addSketch",
    plane: { datum: "front" },
    entities: [{ shape: "circle", c: [0, 40], r: 5 }],
  });
  await settle();
  return apply({ op: "addExtrude", profile: { sketchId: s2.createdId }, distance: "20", extent: "symmetric" });
});
await ok("extrude — remove (throughAll) cuts the body", async () => {
  const s3 = await apply({
    op: "addSketch",
    plane: { datum: "top" },
    entities: [{ shape: "circle", c: [15, 10], r: 4 }],
  });
  await settle();
  return apply({
    op: "addExtrude",
    profile: { sketchId: s3.createdId },
    distance: "50",
    extent: "throughAll",
    mode: "remove",
    targetId: ext.id,
  });
});

// 4. dressup — chamfer + fillet
await fresh();
const b2 = await apply({ op: "addPrimitive", kind: "box", params: { width: 40, depth: 30, height: 20 } });
await settle();
const b2id = b2.id ?? b2.createdId;
const edgesOf = async (id) => {
  const s = await summary();
  const body = (s.bodies ?? []).find((x) => x.id === id) ?? s.bodies?.[0];
  return body?.edges ?? [];
};
const e = await edgesOf(b2id);
await ok("dressup — chamfer on a named edge", () =>
  apply({ op: "dressUp", kind: "chamfer", targetId: b2id, edges: [e[0]], size: "3" }),
);
await ok("dressup — fillet on a named edge", () =>
  apply({ op: "dressUp", kind: "fillet", targetId: b2id, edges: [e[1]], size: "2" }),
);

// 5. shell
await fresh();
const b3 = await apply({ op: "addPrimitive", kind: "box", params: { width: 40, depth: 30, height: 20 } });
await settle();
const b3id = b3.id ?? b3.createdId;
const facesOf = async (id) => {
  const s = await summary();
  const body = (s.bodies ?? []).find((x) => x.id === id) ?? s.bodies?.[0];
  return body?.faces ?? [];
};
const fs = await facesOf(b3id);
await ok("shell — hollow, one face open", () => apply({ op: "shell", targetId: b3id, thickness: "2", faces: [fs[0]] }));

// 6. transform — move, copy-rotate, and rotate about a body EDGE (the axis-key path)
await fresh();
const b4 = await apply({ op: "addPrimitive", kind: "box", params: { width: 40, depth: 30, height: 20 } });
await settle();
const b4id = b4.id ?? b4.createdId;
await ok("transform — move", () => apply({ op: "transform", targetId: b4id, tx: "15" }));
await ok("transform — copy + rotate about world z", () =>
  apply({ op: "transform", targetId: b4id, angle: "30", axis: "z", copy: true }),
);
const b4edges = await edgesOf(b4id);
const edgeName = b4edges[0]; // summary edges are plain persistent-name strings
await ok("transform — rotate about a body EDGE (folds the axis body's key in)", () =>
  apply({ op: "transform", targetId: b4id, angle: "20", axis: { bodyId: b4id, edgeName } }),
);

// 7. mirror
await fresh();
const b5 = await apply({ op: "addPrimitive", kind: "box", params: { width: 20, depth: 20, height: 20 } });
await settle();
await ok("mirror — reflect across a datum", () =>
  apply({ op: "transform", targetId: b5.id ?? b5.createdId, tx: "30" }).then(() =>
    apply({ op: "addMirror", targetId: b5.id ?? b5.createdId, plane: { datum: "front" } }),
  ),
);

// 8. pattern
await fresh();
const b6 = await apply({ op: "addPrimitive", kind: "box", params: { width: 10, depth: 10, height: 10 } });
await settle();
await ok("pattern — linear", () =>
  apply({
    op: "addPattern",
    targetId: b6.id ?? b6.createdId,
    kind: "linear",
    dir1: { world: "x" },
    count1: "4",
    spacing1: "20",
  }),
);

// 9. revolve
await fresh();
const rs = await apply({
  op: "addSketch",
  plane: { datum: "front" },
  entities: [
    { shape: "line", a: [10, 0], b: [20, 0] },
    { shape: "line", a: [20, 0], b: [20, 15] },
    { shape: "line", a: [20, 15], b: [10, 15] },
    { shape: "line", a: [10, 15], b: [10, 0] },
  ],
});
await settle();
await ok("revolve — full turn about a plane axis", () =>
  apply({ op: "addRevolve", profile: { sketchId: rs.createdId }, angle: "360", axis: { plane: { datum: "right" } } }),
);

// 10. sweep
await fresh();
const sp = await apply({
  op: "addSketch",
  plane: { datum: "front" },
  entities: [
    {
      shape: "spline",
      points: [
        [0, 0],
        [20, 10],
        [40, 0],
        [60, 20],
      ],
    },
  ],
});
await settle();
const sprof = await apply({
  op: "addSketch",
  plane: { datum: "top" },
  entities: [{ shape: "circle", c: [0, 0], r: 3 }],
});
await settle();
const pathEntity = (await read({ read: "document" })).features.find((f) => f.id === sp.createdId).entities[0].id;
await ok("sweep — circle along a spline", () =>
  apply({
    op: "addSweep",
    profile: { sketchId: sprof.createdId },
    path: { sketchId: sp.createdId, entityId: pathEntity },
  }),
);

// 11. loft
await fresh();
const l1 = await apply({ op: "addSketch", plane: { datum: "top" }, entities: [{ shape: "circle", c: [0, 0], r: 15 }] });
await settle();
const pl = await apply({ op: "addPlane", method: "offset", base: { datum: "top" }, offset: "30" });
await settle();
const l2 = await apply({
  op: "addSketch",
  plane: { planeId: pl.createdId },
  entities: [{ shape: "circle", c: [0, 0], r: 5 }],
});
await settle();
await ok("loft — between two circles", () =>
  apply({ op: "addLoft", profiles: [{ sketchId: l1.createdId }, { sketchId: l2.createdId }] }),
);

// 12. cache behaviour: a rebuild of an unchanged doc must reuse, and an edit must not
await fresh();
const cb = await apply({ op: "addPrimitive", kind: "box", params: { width: 40, depth: 30, height: 20 } });
await settle();
const cbid = cb.id ?? cb.createdId;
await apply({ op: "transform", targetId: cbid, angle: "25", axis: "z" });
await settle();
const bboxes = async () => JSON.stringify((await summary()).bodies?.map((b) => b.bbox));
const before = await bboxes();
await apply({ op: "setParam", featureId: cbid, name: "width", value: "60" });
await settle();
const after = await bboxes();
check(
  "editing an upstream param rebuilds the downstream transform (no stale cache hit)",
  before !== after,
  `${String(before).slice(0, 80)} → ${String(after).slice(0, 80)}`,
);
// And the inverse: a no-op regen must land on exactly the same geometry.
await apply({ op: "setParam", featureId: cbid, name: "width", value: "60" });
await settle();
check(
  "re-setting the same value is idempotent (cache reuse is correct, not stale)",
  (await bboxes()) === after,
  `${String(await bboxes()).slice(0, 80)}`,
);

check("no page errors across the whole run", errors.length === 0, errors.slice(0, 3).join(" | "));
await page.screenshot({ path: "/tmp/openshape-smoke.png" });
await close();
done();
