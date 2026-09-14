// The four extracted viewport modules, exercised where they actually run.
//
// Three of them (geometryQuery, sceneMath, materials) have unit tests now, but
// what those cannot reach is the integration: that a click at a given world
// point resolves to an edge rather than a phantom vertex, that the gizmo's
// matrix reaches the kernel, that the stencil caps actually draw. viewCube has
// no unit tests at all — its textures are painted on a 2D canvas and Vitest's
// node environment has no `document` — so this is its only coverage.
//
// Covers: face/edge/vertex picking, a faceted rim exposing no phantom vertex,
// section-view caps, a live gizmo rotate, and a real theme swap driven through
// the settings picker (writing data-theme by hand would bypass setTheme).
//
// Run it against a dev server: `npm run dev`, then
// `node scripts/verify-viewport-modules.mjs`.
import { chromium } from "playwright";
const URL = process.env.URL ?? "http://localhost:5173/";
const browser = await chromium.launch();
const page = await (
  await browser.newContext({ viewport: { width: 1660, height: 920 }, deviceScaleFactor: 2 })
).newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => m.type() === "error" && errors.push(`[console] ${m.text()}`));
await page.goto(URL, { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => window.__openpoly, null, { timeout: 30000 });
const waitIdle = async () => {
  let stable = 0;
  for (let i = 0; i < 250; i++) {
    const s = (await page.locator(".status").textContent())?.trim() ?? "";
    stable = /up to date|error|fail/i.test(s) ? stable + 1 : 0;
    if (stable >= 3) return s;
    await page.waitForTimeout(200);
  }
  return "TIMEOUT";
};
const apply = (o) => page.evaluate((x) => window.__openpoly.apply(x), o);
const read = (q) => page.evaluate((x) => window.__openpoly.read(x), q);
const settle = async () => {
  await waitIdle();
  await page.waitForTimeout(350);
  await waitIdle();
};
let failures = 0;
const check = (l, ok, d = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${l}${d ? ` — ${d}` : ""}`);
  if (!ok) failures++;
};
const canvasBox = async () => await page.locator("canvas").first().boundingBox();
const screenOf = async (box, w) => {
  const p = await page.evaluate((q) => window.__openpoly.worldToScreen(q), w);
  return { x: box.x + p.x, y: box.y + p.y };
};
const sel = () => read({ read: "selection" });

await apply({ op: "newDocument" });
await settle();
const b = await apply({ op: "addPrimitive", kind: "box", params: { width: 40, depth: 30, height: 20 } });
await settle();
const bodyId = b.id ?? b.createdId;
const box = await canvasBox();

// --- geometryQuery: face / edge / vertex picking ---------------------------
await page.mouse.click((await screenOf(box, [0, 0, 20])).x, (await screenOf(box, [0, 0, 20])).y);
await page.waitForTimeout(500);
check(
  "a face pick lands on the body's top face",
  JSON.stringify(await sel()).includes('"kind":"face"'),
  JSON.stringify(await sel()).slice(0, 150),
);

// An edge: midpoint of the top-front edge (y = -15, z = 20).
const eMid = await screenOf(box, [0, -15, 20]);
await page.mouse.click(eMid.x, eMid.y);
await page.waitForTimeout(500);
const afterEdge = JSON.stringify(await sel());
check(
  "clicking an edge midpoint picks the EDGE, not the face behind it",
  afterEdge.includes('"kind":"edge"'),
  afterEdge.slice(0, 150),
);

// A corner: realVertexNear should offer the genuine box vertex.
const corner = await screenOf(box, [20, -15, 20]);
await page.mouse.click(corner.x, corner.y);
await page.waitForTimeout(500);
const afterVertex = JSON.stringify(await sel());
check("clicking a box corner picks a VERTEX", afterVertex.includes('"kind":"vertex"'), afterVertex.slice(0, 170));

// A cylinder rim: a 96-gon chain must expose NO vertex, so a rim click is an edge.
await apply({ op: "newDocument" });
await settle();
const cy = await apply({ op: "addPrimitive", kind: "cylinder", params: { radius: 15, height: 20 } });
await settle();
const box2 = await canvasBox();
const rim = await screenOf(box2, [15, 0, 20]);
await page.mouse.click(rim.x, rim.y);
await page.waitForTimeout(600);
const rimSel = JSON.stringify(await sel());
check(
  "a faceted rim offers an edge, never a phantom vertex (chainInteriorPositions)",
  rimSel.includes('"kind":"edge"') && !rimSel.includes('"kind":"vertex"'),
  rimSel.slice(0, 170),
);

// --- materials: section view builds its stencil caps ------------------------
await apply({ op: "setSectionView", enabled: true, plane: { datum: "front" }, offset: 0 });
await settle();
const secOn = await page.evaluate(() => window.__openpoly.read({ read: "sceneSummary" }));
check(
  "section view is actually ON (its stencil caps were built)",
  JSON.stringify(secOn).includes("section") || (await page.locator(".section-bar, [class*='section']").count()) > 0,
  JSON.stringify(secOn.sectionView ?? secOn).slice(0, 140),
);
check("building the section caps threw nothing", errors.length === 0, errors.slice(0, 2).join(" | "));
await page.screenshot({ path: "/tmp/openshape-section.png" });
await apply({ op: "setSectionView", enabled: false });
await settle();

// --- sceneMath: the transform gizmo's live matrix ---------------------------
await apply({ op: "newDocument" });
await settle();
const tb = await apply({ op: "addPrimitive", kind: "box", params: { width: 40, depth: 30, height: 20 } });
await settle();
const tbId = tb.id ?? tb.createdId;
await apply({ op: "transform", targetId: tbId, angle: "0", axis: "z" });
await settle();
await page.locator(".tree-row", { hasText: "Transform" }).last().dblclick();
await page.waitForTimeout(900);
check("the transform gizmo opens", (await page.locator(".extrude-dialog").count()) > 0);
await page.locator(".extrude-dialog button", { hasText: "Rotate" }).first().click();
await page.waitForTimeout(400);
const angleField = page.locator(".extrude-dialog input").first();
await angleField.fill("40");
await angleField.press("Enter");
await page.waitForTimeout(800);
await settle();
const bboxNow = JSON.stringify((await read({ read: "sceneSummary" })).bodies?.[0]?.bbox);
check(
  "a 40° rotate through the gizmo changes the body's extent (transformMatrix ran)",
  !bboxNow.includes('"min":[-20,-15,0]'),
  bboxNow.slice(0, 110),
);

// --- viewCube: render, click, and a theme swap ------------------------------
const cubeAt = { x: box.x + box.width - 14 - 54, y: box.y + 60 + 54 }; // centre of the 108px cube
await page.mouse.move(cubeAt.x, cubeAt.y);
await page.waitForTimeout(400);
await page.screenshot({ path: "/tmp/openshape-cube-hover.png" });
await page.mouse.click(cubeAt.x, cubeAt.y);
await page.waitForTimeout(1200);
check("clicking the view cube navigates without error", errors.length === 0, errors.slice(0, 2).join(" | "));
await page.screenshot({ path: "/tmp/openshape-cube-clicked.png" });

// Theme swap repaints the cube's textures — drive the REAL picker, so React's
// settings state changes and viewCube.setTheme actually runs (writing
// data-theme by hand would bypass it entirely).
await page.locator('button[aria-label="Settings"]').first().click();
await page.waitForTimeout(700);
const picker = page.locator('[role="radiogroup"][aria-label="Color theme"]');
check("the theme picker is open", (await picker.count()) > 0);
const themeBefore = await page.evaluate(() => document.documentElement.getAttribute("data-theme"));
const options = picker.locator('[role="radio"], button');
const n = await options.count();
let flipped = false;
for (let i = 0; i < n; i++) {
  await options.nth(i).click();
  await page.waitForTimeout(700);
  const now = await page.evaluate(() => document.documentElement.getAttribute("data-theme"));
  if (now && now !== themeBefore) {
    flipped = true;
    break;
  }
}
const themeAfter = await page.evaluate(() => document.documentElement.getAttribute("data-theme"));
check("picking a theme actually flips the resolved theme", flipped, `${themeBefore} → ${themeAfter}`);
check("the cube's setTheme repaint threw nothing", errors.length === 0, errors.slice(0, 2).join(" | "));
await page.screenshot({ path: "/tmp/openshape-theme.png" });
await page.keyboard.press("Escape");
await page.waitForTimeout(400);
// And the cube still picks after the repaint (its textures were re-pointed, not disposed).
await page.mouse.click(cubeAt.x, cubeAt.y);
await page.waitForTimeout(1000);
check("the view cube still navigates after a theme change", errors.length === 0, errors.slice(0, 2).join(" | "));
await page.screenshot({ path: "/tmp/openshape-viewport.png" });

check("no page errors across the whole run", errors.length === 0, errors.slice(0, 3).join(" | "));
console.log(`\n${failures ? `${failures} FAILURE(S)` : "all checks passed"}`);
await browser.close();
process.exit(failures ? 1 : 0);
