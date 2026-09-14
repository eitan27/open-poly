// One experience for every modelling tool: a dialog OR a modal, never both; the
// toolbar inert while one is up; one Escape to leave.
//
// These three used to disagree per tool, which is what this pins:
//   - each tool disabled itself for its OWN dialog only, so Extrude's dialog
//     left Revolve, Shell and the rest clickable underneath it (26–28 of 30
//     buttons still live). Plane and Sketch looked correct only because they
//     also set `picking`, which every tool happened to check;
//   - a dialog that armed a pick ALSO raised the viewport pick banner, so the
//     request was made twice, in two places, with two different Cancel buttons;
//   - Escape took one press for Revolve, two for Sweep/Loft/Shell/Extrude/
//     Chamfer/Fillet (they open already armed, so the first press was spent
//     disarming), and never closed Boolean at all — it had no branch.
//
// Run against a dev server: `npm run dev`, then
// `node scripts/verify-dialog-consistency.mjs`.
import { checker, launch, openPoly } from "./lib/harness.mjs";

const { page, close } = await launch({ collectErrors: false });
const op = openPoly(page);
const { check, done } = checker();
const { apply, waitIdle } = op;
await waitIdle();

/** A document with enough in it that every tool can open. */
const seed = async () => {
  await op.newDocument();
  await apply({ op: "addPrimitive", kind: "box", params: { width: 30, depth: 20, height: 10 } });
  await waitIdle();
  await apply({ op: "addPrimitive", kind: "cylinder", params: { radius: 6, height: 20 } });
  await waitIdle();
  await apply({ op: "addSketch", plane: { datum: "top" }, entities: [{ shape: "circle", c: [0, 0], r: 8 }] });
  await waitIdle();
  await apply({ op: "addSketch", plane: { datum: "front" }, entities: [{ shape: "circle", c: [0, 30], r: 4 }] });
  await waitIdle();
  const d = await op.doc();
  const ids = d.features.filter((f) => f.type === "primitive").map((f) => f.id);
  await apply({ op: "select", targets: ids.map((id) => ({ kind: "feature", id })) }).catch(() => {});
  await page.waitForTimeout(200);
};

const dialogs = () => page.locator(".extrude-dialog, .bool-dialog");
/** Buttons a user can actually press — the .tb-mirror measuring row is aria-hidden. */
const liveTools = async () =>
  await page.$$eval(".model-toolbar button", (bs) =>
    bs.filter((b) => !b.closest("[aria-hidden]")).map((b) => !b.disabled),
  );

const TOOLS = [
  "Plane",
  "Extrude",
  "Revolve",
  "Sweep",
  "Loft",
  "Chamfer",
  "Fillet",
  "Shell",
  "Boolean",
  "Transform",
  "Mirror",
  "Pattern",
];

for (const label of TOOLS) {
  await seed();
  const btn = page.locator(`.model-toolbar button[title^="${label}"]`).first();
  if ((await btn.count()) === 0 || (await btn.isDisabled())) {
    check(`${label}: button available to open`, false, "missing or disabled with a full selection");
    continue;
  }
  await btn.click();
  await page.waitForTimeout(700);

  check(`${label}: opens a dialog`, (await dialogs().count()) > 0);

  // A dialog and the viewport pick banner must never both be up: the dialog's
  // own armed slot is already asking.
  check(`${label}: no pick banner behind the dialog`, (await page.locator(".sketch-banner.pick").count()) === 0);

  const live = await liveTools();
  const stillEnabled = live.filter(Boolean).length;
  check(
    `${label}: every other toolbar button is inert`,
    stillEnabled === 0,
    `${stillEnabled} of ${live.length} still enabled`,
  );

  await page.evaluate(() => document.activeElement?.blur());
  await page.keyboard.press("Escape");
  await page.waitForTimeout(500);
  check(`${label}: ONE Escape closes it`, (await dialogs().count()) === 0);

  const after = (await liveTools()).filter(Boolean).length;
  check(`${label}: the toolbar comes back`, after > 0, `${after} enabled`);
}

// Sketch is the one tool that keeps a modal instead of a dialog: it has nothing
// to configure until a plane is picked, so the banner IS the interface.
await seed();
await page.locator('.model-toolbar button[title^="Sketch"]').first().click();
await page.waitForTimeout(700);
check("Sketch: raises the pick banner", (await page.locator(".sketch-banner.pick").count()) === 1);
check("Sketch: and no dialog with it", (await dialogs().count()) === 0);
await page.evaluate(() => document.activeElement?.blur());
await page.keyboard.press("Escape");
await page.waitForTimeout(500);
check("Sketch: ONE Escape closes the banner", (await page.locator(".sketch-banner.pick").count()) === 0);

// Every picker states its whole request — an ellipsis would hide the one thing
// the label exists to say.
await seed();
let clipped = [];
for (const label of TOOLS) {
  const btn = page.locator(`.model-toolbar button[title^="${label}"]`).first();
  if ((await btn.count()) === 0 || (await btn.isDisabled())) continue;
  await btn.click();
  await page.waitForTimeout(600);
  const bad = await page
    .locator(".extrude-dialog .ed-pick-btn")
    .evaluateAll((bs) => bs.filter((b) => b.scrollWidth > b.clientWidth + 1).map((b) => b.textContent.trim()));
  if (bad.length) clipped.push(`${label}: ${bad.join(" / ")}`);
  await page.evaluate(() => document.activeElement?.blur());
  await page.keyboard.press("Escape");
  await page.waitForTimeout(350);
}
check("no picker text is clipped — they wrap instead", clipped.length === 0, clipped.join(" | "));

await close();
done();
