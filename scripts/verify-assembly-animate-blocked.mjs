// Assemblies: the Animate dialog checks the sweep before it plays, and the
// Insert dialog and side panel polish that came with it.
// - Insert: "Parts" / "Instances" column titles (no ×), a count that goes to 0
//   and unticks its part, ticking puts 1 back, and ▶ on a row unfolds a drawn
//   picture of the part.
// - The panel's Instances / Mates / Relations headings fold their lists away.
// - A revolute held still by a fastened mate on the same parts: the dialog
//   opens with Play, Video and GIF disabled and a one-line warning naming the
//   fastened mate. Suppressing that mate frees all three.
// NB if the local open-poly MCP hub is running, this headless tab connects to
// it and can take the bridge from your own tab; reload yours after.
import { chromium } from "playwright";

const URL = process.env.URL ?? "http://localhost:5173/";
const browser = await chromium.launch(process.env.PW_EXE ? { executablePath: process.env.PW_EXE } : {});
const context = await browser.newContext({
  viewport: { width: 1660, height: 920 },
  deviceScaleFactor: 2,
  acceptDownloads: true,
});
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
const rename = async (name) => {
  await page.locator(".doc-title").click();
  await page.locator(".doc-title").fill(name);
  await page.locator(".doc-title").press("Enter");
};

const doc0 = await page.evaluate(() => window.__openpoly.read({ read: "document" }));
for (const f of [...doc0.features].reverse()) await apply({ op: "delete", featureId: f.id });
await rename("Base");
await apply({ op: "addPrimitive", kind: "box", params: { width: "40", depth: "40", height: "10" } });
await waitIdle();
await switchVia(page.locator(".newdoc-btn"));
await rename("Arm");
await apply({ op: "addPrimitive", kind: "cylinder", params: { radius: "6", height: "20" } });
await waitIdle();

await page.locator(".split-btn-caret").click();
await switchVia(page.locator(".split-btn .mt-menu button", { hasText: "Assembly" }));
await rename("Blocked");

// --- Insert dialog ---
await page.locator(".asm-insert").click();
await page.locator(".insert-doc", { hasText: "Arm" }).click();
await page.locator(".insert-confirm").waitFor({ timeout: 30000 });
const dialog = page.locator(".insert-dialog");
check(
  "column titles read Parts and Instances",
  (await dialog.locator(".insert-columns").textContent()) === "PartsInstances" ||
    /Parts\s*Instances/i.test(await dialog.locator(".insert-columns").innerText()),
);
check("no × beside the count", !(await dialog.innerText()).includes("×"));
const width = (await dialog.boundingBox()).width;
check("the dialog is narrower than the Documents one (560px)", width <= 402, `${width}px`);
const count = dialog.locator("input.insert-count").first();
const tick = dialog.locator(".insert-part input[type=checkbox]").first();
await count.focus();
await page.keyboard.press("ArrowDown");
check("ArrowDown takes the count to 0", (await count.inputValue()) === "0");
check("…and unticks the part", !(await tick.isChecked()));
check("…and Insert is disabled", await dialog.locator(".insert-confirm").isDisabled());
await page.keyboard.press("ArrowDown");
check("it doesn't go below 0", (await count.inputValue()) === "0");
await tick.check();
check("ticking it puts 1 back", (await count.inputValue()) === "1");
await dialog.locator(".insert-expand").first().click();
const preview = dialog.locator("canvas.insert-preview");
await preview.waitFor();
const painted = await preview.evaluate((c) => {
  const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
  let n = 0;
  for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n++;
  return n / (c.width * c.height);
});
check(
  "▶ unfolds a drawn picture of the part",
  painted > 0.05 && painted < 0.9,
  `${(painted * 100).toFixed(1)}% painted`,
);
await page.screenshot({
  path: (process.env.SHOTS ?? "/tmp") + "/insert-preview.png",
  clip: await dialog.boundingBox(),
});
await dialog.locator(".insert-expand").first().click();
check("▶ again folds it away", (await preview.count()) === 0);
await dialog.locator(".insert-confirm").click();
await page.waitForTimeout(400);
await page.locator(".asm-insert").click();
await page.locator(".insert-doc", { hasText: "Base" }).click();
await page.locator(".insert-confirm").waitFor({ timeout: 30000 });
await page.locator(".insert-confirm").click();
await page.waitForTimeout(400);
await page.keyboard.press("Escape");
await waitIdle();

// With no mates yet, the Relations hint asks for two, a little below its header.
{
  const hint = await page.locator(".asm-empty").last().textContent();
  check("with no mates, the Relations hint asks for two moving mates", /Add two moving mates/.test(hint), hint);
  if (process.env.SHOTS)
    await page.screenshot({
      path: process.env.SHOTS + "/relation-empty.png",
      clip: { x: 0, y: 60, width: 290, height: 400 },
    });
}

const scene = await page.evaluate(() => window.__openpoly.read({ read: "sceneSummary" }));
const [arm, base] = scene.instances.map((i) => i.id);
const faceOf = (id, test) =>
  scene.parts.find((p) => p.key === scene.instances.find((i) => i.id === id).part).faces.find(test);
const baseTop = faceOf(base, (f) => f.endsWith("/+z"));
const armEnd = faceOf(arm, (f) => f.endsWith("/-z") || /bottom|start/.test(f));

// The first inserted (the arm) was grounded on insert; the base holds instead.
await apply({ op: "groundInstance", instanceId: arm, grounded: false });
await apply({ op: "groundInstance", instanceId: base });
let r = await apply({
  op: "addMate",
  type: "revolute",
  a: { instanceId: base, face: baseTop },
  b: { instanceId: arm, face: armEnd },
});
check("a revolute mate is made", r.ok, JSON.stringify(r));
const revolute = r.createdId;
r = await apply({
  op: "addMate",
  type: "fastened",
  a: { instanceId: base, face: baseTop },
  b: { instanceId: arm, face: armEnd },
  name: "Lock",
});
check("a fastened mate on the same parts is made", r.ok, JSON.stringify(r));
const lock = r.createdId;
await waitIdle();

// --- Collapsible sections ---
const heading = (t) => page.locator(".params-heading.collapsible", { hasText: t });
const rows = (cls) => page.locator(cls);
check("the instance and mate rows show", (await rows(".asm-mate-animate").count()) >= 1);
await heading("Mates").click();
check("folding Mates hides its rows", (await rows(".asm-mate-animate").count()) === 0);
await heading("Instances").click();
const instanceRows = () => page.locator(".asm-row:not(.asm-mate-row):not(.asm-relation-row)").count();
check("folding Instances hides its rows", (await instanceRows()) === 0);
await page.screenshot({
  path: (process.env.SHOTS ?? "/tmp") + "/panel-folded.png",
  clip: { x: 0, y: 0, width: 420, height: 700 },
});
await heading("Instances").click();
await heading("Mates").click();
check("unfolding brings them back", (await rows(".asm-mate-row").count()) === 2 && (await instanceRows()) === 2);

// --- Animate, locked ---
await page.locator(".asm-mate-row").first().locator(".asm-mate-animate").click();
await page.locator(".asm-animate").waitFor();
const warn = page.locator(".asm-animate-blocked");
await warn.waitFor({ timeout: 5000 });
const text = await warn.textContent();
check(
  "the warning is there on opening, naming the fastened mate",
  /Can't animate: Lock holds this part still/.test(text),
  text,
);
check("Play is disabled", await page.locator(".asm-animate-play").isDisabled());
check("GIF is disabled", await page.locator(".asm-export-gif").isDisabled());
check("Video is disabled", await page.locator(".asm-export-video").isDisabled());
await page.screenshot({
  path: (process.env.SHOTS ?? "/tmp") + "/animate-locked.png",
  clip: await page.locator(".asm-animate").boundingBox(),
});
await page.locator(".asm-animate-close").click();

r = await apply({ op: "setSuppressed", id: lock, suppressed: true });
check("the fastened mate is suppressed", r.ok, JSON.stringify(r));
await waitIdle();
await page.locator(".asm-mate-row").first().locator(".asm-mate-animate").click();
await page.locator(".asm-animate").waitFor();
await page
  .waitForFunction(() => !document.querySelector(".asm-export-gif")?.disabled, null, { timeout: 5000 })
  .catch(() => {});
check("with it suppressed, no warning", (await warn.count()) === 0);
check(
  "…and Play, GIF are enabled",
  !(await page.locator(".asm-animate-play").isDisabled()) && !(await page.locator(".asm-export-gif").isDisabled()),
);

// --- The Relation dialog's types sit on one line each ---
await page.locator(".asm-animate-close").click();
// One revolute alone can't be related to anything: ＋ Relation is off, and says why.
const newRelation = page.locator(".asm-new-relation");
const relHint = await page.locator(".asm-empty").last().textContent();
check(
  "＋ Relation is disabled with only one revolute, the hint asking for a second mate",
  (await newRelation.isDisabled()) && /second mate/.test(relHint),
  relHint,
);
// …and looks it: greyed out, not a live-looking button that does nothing.
const looks = await newRelation.evaluate((b) => ({
  opacity: getComputedStyle(b).opacity,
  cursor: getComputedStyle(b).cursor,
}));
check("…and is visibly greyed out", Number(looks.opacity) < 0.5 && looks.cursor === "default", JSON.stringify(looks));
if (process.env.SHOTS)
  await page.screenshot({
    path: process.env.SHOTS + "/relation-off.png",
    clip: { x: 0, y: 60, width: 290, height: 380 },
  });
// A cylindrical mate can drive its own slide (a screw): it enables it.
r = await apply({ op: "editMate", mateId: revolute, type: "cylindrical" });
check("the revolute becomes cylindrical", r.ok, JSON.stringify(r));
await waitIdle();
check(
  "…and ＋ Relation is enabled, at full strength",
  !(await newRelation.isDisabled()) && (await newRelation.evaluate((b) => getComputedStyle(b).opacity)) === "1",
);
await newRelation.click();
const rel = page.locator(".asm-relation");
await rel.waitFor();
const heights = await rel
  .locator(".ed-modes button")
  .evaluateAll((bs) => bs.map((b) => b.getBoundingClientRect().height));
check(
  "Gear / Rack / Screw each fit on one line",
  heights.length === 3 && heights.every((h) => h === heights[0] && h < 30),
  JSON.stringify(heights),
);
const selectFits = await rel
  .locator("select")
  .evaluateAll((ss) =>
    ss.map(
      (el) =>
        el.offsetWidth >= 134 &&
        el.getBoundingClientRect().right <= el.closest(".asm-relation").getBoundingClientRect().right,
    ),
  );
check(
  "the mate pickers are wider and stay inside the dialog",
  selectFits.length === 2 && selectFits.every(Boolean),
  JSON.stringify(selectFits),
);
if (process.env.SHOTS)
  await page.screenshot({ path: process.env.SHOTS + "/relation.png", clip: await rel.boundingBox() });
const insertTool = (await page.getByRole("button", { name: /Insert/ }).allInnerTexts()).join(" | ");
check(
  "the toolbar's Insert reads ＋ Insert, as the Instances list's",
  /＋\s*Insert[\s\S]*＋\s*Insert/.test(insertTool),
  insertTool,
);
if (process.env.SHOTS)
  await page.screenshot({ path: process.env.SHOTS + "/toolbar.png", clip: { x: 0, y: 50, width: 1300, height: 160 } });

await browser.close();
console.log(failures ? `${failures} FAILED` : "ALL PASS");
process.exit(failures ? 1 : 0);
