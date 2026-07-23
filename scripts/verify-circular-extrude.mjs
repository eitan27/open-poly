// Verifies extruding/booleaning a circular (cylinder) face no longer fails with
// StdFail_NotDone. The cylinder primitive is now a faceted prism (like extruded
// circles already were), so analytic-cylinder boolean failures are gone.
import { chromium } from "playwright";

const URL = process.env.URL ?? "http://localhost:5174/";
const browser = await chromium.launch();
const page = await browser.newContext({ viewport: { width: 1660, height: 920 }, deviceScaleFactor: 2 }).then((c) => c.newPage());
await page.goto(URL, { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => window.__openpoly, null, { timeout: 30000 });
await page.waitForTimeout(1500);
const apply = (o) => page.evaluate((x) => window.__openpoly.apply(x), o);
const read = (q) => page.evaluate((x) => window.__openpoly.read(x), q);
const waitIdle = async () => { let s = 0; for (let i = 0; i < 60; i++) { const t = (await page.locator(".status").textContent())?.trim() ?? ""; s = /up to date/i.test(t) ? s + 1 : 0; if (s >= 3) return; await page.waitForTimeout(300); } };
let failures = 0;
const check = (label, ok, detail = "") => { console.log(`${ok ? "PASS" : "FAIL"}: ${label}${detail ? ` — ${detail}` : ""}`); if (!ok) failures++; };

const cyl = async () => { const r = await apply({ op: "addPrimitive", kind: "cylinder", params: { radius: 18, height: 40 } }); await waitIdle(); return r.createdId ?? r.id; };

// Extrude the cylinder's flat circular cap in every mode.
for (const [label, extra] of [
  ["cut into cylinder (remove)", (id) => ({ mode: "remove", targetId: id, flip: true })],
  ["boss on cylinder (add)", (id) => ({ mode: "add", targetId: id })],
  ["new body", () => ({ mode: "new" })],
]) {
  await apply({ op: "newDocument" }); await waitIdle();
  const id = await cyl();
  const r = await apply({ op: "addExtrude", profile: { bodyId: id, faceName: `${id}/+z` }, distance: "10", ...extra(id) }).catch((e) => ({ ok: false, threw: String(e).slice(0, 120) }));
  await waitIdle();
  check(`extrude cylinder cap — ${label}`, r.ok === true, r.ok ? "" : JSON.stringify(r).slice(0, 140));
}

// The classic failing boolean pair: cylinder ∪ box and cylinder − box.
await apply({ op: "newDocument" }); await waitIdle();
const a = await cyl();
const bx = (await apply({ op: "addPrimitive", kind: "box", params: { width: 20, depth: 20, height: 60 } })).createdId; await waitIdle();
const u = await apply({ op: "boolean", kind: "union", operands: [a, bx] }).catch((e) => ({ ok: false, threw: String(e).slice(0, 120) })); await waitIdle();
check("cylinder ∪ box", u.ok === true, u.ok ? "" : JSON.stringify(u).slice(0, 140));
await apply({ op: "newDocument" }); await waitIdle();
const c = await cyl();
const bore = (await apply({ op: "addPrimitive", kind: "box", params: { width: 12, depth: 12, height: 80 } })).createdId; await waitIdle();
const sub = await apply({ op: "boolean", kind: "subtract", operands: [c, bore] }).catch((e) => ({ ok: false, threw: String(e).slice(0, 120) })); await waitIdle();
check("cylinder − box (bore)", sub.ok === true, sub.ok ? "" : JSON.stringify(sub).slice(0, 140));

// Cutting a round hole into a planar body (the extruded tool is faceted too).
await apply({ op: "newDocument" }); await waitIdle();
const slab = (await apply({ op: "addPrimitive", kind: "box", params: { width: 60, depth: 60, height: 10 } })).createdId; await waitIdle();
const skc = await apply({ op: "addSketch", plane: { bodyId: slab, faceName: `${slab}/+z` }, entities: [{ shape: "circle", c: [0, 0], r: 8 }] }).catch(() => null); await waitIdle();
if (skc) {
  const hole = await apply({ op: "addExtrude", profile: { sketchId: skc.createdId ?? skc.id }, distance: "20", mode: "remove", targetId: slab, flip: true }).catch((e) => ({ ok: false, threw: String(e).slice(0, 120) })); await waitIdle();
  check("round hole cut into a slab", hole.ok === true, hole.ok ? "" : JSON.stringify(hole).slice(0, 140));
}

// A revolve is now a faceted (loft) body too, so extruding/cutting one of its
// faces works — it used to fail because MakeRevol emits analytic surfaces.
for (const angle of ["360", "90"]) {
  await apply({ op: "newDocument" }); await waitIdle();
  const sk = await apply({ op: "addSketch", plane: { datum: "front" }, entities: [
    { shape: "line", a: [0, -30], b: [0, 30], construction: true },
    { shape: "rect", corner: [10, -20], w: 15, h: 40 },
  ] }); await waitIdle();
  const skId = sk.createdId ?? sk.id;
  const sketch = (await read({ read: "document" })).features.find((f) => f.id === skId);
  const axisLine = sketch.entities.find((e) => e.type === "line" && e.construction);
  const rev = await apply({ op: "addRevolve", profile: { sketchId: skId }, axis: { sketchId: skId, entityId: axisLine.id }, angle }).catch((e) => ({ ok: false, threw: String(e).slice(0, 120) })); await waitIdle();
  check(`revolve ${angle}° builds`, rev.ok === true, rev.ok ? "" : JSON.stringify(rev).slice(0, 140));
  if (rev.ok) {
    const rid = rev.createdId ?? rev.id;
    const cut = await apply({ op: "addExtrude", profile: { bodyId: rid, faceName: `${rid}/f0` }, distance: "8", mode: "remove", targetId: rid, flip: true }).catch((e) => ({ ok: false, threw: String(e).slice(0, 120) })); await waitIdle();
    check(`cut a face of the ${angle}° revolve`, cut.ok === true, cut.ok ? "" : JSON.stringify(cut).slice(0, 140));
  }
}

await browser.close();
console.log(failures ? `\n${failures} FAILURE(S)` : "\nAll checks passed");
process.exit(failures ? 1 : 0);
