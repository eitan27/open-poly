// Three fixes around the revolve dialog's arming, all reported from real use:
//   1. a datum plane the user switched OFF must not be pickable — three.js
//      raycasts invisible objects, so a hidden plane used to swallow the click
//      (and the hover) meant for the geometry behind it;
//   2. a straight BODY EDGE is a valid revolve axis (it was advertised in the
//      messages but never accepted), and it highlights on hover while arming;
//   3. arming the profile cancels an armed axis — the two roles read different
//      click streams, so the axis button used to stay lit (its dashed pulse)
//      and still swallow the next click.
import { chromium } from "playwright";

const URL = process.env.URL ?? "http://localhost:5173/";
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1400, height: 900 }, deviceScaleFactor: 2 });
const page = await context.newPage();
page.on("pageerror", (e) => console.log(`[pageerror] ${e.message}`));
await page.goto(URL, { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => window.__openpoly, null, { timeout: 30000 });

const waitIdle = async () => {
  let stable = 0;
  for (let i = 0; i < 120; i++) {
    const s = (await page.locator(".status").textContent())?.trim() ?? "";
    stable = /up to date|error|fail/i.test(s) ? stable + 1 : 0;
    if (stable >= 3) return s;
    await page.waitForTimeout(300);
  }
  return "TIMEOUT";
};
const apply = (o) => page.evaluate((x) => window.__openpoly.apply(x), o);
const read = (q) => page.evaluate((x) => window.__openpoly.read(x), q);
let failures = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}: ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};
const dlg = page.locator(".extrude-dialog");
const blur = () => page.evaluate(() => document.activeElement?.blur());

// A profile sketch on Front, off to one side of the Z axis, plus a box whose
// vertical edge sits on that axis — the edge we want to revolve around.
await apply({ op: "newDocument" });
await waitIdle();
const sk = await apply({
  op: "addSketch",
  plane: { datum: "front" },
  entities: [{ shape: "rect", center: [30, 20], w: 12, h: 16 }],
});
await waitIdle();
await apply({ op: "addPrimitive", kind: "box", params: { width: 20, depth: 20, height: 60 } });
await waitIdle();
const canvas = await page.locator("canvas").first().boundingBox();
const clickWorld = async (w) => {
  const s = await page.evaluate((p) => window.__openpoly.worldToScreen(p), w);
  await page.mouse.click(canvas.x + s.x, canvas.y + s.y);
  await page.waitForTimeout(400);
};
const hoverWorld = async (w) => {
  const s = await page.evaluate((p) => window.__openpoly.worldToScreen(p), w);
  await page.mouse.move(canvas.x + s.x, canvas.y + s.y);
  await page.waitForTimeout(300);
};

// --- 3. Arming the profile cancels an armed axis -----------------------------
await blur();
await apply({ op: "select", refs: [] });
await page.keyboard.press("r");
await page.waitForTimeout(400);
const labels = () => dlg.locator(".ed-pick-btn").allTextContents();
const classes = () => dlg.locator(".ed-pick-btn").evaluateAll((els) => els.map((e) => e.className));
await dlg.locator(".ed-pick-btn").last().click(); // arm the axis
await page.waitForTimeout(300);
// Both states read "Select an axis" — the label says what the slot wants and
// doesn't change under the user — so the ARMED state is the dashed-pulse class.
check(
  "arming the axis lights the axis button",
  (await classes())[1].includes("active") && (await labels())[1] === "Select an axis",
  `${(await labels()).join(" | ")} :: ${(await classes()).join(" | ")}`,
);
await dlg.locator(".ed-pick-btn").first().click(); // back to the profile
await page.waitForTimeout(300);
const l = await labels();
const c = await classes();
check("…and going back to the profile disarms it", l[1] === "Select an axis", l.join(" | "));
check("…including its highlight", !c[1].includes("active"), c.join(" | "));
check("…while the profile is now the armed one", c[0].includes("active"), c.join(" | "));
check(
  "…and the pick banner is gone",
  (await page.locator(".sketch-banner.pick span").textContent()) !== null
    ? !/revolve around/.test(await page.locator(".sketch-banner.pick span").textContent())
    : true,
);

// --- 1 + 2. Hide the Front plane, then use a body edge as the axis -----------
// The Front datum stands between the camera and the box's near vertical edge.
const frontEye = page.locator(".tree-row.datum-row", { hasText: "Front" }).locator(".row-icon");
await frontEye.click(); // hide the Front datum
await page.waitForTimeout(400);
// Profile first: the sketch region.
await clickWorld([30, 0, 20]);
check(
  "profile armed from the region",
  (await dlg.locator(".bool-operand-name").allTextContents()).length === 1,
  (await dlg.locator(".bool-operand-name").allTextContents()).join(" | ") || "none",
);
// No second button press: a satisfied slot hands the arming to the next empty
// one, so the axis is already listening for the clicks below.
check(
  "…and the axis armed itself once the profile landed",
  (await dlg.locator(".ed-pick-btn.active").count()) === 1 &&
    (await dlg.locator(".ed-pick-btn.active").textContent()) === "Select an axis",
  (await dlg.locator(".ed-pick-btn").allTextContents()).join(" | ") || "none",
);

// 1a. The HIDDEN Front plane must not take the click. This point is ON that
// plane (y = 0), inside its 72mm quad, and clear of every body/sketch — so
// before the fix the pick fell through to the plane and filled the axis with it.
const onFrontPlane = [-25, 0, 25];
await clickWorld(onFrontPlane);
check(
  "a hidden datum plane doesn't take the axis click",
  (await dlg.locator(".bool-operand-name").allTextContents()).length === 1,
  (await dlg.locator(".bool-operand-name").allTextContents()).join(" | "),
);

// 1b. Positive control: unhide it and the very same click DOES pick it — the
// filter must gate on visibility, not disable plane picking.
await frontEye.click(); // show it again
await page.waitForTimeout(400);
await clickWorld(onFrontPlane);
const withPlane = await dlg.locator(".bool-operand-name").allTextContents();
check(
  "a VISIBLE datum plane still picks as the axis",
  withPlane.length === 2 && /front/i.test(withPlane[1]),
  withPlane.join(" | "),
);
// Clear it and hide the plane again for the edge pick.
await dlg.locator(".bool-operand-row").last().locator(".bool-operand-x").click();
await page.waitForTimeout(300);
await frontEye.click();
await page.waitForTimeout(400);

// 2. Hover must LIGHT UP the body edge while the axis is armed (it used to
// resolve hover with the plane-only raycaster, so the edge stayed dark).
const shotAt = async (w, name) => {
  const pt = await page.evaluate((p) => window.__openpoly.worldToScreen(p), w);
  return page.screenshot({
    path: name,
    clip: { x: canvas.x + pt.x - 40, y: canvas.y + pt.y - 40, width: 80, height: 80 },
  });
};
await hoverWorld([-200, -200, -200]); // park the cursor away
const cold = await shotAt([10, -10, 30], "/tmp/edge-cold.png");
await hoverWorld([10, -10, 30]);
const hot = await shotAt([10, -10, 30], "/tmp/edge-hot.png");
check(
  "hovering a body edge highlights it while the axis is armed",
  !cold.equals(hot),
  `${cold.length} vs ${hot.length} bytes`,
);

await clickWorld([10, -10, 30]);
const operands = await dlg.locator(".bool-operand-name").allTextContents();
check(
  "a body edge fills the axis (not the hidden plane behind it)",
  operands.length === 2 && /· edge$/.test(operands[1]),
  operands.join(" | ") || "none",
);
await page.screenshot({ path: "/tmp/revolve-edge-axis.png" });

// It builds.
await dlg.locator(".ed-primary").click();
await waitIdle();
const summary = await read({ read: "sceneSummary" });
check(
  "the edge-axis revolve builds",
  (summary.bodies ?? []).length === 2,
  (summary.bodies ?? []).map((b) => b.name).join(", "),
);
check(
  "with no errors",
  Object.keys(summary.errors ?? {}).length === 0,
  JSON.stringify(summary.errors ?? {}).slice(0, 200),
);
const docNow = await read({ read: "document" });
const rev = (docNow.document ?? docNow).features.find((f) => f.type === "revolve");
check("…storing an edge axis by name", !!rev?.axis?.edge?.edgeName, JSON.stringify(rev?.axis ?? null).slice(0, 160));
await page.screenshot({ path: "/tmp/revolve-edge-axis-built.png" });

console.log(failures ? `\n${failures} FAILED` : "\nAll checks passed");
await browser.close();
process.exit(failures ? 1 : 0);
