// A preview ghost stays findable:
//  1. Hidden edges — a gear ghost buried in a plate shows its edges through
//     the plate, dashed (counted as ghost-cyan pixels over the plate).
//  2. Bring into view — with the camera zoomed in on one gear, a second gear
//     placed beside it off screen is brought into view, clear of the dialog,
//     with its partner.
// Screenshots to $SHOTS.
//
//   URL=http://localhost:5180/ node scripts/verify-ghost-visibility.mjs
//
// NB if the local open-poly MCP hub is running, this headless tab connects to
// it and can take the bridge from your own tab; reload yours after.
import os from "node:os";
import path from "node:path";
import { launch, openPoly, checker } from "./lib/harness.mjs";

const SHOTS = process.env.SHOTS ?? os.tmpdir();
const { page, errors, close } = await launch({ deviceScaleFactor: 1 });
const op = openPoly(page);
const { check, done } = checker();
const shot = (name) => page.screenshot({ path: path.join(SHOTS, `ghost-visibility-${name}.png`) });
const canvas = page.locator(".viewport canvas").first();
const dialog = page.locator(".gear-dialog");
const fieldInput = (label) => dialog.locator(".ed-field", { hasText: label }).locator("input").first();
const fieldSelect = (label) => dialog.locator(".ed-field", { hasText: label }).locator("select").first();
const key = async (k) => {
  await canvas.hover({ position: { x: 5, y: 5 } });
  await page.keyboard.press(k);
};

/** Ghost-cyan (0x4fd1ff-ish) pixels in a square round a canvas point, read
 *  from a screenshot (decoded in the page; WebGL's buffer isn't kept). */
async function cyanAround(p, half = 110) {
  const box = await canvas.boundingBox();
  const png = await page.screenshot({
    clip: { x: box.x + p.x - half, y: box.y + p.y - half, width: 2 * half, height: 2 * half },
  });
  return page.evaluate(async (b64) => {
    const img = await createImageBitmap(await (await fetch(`data:image/png;base64,${b64}`)).blob());
    const c = new OffscreenCanvas(img.width, img.height);
    const ctx = c.getContext("2d");
    ctx.drawImage(img, 0, 0);
    const buf = ctx.getImageData(0, 0, img.width, img.height).data;
    let n = 0;
    for (let i = 0; i < buf.length; i += 4) {
      const [r, g, b] = [buf[i], buf[i + 1], buf[i + 2]];
      if (b > 140 && b - r > 25) n++; // cyan, or cyan blended over the plate
    }
    return n;
  }, png.toString("base64"));
}

// --- 1. A gear ghost inside a plate --------------------------------------------
await op.newDocument();
await op.applySettled({
  op: "addPrimitive",
  kind: "box",
  params: { width: "100", depth: "100", height: "20", x: "0", y: "0", z: "-4" },
});
let s = await op.scene();
const plate = s.bodies[0].bbox;
check(
  "the plate surrounds the gear's place",
  plate.min[0] < -40 && plate.max[0] > 40 && plate.min[2] < 0 && plate.max[2] > 10,
  JSON.stringify(plate),
);
await key("h");
await page.waitForTimeout(900);
await key("g");
await dialog.waitFor();
await page.waitForTimeout(2000);
await shot("1-buried");
const center = await page.evaluate(() => window.__openpoly.worldToScreen([0, 0, 16]));
const buried = await cyanAround(center);
await dialog.getByRole("button", { name: "Cancel" }).click();
await page.waitForTimeout(800);
// The control: the same spot with no ghost (the Z axis is bluish there too).
const none = await cyanAround(center);
check("the buried ghost's edges show through the plate", buried - none > 400, `${buried} vs ${none} cyan px`);

// --- 2. A placed gear brought into view ---------------------------------------
await op.newDocument();
await key("g");
await dialog.waitFor();
await fieldInput("Teeth").fill("12");
await page.waitForTimeout(400);
await dialog.locator(".ed-primary").click();
await op.settle();
await key("7"); // top view
await page.waitForTimeout(900);
// Zoom right in on gear 1.
const box = await canvas.boundingBox();
const g1 = await page.evaluate(() => window.__openpoly.worldToScreen([0, 0, 4]));
await page.mouse.move(box.x + g1.x, box.y + g1.y);
for (let i = 0; i < 14; i++) {
  await page.mouse.wheel(0, -300);
  await page.waitForTimeout(40);
}
await page.waitForTimeout(600);
const far = await page.evaluate(() => window.__openpoly.worldToScreen([36 + 26, 0, 4]));
check(
  "zoomed in, the far side of where gear 2 goes is off screen",
  far.x > box.width || far.x < 0,
  JSON.stringify(far),
);
await shot("2-zoomed");

await key("g");
await dialog.waitFor();
await fieldInput("Teeth").fill("24");
await fieldSelect("Size by").selectOption({ label: "Gear 1" });
await page.waitForTimeout(2500);
await shot("3-in-view");
const dlg = await dialog.boundingBox();
const onScreen = async (w) => {
  const p = await page.evaluate((q) => window.__openpoly.worldToScreen(q), w);
  return { p, ok: p.x > 0 && p.x < dlg.x - box.x && p.y > 0 && p.y < box.height };
};
// Gear 2's ghost spans x 10–62 (pitch Ø 48, outside Ø 52, centered at 36).
for (const [name, w] of [
  ["gear 2's far side", [62, 0, 4]],
  ["gear 2's near side", [10, 0, 4]],
  ["gear 1 (the partner)", [-13, 0, 4]],
]) {
  const r = await onScreen(w);
  check(`${name} is in view, left of the dialog`, r.ok, JSON.stringify(r.p));
}

// Orbiting away is left alone: only a change to the gear brings it back.
await page.mouse.move(box.x + 200, box.y + 200);
for (let i = 0; i < 8; i++) {
  await page.mouse.wheel(0, -300);
  await page.waitForTimeout(40);
}
await page.waitForTimeout(800);
const zoomedAgain = await page.evaluate(() => window.__openpoly.worldToScreen([62, 0, 4]));
await page.waitForTimeout(800);
const still = await page.evaluate(() => window.__openpoly.worldToScreen([62, 0, 4]));
check(
  "zooming in by hand isn't undone while nothing changes",
  Math.hypot(still.x - zoomedAgain.x, still.y - zoomedAgain.y) < 1,
  JSON.stringify([zoomedAgain, still]),
);
await fieldInput("Angle").fill("180");
await page.waitForTimeout(2500);
const back = await onScreen([-36 - 26, 0, 4]);
check("a new Angle brings the moved gear back into view", back.ok, JSON.stringify(back.p));
await shot("4-angle-180");

const real = errors.filter((e) => !/502|Bad Gateway|drive\/config/.test(e));
check("no page errors", real.length === 0, real.slice(0, 3).join(" | "));
await close();
done();
