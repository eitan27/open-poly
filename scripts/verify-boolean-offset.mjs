// Boolean subtract clearance offset + keep tools, and the Remove-extrude
// clearance. Asserts on the kernel's own numbers (bounding boxes, face names)
// from the scene summary rather than pixels: each tool takes a full slice off
// one end of a 40×30×20 box, so the clearance shows up as the base's bbox.
//
//   URL=http://localhost:5173/ node scripts/verify-boolean-offset.mjs
import { launch, openPoly, checker } from "./lib/harness.mjs";

const { page, errors, close } = await launch({ deviceScaleFactor: 2 });
const op = openPoly(page);
const { check, done } = checker();
const near = (a, b, tol = 1e-3) => Math.abs(a - b) < tol;
const body = async (id) => (await op.bodies()).find((b) => b.id === id);

async function baseAndTool() {
  await op.newDocument();
  const base = (
    await op.applySettled({ op: "addPrimitive", kind: "box", params: { width: 40, depth: 30, height: 20 } })
  ).createdId;
  // x ∈ [15, 25], y ∈ [-20, 20], z ∈ [-5, 25]: clears the base's +x end.
  const tool = (
    await op.applySettled({
      op: "addPrimitive",
      kind: "box",
      params: { width: 10, depth: 40, height: 30, x: 20, z: -5 },
    })
  ).createdId;
  return { base, tool };
}

// 1. Plain subtract: the tool is consumed, the base ends at x = 15.
{
  const { base, tool } = await baseAndTool();
  const toolBox = (await body(tool)).bbox;
  console.log("tool bbox", JSON.stringify(toolBox));
  const r = await op.applySettled({ op: "boolean", kind: "subtract", operands: [base, tool] });
  const bodies = await op.bodies();
  const res = bodies.find((b) => b.id === r.createdId);
  check("plain subtract builds", r.ok && !!res, JSON.stringify(r));
  check("plain subtract consumes the tool", bodies.length === 1);
  check(
    "plain subtract ends at the tool face",
    res && near(res.bbox.max[0], toolBox.min[0]),
    JSON.stringify(res?.bbox),
  );
}

// 2. Offset 1 + keep tools: the base ends 1mm short of the tool, and the tool
//    is still there at its modelled size.
{
  const { base, tool } = await baseAndTool();
  const toolBox = (await body(tool)).bbox;
  const r = await op.applySettled({
    op: "boolean",
    kind: "subtract",
    operands: [base, tool],
    offset: 1,
    keepTools: true,
  });
  const bodies = await op.bodies();
  const res = bodies.find((b) => b.id === r.createdId);
  const kept = bodies.find((b) => b.id === tool);
  check("offset subtract builds", r.ok && !!res, JSON.stringify(r) + JSON.stringify(await op.featureErrors()));
  check(
    "offset grows the cut by the clearance",
    res && near(res.bbox.max[0], toolBox.min[0] - 1),
    JSON.stringify(res?.bbox),
  );
  check("keep tools leaves the tool body", !!kept);
  check(
    "the kept tool is NOT offset",
    kept && near(kept.bbox.min[0], toolBox.min[0]) && near(kept.bbox.max[2], toolBox.max[2]),
  );
  // Edit the offset through set_param: negative = interference.
  await op.applySettled({ op: "setParam", featureId: r.createdId, name: "offset", value: "-0.5" });
  const res2 = await body(r.createdId);
  check(
    "negative offset shrinks the cut",
    res2 && near(res2.bbox.max[0], toolBox.min[0] + 0.5),
    JSON.stringify(res2?.bbox),
  );
  await op.applySettled({ op: "setParam", featureId: r.createdId, name: "keepTools", value: "false" });
  check("unticking keep tools consumes the tool", !(await body(tool)));
}

// 3. A cylinder tool (faceted wall) offsets too.
{
  await op.newDocument();
  const base = (
    await op.applySettled({ op: "addPrimitive", kind: "box", params: { width: 40, depth: 30, height: 20 } })
  ).createdId;
  const pin = (
    await op.applySettled({ op: "addPrimitive", kind: "cylinder", params: { radius: 5, height: 30, z: -5 } })
  ).createdId;
  const r = await op.applySettled({
    op: "boolean",
    kind: "subtract",
    operands: [base, pin],
    offset: 0.2,
    keepTools: true,
  });
  check(
    "cylinder tool with offset builds",
    r.ok && (await op.featureErrors()).length === 0,
    JSON.stringify(await op.featureErrors()),
  );
  check("both bodies remain", (await op.bodyCount()) === 2);
}

// 4. Extrude Remove with clearance: through-all slot over the +x end, and a
//    blind full-top cut whose depth must stay exact.
{
  await op.newDocument();
  const base = (
    await op.applySettled({ op: "addPrimitive", kind: "box", params: { width: 40, depth: 30, height: 20 } })
  ).createdId;
  const sk = (
    await op.applySettled({
      op: "addSketch",
      plane: { bodyId: base, faceName: `${base}/+z` },
      entities: [{ shape: "rect", center: [20, 0], w: 10, h: 40 }],
    })
  ).createdId;
  const r = await op.applySettled({
    op: "addExtrude",
    profile: { sketchId: sk },
    distance: 10,
    mode: "remove",
    extent: "throughAll",
    targetId: base,
    offset: 1,
  });
  const res = await body(base);
  check(
    "remove-extrude with offset builds",
    r.ok && (await op.featureErrors()).length === 0,
    JSON.stringify(r) + JSON.stringify(await op.featureErrors()),
  );
  // The face sketch's axes needn't match the world's, so check the footprint
  // shrank by the 1mm clearance alone on one side (the un-offset slot
  // only touches the body's end): 40 + 30 → 69.
  const ext = res ? res.bbox.max[0] - res.bbox.min[0] + (res.bbox.max[1] - res.bbox.min[1]) : 0;
  check("the slot is 1mm wider", near(ext, 69), JSON.stringify(res?.bbox));

  const sk2 = (
    await op.applySettled({
      op: "addSketch",
      plane: { bodyId: base, faceName: `${base}/-z` },
      entities: [{ shape: "rect", center: [0, 0], w: 60, h: 60 }],
    })
  ).createdId;
  const r2 = await op.applySettled({
    op: "addExtrude",
    profile: { sketchId: sk2 },
    distance: 5,
    mode: "remove",
    targetId: base,
    offset: 1,
  });
  const res2 = await body(base);
  check(
    "blind cut with offset builds",
    r2.ok && (await op.featureErrors()).length === 0,
    JSON.stringify(r2) + JSON.stringify(await op.featureErrors()),
  );
  check("the clearance does not deepen the cut", res2 && near(res2.bbox.min[2], 5), JSON.stringify(res2?.bbox));
  const floor = res2?.faces.find((f) => f.startsWith(`${r2.createdId}/`) && f.endsWith("/end"));
  check("the pocket floor keeps its cap name", !!floor, JSON.stringify(res2?.faces));
  check(
    "offset on a New extrude is refused",
    !(await op.apply({ op: "addExtrude", profile: { sketchId: sk2 }, distance: 5, offset: 1 })).ok,
  );
}

// The dev server has no Pages Functions, so their fetches 502 — not ours.
const real = errors.filter((e) => !/Failed to load resource/.test(e));
check("no page errors", real.length === 0, real.join("\n"));
await close();
done();
