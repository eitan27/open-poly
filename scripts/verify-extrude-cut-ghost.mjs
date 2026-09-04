// A Remove extrude previews in the REMOVAL colour, not the arrival one.
//
// Every ghost used to be the cyan "this will appear" solid, including a cut's
// tool — the one ghost that means the opposite. Chamfer/fillet already had the
// vocabulary (GhostMesh.variant "cut": GHOST_CUT_COLOR, drawn without depth
// testing because the volume is inside the body it changes), and a Remove
// extrude's tool is the same kind of thing, so it now uses the same variant.
//
// Checked in pixels, not by eye: the app's own screenshot API renders and reads
// back in one tick, and the shot is scored for warm vs cool pixels. Switching
// the dialog between New and Remove must flip which one dominates.
import { chromium } from "playwright";

const URL = process.env.URL ?? "http://localhost:5173/";
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1400, height: 900 }, deviceScaleFactor: 2 });
const page = await context.newPage();
page.on("pageerror", (e) => console.log(`[pageerror] ${e.message}`));
await page.goto(URL, { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => window.__openpoly, null, { timeout: 30000 });

const apply = (o) => page.evaluate((x) => window.__openpoly.apply(x), o);
const waitIdle = async () => {
  let stable = 0;
  for (let i = 0; i < 200; i++) {
    const s = (await page.locator(".status").textContent())?.trim() ?? "";
    stable = /up to date|error|fail/i.test(s) ? stable + 1 : 0;
    if (stable >= 3) return s;
    await page.waitForTimeout(300);
  }
  return "TIMEOUT";
};
let failures = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}: ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

/** Warm vs cool, counted only over the pixels the ghost actually CHANGED.
 *  Scoring a whole frame doesn't work — this app's background is itself a cool
 *  blue and swamps the count — so a baseline frame is captured with no dialog
 *  open and every later shot is diffed against it. What's left is the ghost.
 *
 *  The app's own screenshot path is what produces the frames: it renders and
 *  reads the drawing buffer in the same tick (WebGL doesn't preserve it across
 *  compositing) and drops selection highlights, which would otherwise put their
 *  own orange into the warm count. */
const grab = () =>
  page.evaluate(async () => {
    const url = window.__openpoly.read({ read: "screenshot" });
    const img = new Image();
    await new Promise((res, rej) => {
      img.onload = res;
      img.onerror = rej;
      img.src = url;
    });
    const c = document.createElement("canvas");
    c.width = img.width;
    c.height = img.height;
    const g = c.getContext("2d");
    g.drawImage(img, 0, 0);
    return [...g.getImageData(0, 0, c.width, c.height).data];
  });
let baseline = null;
const score = async () => {
  const now = await grab();
  if (!baseline) return { warm: 0, cool: 0, changed: 0 };
  let warm = 0,
    cool = 0,
    changed = 0;
  for (let i = 0; i < now.length; i += 4) {
    const r = now[i],
      gr = now[i + 1],
      b = now[i + 2];
    const dr = r - baseline[i],
      dg = gr - baseline[i + 1],
      db = b - baseline[i + 2];
    if (Math.abs(dr) + Math.abs(dg) + Math.abs(db) < 24) continue;
    changed++;
    // Classify by where the pixel LANDED: the cut accent is red-dominant
    // (#ff6b5a), the additive one blue/green-dominant (#4fd1ff).
    if (r > gr + 25 && r > b + 25) warm++;
    else if (b > r + 25 && gr > r + 10) cool++;
  }
  return { warm, cool, changed };
};

// A box, and a circle on the datum through its base to cut with.
await apply({ op: "newDocument" });
await waitIdle();
await apply({ op: "addPrimitive", kind: "box", params: { width: 40, depth: 40, height: 20 } });
await waitIdle();
const sk = await apply({
  op: "addSketch",
  plane: { datum: "top" },
  entities: [{ shape: "circle", c: [0, 0], r: 8 }],
});
await waitIdle();
check("the scene builds", sk.ok, JSON.stringify(sk).slice(0, 140));

baseline = await grab();
console.log("baseline captured:", baseline.length / 4, "px");

// Open Extrude on that circle.
await page.evaluate(() => document.activeElement?.blur());
// Selecting the circle ENTITY is what makes the region it encloses a profile.
const circleId = await page.evaluate((id) => {
  const doc = window.__openpoly.read({ read: "document" });
  const d = doc.document ?? doc;
  const s = d.features.find((f) => f.id === id);
  return s?.entities?.[0]?.id ?? null;
}, sk.createdId);
console.log("circle entity:", circleId);
await apply({ op: "select", refs: [{ kind: "sketchEntity", sketchId: sk.createdId, entityId: circleId }] });
await page.waitForTimeout(200);
await page.keyboard.press("e");
await page.waitForTimeout(600);
const dlg = page.locator(".extrude-dialog");
check("the extrude dialog opened", await dlg.isVisible());

const mode = (name) => dlg.locator(".ed-modes button", { hasText: new RegExp(`^${name}$`) }).click();
const distance = dlg.locator(".ed-field", { hasText: "Distance" }).locator("input");
await distance.fill("20");
await page.waitForTimeout(1500);
const addShot = await score();
console.log("New (adds material):", JSON.stringify(addShot));
check(
  "a New extrude ghosts in the ARRIVAL colour",
  addShot.cool > 2000 && addShot.cool > addShot.warm * 4,
  JSON.stringify(addShot),
);

// Same extrude, now cutting the box.
await mode("Remove");
await page.waitForTimeout(300);
// The first option is a disabled "Select a part…" placeholder; the body is next.
const target = dlg.locator(".ed-field", { hasText: "Target" }).locator("select");
const values = await target.locator("option").evaluateAll((os) => os.map((o) => o.value).filter(Boolean));
await target.selectOption(values[0]);
console.log("target chosen:", await target.inputValue());
check("the cut has a target body", !!(await target.inputValue()));
await distance.fill("20");
await page.waitForTimeout(1500);
const cutShot = await score();
console.log("Remove (cuts material):", JSON.stringify(cutShot));
check("a Remove extrude ghosts in the REMOVAL colour", cutShot.warm > 2000, JSON.stringify(cutShot));
check("…and it dominates the frame's change", cutShot.warm > cutShot.cool * 4, JSON.stringify(cutShot));
await page.screenshot({ path: "/tmp/openpoly-extrude-cut-ghost.png" });

// Flip it so the tool cuts UP, into the box — the case the variant exists for.
// Buried in the solid, a depth-tested ghost of it would be invisible exactly
// when it matters (the same reason a chamfer's wedge is drawn on top), so this
// is the assertion that would catch losing `depthTest: false`.
await dlg.locator(".ed-field", { hasText: "Flip direction" }).locator("input").check();
await page.waitForTimeout(1500);
const insideShot = await score();
console.log("Remove, tool inside the body:", JSON.stringify(insideShot));
check("a cut buried in the body is still visible", insideShot.warm > 2000, JSON.stringify(insideShot));
check("…and still reads as a removal", insideShot.warm > insideShot.cool * 4, JSON.stringify(insideShot));
await page.screenshot({ path: "/tmp/openpoly-extrude-cut-ghost-inside.png" });
await dlg.locator(".ed-field", { hasText: "Flip direction" }).locator("input").uncheck();
await page.waitForTimeout(800);

// Back to New: the colour follows the mode, it isn't sticky.
await mode("New");
await page.waitForTimeout(1500);
const backShot = await score();
console.log("back to New:", JSON.stringify(backShot));
check("switching back returns the arrival colour", backShot.cool > backShot.warm * 4, JSON.stringify(backShot));

console.log(failures ? `\n${failures} FAILED` : "\nAll checks passed");
await browser.close();
process.exit(failures ? 1 : 0);
