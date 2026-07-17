// End-to-end verification of the FACETED-EXTRUDED-CIRCLE diameter readout.
//
// This OCCT WASM build can't boolean a true cylinder (see BACKLOG), so an
// extruded sketch circle is a POLYGONAL prism — its radius is nowhere in the
// mesh. Instead, measure.ts traces a face named "{extrudeId}/start|end|side{n}"
// back to the source sketch circle and reads its radius. The key property to
// prove is that it's RE-DERIVED every regen: change the driving variable and the
// diameter must follow, with no stored/stale metadata.
import { chromium } from "playwright";

const URL = process.env.URL ?? "http://localhost:5173/";
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1660, height: 920 }, deviceScaleFactor: 2 });
const page = await context.newPage();
page.on("pageerror", (e) => console.log(`[pageerror] ${e.message}`));
await page.goto(URL, { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => window.__openpoly, null, { timeout: 30000 });
const waitIdle = async () => {
  let stable = 0;
  for (let i = 0; i < 80; i++) {
    const s = (await page.locator(".status").textContent())?.trim() ?? "";
    stable = /up to date/i.test(s) ? stable + 1 : 0;
    if (stable >= 3) return;
    await page.waitForTimeout(300);
  }
  throw new Error("app never settled");
};
await waitIdle();

const apply = (op) => page.evaluate((o) => window.__openpoly.apply(o), op);
const read = (q) => page.evaluate((o) => window.__openpoly.read(o), q);
const summ = () => page.evaluate(() => window.__openpoly.summary());
let failures = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}: ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};
const paneRows = async () => {
  const pane = page.locator(".selection-info");
  if ((await pane.count()) === 0) return null;
  const out = {};
  for (const r of await pane.locator(".si-row").all()) {
    out[(await r.locator(".si-label").textContent()).trim()] = (await r.locator(".si-value").textContent()).trim();
  }
  return out;
};
const canvasBox = await page.locator("canvas").first().boundingBox();
const clickFace = async (world) => {
  await apply({ op: "select", refs: [] });
  const s = await page.evaluate((p) => window.__openpoly.worldToScreen(p), world);
  if (!s) return null;
  await page.mouse.click(canvasBox.x + s.x, canvasBox.y + s.y);
  await page.waitForTimeout(120);
  const sel = await read({ read: "selection" });
  return sel.length === 1 && sel[0].kind === "face" ? paneRows() : null;
};
const clickWall = async (rad, z) => {
  for (let deg = 0; deg < 360; deg += 20) {
    const t = (deg * Math.PI) / 180;
    const rows = await clickFace([rad * Math.cos(t), rad * Math.sin(t), z]);
    if (rows) return rows;
  }
  return null;
};

// ---- A circle whose radius is variable-driven, extruded into a (faceted) cylinder. ----
await apply({ op: "newDocument" });
await waitIdle();
await apply({ op: "setVariable", name: "dia", expression: 12 });
await waitIdle();
const sk = await apply({ op: "addSketch", plane: { datum: "top" }, entities: [{ shape: "circle", c: [0, 0], r: "dia/2" }] });
await waitIdle();
const rid = (await summ()).sketches.find((s) => s.id === sk.createdId).regions[0].id;
const ext = await apply({ op: "addExtrude", profile: { sketchId: sk.createdId, regionId: rid }, mode: "new", extent: "blind", distance: 10 });
check("extruded circle built", ext.ok);
await waitIdle();

// Confirm it really is faceted (many side faces), so this path — not the analytic
// classifier — is what's under test.
const faceCount = (await summ()).bodies.find((b) => b.id === ext.createdId).faces.length;
check("extruded circle is a faceted prism (many faces)", faceCount > 10, `${faceCount} faces`);

await page.evaluate(() => window.__openpoly.screenshot("iso"));
await page.waitForTimeout(300);
check("top cap → Diameter 12", (await clickFace([0, 0, 10]))?.Diameter === "12");
check("a wall facet → Diameter 12", (await clickWall(6, 5))?.Diameter === "12");

// ---- The load-bearing property: change the variable, diameter must re-derive. ----
await apply({ op: "setVariable", name: "dia", expression: 20 });
await waitIdle();
await page.evaluate(() => window.__openpoly.screenshot("iso"));
await page.waitForTimeout(300);
check("after dia 12→20, top cap → Diameter 20 (re-derived, not stale)", (await clickFace([0, 0, 10]))?.Diameter === "20");
check("after dia 12→20, wall → Diameter 20", (await clickWall(10, 5))?.Diameter === "20");

// ---- Guard: a rectangular extrude must never report a diameter. ----
await apply({ op: "newDocument" });
await waitIdle();
const sk2 = await apply({ op: "addSketch", plane: { datum: "top" }, entities: [{ shape: "rect", center: [0, 0], w: 10, h: 10 }] });
await waitIdle();
const rid2 = (await summ()).sketches.find((s) => s.id === sk2.createdId).regions[0].id;
await apply({ op: "addExtrude", profile: { sketchId: sk2.createdId, regionId: rid2 }, mode: "new", extent: "blind", distance: 5 });
await waitIdle();
await page.evaluate(() => window.__openpoly.screenshot("iso"));
await page.waitForTimeout(300);
const rectTop = await clickFace([0, 0, 5]);
check("rectangle extrude top → no diameter", rectTop !== null && rectTop.Diameter === undefined, JSON.stringify(rectTop));

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
await browser.close();
process.exit(failures === 0 ? 0 : 1);
