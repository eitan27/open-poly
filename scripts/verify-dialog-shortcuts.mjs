// Feature shortcuts while a feature dialog is open (see src/ui/dialogShortcutGuard.ts).
//
// Each feature key used to check only its OWN dialog, so three feature keys in a
// row stacked three dialogs. Now:
//   - an UNTOUCHED new dialog (nothing picked or changed since it opened) is
//     swapped for the one asked for — pressing the wrong key and then the right
//     one is the common case;
//   - a dialog holding work, or one editing an existing feature, stays put and
//     the key is refused with a "Finish or cancel the … dialog first" hint;
//   - the open dialog's own key is a no-op.
//
// Run against a dev server: `npm run dev`, then
// `node scripts/verify-dialog-shortcuts.mjs` (URL=… and SHOTS=<dir> optional).
import { mkdirSync } from "node:fs";
import { checker, launch, openPoly } from "./lib/harness.mjs";

const SHOTS = process.env.SHOTS;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

const { page, errors, close } = await launch();
const op = openPoly(page);
const { check, done } = checker();
await op.waitIdle();

const dialogs = page.locator(".feature-dialog");
const hint = page.locator(".sketch-msg");
const pickBanner = page.locator(".sketch-banner.pick");
const titles = async () => (await dialogs.locator(".ed-title").allTextContents()).map((t) => t.trim());

/** Press a key the way a user does: canvas hovered, nothing focused. */
const press = async (key) => {
  const box = await page.locator("canvas").first().boundingBox();
  await page.mouse.move(box.x + box.width - 60, box.y + box.height - 60);
  await page.evaluate(() => document.activeElement?.blur());
  await page.keyboard.press(key);
  await page.waitForTimeout(500);
};
const escape = async () => {
  await press("Escape");
  await page.waitForTimeout(200);
};
/** Clear any lingering hint so each check sees only its own. */
const clearHint = () => page.waitForFunction(() => !document.querySelector(".sketch-msg"), null, { timeout: 6000 });

await op.newDocument();
await op.applySettled({ op: "addPrimitive", kind: "box", params: { width: 30, depth: 20, height: 10 } });
await op.apply({ op: "select", targets: [] }).catch(() => {});

// --- Untouched dialogs swap -------------------------------------------------
await press("e");
check("E opens Extrude", JSON.stringify(await titles()) === '["Extrude"]', JSON.stringify(await titles()));
await press("r");
let t = await titles();
check("R over an untouched Extrude swaps to Revolve", t.length === 1 && /Revolve/.test(t[0]), JSON.stringify(t));
check("…without a hint", (await hint.count()) === 0);
await press("l");
t = await titles();
check("L over an untouched Revolve swaps to Loft", t.length === 1 && /Loft/.test(t[0]), JSON.stringify(t));
await press("c");
await press("f");
t = await titles();
check("C then F: Chamfer swaps to Fillet (same dialog slot)", t.length === 1 && /Fillet/.test(t[0]), JSON.stringify(t));
await press("t");
t = await titles();
check("T swaps to the Transform body pick", t.length === 1 && /Transform|Move/i.test(t[0]), JSON.stringify(t));
await press("o");
t = await titles();
check("O swaps the untouched Transform pick for Shell", t.length === 1 && /Shell/.test(t[0]), JSON.stringify(t));
await press("s");
check("S swaps Shell for the sketch-plane pick", (await dialogs.count()) === 0 && (await pickBanner.count()) === 1);
await press("e");
t = await titles();
check(
  "E from the sketch-plane pick opens Extrude and drops the pick",
  t.length === 1 && t[0] === "Extrude" && (await pickBanner.count()) === 0,
  JSON.stringify(t),
);
await press("e");
check(
  "E over Extrude is a no-op (still one Extrude, no hint)",
  (await dialogs.count()) === 1 && (await hint.count()) === 0,
);
await escape();
check("Escape closes it", (await dialogs.count()) === 0);
const doc0 = await op.doc();
check(
  "no feature was left behind by the swaps",
  doc0.features.length === 1,
  doc0.features.map((f) => f.type).join(","),
);

// --- Hole, Screw and Thread ---------------------------------------------------
// Each opens listening for its first pick (a hole's points, a screw's spots, a
// thread's face); arming isn't work, so they swap like the rest.
await press("d");
t = await titles();
check("D opens Hole", t.length === 1 && /Hole/.test(t[0]), JSON.stringify(t));
await press("u");
t = await titles();
check("U over an untouched Hole swaps to Screw", t.length === 1 && /Screw/.test(t[0]), JSON.stringify(t));
await press("j");
t = await titles();
check("J over an untouched Screw swaps to Thread", t.length === 1 && /Thread/.test(t[0]), JSON.stringify(t));
await press("g");
t = await titles();
check("G over an untouched Thread swaps to Gear", t.length === 1 && /Gear/.test(t[0]), JSON.stringify(t));
await escape();
await escape();
check("Escape closes it", (await dialogs.count()) === 0);
// A Thread with its pitch changed holds work: D is refused.
await press("j");
const pitch = dialogs.locator(".ed-field", { hasText: "Pitch" }).locator("input");
await pitch.fill("1.5");
await pitch.blur();
await page.waitForTimeout(200);
await press("d");
t = await titles();
check("D over a changed Thread is refused", t.length === 1 && /Thread/.test(t[0]), JSON.stringify(t));
check("…with the hint", /Finish or cancel the Thread dialog/.test((await hint.textContent().catch(() => "")) ?? ""));
await escape();
await escape();
await clearHint();
check("no fastener feature was left behind", (await op.doc()).features.length === 1);

// --- N, the Body menu, follows the same guard ----------------------------------
const bodyMenu = page.locator(".mt-menu");
await press("e");
await press("n");
check(
  "N over an untouched Extrude swaps it for the Body menu",
  (await dialogs.count()) === 0 && (await bodyMenu.count()) === 1,
  JSON.stringify(await titles()),
);
await escape();
await page.mouse.click(5, 5);
await page.waitForTimeout(200);
await press("e");
const dist0 = dialogs.locator(".ed-field", { hasText: "Distance" }).locator("input");
await dist0.fill("17");
await dist0.blur();
await page.waitForTimeout(200);
await press("n");
check(
  "N over a changed Extrude is refused: no Body menu, the dialog stays",
  (await bodyMenu.count()) === 0 && JSON.stringify(await titles()) === '["Extrude"]',
);
check("…with the hint", /Finish or cancel the Extrude dialog/.test((await hint.textContent().catch(() => "")) ?? ""));
await escape();
await escape();
await clearHint();

// --- A changed field blocks ---------------------------------------------------
await press("e");
const dist = dialogs.locator(".ed-field", { hasText: "Distance" }).locator("input");
await dist.fill("25");
await dist.blur();
await page.waitForTimeout(200);
await press("r");
t = await titles();
check(
  "R over an Extrude with a changed distance leaves it open",
  t.length === 1 && t[0] === "Extrude",
  JSON.stringify(t),
);
const msg = (await hint.count()) ? ((await hint.textContent()) ?? "").trim() : "";
check("…and shows the hint", msg.includes("Finish or cancel the Extrude dialog first (Esc)."), msg);
check("…keeping the typed distance", (await dist.inputValue()) === "25");
if (SHOTS) await page.screenshot({ path: `${SHOTS}/hint-extrude-touched.png` });
await escape();
await clearHint();

// --- A pick blocks ------------------------------------------------------------
await press("o");
await op.clickWorld([0, 0, 5]);
await press("e");
t = await titles();
check("E over a Shell with its body picked leaves it open", t.length === 1 && /Shell/.test(t[0]), JSON.stringify(t));
check(
  "…and shows the Shell hint",
  ((await hint.textContent().catch(() => "")) ?? "").includes("Finish or cancel the Shell dialog first"),
);
await escape();
await clearHint();

// --- Editing an existing feature is never swapped --------------------------------
await op.newDocument();
await op.applySettled({
  op: "addSketch",
  plane: { datum: "top" },
  entities: [{ shape: "rect", corner: [0, 0], w: 40, h: 30 }],
});
const sk = (await op.features()).find((f) => f.type === "sketch");
await op.applySettled({ op: "addExtrude", profile: { sketchId: sk.id }, distance: "10" });
await page.locator(".tree-row", { hasText: "Extrude" }).first().dblclick();
await page.waitForTimeout(500);
t = await titles();
check("double-click opens the extrude for editing", t.length === 1 && /Edit extrude/.test(t[0]), JSON.stringify(t));
await press("r");
t = await titles();
check("R over an untouched EDIT dialog leaves it open", t.length === 1 && /Edit extrude/.test(t[0]), JSON.stringify(t));
check(
  "…and shows the hint",
  ((await hint.textContent().catch(() => "")) ?? "").includes("Finish or cancel the Extrude dialog first"),
);
if (SHOTS) await page.screenshot({ path: `${SHOTS}/hint-edit-extrude.png` });
await escape();
check("Escape closes the edit dialog", (await dialogs.count()) === 0);
const ex = (await op.features()).find((f) => f.type === "extrude");
check("the edited extrude is untouched", ex?.distance === "10", ex?.distance);

// Two failures that are about the local environment, not this page: the agent
// bridge (ws://127.0.0.1:7373) is not running, and the dev server has no Pages
// Functions behind /api/drive/config, so it answers 502.
const real = errors.filter((e) => !/ws:\/\/127\.0\.0\.1:7373|502|Bad Gateway|drive\/config/.test(e));
check("no page errors", real.length === 0, real.slice(0, 3).join(" | "));

await close();
done();
