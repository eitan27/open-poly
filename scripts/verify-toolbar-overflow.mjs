// Drives the modeling toolbar's overflow "More ▾" flyout at several window
// widths: which buttons stay in the bar, the flyout's default (hidden) list,
// search, arrow-key navigation, and Enter to run a tool.
import { chromium } from "playwright";

const URL = process.env.URL ?? "http://localhost:5173/";
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1660, height: 920 }, deviceScaleFactor: 2 });
const page = await context.newPage();
page.on("pageerror", (e) => console.log(`[pageerror] ${e.message}`));
page.on("console", (m) => {
  if (m.type() === "error") console.log(`[console.error] ${m.text()}`);
});

await page.goto(URL, { waitUntil: "domcontentloaded" });
for (let i = 0; i < 60; i++) {
  const s = (await page.locator(".status").textContent())?.trim() ?? "";
  if (/up to date/i.test(s)) break;
  await page.waitForTimeout(300);
}

const barLabels = () =>
  page.$$eval(".model-toolbar > button, .model-toolbar > .mt-dropdown > button", (bs) =>
    bs.map((b) => b.textContent.trim()),
  );
const rowLabels = () =>
  page.$$eval(".tb-more-list button", (bs) =>
    bs.map(
      (b) =>
        (b.classList.contains("active") ? "> " : "  ") +
        b.querySelector(".tb-row-label").textContent +
        (b.disabled ? " [disabled]" : ""),
    ),
  );
const overflows = async () => {
  const bar = await page.locator(".model-toolbar").boundingBox();
  const wrap = await page.locator(".model-toolbar-wrap").boundingBox();
  return `bar ${Math.round(bar.width)}px / avail ${Math.round(wrap.width)}px`;
};

for (const width of [1660, 1200, 900, 620, 460]) {
  await page.setViewportSize({ width, height: 900 });
  await page.waitForTimeout(350);
  const more = await page.locator(".model-toolbar > .tb-more > .tb-more-btn").count();
  console.log(`\n=== window ${width}px — ${await overflows()} — More button: ${more > 0 ? "yes" : "no"}`);
  console.log("   bar:", (await barLabels()).join(" | "));
}

// --- Flyout at a narrow width -------------------------------------------------
await page.setViewportSize({ width: 900, height: 900 });
await page.waitForTimeout(300);
await page.click(".model-toolbar > .tb-more > .tb-more-btn");

// Stacking guard. The flyout drops over the viewport's top-right corner
// controls (perspective / section view / Home), which come LATER in the DOM, so
// it can only win on z-index — which requires .model-toolbar itself to create
// no stacking context. Anything that does (backdrop-filter, filter, transform,
// opacity < 1, isolation, a z-index on the positioned bar) would confine the
// flyout's z-index to the bar and let those buttons paint over the menu.
console.log(
  "\n=== stacking",
  await page.evaluate(() => {
    const cs = getComputedStyle(document.querySelector(".model-toolbar"));
    const traps = ["backdropFilter", "filter", "transform", "isolation", "mixBlendMode", "contain", "willChange"]
      .filter((p) => !["none", "auto", "normal"].includes(cs[p]))
      .concat(cs.zIndex !== "auto" ? ["zIndex"] : [], cs.opacity !== "1" ? ["opacity"] : []);
    const menuZ = Number(getComputedStyle(document.querySelector(".tb-more-menu")).zIndex);
    const cornerZ = getComputedStyle(document.querySelector(".view-reset")).zIndex;
    return (
      `.model-toolbar stacking-context triggers: ${traps.length ? traps.join(",") + "  <== BUG" : "none"}` +
      ` | flyout z=${menuZ} vs corner controls z=${cornerZ} (auto ⇒ flyout wins)`
    );
  }),
);
console.log("\n=== flyout default (should be exactly the hidden buttons)");
console.log((await rowLabels()).join("\n"));

await page.fill(".tb-more-search", "fil");
await page.waitForTimeout(120);
console.log("\n=== search 'fil'");
console.log((await rowLabels()).join("\n"));

await page.fill(".tb-more-search", "cyl");
await page.waitForTimeout(120);
console.log("\n=== search 'cyl' (a Body dropdown choice, flattened)");
console.log((await rowLabels()).join("\n"));

await page.fill(".tb-more-search", "b");
await page.waitForTimeout(120);
console.log("\n=== search 'b' then ArrowDown ×2");
await page.keyboard.press("ArrowDown");
await page.keyboard.press("ArrowDown");
console.log((await rowLabels()).join("\n"));

await page.fill(".tb-more-search", "zzz");
await page.waitForTimeout(120);
console.log("\n=== search 'zzz' →", await page.locator(".tb-more-empty").textContent());

// Enter on "Cylinder" must create a body (feature count grows) and close the flyout.
const before = await page.locator(".tree-list .tree-row .row-name").count();
await page.fill(".tb-more-search", "cylinder");
await page.waitForTimeout(120);
await page.keyboard.press("Enter");
await page.waitForTimeout(1500);
console.log("\n=== Enter on 'Body ▸ Cylinder'");
console.log("   flyout open:", (await page.locator(".tb-more-menu").count()) > 0);
console.log("   tree rows:", before, "→", await page.locator(".tree-list .tree-row .row-name").count());
console.log("   status:", (await page.locator(".status").textContent())?.trim());

// Escape must close the flyout without tripping the app's global Esc chain.
await page.click(".model-toolbar > .tb-more > .tb-more-btn");
await page.keyboard.press("Escape");
console.log("   Esc closes flyout:", (await page.locator(".tb-more-menu").count()) === 0);

// --- "/" opens the flyout in modelling mode, hidden buttons or not -----------
await page.evaluate(() => document.activeElement?.blur());
await page.keyboard.press("/");
await page.waitForTimeout(250);
console.log("\n=== '/' at 900px (buttons hidden)");
console.log(
  "   flyout open:",
  (await page.locator(".model-toolbar .tb-more-menu").count()) === 1,
  "| rows:",
  (await rowLabels()).length,
);
await page.keyboard.press("Escape");
await page.waitForTimeout(150);
console.log("   Esc closed it:", (await page.locator(".model-toolbar .tb-more-menu").count()) === 0);

// Wide enough that everything fits: no More button, but "/" is still a tool
// search — and then it lists every tool rather than an empty box.
await page.setViewportSize({ width: 1660, height: 900 });
await page.waitForTimeout(400);
await page.evaluate(() => document.activeElement?.blur());
await page.keyboard.press("/");
await page.waitForTimeout(250);
console.log("\n=== '/' at 1660px (nothing hidden — no More button)");
console.log(
  "   More button:",
  await page.locator(".model-toolbar > .tb-more > .tb-more-btn").count(),
  "| flyout open:",
  (await page.locator(".model-toolbar .tb-more-menu").count()) === 1,
  "| rows:",
  (await rowLabels()).length,
);
await page.keyboard.press("Escape");
await page.waitForTimeout(150);
await page.setViewportSize({ width: 900, height: 900 });
await page.waitForTimeout(400);

// The in-bar ▾ dropdown must still work (it moved into OverflowToolbar).
await page.click(".model-toolbar > .mt-dropdown > button");
console.log("\n=== in-bar Body ▾ dropdown");
console.log("   menu:", (await page.$$eval(".mt-menu button", (b) => b.map((x) => x.textContent))).join(" | "));
await page.click(".model-toolbar .mt-menu button:nth-child(1)");
await page.waitForTimeout(1200);
console.log(
  "   after clicking Box — menu open:",
  (await page.locator(".mt-menu").count()) > 0,
  "| tree rows:",
  await page.locator(".tree-list .tree-row .row-name").count(),
);

// A hidden dropdown reached by its keyboard shortcut (N) should open the flyout
// pre-filtered to it.
await page.setViewportSize({ width: 200, height: 900 });
await page.waitForTimeout(400);
console.log("\n=== window 200px");
console.log("   bar:", (await barLabels()).join(" | ") || "(all collapsed)");
await page.evaluate(() => document.activeElement?.blur());
await page.keyboard.press("n");
await page.waitForTimeout(250);
console.log(
  "   'N' with Body hidden → flyout open:",
  (await page.locator(".tb-more-menu").count()) > 0,
  "| query:",
  JSON.stringify(
    await page
      .locator(".tb-more-search")
      .inputValue()
      .catch(() => null),
  ),
);
console.log((await rowLabels().catch(() => [])).join("\n"));

await page.screenshot({ path: "/tmp/openshape-toolbar.png" });
await browser.close();
