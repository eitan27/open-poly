// Everything that takes material away previews in the REMOVAL colour.
//
// Every ghost used to be the cyan "this will appear" solid, including a cut's
// tool — the one ghost that means the opposite. Chamfer/fillet already had the
// vocabulary (GhostMesh.variant "cut": GHOST_CUT_COLOR, drawn without depth
// testing because the volume is inside the body it changes), and a Remove
// extrude's tool is the same kind of thing, so it now uses the same variant.
//
// A Boolean subtract's TOOL bodies are the same statement — that material is
// about to be taken away — and used to wear the additive cyan, so they join the
// vocabulary here too.
//
// Checked in pixels, not by eye: the app's own screenshot API renders and reads
// back in one tick, and the shot is scored for warm vs cool pixels. Switching
// the dialog between New and Remove must flip which one dominates.
import { launch, openPoly } from "./lib/harness.mjs";

const { page, close } = await launch({ deviceScaleFactor: 2, collectErrors: false, width: 1400, height: 900 });
const { waitIdle, apply } = openPoly(page);

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
  if (!baseline) return { warm: 0, red: 0, orange: 0, cool: 0, changed: 0 };
  let warm = 0,
    red = 0,
    orange = 0,
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
    if (r > gr + 25 && r > b + 25) {
      warm++;
      // Split the two warm accents by WHERE green sits between blue and red,
      // not by an absolute gap: shading scales all three channels together, so
      // a lit face and a face in shadow must classify the same. The removal red
      // (#ff6b5a) sits at (107-90)/(255-90) = 0.10, the selection orange
      // (#ff9d3c) at (157-60)/(255-60) = 0.50 — and both survive being blended
      // or lerped over a neutral body, which shifts the magnitudes but not the
      // ratio.
      if ((gr - b) / (r - b) > 0.3) orange++;
      else red++;
    } else if (b > r + 25 && gr > r + 10) cool++;
  }
  return { warm, red, orange, cool, changed };
};

// A box, and a circle on the datum through its base to cut with.
const NEUTRAL = 0x9aa3ad;
await apply({ op: "newDocument" });
await waitIdle();
const boxA = await apply({ op: "addPrimitive", kind: "box", params: { width: 40, depth: 40, height: 20 } });
await waitIdle();
// Bodies get their own colour, and the SELECTED material is that colour lerped
// toward the highlight — so a purple body highlighted orange lands on the same
// salmon as the removal red, and no hue test could tell them apart. Neutral
// grey keeps each accent recognisably itself.
await apply({ op: "setAppearance", featureId: boxA.createdId, color: NEUTRAL });
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
// The claim is about the REMOVAL accent, not about how much cyan is on screen:
// an additive ghost is depth-tested, so how much of it you can see depends on
// where the tool sits relative to the body (and the body's own colour tints
// what shows through). What must hold is that none of the frame turns red.
check("a New extrude ghosts nothing as a removal", addShot.red < 100, JSON.stringify(addShot));

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
check("a Remove extrude ghosts in the REMOVAL colour", cutShot.red > 2000, JSON.stringify(cutShot));
check("…the removal red, not the selection orange", cutShot.red > cutShot.orange * 4, JSON.stringify(cutShot));
check("…and it dominates the frame's change", cutShot.red > cutShot.cool * 4, JSON.stringify(cutShot));
await page.screenshot({ path: "/tmp/openpoly-extrude-cut-ghost.png" });

// Flip it so the tool cuts UP, into the box — the case the variant exists for.
// Buried in the solid, a depth-tested ghost of it would be invisible exactly
// when it matters (the same reason a chamfer's wedge is drawn on top), so this
// is the assertion that would catch losing `depthTest: false`.
await dlg.locator(".ed-field", { hasText: "Flip direction" }).locator("input").check();
await page.waitForTimeout(1500);
const insideShot = await score();
console.log("Remove, tool inside the body:", JSON.stringify(insideShot));
check("a cut buried in the body is still visible", insideShot.red > 2000, JSON.stringify(insideShot));
check("…and still reads as a removal", insideShot.red > insideShot.cool * 4, JSON.stringify(insideShot));
await page.screenshot({ path: "/tmp/openpoly-extrude-cut-ghost-inside.png" });
await dlg.locator(".ed-field", { hasText: "Flip direction" }).locator("input").uncheck();
await page.waitForTimeout(800);

// Back to New: the colour follows the mode, it isn't sticky.
await mode("New");
await page.waitForTimeout(1500);
const backShot = await score();
console.log("back to New:", JSON.stringify(backShot));
// Not zero: the orange selection highlight's antialiased edge pixels land on
// the red side of the split. What matters is that the removal accent is two
// orders of magnitude down from an actual removal.
check(
  "switching back drops the removal colour again",
  backShot.red < cutShot.red / 50,
  `${backShot.red} vs ${cutShot.red}`,
);

// --- The same statement in the Boolean dialog: a subtract's TOOLS ------------
// The base survives as itself (selection orange); the tools are consumed, so
// they now read in the removal red instead of the additive cyan they used to
// borrow. Baselining on the frame where only the BASE is picked isolates the
// tool's own contribution: whatever changes when the tool lands is the tool.
await dlg.locator("button", { hasText: "Cancel" }).click();
await page.waitForTimeout(400);
const boxB = await apply({ op: "addPrimitive", kind: "box", params: { width: 30, depth: 30, height: 30 } });
await waitIdle();
await apply({ op: "setAppearance", featureId: boxB.createdId, color: NEUTRAL });
await waitIdle();
await apply({ op: "transform", targetId: boxB.createdId, tx: 45, ty: 0, tz: 0 });
await waitIdle();
await apply({ op: "select", refs: [] });
await page.evaluate(() => document.activeElement?.blur());
await page.waitForTimeout(200);
await page.keyboard.press("b");
await page.waitForTimeout(600);
const bdlg = page.locator(".boolean-dialog");
check("the boolean dialog opened", await bdlg.isVisible());
await bdlg.locator(".ed-modes button", { hasText: "Subtract" }).click();
await page.waitForTimeout(300);

const canvas2 = await page.locator("canvas").first().boundingBox();
const clickWorld = async (w) => {
  const p = await page.evaluate((q) => window.__openpoly.worldToScreen(q), w);
  await page.mouse.click(canvas2.x + p.x, canvas2.y + p.y);
  await page.waitForTimeout(500);
};
await clickWorld([0, 0, 20]); // the original box's top face → the BASE
const picked = await bdlg.locator(".bool-operand-name").allTextContents();
console.log("base:", picked.join(" | ") || "none");
check("the base landed", picked.length === 1, picked.join(" | ") || "none");

baseline = await grab(); // base picked, tool not yet — everything else frozen
await clickWorld([45, 0, 30]); // the second box → a TOOL
const tools = await bdlg.locator(".bool-operand-name").allTextContents();
console.log("operands:", tools.join(" | "));
check("the tool landed", tools.length === 2, tools.join(" | "));
const toolShot = await score();
console.log("subtract tool:", JSON.stringify(toolShot));
check("a subtract TOOL reads as a removal", toolShot.red > 2000, JSON.stringify(toolShot));
check("…in the removal red, not the selection orange", toolShot.red > toolShot.orange * 4, JSON.stringify(toolShot));
check("…and not the additive cyan it used to borrow", toolShot.red > toolShot.cool * 4, JSON.stringify(toolShot));
await page.screenshot({ path: "/tmp/openpoly-boolean-cut-highlight.png" });

// Union says the opposite about the same two bodies: both are kept.
await bdlg.locator(".ed-modes button", { hasText: "Union" }).click();
await page.waitForTimeout(600);
const unionShot = await score();
console.log("union operand:", JSON.stringify(unionShot));
await page.screenshot({ path: "/tmp/openpoly-boolean-union.png" });
check("switching to Union stops calling it a removal", unionShot.red < toolShot.red / 4, JSON.stringify(unionShot));

console.log(failures ? `\n${failures} FAILED` : "\nAll checks passed");
await close();
process.exit(failures ? 1 : 0);
