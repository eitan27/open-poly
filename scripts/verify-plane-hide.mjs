// The timeline eye on a reference plane must HIDE it (view-only), not suppress
// it: suppressing dropped the plane from the resolved frames, so every sketch
// on it threw out of render and the whole app went blank.
import { chromium } from "playwright";

const URL = process.env.URL ?? "http://localhost:5173/";
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1660, height: 920 }, deviceScaleFactor: 2 });
const page = await context.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
await page.goto(URL, { waitUntil: "domcontentloaded" });

const waitIdle = async () => {
  let stable = 0;
  for (let i = 0; i < 100; i++) {
    const s = (await page.locator(".status").textContent())?.trim() ?? "";
    stable = /up to date|error/i.test(s) ? stable + 1 : 0;
    if (stable >= 3) return;
    await page.waitForTimeout(300);
  }
  throw new Error("app never settled");
};
await waitIdle();
await page.waitForFunction(() => window.__openpoly);

const apply = (op) => page.evaluate((o) => window.__openpoly.apply(o), op);
const doc = () => page.evaluate(() => window.__openpoly.read({ read: "document" }));

let failures = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}: ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

// A fresh document: plane 20 above Top, a circle sketched ON that plane, extruded.
await apply({ op: "newDocument", name: "PlaneHide" });
await waitIdle();
const rp = await apply({ op: "addPlane", method: "offset", base: { datum: "top" }, offset: "20" });
check("addPlane", rp.ok === true, JSON.stringify(rp));
const rs = await apply({
  op: "addSketch",
  plane: { planeId: rp.createdId },
  entities: [{ shape: "circle", c: [0, 0], r: 10 }],
});
check("addSketch on that plane", rs.ok === true, JSON.stringify(rs));
const re = await apply({
  op: "addExtrude",
  profile: { sketchId: rs.createdId },
  distance: "15",
});
check("addExtrude from it", re.ok === true, JSON.stringify(re));
await waitIdle();

const planeRow = page.locator(".tree-row", { hasText: "Plane 1" }).first();
// row buttons: ▲ ▼ eye ✕ — the eye is the third
const eye = planeRow.locator(".row-icon").nth(2);
check(
  "plane row has an eye titled Hide",
  (await eye.getAttribute("title")) === "Hide",
  await eye.getAttribute("title"),
);

const rowsBefore = await page.locator(".tree-row").count();
const canvasBefore = await page.locator("canvas").count();
await eye.click();
await page.waitForTimeout(1200);

check("app still rendered (rows)", (await page.locator(".tree-row").count()) === rowsBefore);
check("canvas still mounted", (await page.locator("canvas").count()) === canvasBefore);
check("no page errors", errors.length === 0, errors.join(" | "));
check("eye now reads Show", (await eye.getAttribute("title")) === "Show", await eye.getAttribute("title"));

const d1 = await doc();
const plane1 = d1.features.find((f) => f.type === "plane");
check("plane stays in the model (not suppressed)", plane1?.suppressed === false, JSON.stringify(plane1?.suppressed));
check("plane is flagged hidden", plane1?.hidden === true, String(plane1?.hidden));
check(
  "sketch on it survives",
  d1.features.some((f) => f.type === "sketch"),
  "",
);
check("timeline shows no error badge", (await page.locator(".tree-row .row-badge").count()) === 0);
await page.screenshot({ path: process.env.SHOT ?? "/tmp/openshape-plane-hidden.png" });

await eye.click();
await page.waitForTimeout(800);
const d2 = await doc();
check("toggles back to visible", d2.features.find((f) => f.type === "plane")?.hidden === false);
check("still no page errors", errors.length === 0, errors.join(" | "));

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
await browser.close();
process.exit(failures === 0 ? 0 : 1);
