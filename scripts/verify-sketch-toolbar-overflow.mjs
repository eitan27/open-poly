// The sketch toolbar is a vertical column, so it overflows the BOTTOM of a
// short window. Checks that the tools which don't fit collapse into the "More"
// flyout, that the column ends cleanly above the window edge, that the flyout
// opens beside the column (not over it, and not clipped by it), and that its
// search reaches every tool — grouped variants and the seven constraints
// included.
import { chromium } from "playwright";

const URL = process.env.URL ?? "http://localhost:5173/";
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1400, height: 900 }, deviceScaleFactor: 2 });
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

let failures = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}: ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

await apply({ op: "newDocument" });
await waitIdle();
await apply({ op: "addSketch", plane: { datum: "top" }, entities: [{ shape: "line", a: [0, 0], b: [30, 0] }] });
await waitIdle();
await page.locator(".tree-row", { hasText: "Sketch" }).first().dblclick();
await page.waitForTimeout(500);

const moreBtn = ".sketch-toolbar > .tbc-more > .tbc-more-btn";
const visibleSlots = () =>
  page.$$eval(".sketch-toolbar > [data-slot]", (els) =>
    els.filter((e) => getComputedStyle(e).visibility !== "hidden").length);
const geometry = async () =>
  page.evaluate(() => {
    const bar = document.querySelector(".sketch-toolbar").getBoundingClientRect();
    return { top: Math.round(bar.top), bottom: Math.round(bar.bottom), h: window.innerHeight };
  });

// The full column is ~440px tall, so it only overflows below ~560px of window.
for (const height of [900, 700, 520, 420]) {
  await page.setViewportSize({ width: 1400, height });
  await page.waitForTimeout(350);
  const g = await geometry();
  const more = await page.locator(moreBtn).count();
  console.log(`\n--- window ${height}px: column ${g.top}→${g.bottom}, More button: ${more ? "yes" : "no"}, ` +
    `${await visibleSlots()} slots visible`);
  check(`column stays inside the window at ${height}px`, g.bottom <= g.h - 6, `bottom ${g.bottom} of ${g.h}`);
  // The column's height is derived from its slots; slots with margins (the
  // separators) used to be measured without them, leaving the column short and
  // clipping the last button whenever everything fit.
  const fit = await page.evaluate(() => {
    const bar = document.querySelector(".sketch-toolbar");
    const slots = [...bar.querySelectorAll("[data-slot]")].filter((e) => getComputedStyle(e).visibility !== "hidden");
    const last = slots[slots.length - 1];
    const r = last.getBoundingClientRect();
    const room = bar.getBoundingClientRect().bottom - r.bottom - parseFloat(getComputedStyle(last).marginBottom);
    const pad = parseFloat(getComputedStyle(bar).paddingBottom);
    return { room: Math.round(room * 10) / 10, pad, ok: room >= pad - 0.5 };
  });
  check(`the last visible button isn't clipped at ${height}px`, fit.ok,
    `${fit.room}px below it (padding is ${fit.pad}px)`);
  if (height <= 520) check(`the More button appears at ${height}px`, more === 1);
  else check(`no More button when everything fits (${height}px)`, more === 0);
}

// --- The flyout at a short height ---------------------------------------------
await page.setViewportSize({ width: 1400, height: 430 });
await page.waitForTimeout(350);
const shown = await visibleSlots();
await page.click(moreBtn);
await page.waitForTimeout(200);
const rowLabels = () =>
  page.$$eval(".tbc-more-menu .tb-more-list button", (bs) =>
    bs.map((b) => (b.classList.contains("active") ? "> " : "  ") + b.querySelector(".tb-row-label").textContent +
      (b.disabled ? " [disabled]" : "")));
const defaults = await rowLabels();
console.log("\n=== flyout default (the tools below the fold)");
console.log(defaults.join("\n"));
check("the flyout lists the hidden tools", defaults.length > 0, `${defaults.length} rows`);

// The popup must sit BESIDE the column, not over the tools, and must not be
// clipped by the column's overflow — it is a sibling of the column for exactly
// this reason.
const boxes = await page.evaluate(() => {
  const r = (s) => { const e = document.querySelector(s); const b = e.getBoundingClientRect(); return { l: Math.round(b.left), r: Math.round(b.right), w: Math.round(b.width) }; };
  return { col: r(".sketch-toolbar"), menu: r(".tbc-more-menu"), row: r(".tbc-more-menu .tb-more-list button"), win: window.innerWidth };
});
check("the flyout opens beside the column, not over it", boxes.menu.l >= boxes.col.r,
  `column right ${boxes.col.r}, flyout left ${boxes.menu.l}`);
check("the flyout is not clipped to the column's width", boxes.menu.w > boxes.col.w * 2 && boxes.row.w > 150,
  `flyout ${boxes.menu.w}px, rows ${boxes.row.w}px, column ${boxes.col.w}px`);
check("the flyout stays inside the window", boxes.menu.r <= boxes.win, `right ${boxes.menu.r} of ${boxes.win}`);

// The button says "More": every "and the rest" glyph is already a tool icon
// (⋯ is the linear pattern).
const moreLabel = (await page.locator(moreBtn).textContent())?.trim();
check("the overflow button is labelled in words, not a glyph", moreLabel === "More▸", `"${moreLabel}"`);
// The column is only ~50px wide, so the label + arrow have to fit one line.
const fitsOneLine = await page.locator(moreBtn).evaluate((el) => {
  const line = parseFloat(getComputedStyle(el).fontSize) * 2; // generous single-line bound
  return { overflow: el.scrollWidth - el.clientWidth, textH: el.getBoundingClientRect().height, lineMax: line, ok: el.scrollWidth <= el.clientWidth + 0.5 };
});
check("the label and its arrow sit on one line, unclipped", fitsOneLine.ok,
  `overflow ${fitsOneLine.overflow.toFixed(1)}px`);
check("…and carries the same ▸ 'opens to the right' arrow as the tool groups",
  moreLabel.endsWith("▸") &&
  (await page.locator(".sketch-group .sketch-group-arrow").first().textContent())?.trim() === "▸");
check("the More button shows its open state like the group arrows",
  await page.locator(moreBtn).evaluate((el) => el.classList.contains("expanded")));

// Clicking into the search box must not count as clicking outside the popup.
await page.click(".tb-more-search");
await page.waitForTimeout(150);
check("clicking the search box keeps the flyout open", (await page.locator(".tbc-more-menu").count()) === 1);
check("the search box names this bar's tools",
  (await page.locator(".tbc-more-menu .tb-more-search").getAttribute("placeholder")) === "Search sketch tools…",
  await page.locator(".tbc-more-menu .tb-more-search").getAttribute("placeholder"));

// The whole modeling toolbar greys out while a sketch is open — its More button
// has to grey out with it. (Narrow the window so that bar overflows at all.)
await page.setViewportSize({ width: 900, height: 430 });
await page.waitForTimeout(400);
const modelMore = page.locator(".model-toolbar > .tb-more > .tb-more-btn");
check("the modeling toolbar overflows at 900px", (await modelMore.count()) === 1);
check("the modeling toolbar's More is disabled during sketch edit", await modelMore.isDisabled());

// "/" toggles the flyout of whichever toolbar is live.
await page.keyboard.press("Escape");
await page.waitForTimeout(200);
check("Esc closed the flyout before the / checks", (await page.locator(".tbc-more-menu").count()) === 0);
await page.evaluate(() => document.activeElement?.blur());
await page.keyboard.press("/");
await page.waitForTimeout(250);
check("'/' opens the SKETCH flyout while editing a sketch", (await page.locator(".tbc-more-menu").count()) === 1);
check("…and not the modeling one", (await page.locator(".model-toolbar .tb-more-menu").count()) === 0);
await page.keyboard.press("/"); // typed into the focused search box, not a toggle
await page.waitForTimeout(150);
check("'/' typed in the search box is text, not a second toggle",
  (await page.locator(".tb-more-search").inputValue()) === "/" && (await page.locator(".tbc-more-menu").count()) === 1);
await page.keyboard.press("Escape");
await page.waitForTimeout(200);
await page.evaluate(() => document.activeElement?.blur());
await page.keyboard.press("/"); // reopen, empty, for the search checks below
await page.waitForTimeout(250);

await page.fill(".tb-more-search", "3 poi");
await page.waitForTimeout(150);
const variants = await rowLabels();
console.log("\n=== search '3 poi' (grouped variants are searchable)");
console.log(variants.join("\n"));
check("a grouped variant is reachable by name", variants.some((l) => /Circle ▸ 3 points/.test(l)), variants.join(" | "));

await page.fill(".tb-more-search", "perp");
await page.waitForTimeout(150);
const cons = await rowLabels();
check("constraints are searchable from the sketch flyout", cons.some((l) => /Perpendicular/.test(l)), cons.join(" | "));

// Enter runs the highlighted tool and closes the flyout.
await page.fill(".tb-more-search", "polygon");
await page.waitForTimeout(150);
await page.keyboard.press("Enter");
await page.waitForTimeout(250);
check("Enter picks the tool and closes the flyout", (await page.locator(".tbc-more-menu").count()) === 0);
const active = await page.$$eval(".sketch-toolbar button.active", (bs) => bs.map((b) => b.title));
check("…and that tool is now active", active.some((t) => /polygon/i.test(t)), active.join(" | "));

// A tool chosen from the flyout that was hidden stays reachable: the column is
// unchanged in size (it doesn't grow to show the newly active tool).
check("the column did not resize when a hidden tool was picked", (await visibleSlots()) === shown,
  `${shown} → ${await visibleSlots()}`);

await page.screenshot({ path: "/tmp/sketch-toolbar-overflow.png" });
console.log(failures === 0 ? "\n=== ALL CHECKS PASSED ===" : `\n=== ${failures} CHECK(S) FAILED ===`);
await browser.close();
process.exit(failures === 0 ? 0 : 1);
