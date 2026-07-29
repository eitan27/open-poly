// Throwaway verification that a body never renders with holes in it.
//
// OCCT's one-shot BRepMesh silently emits no triangulation for individual faces
// it can't handle. The shape is valid and nothing errors — the renderer just
// draws nothing there, and you see the background through the solid. It bites
// where a boolean has left slivers along coincident walls and a chamfer then
// re-trims them, which is how it was found: extrude a semicircle from a
// cylinder's top (its curved wall lies exactly on the cylinder's) and chamfer
// the concave edge underneath.
//
// The assertion is face accounting, not pixels. Every face of the shape must end
// up with triangles in the mesh, and that is exactly what "no holes" means —
// where a pixel count has to be argued down past edge lines, grid lines and the
// silhouette. The worker logs both outcomes with stable prefixes:
//     "mesh: recovered N dropped face(s) on <id>"   — the patch fired
//     "mesh: UNMESHED N face(s) on <id>"            — a hole survives
// So the run proves BOTH halves: that the defect is real and reproduced here
// (something had to be recovered), and that none of it is left over.
import { chromium } from "playwright";

const URL = process.env.URL ?? "http://localhost:5175/";
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
const context = await browser.newContext({ viewport: { width: 1660, height: 920 }, deviceScaleFactor: 2 });
const page = await context.newPage();
page.on("pageerror", (e) => console.log(`[pageerror] ${e.message}`));

const recovered = [];
const unmeshed = [];
page.on("console", (m) => {
  const t = m.text();
  const rec = /mesh: recovered (\d+) dropped face/.exec(t);
  if (rec) recovered.push(Number(rec[1]));
  const bad = /mesh: UNMESHED (\d+) face/.exec(t);
  if (bad) unmeshed.push(Number(bad[1]));
});

await page.goto(URL, { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => window.__openpoly, null, { timeout: 30000 });
const waitIdle = async () => {
  let stable = 0;
  for (let i = 0; i < 120; i++) {
    const s = (await page.locator(".status").textContent())?.trim() ?? "";
    stable = /up to date|error|fail/i.test(s) ? stable + 1 : 0;
    if (stable >= 3) return;
    await page.waitForTimeout(300);
  }
  throw new Error("app never settled");
};
await waitIdle();
const apply = (o) => page.evaluate((x) => window.__openpoly.apply(x), o);
const read = (q) => page.evaluate((x) => window.__openpoly.read(x), q);

let failures = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}: ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};
const sum = (a) => a.reduce((x, y) => x + y, 0);

await apply({ op: "newDocument", name: "mesh-holes" });
await waitIdle();
const cyl = await apply({ op: "addPrimitive", kind: "cylinder", params: { radius: 30, height: 60 } });
// Exactly as wide as the cylinder, so its side walls are TANGENT to the round
// one — the coincident-surface condition that makes the union leave slivers.
const blk = await apply({ op: "addPrimitive", kind: "box", params: { width: 60, depth: 30, height: 20, y: 15, z: 60 } });
await waitIdle();
const solid = await apply({ op: "boolean", kind: "union", operands: [cyl.createdId, blk.createdId] });
check("body built", solid.ok, JSON.stringify(solid).slice(0, 160));
await waitIdle();
check("the un-chamfered body meshes whole", unmeshed.length === 0, `${sum(unmeshed)} faces unmeshed`);

const scene = await read({ read: "sceneSummary" });
const body = scene.bodies.find((b) => b.id === solid.createdId) ?? scene.bodies[0];
const concave = (body?.edges ?? []).filter((e) => e.includes(`${cyl.createdId}/+z`) && e.includes(`${blk.createdId}/-y`));
check("the concave edge is named", concave.length === 1, `${concave.length} edges`);

recovered.length = 0;
const ch = await apply({ op: "dressUp", kind: "chamfer", targetId: body.id, edges: concave, size: "2" });
check("chamfer created", ch.ok, JSON.stringify(ch).slice(0, 160));
await waitIdle();

check(
  "the chamfer really does defeat the one-shot mesher (the bug is reproduced)",
  sum(recovered) > 0,
  `${sum(recovered)} face(s) had to be re-meshed one at a time`,
);
check("…and every one of them was recovered", unmeshed.length === 0, `${sum(unmeshed)} left unmeshed`);
await apply({ op: "select", refs: [] });
await page.waitForTimeout(500);
await page.screenshot({ path: "/tmp/openpoly-mesh-holes-chamfered.png" });

// Which faces defeat the mesher depends on how the chamfer trims the slivers, so
// one size proves little on its own.
for (const size of ["1", "4", "6"]) {
  unmeshed.length = 0;
  recovered.length = 0;
  await apply({ op: "setParam", featureId: ch.createdId, name: "size", value: size });
  await waitIdle();
  check(
    `no holes at size ${size}`,
    unmeshed.length === 0,
    `${sum(unmeshed)} unmeshed, ${sum(recovered)} recovered`,
  );
}

// A plain body must be untouched by any of this: nothing to recover, nothing
// lost. Catches the patch firing spuriously and bloating ordinary meshes.
unmeshed.length = 0;
recovered.length = 0;
await apply({ op: "newDocument", name: "plain" });
await waitIdle();
await apply({ op: "addPrimitive", kind: "cylinder", params: { radius: 20, height: 40 } });
await waitIdle();
check("an ordinary body needs no patching at all", recovered.length === 0 && unmeshed.length === 0,
  `${sum(recovered)} recovered, ${sum(unmeshed)} unmeshed`);

await page.screenshot({ path: "/tmp/openpoly-mesh-holes.png" });
console.log(failures === 0 ? "=== ALL CHECKS PASSED ===" : `=== ${failures} CHECK(S) FAILED ===`);
console.log("screenshot: /tmp/openpoly-mesh-holes.png");
await browser.close();
process.exit(failures === 0 ? 0 : 1);
