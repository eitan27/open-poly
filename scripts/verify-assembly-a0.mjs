// Assemblies A0: the document kind end to end in the real app — New ▾ →
// Assembly, the assembly side panel in place of the part UI, part shortcuts
// standing down, persistence across a reload, the Documents tabs, rename,
// duplicate, the agent guard, and switching back to a part.
// NB if the local open-poly MCP hub is running, this headless tab connects to
// it ("Agent connected" in the screenshots) and can take the bridge from your
// own tab; reload yours afterwards.
import { chromium } from "playwright";

const URL = process.env.URL ?? "http://localhost:5173/";
const browser = await chromium.launch(process.env.PW_EXE ? { executablePath: process.env.PW_EXE } : {});
const context = await browser.newContext({ viewport: { width: 1660, height: 920 }, deviceScaleFactor: 2 });
const page = await context.newPage();
page.on("pageerror", (e) => console.log(`[pageerror] ${e.message}`));
await page.goto(URL, { waitUntil: "domcontentloaded" });

const waitIdle = async () => {
  let stable = 0;
  for (let i = 0; i < 100; i++) {
    const s = (await page.locator(".status").textContent())?.trim() ?? "";
    stable = /up to date|error/i.test(s) ? stable + 1 : 0;
    if (stable >= 3) return;
    await page.waitForTimeout(300);
  }
  throw new Error("app never settled");
};
await waitIdle();
await page.waitForFunction(() => window.__openpoly);

let failures = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}: ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};
const title = async () => (await page.locator(".doc-title").inputValue())?.trim();
const inAssembly = async () => (await page.locator(".panel h2", { hasText: "Instances" }).count()) === 1;
// The part toolbar (an assembly has its own). Counted with `> 0`: the bar keeps
// a hidden measuring copy of its buttons.
const toolbarShown = async () => (await page.locator(".model-toolbar button", { hasText: "Extrude" }).count()) > 0;
/** A document switch lands a few hundred ms after its click, while the status
 *  still reads "up to date" from before: wait for the side panel to show the
 *  kind expected (up to 10 s; the check that follows says if it never does). */
const settleAs = async (kind) => {
  await page
    .waitForFunction(
      (k) => !!document.querySelector(".panel .asm-list, .panel .asm-empty") === (k === "assembly"),
      kind,
      { timeout: 10000 },
    )
    .catch(() => {});
  await waitIdle();
};

check("starts in a part (model toolbar shown)", (await toolbarShown()) && !(await inAssembly()));

// 1. New ▾ → Assembly.
await page.locator(".split-btn-caret").click();
await page.locator(".split-btn .mt-menu button", { hasText: "Assembly" }).click();
await settleAs("assembly");
check("New ▾ → Assembly opens an assembly", await inAssembly());
check(
  "the part toolbar gives way to the assembly's",
  !(await toolbarShown()) && (await page.locator(".model-toolbar button", { hasText: "Insert" }).count()) > 0,
);
check(
  "the part panel (Timeline) is gone",
  (await page.locator(".params-heading", { hasText: "Timeline" }).count()) === 0,
);
check("it got an Untitled name", /^Untitled/.test(await title()), await title());
await page.screenshot({ path: "/tmp/asm-a0-empty.png" });

// 2. Part shortcuts stand down: "e" must not open Extrude.
await page
  .locator("canvas")
  .first()
  .click({ position: { x: 900, y: 500 } });
await page.keyboard.press("e");
await page.waitForTimeout(300);
check("pressing E opens no Extrude dialog", (await page.locator(".feature-dialog").count()) === 0);

// 3. The agent refuses part edits here.
const refused = await page.evaluate(() => window.__openpoly.apply({ op: "addPrimitive", kind: "box" }));
check("the agent's part edit is refused", refused.ok === false && /assembly/.test(refused.error), refused.error);

// 4. Rename, then reload: it comes back as the same assembly.
await page.locator(".doc-title").click();
await page.locator(".doc-title").fill("Arm");
await page.locator(".doc-title").press("Enter");
await page.waitForTimeout(900); // autosave debounce
await page.reload({ waitUntil: "domcontentloaded" });
await waitIdle();
check("after reload it is still an assembly", await inAssembly());
check("and still named Arm", (await title()) === "Arm", await title());

// 5. Documents dialog tabs.
await page.locator(".docs-btn").click();
const rowNames = async () =>
  page.locator(".docs-row .docs-name").evaluateAll((els) => els.map((e) => e.textContent?.trim() ?? ""));
const all = await rowNames();
check(
  "All lists the assembly with its badge",
  all.some((n) => n.startsWith("ArmAssembly")),
  all.join(" | "),
);
await page.locator(".docs-tabs button", { hasText: "Assemblies" }).click();
const asms = await rowNames();
check(
  "Assemblies lists only assemblies",
  asms.length >= 1 && asms.every((n) => n.includes("Assembly")),
  asms.join(" | "),
);
const sub = await page.locator(".docs-row", { hasText: "Arm" }).locator(".docs-sub").textContent();
check("an assembly's subtitle counts its parts and mates", /0 parts · 0 mates/.test(sub ?? ""), sub ?? "");
await page.screenshot({ path: "/tmp/asm-a0-docs.png" });
await page.locator(".docs-tabs button", { hasText: "Parts" }).click();
const parts = await rowNames();
check("Parts hides the assembly", !parts.some((n) => n.includes("Assembly")), parts.join(" | "));

// 6. Duplicate from the Assemblies tab: the copy is an assembly too.
await page.locator(".docs-tabs button", { hasText: "Assemblies" }).click();
await page.locator(".docs-row", { hasText: "Arm" }).first().locator(".text-btn", { hasText: "Duplicate" }).click();
await page
  .waitForFunction(() => document.querySelector(".doc-title")?.value === "Copy of Arm", null, { timeout: 10000 })
  .catch(() => {});
await settleAs("assembly");
check("the duplicate opens as an assembly", (await inAssembly()) && (await title()) === "Copy of Arm", await title());

// 7. Undo/redo stay usable (nothing to undo in an empty assembly).
check("undo is disabled with nothing to undo", await page.locator(".topbar-actions .tool-btn").first().isDisabled());

// 8. Plain "＋ New" is still a part, and the part UI comes back.
await page.locator(".newdoc-btn").click();
await settleAs("part");
check("＋ New makes a part again", (await toolbarShown()) && !(await inAssembly()));
const made = await page.evaluate(() => window.__openpoly.apply({ op: "addPrimitive", kind: "box" }));
check("the agent can model in the part", made.ok === true, made.error ?? "");

// Control for step 2: in a part, the same key DOES open Extrude — so the check
// above can't pass just because the selector matches nothing.
await page
  .locator("canvas")
  .first()
  .click({ position: { x: 900, y: 500 } });
await page.keyboard.press("e");
await page.waitForTimeout(300);
check("control: in a part, E opens the Extrude dialog", (await page.locator(".feature-dialog").count()) === 1);
await page.keyboard.press("Escape");

// 9. The tab choice was remembered.
await page.locator(".docs-btn").click();
const sel = await page.locator(".docs-tabs button.active").textContent();
check("the Documents tab is remembered", sel?.trim() === "Assemblies", sel ?? "");
await page.keyboard.press("Escape");

console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL PASS");
await browser.close();
process.exit(failures ? 1 : 0);
