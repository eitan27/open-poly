// The Pattern dialog's direction/axis controls: one two-level chooser per slot,
// and a pick that lands on the FIRST click.
//
// These used to be <select>s whose last option armed a viewport pick, which is
// the shape that breaks: on macOS a select's popup is a native menu running its
// own event loop, and after choosing from it the first click on the canvas is
// swallowed — so the pick took two clicks, the first appearing to do nothing.
// (It reproduces only in a real browser; no automation, headless or headed, sees
// it. Hence this script can't assert the swallow itself — what it CAN pin down
// is that no <select> arms a pick any more, and that every flow through the new
// buttons still works.) See the Transform dialog's axis control for the story.
//
// Run: `npm run dev`, then `URL=http://localhost:5173/ node scripts/verify-pattern-refs.mjs`.
import { chromium } from "playwright";

const URL = process.env.URL ?? "http://localhost:5173/";
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const page = await (await browser.newContext({ viewport: { width: 1400, height: 900 } })).newPage();
page.on("pageerror", (e) => console.log(`[pageerror] ${e.message}`));

await page.goto(URL, { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => window.__openpoly, null, { timeout: 30000 });
const waitIdle = async () => {
  let stable = 0;
  for (let i = 0; i < 200; i++) {
    const s = (await page.locator(".status").textContent())?.trim() ?? "";
    stable = /up to date|error/i.test(s) ? stable + 1 : 0;
    if (stable >= 3) return;
    await page.waitForTimeout(300);
  }
  throw new Error("app never settled");
};
await waitIdle();

const apply = (op) => page.evaluate((o) => window.__openpoly.apply(o), op);
const read = (q) => page.evaluate((o) => window.__openpoly.read(o), q);

let failures = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}: ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

// A sketch line to pick as a direction, well clear of the body.
const lineSketch = await apply({
  op: "addSketch",
  plane: { datum: "top" },
  entities: [{ shape: "line", a: [-40, 40], b: [40, 40] }],
  name: "Dir",
});
await waitIdle();

const scene = await read({ read: "sceneSummary" });
const box = scene.bodies[0];
await apply({ op: "select", refs: [{ kind: "feature", id: box.id }] });
await page.waitForTimeout(300);
await page.keyboard.press("x"); // Pattern
const dialog = page.locator(".feature-dialog");
await dialog.waitFor({ state: "visible", timeout: 5000 });

// --- 1. Linear direction: a two-level chooser, no dropdown ----------------
check("no <select> arms a pick in the Pattern dialog", (await dialog.locator("select").count()) === 0);
const kindRow = dialog.locator(".ed-modes").nth(1);
check(
  "the direction offers its two kinds as buttons",
  (await kindRow.locator("button").allTextContents()).join("/") === "World axis/Sketch line",
  (await kindRow.locator("button").allTextContents()).join("/"),
);
const alongRow = dialog.locator(".ed-modes").nth(2);
check("…starting on a world axis, with X/Y/Z shown", await alongRow.isVisible());
check("…and no pick slot competing with them", (await dialog.locator(".ed-pick-btn").count()) === 0);
await alongRow.getByRole("button", { name: "Y" }).click();
await page.waitForTimeout(300);
check(
  "choosing Y takes effect",
  ((await alongRow.locator("button.active").textContent()) ?? "") === "Y",
  (await alongRow.locator("button.active").textContent()) ?? "",
);

// --- 2. Switching to a picked line arms, and the pick lands in ONE click ---
await kindRow.getByRole("button", { name: "Sketch line" }).click();
await page.waitForTimeout(400);
check("switching to a sketch line arms the slot", (await dialog.locator(".ed-pick-btn.active").count()) === 1);
check("…puts X/Y/Z away", (await dialog.locator(".ed-modes").count()) === 2);
check(
  "…and leaves nothing in the dialog holding focus",
  (await page.evaluate(() => document.activeElement?.tagName)) === "BODY",
  await page.evaluate(() => document.activeElement?.tagName),
);
// Move the dialog clear, then click the sketch line — once. NB the Body slot is
// itself a filled row, so "the direction filled" means one row MORE than now.
const filledRows = () => dialog.locator(".bool-operand-row").count();
const rowsBefore = await filledRows();
const hb = await dialog.locator("[data-drag-handle]").first().boundingBox();
await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
await page.mouse.down();
await page.mouse.move(1160, 790, { steps: 8 });
await page.mouse.up();
await page.waitForTimeout(200);
// The line sits off the body's right in the default iso view; sweep along it so
// the test doesn't hang on one hard-coded pixel.
let picked = null;
for (const [x, y] of [
  [1070, 425],
  [1040, 410],
  [1100, 442],
  [1010, 395],
  [1130, 456],
  [1070, 428],
  [1070, 422],
]) {
  await page.mouse.move(x, y);
  await page.waitForTimeout(80);
  await page.mouse.down();
  await page.mouse.up();
  await page.waitForTimeout(400);
  if ((await filledRows()) > rowsBefore) {
    picked = `${x},${y}`;
    break;
  }
}
check("one click on the sketch line fills the direction slot", picked !== null, picked ?? "never hit the line");
if (picked) {
  check(
    "…showing which line it is",
    /line/i.test((await dialog.locator(".bool-operand-row").last().textContent()) ?? ""),
    (await dialog.locator(".bool-operand-row").last().textContent()) ?? "",
  );
}

// --- 3. Back to a world axis clears the picked one ------------------------
await kindRow.getByRole("button", { name: "World axis" }).click();
await page.waitForTimeout(400);
check("going back to a world axis clears the picked line", (await filledRows()) === rowsBefore);
check("…and brings X/Y/Z back", await dialog.locator(".ed-modes").nth(2).isVisible());

// --- 4. The pattern still builds -----------------------------------------
await dialog.getByRole("button", { name: "Create" }).click();
await waitIdle();
const after = await read({ read: "sceneSummary" });
const pat = (await read({ read: "document" })).features.filter((f) => f.type === "pattern").at(-1);
check("the pattern was created", Boolean(pat), JSON.stringify(pat?.dir1));
check("…on a world direction", pat?.dir1?.world !== undefined, JSON.stringify(pat?.dir1));
check("no feature errored", Object.keys(after.errors ?? {}).length === 0, JSON.stringify(after.errors));

// --- 5. The circular axis got the same treatment --------------------------
await apply({ op: "select", refs: [{ kind: "feature", id: box.id }] });
await page.waitForTimeout(300);
await page.keyboard.press("x");
await dialog.waitFor({ state: "visible", timeout: 5000 });
await dialog.locator(".ed-modes").nth(0).getByRole("button", { name: "Circular" }).click();
await page.waitForTimeout(500);
check("the circular axis is buttons too", (await dialog.locator("select").count()) === 0);
check(
  "…offering a world axis or a picked line/face",
  (await dialog.locator(".ed-modes").nth(1).locator("button").allTextContents()).join("/") ===
    "World axis/Line or face",
  (await dialog.locator(".ed-modes").nth(1).locator("button").allTextContents()).join("/"),
);
check("…with the sketch still available to pick", Boolean(lineSketch.createdId));

console.log(failures === 0 ? "=== ALL CHECKS PASSED ===" : `=== ${failures} CHECK(S) FAILED ===`);
await browser.close();
process.exit(failures === 0 ? 0 : 1);
