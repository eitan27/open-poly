// Four one-off UI fixes, checked in the real app:
//  1. the shortcut-hint toggle reads "Keyboard shortcuts" with a "?" key cap,
//     not a bare "?" glyph;
//  2. the Transform panel opens clear of the gizmo it drives;
//  3. the modelling toolbar's overflow button is "…" and is always on the bar;
//  4. the sketch groups' ▸ arrows (rectangle / circle / pattern) and the
//     constraint ▸ arrow open their flyouts — the column used to clip them away.
import { launch, openPoly } from "./lib/harness.mjs";

const { page, close } = await launch({ deviceScaleFactor: 2, collectErrors: false, width: 1500, height: 900 });
const { waitIdle, apply } = openPoly(page);

await waitIdle();

let failures = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}: ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};
const box = (sel) =>
  page.evaluate((s) => {
    const e = document.querySelector(s);
    if (!e) return null;
    const b = e.getBoundingClientRect();
    return { l: Math.round(b.left), r: Math.round(b.right), t: Math.round(b.top), b: Math.round(b.bottom) };
  }, sel);

// --- 1. the keyboard-shortcuts toggle ----------------------------------------
console.log("\n=== 1. keyboard-shortcuts toggle");
const scBtn = page.locator(".topbar-chrome .shortcuts-btn");
check("the toggle is labelled, not a bare glyph", (await scBtn.textContent())?.trim() === "Keyboard shortcuts?");
check(
  "…with the '?' drawn as a key cap, like every other shortcut",
  (await scBtn.locator(".kbd-hint").textContent())?.trim() === "?",
);
const scGeom = await scBtn.evaluate((el) => ({
  w: Math.round(el.getBoundingClientRect().width),
  clipped: el.scrollWidth > el.clientWidth + 0.5,
}));
check("the label isn't clipped by .tool-btn's 28px square", !scGeom.clipped, `${scGeom.w}px wide`);
await scBtn.click();
await page.waitForTimeout(200);
check("it still toggles the hints on", (await page.locator(".model-toolbar .kbd-hint").count()) > 0);
await scBtn.click();
await page.waitForTimeout(200);

// --- 3. the modelling toolbar's "…" -------------------------------------------
console.log('\n=== 3. the modelling toolbar\'s "…" button');
const modelMore = ".model-toolbar > .tb-more > .tb-more-btn";
for (const width of [1500, 1100, 800]) {
  await page.setViewportSize({ width, height: 900 });
  await page.waitForTimeout(400);
  const label = (await page.locator(modelMore).textContent())?.trim();
  const bar = await page.$$eval(".model-toolbar > button, .model-toolbar > .mt-dropdown > button", (bs) => bs.length);
  check(
    `the button is on the bar at ${width}px (${bar} tools beside it)`,
    (await page.locator(modelMore).count()) === 1,
  );
  // A magnifier since 324d70e, not the old "…" glyph: it opens a SEARCH box.
  // Assert the thing that has to be true for a user — an icon and a usable
  // title — rather than the text it no longer has.
  const title = await page.locator(modelMore).getAttribute("title");
  check(
    `…a magnifier with a descriptive title at ${width}px`,
    (await page.locator(`${modelMore} svg`).count()) === 1 && /search all tools/i.test(title ?? ""),
    `svg=${await page.locator(`${modelMore} svg`).count()} title="${title}" text="${label}"`,
  );
}
await page.setViewportSize({ width: 1500, height: 900 });
await page.waitForTimeout(400);
// It stays inside the bar rather than pushing it past the window.
const fits = await page.evaluate(() => {
  const bar = document.querySelector(".model-toolbar").getBoundingClientRect();
  const wrap = document.querySelector(".model-toolbar-wrap").getBoundingClientRect();
  return { bar: Math.round(bar.width), wrap: Math.round(wrap.width), ok: bar.width <= wrap.width + 0.5 };
});
check("the bar still fits its wrapper with nothing hidden", fits.ok, `${fits.bar}px of ${fits.wrap}px`);
await page.click(modelMore);
await page.waitForTimeout(250);
const rows = await page.$$eval(".tb-more-menu .tb-more-list button", (bs) => bs.length);
check("clicking it with nothing hidden opens a search over every tool", rows > 5, `${rows} rows`);
await page.keyboard.press("Escape");
await page.waitForTimeout(200);

// --- 4. the sketch group / constraint ▸ arrows --------------------------------
console.log("\n=== 4. sketch ▸ arrows");
await apply({ op: "newDocument" });
await waitIdle();
await apply({ op: "addSketch", plane: { datum: "top" }, entities: [{ shape: "line", a: [0, 0], b: [30, 0] }] });
await waitIdle();
await page.locator(".tree-row", { hasText: "Sketch" }).first().dblclick();
await page.waitForTimeout(500);

const arrows = await page.$$eval(".sketch-group .sketch-group-arrow", (bs) => bs.length);
check("all four tool groups (rectangle / circle / trim / pattern) show an arrow", arrows === 4, `${arrows}`);

// Patterning is one idea: the sketch group's primary wears the same glyph as
// the solids toolbar's Pattern button.
const patternIcons = await page.evaluate(() => {
  // Find the pattern group by its primary's title, not by index: trim/extend
  // joined the row after this was written and took slot [2].
  const groups = [...document.querySelectorAll(".sketch-group")];
  const sketch = groups
    .map((g) => g.querySelector(".sketch-group-primary"))
    .find((b) => /pattern/i.test(b?.getAttribute("title") ?? ""));
  const solids = [...document.querySelectorAll(".model-toolbar button")].find((b) =>
    /^Pattern \(X\)/.test(b.title ?? ""),
  );
  return { sketch: sketch?.firstChild?.textContent?.trim(), solids: solids?.textContent?.trim().split(" ")[0] };
});
check(
  "the sketch pattern button wears the solids Pattern icon",
  patternIcons.sketch === patternIcons.solids && !!patternIcons.sketch,
  `sketch "${patternIcons.sketch}" vs solids "${patternIcons.solids}"`,
);

const groupTotal = await page.locator(".sketch-group .sketch-group-arrow").count();
for (let i = 0; i < groupTotal; i++) {
  const arrow = page.locator(".sketch-group .sketch-group-arrow").nth(i);
  await arrow.click();
  await page.waitForTimeout(200);
  const flyout = await box(".sketch-flyout");
  const col = await box(".sketch-toolbar");
  const painted = await page.evaluate(() => {
    const e = document.querySelector(".sketch-flyout");
    if (!e) return null;
    const b = e.getBoundingClientRect();
    // What the user actually sees at the flyout's own centre: if the column's
    // box clipped it, the hit test lands on something else entirely.
    const hit = document.elementFromPoint(b.left + b.width / 2, b.top + 20);
    return { w: Math.round(b.width), h: Math.round(b.height), hit: hit?.closest(".sketch-flyout") !== null };
  });
  check(`group ${i}: the ▸ arrow opens its variant flyout`, flyout !== null);
  check(
    `group ${i}: the flyout is beside the column and actually on screen`,
    flyout && col && flyout.l >= col.r && painted?.hit && painted.w > 40,
    flyout
      ? `flyout ${flyout.l}→${flyout.r}, column right ${col.r}, ${painted?.w}×${painted?.h}, hit ${painted?.hit}`
      : "no flyout",
  );
  // Picking a variant closes the flyout and selects that tool.
  const variant = page.locator(".sketch-flyout button").nth(1);
  const title = await variant.getAttribute("title");
  await variant.click();
  await page.waitForTimeout(250);
  const active = await page.$$eval(".sketch-toolbar button.active", (bs) => bs.map((b) => b.title));
  check(
    `group ${i}: picking a variant selects it and closes the flyout`,
    (await page.locator(".sketch-flyout").count()) === 0 && active.includes(title),
    `${title} | active: ${active.join(", ")}`,
  );
}

const consArrow = page.locator(".constraint-group .constraint-arrow");
await consArrow.click();
await page.waitForTimeout(200);
const cf = await box(".constraint-flyout");
const col = await box(".sketch-toolbar");
const cfPaint = await page.evaluate(() => {
  const e = document.querySelector(".constraint-flyout");
  if (!e) return null;
  const b = e.getBoundingClientRect();
  const hit = document.elementFromPoint(b.left + b.width / 2, b.top + 20);
  return {
    w: Math.round(b.width),
    rows: e.querySelectorAll("button").length,
    hit: hit?.closest(".constraint-flyout") !== null,
  };
});
check("the constraint ▸ arrow opens its flyout", cf !== null);
check(
  "…beside the column and actually on screen",
  cf && cf.l >= col.r && cfPaint?.hit,
  cf ? `flyout ${cf.l}→${cf.r}, column right ${col.r}, hit ${cfPaint?.hit}` : "no flyout",
);
check("…listing every geometric constraint", cfPaint?.rows === 7, `${cfPaint?.rows} rows`);
await page.screenshot({ path: "/tmp/openshape-sketch-arrows.png" });
await page.keyboard.press("Escape");
await page.waitForTimeout(200);
await page
  .locator(".sketch-banner button", { hasText: "Finish sketch" })
  .first()
  .click({ timeout: 3000 })
  .catch(() => {});
await page.waitForTimeout(400);

// --- 2. the Transform panel vs. its gizmo ------------------------------------
console.log("\n=== 2. the Transform panel clears the gizmo");
await apply({ op: "newDocument" });
await waitIdle();
const made = await apply({ op: "addPrimitive", kind: "box" });
await waitIdle();
await apply({ op: "select", refs: [{ kind: "feature", id: made.createdId }] });
await page.waitForTimeout(300);
await page.locator(".model-toolbar button[title^='Transform']").first().click();
await page.waitForTimeout(800);
const panel = await box(".feature-dialog");
check("the Transform panel opened", panel !== null);
if (panel) {
  const g = await page.evaluate(() => {
    // The gizmo is drawn at the body's pivot; its arms reach a good fraction of
    // the viewport height, so the panel must clear a disc, not just a point.
    const main = document.querySelector("main.viewport").getBoundingClientRect();
    return {
      cx: main.left + main.width / 2,
      cy: main.top + main.height / 2,
      h: main.height,
      w: main.width,
      l: main.left,
    };
  });
  const clearance = Math.min(Math.abs(g.cx - panel.r), Math.abs(panel.l - g.cx));
  check(
    "the panel does not sit on the gizmo at the middle of the view",
    panel.r < g.cx - 0.2 * g.h || panel.l > g.cx + 0.2 * g.h,
    `panel ${panel.l}→${panel.r}, gizmo centre ${Math.round(g.cx)}, clearance ${Math.round(clearance)}px of ${Math.round(0.2 * g.h)} needed`,
  );
  check(
    "…and stays fully inside the viewport",
    panel.l >= g.l && panel.r <= g.l + g.w,
    `panel ${panel.l}→${panel.r} in ${Math.round(g.l)}→${Math.round(g.l + g.w)}`,
  );
  check(
    "…still titled as the Transform panel",
    /Transform/.test(await page.locator(".ed-title").first().textContent()),
  );
}
await page.screenshot({ path: "/tmp/openshape-transform-panel.png" });

console.log(failures === 0 ? "\n=== ALL CHECKS PASSED ===" : `\n=== ${failures} CHECK(S) FAILED ===`);
await close();
process.exit(failures === 0 ? 0 : 1);
