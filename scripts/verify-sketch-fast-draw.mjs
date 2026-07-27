// Regression harness for the drawing race: sketch commits solve asynchronously,
// so a click landing before the previous solve returned used to build on a stale
// document and silently drop the earlier segment. Draws chains far faster than
// the solver round-trip and checks nothing is lost.
import { chromium } from "playwright";

const URL = process.env.URL ?? "http://localhost:5173/";
const GAP = Number(process.env.GAP ?? 30); // ms between clicks — well under a solve
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
};
await waitIdle();
const apply = (op) => page.evaluate((o) => window.__openpoly.apply(o), op);
const read = (q) => page.evaluate((o) => window.__openpoly.read(o), q);

let failures = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}: ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

await apply({ op: "newDocument" });
await waitIdle();
const canvas = await page.locator("canvas").first().boundingBox();
const sk = await apply({ op: "addSketch", plane: { datum: "top" }, entities: [] });
await waitIdle();
await page.locator("[class*=row]").filter({ hasText: "Sketch" }).first().dblclick().catch(() => {});
await page.waitForTimeout(400);

const clickFast = async (w) => {
  const s = await page.evaluate((p) => window.__openpoly.worldToScreen(p), w);
  await page.mouse.click(canvas.x + s.x, canvas.y + s.y);
  await page.waitForTimeout(GAP);
};
const lines = async () => {
  const doc = await read({ read: "document" });
  const s = doc.features.find((f) => f.id === sk.createdId);
  return (s?.entities ?? []).filter((e) => e.type === "line");
};
// Two points count as the same corner once the solver has rounded them.
const near = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]) < 0.5;

// --- An open 5-segment polyline drawn at speed --------------------------------
await page.keyboard.press("l");
await page.waitForTimeout(150);
const P = [[-40, -20], [-20, -20], [0, -5], [20, -20], [40, -20], [50, 5]];
for (const [x, y] of P) await clickFast([x, y, 0]);
await page.keyboard.press("Escape"); // end the chain
await waitIdle();
let got = await lines();
check(`a 5-segment chain clicked ${GAP}ms apart keeps every segment`, got.length === 5, `lines: ${got.length}`);
const chained = got.every((l, i) => near(l.a, P[i]) && near(l.b, P[i + 1]));
check("every segment runs between the points that were clicked", chained,
  got.map((l) => `(${l.a.map((v) => v.toFixed(0))}→${l.b.map((v) => v.toFixed(0))})`).join(" "));

// --- Undo granularity: one step per drawn segment ------------------------------
const before = (await lines()).length;
await page.evaluate(() => document.activeElement?.blur());
await page.keyboard.press("Meta+z");
await waitIdle();
const afterUndo = (await lines()).length;
check("one undo removes exactly one segment (no double history entries)",
  afterUndo === before - 1, `${before} → ${afterUndo}`);
await page.keyboard.press("Meta+Shift+z");
await waitIdle();
check("redo restores it", (await lines()).length === before, `lines: ${(await lines()).length}`);

// --- A closed triangle drawn at speed still ends the chain --------------------
await apply({ op: "newDocument" });
await waitIdle();
const sk2 = await apply({ op: "addSketch", plane: { datum: "top" }, entities: [] });
await waitIdle();
await page.locator("[class*=row]").filter({ hasText: "Sketch" }).first().dblclick().catch(() => {});
await page.waitForTimeout(400);
await page.keyboard.press("l");
await page.waitForTimeout(150);
const T = [[-20, -10], [20, -10], [0, 20], [-20, -10]];
for (const [x, y] of T) await clickFast([x, y, 0]);
await waitIdle();
const doc2 = await read({ read: "document" });
const tri = (doc2.features.find((f) => f.id === sk2.createdId)?.entities ?? []).filter((e) => e.type === "line");
check("a triangle closed at speed yields 3 lines", tri.length === 3, `lines: ${tri.length}`);
const selectActive = await page.locator(".sketch-toolbar button[title^='Select']")
  .evaluate((el) => el.classList.contains("active"));
check("closing on the start vertex still ends the chain (back to Select)", selectActive);

// --- Drawing and a constraint edit composing -----------------------------------
// Deleting a constraint builds and solves its own document, so it has to commit
// through the same base+claim path as drawing or the two would clobber each
// other. NOTE: these two checks pass with or without that fix — driving both
// events inside one ~50ms solve window isn't possible over CDP (a mouse click
// plus a dispatch costs ~400ms round trip). They guard the invariant, not the
// race: draw a segment, delete a constraint, keep both.
await apply({ op: "newDocument" });
await waitIdle();
const sk3 = await apply({ op: "addSketch", plane: { datum: "top" }, entities: [] });
await waitIdle();
await page.locator("[class*=row]").filter({ hasText: "Sketch" }).first().dblclick().catch(() => {});
await page.waitForTimeout(400);
await page.keyboard.press("l");
await page.waitForTimeout(150);
// Axis-aligned segments pick up automatic horizontal/vertical constraints, so
// the panel has something to delete.
// (Away from the origin — snapping onto it would close the chain.)
for (const p of [[-30, 10], [0, 10], [0, 35]]) await clickFast([p[0], p[1], 0]);
await waitIdle();
const sketchOf = async () => {
  const d = await read({ read: "document" });
  return d.features.find((f) => f.id === sk3.createdId);
};
const s0 = await sketchOf();
const consBefore = s0.constraints.length;
const linesBefore = s0.entities.filter((e) => e.type === "line").length;
check("drawn segments carry auto H/V constraints to delete", consBefore > 0 && linesBefore === 2,
  `lines: ${linesBefore} constraints: ${consBefore}`);
// Draw one more segment and delete a constraint immediately — inside the solve.
// The ✕ is resolved and the screen point computed BEFORE the draw click, and
// the delete is dispatched with no round trip in between, so it really does
// land while the segment's solve is still running.
const delBtn = await page.locator(".cl-del").first().elementHandle();
const last = await page.evaluate((p) => window.__openpoly.worldToScreen(p), [30, 35, 0]);
await page.mouse.click(canvas.x + last.x, canvas.y + last.y);
await delBtn.dispatchEvent("click");
await waitIdle();
const s1 = await sketchOf();
const linesAfter = s1.entities.filter((e) => e.type === "line").length;
check("the segment drawn just before a constraint delete survives", linesAfter === linesBefore + 1,
  `lines: ${linesBefore} → ${linesAfter}`);
check("…and the delete survives too", s1.constraints.length < consBefore + 1,
  `constraints: ${consBefore} → ${s1.constraints.length}`);

console.log(failures === 0 ? "=== ALL CHECKS PASSED ===" : `=== ${failures} CHECK(S) FAILED ===`);
await browser.close();
process.exit(failures === 0 ? 0 : 1);
