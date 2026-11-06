// A chamfer or fillet on an edge whose END FACE slopes away must carry on past the
// edge's endpoint, or the material under the slope is left behind as a tab.
//
// The user's report: chamfer two opposite edges of a box's top, then the edge that
// connects them. That edge is now shorter, the earlier bevels sit at its ends, and
// a wedge stopping at the endpoints left a protruding corner at each one.
//
// The observable is which faces MEET. On the correct solid the new bevel runs right
// up against both earlier ones, so edges between them exist; with the tabs, the old
// bevels are never reached at the far corner. Screenshots go to OUT if set.
//
// Volumes were checked by hand against a temporary kernel probe when this was
// written, for a 60×40×30 box with 8mm bevels on its ±x top edges: the connecting
// 8mm bevel took it to 67861.33 (72000 − 2560 − ∫₀⁸ t(60−2t) dt), against 68029.20
// with the tabs left on.
import { writeFileSync } from "node:fs";
import { launch, openPoly, checker } from "./lib/harness.mjs";

const { page, close } = await launch({ deviceScaleFactor: 2, collectErrors: false });
const { waitIdle, apply, read } = openPoly(page);
const { check, done } = checker();
const unmeshed = [];
page.on("console", (m) => {
  if (/mesh: (UNMESHED|NORMALLESS)/.test(m.text())) unmeshed.push(m.text());
});
await waitIdle();

const OUT = process.env.OUT;
const shoot = async (name) => {
  if (!OUT) return;
  await apply({ op: "select", refs: [] });
  for (const eye of await page.locator(".tree-row.datum-row .row-icon").all()) await eye.click();
  await page.waitForTimeout(700);
  const img = await page.evaluate(() => window.__openpoly.screenshot("iso"));
  writeFileSync(`${OUT}/${name}.png`, Buffer.from(String(img).replace(/^data:image\/\w+;base64,/, ""), "base64"));
};
const bodyOf = async (id) => (await read({ read: "sceneSummary" })).bodies.find((b) => b.id === id);

/** A 60×40×30 box with bevels on the ±x top edges. */
const beveledBox = async (name, size = "8") => {
  await apply({ op: "newDocument", name });
  await waitIdle();
  const { createdId: id } = await apply({
    op: "addPrimitive",
    kind: "box",
    params: { width: 60, depth: 40, height: 30 },
  });
  await waitIdle();
  const pick = (b, x, y) => b.edges.filter((e) => e.includes(`${id}/${x}`) && e.includes(`${id}/${y}`));
  const b = await bodyOf(id);
  const first = await apply({
    op: "dressUp",
    kind: "chamfer",
    targetId: id,
    edges: [...pick(b, "+z", "+x"), ...pick(b, "+z", "-x")],
    size,
  });
  await waitIdle();
  return { id, pick, first: first.createdId };
};
const dress = async (kind, id, edges, size) => {
  const r = await apply({ op: "dressUp", kind, targetId: id, edges, size });
  const status = await waitIdle();
  const err = r.ok ? (r.featureErrors?.[r.createdId] ?? null) : (r.error ?? "failed");
  return { created: r.createdId, ok: !err && /up to date/.test(status), err };
};
// An edge's name is its two faces joined in sorted order, and feature ids are random,
// so the pair has to be compared as a set.
const meets = (edges, a, b) =>
  edges.some((e) => {
    const parts = e.split("∩");
    return parts.includes(a) && parts.includes(b);
  });

// A — the report.
{
  const { id, pick, first } = await beveledBox("runout-report");
  const b = await bodyOf(id);
  const r = await dress("chamfer", id, pick(b, "+z", "-y"), "8");
  const after = await bodyOf(id);
  check("A: it builds", r.ok, r.err ?? "");
  check("A: nine faces, no leftovers", after.faces.length === 9, `${after.faces.length}`);
  const bevel = `${r.created}/chamfer`;
  check(
    "A: the new bevel meets both earlier ones",
    meets(after.edges, `${first}/chamfer`, bevel) && meets(after.edges, `${first}/chamfer#1`, bevel),
    after.edges.filter((e) => e.includes(r.created)).join("  "),
  );
  // Same size as the old bevels, so the front face's top corners land exactly where
  // they end and it no longer touches them. A tab would keep that edge alive.
  check(
    "A: no tab: the front face no longer touches the old bevels",
    !meets(after.edges, `${id}/-y`, `${first}/chamfer`) && !meets(after.edges, `${id}/-y`, `${first}/chamfer#1`),
    after.edges.filter((e) => e.includes(`${id}/-y`) && e.includes(first)).join("  "),
  );
  check("A: it meshes whole", unmeshed.length === 0, unmeshed.join("; "));
  await shoot("A-report");

  // The opposite edge too, to reach the shape in the reference picture.
  const b2 = await bodyOf(id);
  const r2 = await dress("chamfer", id, pick(b2, "+y", "+z"), "8");
  const after2 = await bodyOf(id);
  check(
    "A: a second connecting edge builds",
    r2.ok && after2.faces.length === 10,
    `${after2.faces.length} ${r2.err ?? ""}`,
  );
  await shoot("A-both");

  // Round-trips through the parameter: bigger than the old bevel, then smaller.
  for (const size of ["3", "14"]) {
    const s = await apply({ op: "setParam", featureId: r.created, name: "size", value: size });
    await waitIdle();
    const a = await bodyOf(id);
    check(
      `A: resized to ${size}, still builds`,
      s.ok && !s.featureErrors?.[r.created] && a.faces.length === 10,
      `${a.faces.length}`,
    );
  }
}

// B — the leg is LONGER than the old bevel: the bevel crosses onto the side walls.
{
  const { id, pick } = await beveledBox("runout-long-leg", "4");
  const b = await bodyOf(id);
  const r = await dress("chamfer", id, pick(b, "+z", "-y"), "10");
  const after = await bodyOf(id);
  check(
    "B: a bevel longer than the old one builds",
    r.ok && after.faces.length === 9,
    `${after.faces.length} ${r.err ?? ""}`,
  );
  check("B: it reaches the side walls", meets(after.edges, `${id}/+x`, `${r.created}/chamfer`));
  await shoot("B-long-leg");
}

// C — a fillet has the same problem and the same fix.
{
  const { id, pick } = await beveledBox("runout-fillet");
  const b = await bodyOf(id);
  const r = await dress("fillet", id, pick(b, "+z", "-y"), "6");
  const after = await bodyOf(id);
  check("C: fillet builds, one round face", r.ok && after.faces.length === 9, `${after.faces.length} ${r.err ?? ""}`);
  check("C: it meshes whole", unmeshed.length === 0, unmeshed.join("; "));
  await shoot("C-fillet");
}

// D — a VERTICAL edge, landing on an old bevel at its top end only.
{
  const { id, pick } = await beveledBox("runout-vertical");
  const b = await bodyOf(id);
  const r = await dress("chamfer", id, pick(b, "+x", "-y"), "5");
  const after = await bodyOf(id);
  check("D: vertical edge builds", r.ok && after.faces.length === 9, `${after.faces.length} ${r.err ?? ""}`);
  await shoot("D-vertical");
}

// E — wedges that run out can overlap though their edges don't touch: the top/front
// edge and the front/+x edge are separated by the old bevel.
{
  const { id, pick } = await beveledBox("runout-overlap");
  const b = await bodyOf(id);
  const r = await dress("chamfer", id, [...pick(b, "+z", "-y"), ...pick(b, "+x", "-y")], "5");
  const after = await bodyOf(id);
  check("E: overlapping run-outs build", r.ok && after.faces.length >= 10, `${after.faces.length} ${r.err ?? ""}`);
  check("E: it meshes whole", unmeshed.length === 0, unmeshed.join("; "));
  await shoot("E-overlap");
}

// F — control: on a plain box nothing slopes, so nothing changes.
{
  await apply({ op: "newDocument", name: "runout-control" });
  await waitIdle();
  const { createdId: id } = await apply({
    op: "addPrimitive",
    kind: "box",
    params: { width: 60, depth: 40, height: 30 },
  });
  await waitIdle();
  const b = await bodyOf(id);
  const r = await dress(
    "chamfer",
    id,
    b.edges.filter((e) => e.includes(`${id}/+z`) && e.includes(`${id}/-y`)),
    "8",
  );
  const after = await bodyOf(id);
  check("F: plain box still 7 faces", r.ok && after.faces.length === 7, `${after.faces.length}`);
}

// G — a flat milled on a cylinder. The edge ends on round wall, which curves away, so
// this has the same tab; and BRepFilletAPI's facet ceiling (chord ~1.2mm at r=18) is
// why the fix runs the wedge out rather than handing these edges to OCCT.
{
  await apply({ op: "newDocument", name: "runout-d-flat" });
  await waitIdle();
  const { createdId: id } = await apply({ op: "addPrimitive", kind: "cylinder", params: { radius: 18, height: 30 } });
  await waitIdle();
  const sk = await apply({
    op: "addSketch",
    plane: { bodyId: id, faceName: `${id}/+z` },
    entities: [
      { shape: "line", a: [10, -25], b: [25, -25] },
      { shape: "line", a: [25, -25], b: [25, 25] },
      { shape: "line", a: [25, 25], b: [10, 25] },
      { shape: "line", a: [10, 25], b: [10, -25] },
    ],
  });
  await waitIdle();
  const cut = await apply({
    op: "addExtrude",
    profile: { sketchId: sk.createdId },
    distance: "30",
    extent: "throughAll",
    mode: "remove",
    targetId: id,
  });
  await waitIdle();
  const b = await bodyOf(id);
  const flatTop = b.edges.filter((e) => e.includes(`${id}/+z`) && e.includes(cut.createdId));
  check("G: the flat's top edge is one named edge", flatTop.length === 1, flatTop.join(" "));
  for (const size of ["1", "4"]) {
    const r = await dress("chamfer", id, flatTop, size);
    const after = await bodyOf(id);
    check(`G: ${size}mm builds on the D-flat`, r.ok, `${after.faces.length} faces ${r.err ?? ""}`);
    check(`G: ${size}mm meshes whole`, unmeshed.length === 0, unmeshed.join("; "));
    const onWall = after.edges.filter((e) => e.includes(`${r.created}/chamfer`) && /\/f\d+/.test(e));
    console.log(`      bevel meets ${onWall.length} wall facets at ${size}mm`);
    // Stopping at the edge's ends touches 4, whatever the size.
    if (size === "4") check("G: 4mm bevel runs out across the wall facets", onWall.length > 4, `${onWall.length}`);
    if (size === "4") await shoot("G-d-flat");
    else {
      await apply({ op: "delete", featureId: r.created });
      await waitIdle();
    }
  }
}

await close();
done();
