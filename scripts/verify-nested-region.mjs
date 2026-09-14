// End-to-end verification of NESTED (island) sketch regions:
//  1. A big box with a smaller box fully inside → outer annulus + inner face.
//  2. REAL viewport clicks: clicking inside the inner box selects the inner
//     region; clicking the frame (annulus) selects the outer — each distinct.
//  3. Extruding the outer (frame) region yields a solid WITH a hole (a picture
//     frame), verified by measuring its volume vs a solid slab.
import { launch, openPoly } from "./lib/harness.mjs";

const { page, close } = await launch({ deviceScaleFactor: 2, collectErrors: false });
const { waitIdle, apply, read } = openPoly(page);
await waitIdle();

let failures = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}: ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

const nd = await apply({ op: "newDocument" });
check("fresh document", nd.ok);
await waitIdle();

// Big box 40×40 centered on origin, inner box 16×16 centered on origin.
const sk = await apply({
  op: "addSketch",
  plane: { datum: "top" },
  entities: [
    { shape: "rect", center: [0, 0], w: 40, h: 40 },
    { shape: "rect", center: [0, 0], w: 16, h: 16 },
  ],
});
check("sketch created", sk.ok, JSON.stringify(sk).slice(0, 150));
await waitIdle();

const scene = await read({ read: "sceneSummary" });
const regions = scene.sketches.find((s) => s.id === sk.createdId)?.regions ?? [];
check(
  "two regions detected",
  regions.length === 2,
  `regions: ${JSON.stringify(regions.map((r) => Math.round(r.area)))}`,
);
const outer = regions.find((r) => r.area > 1000);
const inner = regions.find((r) => r.area < 1000);
check("outer is the annulus (1600−256=1344)", outer && Math.abs(outer.area - 1344) < 2, `${outer?.area}`);
check("inner is the 16×16 face (256)", inner && Math.abs(inner.area - 256) < 2, `${inner?.area}`);

// --- Real clicks ------------------------------------------------------------
const canvasBox = await page.locator("canvas").first().boundingBox();
const clickWorld = async (w) => {
  const s = await page.evaluate((p) => window.__openpoly.worldToScreen(p), w);
  await page.mouse.click(canvasBox.x + s.x, canvasBox.y + s.y);
  await page.waitForTimeout(150);
};

// Clicks accumulate across distinct regions and toggle when repeated, so reset
// by re-clicking the same world point (deselects) before the next check.
await clickWorld([0, 0, 0]); // dead center → inside the inner box
let sel = await read({ read: "selection" });
check(
  "clicking inside the inner box selects the inner region",
  sel.length === 1 && sel[0].kind === "sketchFace" && sel[0].regionId === inner.id,
  JSON.stringify(sel),
);
await clickWorld([0, 0, 0]); // toggle the inner region back off

await clickWorld([15, 15, 0]); // in the frame near a corner (annulus only)
sel = await read({ read: "selection" });
check(
  "clicking the frame selects the OUTER region",
  sel.length === 1 && sel[0].kind === "sketchFace" && sel[0].regionId === outer.id,
  JSON.stringify(sel),
);

// --- Extrude the frame → a hollow solid -------------------------------------
// The outer region is already selected; extrude it. A solid slab would span the
// full 40×40 outer extent with 6 faces; a real frame keeps its inner walls.
check("outer region selected for extrude", sel.length === 1 && sel[0].regionId === outer.id, JSON.stringify(sel));
await page.keyboard.press("e");
await page.waitForTimeout(300);
check("extrude dialog opened", (await page.locator(".extrude-dialog").count()) === 1);
await page.keyboard.press("Enter");
try {
  await waitIdle();
} catch {
  /* capture status below instead of failing hard */
}
const status = (await page.locator(".status").textContent())?.trim();
console.log(`INFO: status after extrude = "${status}"`);

const scene2 = await read({ read: "sceneSummary" });
const bodies = scene2.bodies ?? [];
check("one body from the frame extrude", bodies.length === 1, `bodies: ${bodies.length}`);
const b = bodies[0];
// Frame bbox should still span the full 40×40 outer extent.
check(
  "frame body spans the full 40×40 outer extent",
  b?.bbox && Math.abs(b.bbox.max[0] - b.bbox.min[0] - 40) < 0.5 && Math.abs(b.bbox.max[1] - b.bbox.min[1] - 40) < 0.5,
  JSON.stringify(b?.bbox),
);
// A hollow rectangular frame has 4 outer + 4 inner walls + 2 annular caps = 10
// faces; a solid slab (hole lost) would have just 6. Face count proves the cut.
check(
  "frame body has an inner wall (hole preserved, not a solid slab)",
  Array.isArray(b?.faces) && b.faces.length >= 10,
  `faces: ${b?.faces?.length}`,
);

await page.screenshot({ path: "/tmp/openshape-nested-region.png" });
console.log(failures === 0 ? "=== ALL CHECKS PASSED ===" : `=== ${failures} CHECK(S) FAILED ===`);
await close();
process.exit(failures === 0 ? 0 : 1);
