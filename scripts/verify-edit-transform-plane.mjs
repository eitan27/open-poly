// Transform de-dup + plane edit:
//  • Transform: single-click shows NO params panel; double-click opens the
//    gizmo dialog (the one editor) — never both.
//  • Plane: double-click opens "Edit plane"; changing offset updates in place.
import { chromium } from "playwright";

const URL = process.env.URL ?? "http://localhost:5174/";
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
const row = (label) => page.locator(".tree-row", { hasText: label }).first();
const panel = page.locator(".edit-panel");
const dialog = page.locator(".extrude-dialog");

// --- Transform ---
await apply({ op: "newDocument" });
await waitIdle();
const box = await apply({ op: "addPrimitive", kind: "box", params: { width: 40, depth: 30, height: 20 } });
await waitIdle();
await apply({ op: "transform", targetId: box.id ?? box.createdId, tx: "10" });
await waitIdle();
let doc = await read({ read: "document" });
check(
  "transform feature exists",
  (doc.document ?? doc).features.some((f) => f.type === "transform"),
);

// Single-click the transform: selects, but NO params panel.
await row("Transform").click();
await page.waitForTimeout(300);
check("single-click transform shows no params panel", (await panel.count()) === 0);

// Double-click: opens the gizmo dialog (title "Transform · …"), still no params panel.
await row("Transform").dblclick();
await page.waitForTimeout(500);
const titles = await dialog.locator(".ed-title").allTextContents();
check(
  "double-click transform opens the gizmo dialog",
  titles.some((t) => t.startsWith("Transform")),
  titles.join(" | "),
);
check("no separate params panel alongside the gizmo dialog", (await panel.count()) === 0);
await page.keyboard.press("Escape");
await page.waitForTimeout(200);

// --- Plane ---
await apply({ op: "newDocument" });
await waitIdle();
const pl = await apply({ op: "addPlane", method: "offset", base: { datum: "top" }, offset: "20" });
await waitIdle();
const planeId = pl.id ?? pl.createdId;
// Datum rows also carry the kind "Plane"; target the feature plane row only.
await page.locator(".tree-row:not(.datum-row)", { hasText: "Plane" }).first().dblclick();
await page.waitForTimeout(400);
const pTitle = await dialog.locator(".ed-title").first().textContent();
check("double-click plane opens 'Edit plane'", (pTitle ?? "").includes("Edit plane"), pTitle);
const offsetInput = dialog.locator(".ed-field", { hasText: "Offset" }).locator("input");
await offsetInput.fill("45");
await dialog.locator("button", { hasText: "Done" }).first().click();
await waitIdle();
doc = await read({ read: "document" });
const planeFeat = (doc.document ?? doc).features.find((f) => f.id === planeId);
check("editing plane offset updates in place", planeFeat.offset === "45", planeFeat.offset);
check(
  "still one plane (not duplicated)",
  (doc.document ?? doc).features.filter((f) => f.type === "plane").length === 1,
);

await browser.close();
console.log(failures ? `\n${failures} FAILURE(S)` : "\nAll checks passed");
process.exit(failures ? 1 : 0);
