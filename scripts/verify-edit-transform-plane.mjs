// Transform de-dup + plane edit:
//  • Transform: single-click shows NO params panel; double-click opens the
//    gizmo dialog (the one editor) — never both.
//  • Plane: double-click opens "Edit plane"; changing offset updates in place.
import { checker, launch, openPoly } from "./lib/harness.mjs";

const { page, close } = await launch({ deviceScaleFactor: 2, collectErrors: false });
const op = openPoly(page);
const { check, done } = checker();
const { apply, read, waitIdle } = op;
await waitIdle();
const row = (label) => page.locator(".tree-row", { hasText: label }).first();
const panel = page.locator(".edit-panel");
const dialog = page.locator(".feature-dialog");

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

await close();
done();
