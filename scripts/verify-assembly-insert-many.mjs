// Assemblies: several instances at once. The Insert dialog's count places
// four bolts in one go, in a grid (none overlapping, all selected after); an
// instance row's ⧉ asks how many copies and puts them beside the original —
// or past everything when that spot is taken — not grounded. The parts are
// made through the agent bridge for speed; the inserting is the UI's. NB if
// the local open-poly MCP hub is running, this headless tab connects to it
// and can take the bridge from your own tab; reload yours after.
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
await apply({ op: "renameDocument", name: "ManyBase" });
await apply({ op: "addPrimitive", kind: "box", params: { width: "40", depth: "40", height: "10" } });
await apply({ op: "newDocument", name: "ManyBolt" });
await apply({ op: "addPrimitive", kind: "cylinder", params: { radius: 3, height: 20 } });
await waitIdle();
await apply({ op: "newDocument", name: "Insert many", kind: "assembly" });
await waitIdle();

const insert = async (docName, count) => {
  await page.locator(".asm-insert").click();
  await page.locator(".insert-doc", { hasText: docName }).click();
  await page.locator(".insert-confirm").waitFor({ timeout: 30000 });
  if (count !== 1) await page.locator("input.insert-count").first().fill(String(count));
  const label = await page.locator(".insert-confirm").textContent();
  if (process.env.SHOTS && count !== 1) await page.screenshot({ path: `${process.env.SHOTS}/insert-count.png` });
  await page.locator(".insert-confirm").click();
  await page.waitForTimeout(800);
  return label;
};
const overlapping = (list) => {
  for (let i = 0; i < list.length; i++)
    for (let j = i + 1; j < list.length; j++) {
      const [p, q] = [list[i].bbox, list[j].bbox];
      if ([0, 1, 2].every((k) => p.min[k] < q.max[k] - 1e-6 && q.min[k] < p.max[k] - 1e-6)) return [i, j];
    }
  return null;
};

await insert("ManyBase", 1);
const label = await insert("ManyBolt", 4);
check("the count reads into the button", label.trim() === "Insert 4 instances", label);
let s = await summary();
const bolts = s.instances.slice(1);
check("four bolts are inserted in one go", s.instances.length === 5 && bolts.every((b) => b.part === bolts[0].part));
check(
  "…none overlapping each other or the base",
  overlapping(s.instances) === null,
  JSON.stringify(overlapping(s.instances)),
);
check("…and all four selected", (await page.locator(".asm-row.selected").count()) === 4);
check("…only the first instance of the assembly grounded", s.instances.filter((i) => i.grounded).length === 1);

// --- Duplicate the base twice -----------------------------------------------------------
await page.locator(".asm-row").nth(0).locator(".asm-duplicate-btn").click();
await page.locator(".asm-duplicate").waitFor();
check(
  "⧉ asks how many copies of it",
  (await page.locator(".asm-duplicate .report-header").textContent()).includes("Duplicate Box 1 <1>"),
);
await page.locator(".asm-duplicate-count").fill("2");
await page.locator(".asm-duplicate-count").press("Enter");
await page.waitForTimeout(800);
s = await summary();
const copies = s.instances.slice(5);
check(
  "Duplicate makes two copies of the base",
  copies.length === 2 && copies.every((c) => c.part === s.instances[0].part),
);
check(
  "…not grounded",
  copies.every((c) => !c.grounded),
);
check("…clear of everything", overlapping(s.instances) === null, JSON.stringify(overlapping(s.instances)));
check("…and selected", (await page.locator(".asm-row.selected").count()) === 2);
if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/insert-many.png` });

// Undo takes the copies back in one step.
await page
  .locator(".viewport canvas")
  .first()
  .hover({ position: { x: 5, y: 5 } });
await page.keyboard.press("Control+z");
await page.waitForTimeout(500);
check("Ctrl+Z takes the duplicate back in one step", (await summary()).instances.length === 5);

console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL PASS");
await browser.close();
process.exit(failures ? 1 : 0);
