// The passive measure panel in an assembly (MeasurePanel, selection/measure.ts
// and measurePair.ts): a base and an arm placed apart, no mate. Clicking the
// base's top face shows its area; clicking the arm's top face too measures
// between them, across the two parts, in assembly space — the true gap and the
// faces' parallel distance. Built through the agent bridge for speed; the
// picks are the UI's. NB if the local open-poly MCP hub is running, this
// headless tab connects to it and can take the bridge from your own tab;
// reload yours after.
import { chromium } from "playwright";

const URL = process.env.URL ?? "http://localhost:5173/";
const browser = await chromium.launch(process.env.PW_EXE ? { executablePath: process.env.PW_EXE } : {});
const context = await browser.newContext({ viewport: { width: 1660, height: 920 }, deviceScaleFactor: 2 });
const page = await context.newPage();
page.on("pageerror", (e) => console.log(`[pageerror] ${e.message}`));
await page.goto(URL, { waitUntil: "domcontentloaded" });

const waitIdle = async () => {
  let stable = 0;
  for (let i = 0; i < 120; i++) {
    const s = (await page.locator(".status").textContent())?.trim() ?? "";
    stable = /up to date|error/i.test(s) ? stable + 1 : 0;
    if (stable >= 3) return;
    await page.waitForTimeout(300);
  }
  throw new Error("app never settled");
};
await waitIdle();
await page.waitForFunction(() => window.__openpoly);
/** Click `target` to switch documents, then wait for the switch to land: it
 *  comes a few hundred ms after the click, while the status still reads "up
 *  to date", so without this the next step acts on the previous document. */
const switchVia = async (target) => {
  const was = await page.locator(".doc-title").inputValue();
  await target.click();
  await page.waitForFunction((t) => document.querySelector(".doc-title")?.value !== t, was, { timeout: 10000 });
  await waitIdle();
};

let failures = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}: ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};
const apply = (op) => page.evaluate((o) => window.__openpoly.apply(o), op);
const read = (q) => page.evaluate((x) => window.__openpoly.read(x), q);
const summary = () => read({ read: "sceneSummary" });

const doc0 = await read({ read: "document" });
for (const f of [...doc0.features].reverse()) await apply({ op: "delete", featureId: f.id });
await apply({ op: "renameDocument", name: "MeasureBase" });
await apply({ op: "addPrimitive", kind: "box", params: { width: "40", depth: "40", height: "10" } });
await apply({ op: "newDocument", name: "MeasureArm" });
await apply({ op: "addPrimitive", kind: "box", params: { width: "30", depth: "8", height: "4" } });
await waitIdle();
await apply({ op: "newDocument", name: "Measure test", kind: "assembly" });
await waitIdle();
const docs = await read({ read: "documents" });
const idOf = (name) => docs.find((d) => d.name === name)?.id;
await apply({ op: "insertInstance", documentId: idOf("MeasureBase") });
await apply({ op: "insertInstance", documentId: idOf("MeasureArm"), name: "Arm" });
const s = await summary();
const [base, arm] = s.instances;
const toScreen = async (p) => {
  const box = await page.locator(".viewport canvas").first().boundingBox();
  const q = await page.evaluate((x) => window.__openpoly.worldToScreen(x), p);
  return { x: box.x + q.x, y: box.y + q.y };
};
const topCentre = (b) => [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, b.max[2]];
const click = async (p) => {
  const q = await toScreen(p);
  await page.mouse.click(q.x, q.y);
  await page.waitForTimeout(400);
};
const panel = async () => {
  if ((await page.locator(".selection-info").count()) === 0) return null;
  const title = await page.locator(".selection-info .si-title").textContent();
  const rows = await page
    .locator(".selection-info .si-row")
    .evaluateAll((els) =>
      Object.fromEntries(
        els.map((e) => [e.querySelector(".si-label").textContent, e.querySelector(".si-value").textContent]),
      ),
    );
  return { title, ...rows };
};

check("nothing picked, no panel", (await panel()) === null);
await click(topCentre(base.bbox));
const one = await panel();
check("picking the base's top face shows its area", one?.title === "Face" && one.Area === "1600", JSON.stringify(one));
if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/measure-one.png` });

await click(topCentre(arm.bbox));
const two = await panel();
// The tops are 10 and 4 high; the gap between them across the parts' spans.
const gapX = Math.max(0, arm.bbox.min[0] - base.bbox.max[0], base.bbox.min[0] - arm.bbox.max[0]);
const gapY = Math.max(0, arm.bbox.min[1] - base.bbox.max[1], base.bbox.min[1] - arm.bbox.max[1]);
const expected = Math.hypot(gapX, gapY, base.bbox.max[2] - arm.bbox.max[2]);
check(
  "picking the arm's top too measures between the parts",
  two?.title === "Face ↔ Face" &&
    Math.abs(Number(two.Distance) - expected) < 1e-3 &&
    two["Parallel distance"] === String(base.bbox.max[2] - arm.bbox.max[2]),
  `${JSON.stringify(two)} — expected ${expected.toFixed(3)}`,
);
if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/measure-two.png` });

await page.keyboard.press("Escape");
await page.waitForTimeout(300);
check("Esc clears the picks and the panel", (await panel()) === null);

console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL PASS");
await browser.close();
process.exit(failures ? 1 : 0);
