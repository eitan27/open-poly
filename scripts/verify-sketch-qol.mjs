// Verifies the four sketch QoL changes end-to-end against the running dev app:
//  1. Line tool ends the chain when its endpoint lands on an existing vertex.
//  2. Deleting a selected edge while editing removes only the edge, not the sketch.
//  3. All seven geometric constraints live behind one grouped button.
//  4. The ▸ arrow opens a vertical flyout of the constraint choices.
import { launch, openPoly } from "./lib/harness.mjs";

const { page, close } = await launch({ deviceScaleFactor: 2, collectErrors: false });
const { waitIdle, apply, read } = openPoly(page);
await waitIdle();

let failures = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}: ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

await apply({ op: "newDocument" });
await waitIdle();
const canvas = await page.locator("canvas").first().boundingBox();
const toScreen = (w) => page.evaluate((p) => window.__openpoly.worldToScreen(p), w);
const clickWorld = async (w) => {
  const s = await toScreen(w);
  await page.mouse.click(canvas.x + s.x, canvas.y + s.y);
  await page.waitForTimeout(140);
};
const moveWorld = async (w) => {
  const s = await toScreen(w);
  await page.mouse.move(canvas.x + s.x, canvas.y + s.y);
  await page.waitForTimeout(60);
};

// --- Start a sketch on Top and enter the line tool -------------------------
const sk = await apply({ op: "addSketch", plane: { datum: "top" }, entities: [] });
await waitIdle();
// Enter edit mode via the timeline row (double-click).
const row = page.locator("[class*=row]").filter({ hasText: "Sketch" }).first();
await row.dblclick().catch(() => {});
await page.waitForTimeout(400);
// Select the Line tool (keyboard shortcut for line).
await page.keyboard.press("l");
await page.waitForTimeout(200);

// --- 1. Draw a triangle; closing on the start vertex ends the chain --------
// Vertices of a triangle on the Top plane (z=0).
const P0 = [-20, -10, 0],
  P1 = [20, -10, 0],
  P2 = [0, 20, 0];
await clickWorld(P0); // start
await clickWorld(P1); // seg 1
await clickWorld(P2); // seg 2
await clickWorld(P0); // close onto the start vertex → should END the chain
await waitIdle();

// After closing, the chain must be ended: moving the mouse shows NO rubber-band
// preview, and a further click starts a brand-new segment rather than drawing
// from P0. Assert via entity count: a closed triangle = exactly 3 lines.
let doc = await read({ read: "document" });
let sketch = doc.features.find((f) => f.id === sk.createdId);
const lineCount = (sketch?.entities ?? []).filter((e) => e.type === "line").length;
check("closing on the start vertex yields exactly 3 lines (chain ended)", lineCount === 3, `lines: ${lineCount}`);

// Ending the chain must switch back to the Select tool (not stay on Line).
const selectActive = await page
  .locator(".sketch-toolbar button[title^='Select']")
  .evaluate((el) => el.classList.contains("active"));
check("ending the chain switches to the Select tool", selectActive);

// And Select is active, so a click on empty space clears selection rather than
// drawing — the loop stays at 3 lines.
await clickWorld([40, 40, 0]);
await page.waitForTimeout(150);
doc = await read({ read: "document" });
sketch = doc.features.find((f) => f.id === sk.createdId);
const lineCount2 = (sketch?.entities ?? []).filter((e) => e.type === "line").length;
check("a click after closing does not extend the old chain", lineCount2 === 3, `lines: ${lineCount2}`);

// --- Circle / rectangle groups use the same primary + ▸ flyout UX ----------
// (Four groups: rect, circle, trim, pattern — all share the same rendering.
// Trim/extend joined them after this check was written.)
const GROUPS = 4;
const groupCount = await page.locator(".sketch-group").count();
check("sketch-tool groups render with the new group UX", groupCount === GROUPS, `groups: ${groupCount}`);
const primaryCount = await page.locator(".sketch-group .sketch-group-primary").count();
const arrowCount = await page.locator(".sketch-group .sketch-group-arrow").count();
check(
  "each group has a primary + an arrow",
  primaryCount === GROUPS && arrowCount === GROUPS,
  `primary:${primaryCount} arrow:${arrowCount}`,
);
// Open the RECTANGLE group's flyout (first group) and confirm it's vertical,
// to the right, and lists the two rect variants by name.
const rectArrow = page.locator(".sketch-group").nth(0).locator(".sketch-group-arrow");
await rectArrow.click();
await page.waitForTimeout(200);
const rectNames = await page.locator(".sketch-group").nth(0).locator(".sketch-flyout .cf-name").allInnerTexts();
check(
  "rectangle flyout lists both variants",
  rectNames.some((n) => /2 corners/.test(n)) && rectNames.some((n) => /Center/.test(n)),
  rectNames.join(", "),
);
const rectBoxes = await page
  .locator(".sketch-group")
  .nth(0)
  .locator(".sketch-flyout button")
  .evaluateAll((els) =>
    els.map((e) => e.getBoundingClientRect()).map((r) => ({ x: Math.round(r.x), y: Math.round(r.y) })),
  );
const rectVertical = rectBoxes.every(
  (b, i) => i === 0 || (b.y > rectBoxes[i - 1].y && Math.abs(b.x - rectBoxes[0].x) < 2),
);
check("rectangle flyout is vertical", rectVertical, JSON.stringify(rectBoxes.map((b) => b.y)));
const rtoolbar = await page.locator(".sketch-toolbar").boundingBox();
const rfly = await page.locator(".sketch-group").nth(0).locator(".sketch-flyout").boundingBox();
check(
  "rectangle flyout sits to the right of the toolbar",
  rfly.x >= rtoolbar.x + rtoolbar.width - 2,
  `fly.x=${Math.round(rfly.x)} toolbar.right=${Math.round(rtoolbar.x + rtoolbar.width)}`,
);
// Picking a variant from the flyout selects that tool AND closes the flyout.
await page.locator(".sketch-group").nth(0).locator(".sketch-flyout button", { hasText: "Center" }).click();
await page.waitForTimeout(200);
const rectFlyGone = await page.locator(".sketch-group").nth(0).locator(".sketch-flyout").count();
check("picking a variant closes the flyout", rectFlyGone === 0);
const rectPrimaryActive = await page
  .locator(".sketch-group")
  .nth(0)
  .locator(".sketch-group-primary")
  .evaluate((el) => el.classList.contains("active"));
check("the rect primary is now active (rect-center selected)", rectPrimaryActive);
// Clicking the primary directly re-selects the (now rect-center) tool: still active.
await page.locator(".sketch-group").nth(0).locator(".sketch-group-primary").click();
await page.waitForTimeout(150);
const stillActive = await page
  .locator(".sketch-group")
  .nth(0)
  .locator(".sketch-group-primary")
  .evaluate((el) => el.classList.contains("active"));
check("clicking the primary selects its variant tool", stillActive);
// Circle group's arrow opens its own flyout with the circle variants.
const circleArrow = page.locator(".sketch-group").nth(1).locator(".sketch-group-arrow");
await circleArrow.click();
await page.waitForTimeout(200);
const circNames = await page.locator(".sketch-group").nth(1).locator(".sketch-flyout .cf-name").allInnerTexts();
check(
  "circle flyout lists both variants",
  circNames.some((n) => /Center \+ radius/.test(n)) && circNames.some((n) => /3 points/.test(n)),
  circNames.join(", "),
);
await circleArrow.click(); // close it before moving on
await page.waitForTimeout(150);

// --- 3 & 4. Grouped constraint button + vertical flyout --------------------
const groups = await page.locator(".constraint-group").count();
check("a single grouped constraint button exists", groups === 1, `count: ${groups}`);
// The primary defaults to Parallel.
const defaultTitle = await page.locator(".constraint-primary").getAttribute("title");
check("primary defaults to Parallel", /Parallel/.test(defaultTitle ?? ""), defaultTitle ?? "");
// Before opening, only the primary is visible (no standalone H/V/∥ buttons).
const flyoutBefore = await page.locator(".constraint-flyout").count();
check("flyout is closed initially", flyoutBefore === 0);
// Click the ▸ arrow → vertical flyout with all 7 choices.
await page.locator(".constraint-group .constraint-arrow").click();
await page.waitForTimeout(200);
const flyoutBtns = await page.locator(".constraint-flyout button").count();
check("▸ opens a flyout listing all 7 geometric constraints", flyoutBtns === 7, `buttons: ${flyoutBtns}`);
const names = await page.locator(".constraint-flyout .cf-name").allInnerTexts();
check(
  "flyout names cover Horizontal…Tangent",
  ["Horizontal", "Vertical", "Parallel", "Perpendicular", "Equal", "Coincident", "Tangent"].every((n) =>
    names.includes(n),
  ),
  names.join(", "),
);
// Flyout is vertical: its buttons stack (each below the previous).
const boxes = await page
  .locator(".constraint-flyout button")
  .evaluateAll((els) =>
    els.map((e) => e.getBoundingClientRect()).map((r) => ({ x: Math.round(r.x), y: Math.round(r.y) })),
  );
const vertical = boxes.every((b, i) => i === 0 || (b.y > boxes[i - 1].y && Math.abs(b.x - boxes[0].x) < 2));
check("flyout is laid out vertically", vertical, JSON.stringify(boxes.map((b) => b.y)));
// And it sits to the RIGHT of the toolbar column.
const toolbarBox = await page.locator(".sketch-toolbar").boundingBox();
const flyoutBox = await page.locator(".constraint-flyout").boundingBox();
check(
  "flyout sits to the right of the sketch tools",
  flyoutBox.x >= toolbarBox.x + toolbarBox.width - 2,
  `flyout.x=${Math.round(flyoutBox.x)} toolbar.right=${Math.round(toolbarBox.x + toolbarBox.width)}`,
);

// --- Pick a constraint from the flyout and confirm it applies --------------
// Close the flyout (toggle the arrow — Escape would exit the sketch), then
// select one line deterministically via the bridge so the flyout has a valid
// target, and apply Horizontal from the flyout.
await page.locator(".constraint-group .constraint-arrow").click();
await page.waitForTimeout(150);
doc = await read({ read: "document" });
sketch = doc.features.find((f) => f.id === sk.createdId);
const lines = (sketch?.entities ?? []).filter((e) => e.type === "line");
// The base edge P0–P1 (both endpoints near y=-10) — apply Horizontal to it.
const base = lines.find((e) => Math.abs(e.a[1] - e.b[1]) < 0.01 && Math.abs(e.a[1] + 10) < 2) ?? lines[0];
await apply({ op: "select", refs: [{ kind: "sketchEntity", sketchId: sk.createdId, entityId: base.id }] });
await page.waitForTimeout(150);
const sel0 = await read({ read: "selection" });
check(
  "selected a base line via the bridge",
  sel0.some((s) => s.kind === "sketchEntity" && s.entityId === base.id),
  JSON.stringify(sel0),
);

// Open flyout — Horizontal must now be ENABLED (one line selected) — and click it.
await page.locator(".constraint-group .constraint-arrow").click();
await page.waitForTimeout(150);
const horizDisabled = await page.locator(".constraint-flyout button", { hasText: "Horizontal" }).isDisabled();
check("Horizontal is enabled in the flyout with a line selected", !horizDisabled);
await page.locator(".constraint-flyout button", { hasText: "Horizontal" }).click();
await waitIdle();
doc = await read({ read: "document" });
sketch = doc.features.find((f) => f.id === sk.createdId);
const hasHoriz = (sketch?.constraints ?? []).some((c) => c.type === "horizontal");
check(
  "applying Horizontal from the flyout adds the constraint",
  hasHoriz,
  JSON.stringify((sketch?.constraints ?? []).map((c) => c.type)),
);
// The primary button now shows the last-used choice (Horizontal) — its title.
const primaryTitle = await page.locator(".constraint-primary").getAttribute("title");
check(
  "primary now reflects the last-used constraint (Horizontal)",
  /Horizontal/.test(primaryTitle ?? ""),
  primaryTitle ?? "",
);

// --- 2. Delete a selected edge while editing removes only the edge ---------
// Reproduce the real accumulated state: entering edit selects the whole-sketch
// FEATURE, then an edge pick adds a sketchEntity on top. With both selected,
// Delete must remove only the edge — the fix protects the sketch being edited.
const remaining = (sketch?.entities ?? []).filter((e) => e.type === "line");
const victim = remaining.find((e) => e.id !== base.id) ?? remaining[0];
await apply({
  op: "select",
  refs: [
    { kind: "feature", id: sk.createdId },
    { kind: "sketchEntity", sketchId: sk.createdId, entityId: victim.id },
  ],
});
await page.waitForTimeout(150);
let sel = await read({ read: "selection" });
check(
  "selection holds both the sketch feature and an edge (the buggy state)",
  sel.some((s) => s.kind === "feature") && sel.some((s) => s.kind === "sketchEntity"),
  JSON.stringify(sel),
);
// Give the canvas focus so the Delete keydown lands on the app handler.
await page.mouse.move(canvas.x + 200, canvas.y + 200);
await page.keyboard.press("Delete");
await waitIdle();
doc = await read({ read: "document" });
sketch = doc.features.find((f) => f.id === sk.createdId);
check("sketch still exists after deleting an edge", !!sketch, `sketch present: ${!!sketch}`);
const linesAfterDel = (sketch?.entities ?? []).filter((e) => e.type === "line").length;
check("only the one edge was deleted (3 → 2 lines)", linesAfterDel === 2, `lines: ${linesAfterDel}`);

await page.screenshot({ path: "/tmp/verify-sketch-qol.png" });
console.log(failures === 0 ? "=== ALL CHECKS PASSED ===" : `=== ${failures} CHECK(S) FAILED ===`);
console.log("screenshot: /tmp/verify-sketch-qol.png");
await close();
process.exit(failures === 0 ? 0 : 1);
