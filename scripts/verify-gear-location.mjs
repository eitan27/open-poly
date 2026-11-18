// The Gear dialog's Location slot, end to end: it opens listening, with the
// ghost already on the Top plane's origin; hovering a face shows the gear's
// pitch circle where a click would centre it; a click on a face, a sketch
// point or a datum plane moves it there; the gear Create builds is centred
// where it was put, and one on a sketch point follows that point.
// Screenshots go to $SHOTS (default: the OS temp dir).
//
//   URL=http://localhost:5180/ node scripts/verify-gear-location.mjs
import os from "node:os";
import path from "node:path";
import { launch, openPoly, checker } from "./lib/harness.mjs";

const SHOTS = process.env.SHOTS ?? os.tmpdir();
const { page, errors, close } = await launch({ deviceScaleFactor: 2 });
const op = openPoly(page);
const { check, done } = checker();
const shot = (name) => page.screenshot({ path: path.join(SHOTS, `gear-loc-${name}.png`) });

await op.newDocument();
// A plate (x −20…20, y −15…15, z 0…15), and a sketch point on Top off its side.
await op.applySettled({ op: "addPrimitive", kind: "box", params: { width: 40, depth: 30, height: 15 } });
// Its x is a variable, so the check can move it.
await op.applySettled({ op: "setVariable", name: "px", expression: "45" });
await op.applySettled({ op: "addSketch", plane: { datum: "top" }, entities: [{ shape: "point", p: ["px", 0] }] });

const canvas = page.locator(".viewport canvas").first();
const dialog = page.locator(".gear-dialog");
const slot = dialog.locator(".ed-pick-btn.ed-wide, .bool-operand-row").first();
const slotText = async () => (await dialog.textContent()) ?? "";
const hover = async (w) => {
  const p = await op.screenOf(w);
  await page.mouse.move(p.x, p.y, { steps: 4 });
  await page.waitForTimeout(300);
};
const openGear = async () => {
  await canvas.hover({ position: { x: 5, y: 5 } });
  await page.keyboard.press("g");
  await dialog.waitFor({ timeout: 5000 });
  await page.waitForTimeout(1200);
};
const create = async () => {
  await dialog.locator(".ed-primary").click();
  await op.settle();
};
/** The newest gear's body: its bounding box centre and z extent. */
const lastGear = async () => {
  const gears = (await op.features()).filter((f) => f.type === "gear");
  const g = gears[gears.length - 1];
  const b = (await op.bodies()).find((x) => x.id === g.id);
  const [x0, y0, z0] = b.bbox.min;
  const [x1, y1, z1] = b.bbox.max;
  return { id: g.id, c: [(x0 + x1) / 2, (y0 + y1) / 2], z: [z0, z1] };
};
const near = (a, b, tol = 0.6) => Math.abs(a - b) < tol;

// 1. Opens listening, ghost on the default.
await openGear();
check("the Location slot opens listening", (await slot.getAttribute("class"))?.includes("active"));
check("…and says what to click, and where it is until then", /Until then it's on Top/.test(await slotText()));
await shot("1-open");

// 2. The plate's top: the pitch circle shows on it; a click centres the gear there.
await hover([4, 3, 15]);
await shot("2-hover-face");
await op.clickWorld([4, 3, 15]);
await page.waitForTimeout(600);
check("a face pick fills the slot", /Box 1 · face/.test(await slotText()), (await slotText()).slice(0, 160));
check("…and stops listening", !(await slot.getAttribute("class"))?.includes("active"));
await shot("3-on-face");
await create();
let g = await lastGear();
check("the gear sits on the plate's top", near(g.z[0], 15), JSON.stringify(g));
check("…centred on the face", near(g.c[0], 0) && near(g.c[1], 0), JSON.stringify(g));

// 3. A sketch point: centred on it, and it follows the point.
await openGear();
await hover([45, 0, 0]);
await shot("4-hover-point");
await op.clickWorld([45, 0, 0]);
await page.waitForTimeout(600);
check("a sketch point fills the slot", /Sketch 1 · point/.test(await slotText()), (await slotText()).slice(0, 160));
await create();
g = await lastGear();
check("the gear is centred on the point", near(g.c[0], 45) && near(g.c[1], 0), JSON.stringify(g));
await op.applySettled({ op: "setVariable", name: "px", expression: "60" });
g = await lastGear();
check("…and follows it when the point moves", near(g.c[0], 60) && near(g.c[1], 0), JSON.stringify(g));

// 4. A datum plane where nothing on a face snaps: centred on its origin.
await openGear();
await hover([-12, 0, 34]);
await shot("5-hover-plane");
await op.clickWorld([-12, 0, 34]);
await page.waitForTimeout(600);
check("a datum plane fills the slot", /Front/.test(await slotText()), (await slotText()).slice(0, 160));
await create();
g = await lastGear();
check("the gear is on the Front plane's origin", near(g.c[0], 0), JSON.stringify(g));

// The dev server's 502s for resources it doesn't serve are noise (as in
// verify-gear / verify-hole-points).
const real = errors.filter((e) => !/Failed to load resource/.test(e));
check("no page errors", real.length === 0, real.join("; "));
await close();
done();
