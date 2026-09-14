// Transform UX branch: the toolbar button is always live, arms a body pick when
// there is no unambiguous target, and Move / Rotate / Scale each get their own
// searchable row in the "/" flyout without appearing on the bar.
import { launch, openPoly } from "./lib/harness.mjs";

const { page, close } = await launch({ deviceScaleFactor: 2, collectErrors: false });
const { waitIdle, apply, read } = openPoly(page);
page.on("console", (m) => {
  if (m.type() === "error") console.log(`[console.error] ${m.text()}`);
});
await waitIdle();
let failures = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}: ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

const dialog = page.locator(".extrude-dialog");
const barLabels = () =>
  page.$$eval(".model-toolbar > button, .model-toolbar > .mt-dropdown > button", (bs) =>
    bs.map((b) => b.textContent.trim()),
  );
const rowLabels = () =>
  page.$$eval(".tb-more-list button", (bs) =>
    bs.map((b) => b.querySelector(".tb-row-label").textContent + (b.disabled ? " [disabled]" : "")),
  );
const openFlyout = async (q) => {
  await page.click(".model-toolbar > .tb-more > .tb-more-btn");
  if (q !== undefined) {
    await page.fill(".tb-more-search", q);
    await page.waitForTimeout(150);
  }
};
const closeFlyout = () => page.keyboard.press("Escape");
const transformFeatures = async () => (await read({ read: "document" })).features.filter((f) => f.type === "transform");
const fieldLabels = async () => (await dialog.locator(".ed-field > span").allTextContents()).join(",");

// --- 1. The bar itself is unchanged: no "Transform ▸ …" buttons -------------
const bar = await barLabels();
check(
  "bar has a plain Transform button",
  bar.some((l) => /Transform/.test(l)),
  bar.join(" | "),
);
check("bar has no Transform ▸ mode buttons", !bar.some((l) => /▸/.test(l)), bar.filter((l) => /▸/.test(l)).join(" | "));

// --- 2. The three modes are searchable in the flyout -------------------------
await openFlyout("");
const defaults = await rowLabels();
check(
  "flyout default listing includes all three mode rows",
  ["Move", "Rotate", "Scale"].every((m) => defaults.includes(`Transform ▸ ${m}`)),
  defaults.join(" | "),
);
for (const [q, want] of [
  ["move", "Transform ▸ Move"],
  ["rotate", "Transform ▸ Rotate"],
  ["scale", "Transform ▸ Scale"],
  ["resize", "Transform ▸ Scale"],
  ["spin", "Transform ▸ Rotate"],
]) {
  await page.fill(".tb-more-search", q);
  await page.waitForTimeout(120);
  const rows = await rowLabels();
  check(`search "${q}" finds ${want}, enabled`, rows.includes(want), rows.join(" | "));
}
await closeFlyout();

// --- 3. Transform with nothing selected arms instead of being disabled -------
const sel0 = await read({ read: "selection" });
check("nothing is selected to start", JSON.stringify(sel0) === "[]" || (sel0.length ?? 0) === 0, JSON.stringify(sel0));
const tbBtn = page.locator(".model-toolbar > button", { hasText: "Transform" }).first();
check("toolbar Transform is enabled with no selection", !(await tbBtn.isDisabled()));
const before = (await transformFeatures()).length;
await tbBtn.click();
await page.waitForTimeout(300);
check("clicking it opens an arming panel", (await dialog.count()) === 1, `${await dialog.count()} dialog(s)`);
check("no feature was created yet", (await transformFeatures()).length === before);
const armModes = await dialog.locator(".ed-modes").first().locator("button").allTextContents();
check("arming panel offers Move / Rotate / Scale", armModes.join(",") === "Move,Rotate,Scale", armModes.join(","));
const activeMode = await dialog.locator(".ed-modes button.active").textContent();
check("default armed mode is Move", activeMode?.trim() === "Move", activeMode);
const slotText =
  (await dialog
    .locator(".ed-actions")
    .first()
    .evaluate((n) => n.parentElement.textContent)) ?? "";
check("panel asks for a body", /Select a body/i.test(slotText), slotText.replace(/\s+/g, " ").slice(0, 120));
await page.screenshot({ path: "/tmp/openshape-transform-arming-panel.png" });
check("toolbar Transform is disabled while armed", await tbBtn.isDisabled());

// --- 4. Esc cancels arming without creating anything -------------------------
await page.keyboard.press("Escape");
await page.waitForTimeout(250);
check("Esc closes the arming panel", (await dialog.count()) === 0);
check("Esc created no feature", (await transformFeatures()).length === before);

// --- 5. Arming from the search row, then a viewport body click ---------------
await openFlyout("rotate");
await page.locator(".tb-more-list button", { hasText: "Transform ▸ Rotate" }).first().click();
await page.waitForTimeout(300);
check(
  "search row opens the arming panel on Rotate",
  (await dialog.locator(".ed-modes button.active").textContent())?.trim() === "Rotate",
);
const canvas = page.locator("canvas").first();
const cbox = await canvas.boundingBox();
const centre = [cbox.x + cbox.width / 2, cbox.y + cbox.height / 2];
await page.mouse.click(...centre);
await waitIdle();
const after = await transformFeatures();
check("clicking the body creates the Transform", after.length === before + 1, `${before} -> ${after.length}`);
check("gizmo opened on the Rotate tab", (await fieldLabels()).startsWith("Along,Angle"), await fieldLabels());
const targetOk = after[after.length - 1]?.target ?? after[after.length - 1]?.targetId;
const bodyId = (await read({ read: "sceneSummary" })).bodies[0]?.id;
check("Transform targets a real body", Boolean(targetOk), JSON.stringify({ targetOk, bodyId }));
await dialog.getByRole("button", { name: "Cancel" }).first().click();
await waitIdle();
check(
  "Cancel removes the just-created Transform",
  (await transformFeatures()).length === before,
  String((await transformFeatures()).length),
);

// --- 6. With a single body selected, T goes straight to the gizmo ------------
await page.mouse.click(...centre);
await page.waitForTimeout(300);
check("a viewport click selects something", JSON.stringify(await read({ read: "selection" })) !== "[]");
await page.keyboard.press("t");
await waitIdle();
check("T created a Transform immediately", (await transformFeatures()).length === before + 1);
check("…and opened the Move tab (no arming step)", (await fieldLabels()).startsWith("Move X"), await fieldLabels());
await page.screenshot({ path: "/tmp/openshape-transform-arming.png" });
await dialog.getByRole("button", { name: "Cancel" }).first().click();
await waitIdle();

// --- 7. Scale row on an already-selected body opens Scale directly -----------
await page.mouse.click(...centre);
await page.waitForTimeout(300);
await openFlyout("scale");
await page.locator(".tb-more-list button", { hasText: "Transform ▸ Scale" }).first().click();
await waitIdle();
check(
  "Scale row on a selected body opens the Scale tab",
  (await fieldLabels()).startsWith("Factor"),
  await fieldLabels(),
);
await dialog.getByRole("button", { name: "Cancel" }).first().click();
await waitIdle();
check("document is back to its starting feature count", (await transformFeatures()).length === before);

// --- 8. A selection spanning two bodies arms rather than guessing -----------
await apply({ op: "addPrimitive", kind: "box", params: { width: 10, depth: 10, height: 10, x: 60 } });
await waitIdle();
const ids = (await read({ read: "sceneSummary" })).bodies.map((b) => b.id);
check("two bodies now exist", ids.length === 2, JSON.stringify(ids));
await apply({ op: "select", refs: ids.map((id) => ({ kind: "feature", id })) });
await page.waitForTimeout(250);
const n8 = (await transformFeatures()).length;
await page.keyboard.press("t");
await page.waitForTimeout(350);
check(
  "T on a two-body selection arms instead of picking one",
  (await dialog.locator(".ed-modes button.active").count()) === 1 && (await transformFeatures()).length === n8,
);
check(
  "…and it cleared the ambiguous selection",
  JSON.stringify(await read({ read: "selection" })) === "[]",
  JSON.stringify(await read({ read: "selection" })),
);
await page.keyboard.press("Escape");
await page.waitForTimeout(200);
check("Esc leaves no Transform behind", (await transformFeatures()).length === n8);

console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL PASS");
await close();
process.exit(failures ? 1 : 0);
