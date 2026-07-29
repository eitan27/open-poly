// Throwaway verification for the chamfer/fillet DELTA PREVIEW:
//  1. opening a chamfer for edit ghosts the material it carves off — the
//     viewport changes even though the document doesn't;
//  2. a fillet on a CONCAVE edge ghosts material it ADDS, and the two cases
//     render differently (one is drawn warm, the other green);
//  3. the ghost is scoped to the dialog: closing it restores the plain view;
//  4. the ghost tracks the size — a bigger chamfer ghosts a bigger wedge;
//  5. an invalid size drops the ghost rather than leaving a stale one;
//  6. the preview costs the document nothing: the delta bodies never leak into
//     the model (Parts list / sceneSummary) or into a committed document;
//  7. creating (not just editing) ghosts the wedge inside the untouched solid;
//  8. the ghost stays CONFINED to the dressed edge — the regression that
//     prompted all the clipping in the worker's previewDelta branch, where
//     a chamfer on one concave edge painted the entire adjoining face.
// Comparisons are pixel comparisons of a fixed view — the delta solids aren't
// exposed to the bridge, so "did it draw" is the observable.
// Known gap, deliberately not asserted here: one dress-up spanning two rings far
// apart on a FACETED boss can lose its ghost. Blending the facets into a true
// cylinder makes before and after differ by a hair over the whole wall between
// the rings, and those slivers — fused to the real delta, so no volume floor
// reaches them — defeat the mesher. The preview goes away; the model is fine.
import { chromium } from "playwright";

const URL = process.env.URL ?? "http://localhost:5175/";
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
const context = await browser.newContext({ viewport: { width: 1660, height: 920 }, deviceScaleFactor: 2 });
const page = await context.newPage();
page.on("pageerror", (e) => console.log(`[pageerror] ${e.message}`));

await page.goto(URL, { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => window.__openpoly, null, { timeout: 30000 });

const waitIdle = async ({ allowError = false } = {}) => {
  let stable = 0;
  for (let i = 0; i < 80; i++) {
    const s = (await page.locator(".status").textContent())?.trim() ?? "";
    const done = /up to date/i.test(s) || (allowError && /error|fail/i.test(s));
    stable = done ? stable + 1 : 0;
    if (stable >= 3) return;
    await page.waitForTimeout(300);
  }
  throw new Error("app never settled");
};
await waitIdle();

const apply = (op) => page.evaluate((o) => window.__openpoly.apply(o), op);
const read = (q) => page.evaluate((o) => window.__openpoly.read(o), q);
// Opening a feature's dialog also SELECTS it, which tints the body orange — a
// viewport change that has nothing to do with the ghost. Every comparison shot
// therefore clears the selection first, so a pixel difference can only be the
// preview. (Clearing is safe mid-dialog: an edit resolves its edges from the
// feature, not from the selection.)
const shot = async (view = "iso") => {
  await apply({ op: "select", refs: [] });
  await page.waitForTimeout(150);
  return page.evaluate((v) => window.__openpoly.screenshot(v), view);
};
// The preview is produced by a 250ms-debounced regen that is SEPARATE from the
// document's own — it doesn't move the status chip, so `waitIdle` says "up to
// date" while the ghost is still being built. On a cheap chamfer that lands in
// milliseconds; on a 192-edge fillet plus two boolean cuts it very much doesn't.
// So the ghost is waited for by watching the picture instead — see shotUntil.
const settlePreview = async () => {
  await page.waitForTimeout(400);
  await waitIdle({ allowError: true });
};
// Shoot until the frame reaches the expected relationship to `ref`: "differs"
// (the ghost has appeared / changed) or "matches" (it has gone). Waiting for the
// picture to merely stop moving is not enough — before a slow preview lands the
// frame is perfectly still, and any "settled?" test passes on the stale view.
// On timeout the last frame is returned so the failing check reports the real
// number rather than dying in the helper.
const shotUntil = async (ref, want, tries = 30) => {
  let cur = await shot();
  for (let i = 0; i < tries; i++) {
    const d = await diffPct(ref, cur);
    if (want === "differs" ? d > DREW : d < SAME) return cur;
    await page.waitForTimeout(400);
    cur = await shot();
  }
  return cur;
};

// Percentage of pixels that differ between two captures, measured in-page on a
// canvas. Exact equality is too strict here: a rebuilt body re-tessellates, and
// the re-ordered triangles shift edge antialiasing by a few hundred pixels out
// of 4.7M even when the image is visually identical. A ghost, by contrast,
// paints a solid region — percent-of-frame separates the two cleanly.
const diffPct = (a, b) =>
  page.evaluate(async ([da, db]) => {
    const load = (src) => new Promise((res) => { const i = new Image(); i.onload = () => res(i); i.src = src; });
    const [ia, ib] = await Promise.all([load(da), load(db)]);
    const px = (img) => {
      const c = new OffscreenCanvas(img.width, img.height);
      const x = c.getContext("2d");
      x.drawImage(img, 0, 0);
      return x.getImageData(0, 0, img.width, img.height).data;
    };
    const [pa, pb] = [px(ia), px(ib)];
    let n = 0;
    for (let i = 0; i < pa.length; i += 4) {
      if (Math.max(Math.abs(pa[i] - pb[i]), Math.abs(pa[i + 1] - pb[i + 1]), Math.abs(pa[i + 2] - pb[i + 2])) > 8) n++;
    }
    return (100 * n) / (pa.length / 4);
  }, [a, b]);
// A ghost covers a chunk of the frame; rebuild noise is a rounding error.
const SAME = 0.05; // % of frame — below this the two renders are the same picture
const DREW = 0.30; // % of frame — above this something was genuinely painted

let failures = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}: ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};
const checkDrew = async (label, a, b) => {
  const d = await diffPct(a, b);
  check(label, d > DREW, `${d.toFixed(3)}% of frame changed`);
  return d;
};
const checkSame = async (label, a, b) => {
  const d = await diffPct(a, b);
  check(label, d < SAME, `${d.toFixed(3)}% of frame changed`);
};

// Open a feature's dialog the way a user does — double-click its timeline row.
const openEdit = async (name) => {
  await page.locator(".tree-row", { hasText: name }).first().dblclick();
  await settlePreview();
};
const closeDialog = async () => {
  await page.keyboard.press("Escape");
  await settlePreview();
};

// ---------------------------------------------------------------------------
// 1. A chamfer on a convex edge ghosts REMOVED material.
// ---------------------------------------------------------------------------
const box = await apply({ op: "addPrimitive", kind: "box", params: { width: 40, depth: 40, height: 40 } });
check("box created", box.ok, JSON.stringify(box).slice(0, 200));
await waitIdle();

const scene = await read({ read: "sceneSummary" });
const boxEdges = scene.bodies.find((b) => b.id === box.createdId)?.edges ?? [];
const convexEdge = boxEdges.find((e) => e.includes("+z") && e.includes("+x"));
check("a top rim edge is named", Boolean(convexEdge), JSON.stringify(boxEdges).slice(0, 200));

const ch = await apply({ op: "dressUp", kind: "chamfer", targetId: box.createdId, edges: [convexEdge], size: "8" });
check("chamfer created", ch.ok, JSON.stringify(ch).slice(0, 200));
await waitIdle();

const plain = await shot();
await openEdit("Chamfer");
const withCutGhost = await shotUntil(plain, "differs");
const cutArea = await checkDrew("editing a chamfer ghosts the material it carves off", plain, withCutGhost);

// ---------------------------------------------------------------------------
// 3. The ghost belongs to the dialog, not the model.
// ---------------------------------------------------------------------------
await closeDialog();
await checkSame("closing the dialog removes the ghost (view back to plain)", plain, await shotUntil(plain, "matches"));

// ---------------------------------------------------------------------------
// 4. The ghost follows the size field.
// ---------------------------------------------------------------------------
await openEdit("Chamfer");
const sizeInput = page.locator(".extrude-dialog input").first();
await sizeInput.fill("16");
await settlePreview();
const biggerGhost = await shotUntil(withCutGhost, "differs");
const biggerArea = await diffPct(plain, biggerGhost);
check(
  "a bigger chamfer ghosts a bigger wedge",
  biggerArea > cutArea,
  `8mm covered ${cutArea.toFixed(2)}%, 16mm covered ${biggerArea.toFixed(2)}%`,
);

// ---------------------------------------------------------------------------
// 5. An invalid size drops the ghost instead of stranding the last good one.
// ---------------------------------------------------------------------------
await sizeInput.fill("");
await settlePreview();
await checkDrew("an empty size drops the ghost", biggerGhost, await shotUntil(biggerGhost, "differs"));

// An unbuildable size is checked on the message rather than on pixels: a valid-
// looking number still live-applies, so the BODY breaks too and the view would
// differ for reasons other than the ghost.
await sizeInput.fill("999"); // unbuildable on a 40mm box
await settlePreview();
check(
  "an unbuildable size is reported in the dialog",
  /\S/.test((await page.locator(".extrude-dialog .ed-warning").first().textContent().catch(() => "")) ?? ""),
);
await sizeInput.fill("8");
await settlePreview();
await closeDialog();

// ---------------------------------------------------------------------------
// 6. The delta never becomes part of the model.
// ---------------------------------------------------------------------------
const partsBefore = (await read({ read: "sceneSummary" })).bodies.map((b) => b.id).sort();
await openEdit("Chamfer");
const partsDuring = (await read({ read: "sceneSummary" })).bodies.map((b) => b.id).sort();
check(
  "the delta solids are not bodies in the model",
  JSON.stringify(partsBefore) === JSON.stringify(partsDuring),
  JSON.stringify({ partsBefore, partsDuring }),
);
check(
  "…and no ::removed/::added id leaks into the document",
  !/::(removed|added)/.test(JSON.stringify(await read({ read: "document" }))),
);
await closeDialog();

// ---------------------------------------------------------------------------
// 2. A fillet on a CONCAVE edge ghosts ADDED material — and reads differently.
// ---------------------------------------------------------------------------
const post = await apply({
  op: "addPrimitive", kind: "cylinder",
  params: { radius: 10, height: 30, x: 0, y: 0, z: 40 },
});
check("boss created", post.ok, JSON.stringify(post).slice(0, 200));
await waitIdle();
const fused = await apply({ op: "boolean", kind: "union", operands: [box.createdId, post.createdId] });
check("boss fused to the box", fused.ok, JSON.stringify(fused).slice(0, 200));
await waitIdle();

// The joint between the boss and the box top is concave — filleting it FILLS a
// cove rather than cutting one, which is the "adds material" half of the design.
// The kernel facets cylinders, so that joint is ~92 straight chords rather than
// one circle: the whole ring has to be dressed, or the fillet is a sliver too
// small to see. (Clicking it in the viewport picks the whole chain for you —
// that's what edgeGroups' chainId is for — but the bridge takes edges by name.)
const fusedScene = await read({ read: "sceneSummary" });
const jointBody = fusedScene.bodies.find((b) => b.id === fused.createdId) ?? fusedScene.bodies[0];
// Only the BASE joint — requiring the box's face name too excludes the boss's
// own top rim, which shares the "+z" spelling. Dressing one ring is also what a
// user does: a viewport click picks one tangent-continuous chain.
const ring = (jointBody?.edges ?? []).filter(
  (e) => e.includes(`${box.createdId}/+z`) && e.includes(post.createdId),
);
check("the boss/box joint ring is named", ring.length > 8, `${ring.length} chords`);

if (ring.length > 8) {
  const fil = await apply({ op: "dressUp", kind: "fillet", targetId: jointBody.id, edges: ring, size: "4" });
  check("concave fillet created", fil.ok, JSON.stringify(fil).slice(0, 200));
  await waitIdle();
  const plainFillet = await shot();
  await openEdit("Fillet");
  const withFillGhost = await shotUntil(plainFillet, "differs");
  await checkDrew("editing a concave fillet ghosts the material it adds", plainFillet, withFillGhost);
  await page.screenshot({ path: "/tmp/openpoly-dressup-fill.png" });
  await closeDialog();
  await checkSame("closing the fillet dialog removes its ghost", plainFillet, await shotUntil(plainFillet, "matches"));
}

// ---------------------------------------------------------------------------
// 7. CREATING a chamfer (rather than editing one) ghosts too. This is the case
//    the whole depth-test decision hangs on: nothing has been applied to the
//    model yet, so the wedge lies wholly INSIDE the un-chamfered solid, its
//    faces exactly coplanar with the body's. A depth-tested ghost would be
//    invisible here; this check is what proves it isn't.
//    Needs a real edge pick — the dialog takes its edges from the selection, and
//    the bridge's `select` wants a build-local edge id no script can know — so
//    the edge is found by clicking the viewport, as a user would.
// ---------------------------------------------------------------------------
const fresh = await apply({ op: "newDocument", name: "create-path" });
check("fresh document", fresh.ok, JSON.stringify(fresh).slice(0, 200));
await waitIdle();
await apply({ op: "addPrimitive", kind: "box", params: { width: 40, depth: 40, height: 40 } });
await waitIdle();
await shot("iso"); // park the camera where the sweep below expects it

const canvas = await page.locator("canvas").first().boundingBox();
let picked = null;
outer: for (let gy = 0.15; gy <= 0.85 && !picked; gy += 0.025) {
  for (let gx = 0.15; gx <= 0.85; gx += 0.025) {
    await page.mouse.click(canvas.x + canvas.width * gx, canvas.y + canvas.height * gy);
    const sel = await read({ read: "selection" });
    if (sel?.some?.((s) => s.kind === "edge")) { picked = { gx, gy }; break outer; }
  }
}
check("an edge was picked by clicking the viewport", Boolean(picked), JSON.stringify(picked));

if (picked) {
  const beforeCreate = await page.evaluate(() => window.__openpoly.screenshot("iso")); // keep the selection!
  await page.keyboard.press("c"); // Chamfer
  await settlePreview();
  check("the Chamfer dialog opened", (await page.locator(".extrude-dialog").count()) === 1);
  // Match the size used for the edit-mode checks — the dialog defaults to 2mm,
  // whose wedge is real but too slight to clear the "something was painted" bar.
  await page.locator(".extrude-dialog input").first().fill("8");
  await settlePreview();
  // The selection tint is present in BOTH frames here (the edge stays picked
  // while the dialog is open), so it cancels out of the comparison.
  let cur = await page.evaluate(() => window.__openpoly.screenshot("iso"));
  for (let i = 0; i < 30 && (await diffPct(beforeCreate, cur)) <= DREW; i++) {
    await page.waitForTimeout(400);
    cur = await page.evaluate(() => window.__openpoly.screenshot("iso"));
  }
  await checkDrew("a chamfer being CREATED ghosts the wedge inside the untouched solid", beforeCreate, cur);
  await page.screenshot({ path: "/tmp/openpoly-dressup-create.png" });
  const docNow = await read({ read: "document" });
  check(
    "…while the document still has no chamfer in it",
    !docNow.features.some((f) => f.type === "dressup"),
    JSON.stringify(docNow.features.map((f) => f.type)),
  );
  await closeDialog();
}

// ---------------------------------------------------------------------------
// 8. The ghost stays CONFINED to the edge it dresses. Regression: a block
//    sitting on half a cylinder's top face. Chamfering the concave edge where
//    the block's wall meets that top used to paint the ENTIRE exposed half-disc
//    green — the cut of before against after hangs a zero-thickness flap across
//    every face the two still share, and a flap drawn without depth testing
//    covers its whole face. A 2mm bevel on a 60mm edge may cover a percent or so
//    of frame; the whole half-disc covered an order of magnitude more.
// ---------------------------------------------------------------------------
const doc8 = await apply({ op: "newDocument", name: "confined" });
check("regression document", doc8.ok, JSON.stringify(doc8).slice(0, 200));
await waitIdle();
const rc = await apply({ op: "addPrimitive", kind: "cylinder", params: { radius: 30, height: 60 } });
const rb = await apply({ op: "addPrimitive", kind: "box", params: { width: 60, depth: 30, height: 20, y: 15, z: 60 } });
await waitIdle();
const rsolid = await apply({ op: "boolean", kind: "union", operands: [rc.createdId, rb.createdId] });
await waitIdle();
const rscene = await read({ read: "sceneSummary" });
const rbody = rscene.bodies.find((b) => b.id === rsolid.createdId) ?? rscene.bodies[0];
const rEdge = (rbody?.edges ?? []).filter((e) => e.includes(`${rc.createdId}/+z`) && e.includes(`${rb.createdId}/-y`));
check("the block/cylinder concave edge is named", rEdge.length === 1, `${rEdge.length} edges`);

if (rEdge.length === 1) {
  const rch = await apply({ op: "dressUp", kind: "chamfer", targetId: rbody.id, edges: rEdge, size: "2" });
  check("concave chamfer created", rch.ok, JSON.stringify(rch).slice(0, 200));
  await waitIdle();
  const rPlain = await shot();
  await openEdit("Chamfer");
  const rGhost = await shotUntil(rPlain, "differs");
  const area = await diffPct(rPlain, rGhost);
  check("the concave chamfer ghosts something", area > DREW, `${area.toFixed(3)}% of frame`);
  // The exposed half-disc is ~5% of this frame; the correct 2mm band is ~1%.
  check(
    "…confined to the edge, not spread over the adjoining face",
    area < 2.5,
    `${area.toFixed(3)}% of frame changed (whole-face regression measured ~5%)`,
  );
  await page.screenshot({ path: "/tmp/openpoly-dressup-confined.png" });
  await closeDialog();
}

console.log(failures === 0 ? "=== ALL CHECKS PASSED ===" : `=== ${failures} CHECK(S) FAILED ===`);
console.log("screenshots: /tmp/openpoly-dressup-*.png");
await browser.close();
process.exit(failures === 0 ? 0 : 1);
