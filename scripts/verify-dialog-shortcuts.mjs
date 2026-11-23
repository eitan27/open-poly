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
