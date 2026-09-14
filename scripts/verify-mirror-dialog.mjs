// The Mirror dialog: two pickers — a body, and the plane to mirror it across —
// plus a live ghost of the result.
//
// The plane used to be a <select> of named planes whose last option ("Body
// face…") armed a viewport pick. Two things were wrong with that. The pick is
// the shape that breaks (on macOS a select's popup is a native menu running its
// own event loop, and the first canvas click after it closes is swallowed, so
// the pick took two clicks — see the Transform dialog's axis control). And the
// list was a second control for a job the viewport already does: its plane-pick
// stream resolves a datum, a reference plane OR a planar face to one
// SketchPlaneRef, which is exactly what a mirror needs.
//
// Run: `npm run dev`, then `URL=http://localhost:5173/ node scripts/verify-mirror-dialog.mjs`.
import { launch, openPoly } from "./lib/harness.mjs";

const { page, close } = await launch({ collectErrors: false, width: 1400, height: 900 });
const { waitIdle, apply, read } = openPoly(page);
await waitIdle();

let failures = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}: ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

const scene = await read({ read: "sceneSummary" });
const box = scene.bodies[0];
// Sit the box off-origin so a mirror lands somewhere visibly different.
await apply({ op: "transform", targetId: box.id, tx: "80" });
await waitIdle();

await apply({ op: "select", refs: [{ kind: "feature", id: box.id }] });
await page.waitForTimeout(300);
await page.keyboard.press("m"); // Mirror
const dialog = page.locator(".extrude-dialog");
await dialog.waitFor({ state: "visible", timeout: 5000 });

// --- 1. Two pickers, no dropdown -----------------------------------------
check(
  "the dialog is titled for the feature, not for one kind of reference",
  ((await dialog.locator(".ed-title").textContent()) ?? "").trim() === "Mirror a body",
  ((await dialog.locator(".ed-title").textContent()) ?? "").trim(),
);
check(
  "…and the plane slot's heading names both kinds",
  (await dialog.locator(".bool-group-label").allTextContents()).some((t) => /plane or face/i.test(t)),
  (await dialog.locator(".bool-group-label").allTextContents()).join(" / "),
);
check("…with no dropdown at all", (await dialog.locator("select").count()) === 0);
const slotText = async () => (await dialog.locator(".bool-operand-row, .ed-pick-btn").allTextContents()).join(" | ");
check("the body it opened with is already filled", /Box/i.test(await slotText()), await slotText());
check(
  "…and the plane slot — not the body — is the armed one",
  /plane or face/i.test(((await dialog.locator(".ed-pick-btn.active").textContent()) ?? "").trim()),
  ((await dialog.locator(".ed-pick-btn.active").textContent()) ?? "").trim(),
);
check(
  "…with nothing in the dialog holding focus",
  (await page.evaluate(() => document.activeElement?.tagName)) === "BODY",
  await page.evaluate(() => document.activeElement?.tagName),
);
const banner = (await page.locator(".sketch-banner.pick span").textContent())?.trim() ?? "";
check("the banner names all three kinds of plane", /datum/i.test(banner) && /face/i.test(banner), banner);
check("Create is refused until a plane is picked", await dialog.getByRole("button", { name: "Create" }).isDisabled());
check("the plane slot asks for either kind of reference", /plane or face/i.test(await slotText()), await slotText());

// --- 1b. Opening with NOTHING selected advances the same way --------------
// The body slot arms first; filling it by click has to hand the arming straight
// to the plane, or the dialog sits waiting on a button the user has to find.
await dialog.getByRole("button", { name: "Cancel" }).click();
await page.waitForTimeout(300);
await apply({ op: "select", refs: [] });
await page.waitForTimeout(200);
await page.keyboard.press("m");
await dialog.waitFor({ state: "visible", timeout: 5000 });
const armedSlot = async () =>
  (
    (await dialog
      .locator(".ed-pick-btn.active")
      .textContent()
      .catch(() => "")) ?? ""
  ).trim();
check("with nothing selected, the BODY slot arms first", /Select a body/i.test(await armedSlot()), await armedSlot());
const hbA = await dialog.locator("[data-drag-handle]").first().boundingBox();
await page.mouse.move(hbA.x + hbA.width / 2, hbA.y + hbA.height / 2);
await page.mouse.down();
await page.mouse.move(1180, 800, { steps: 8 });
await page.mouse.up();
await page.waitForTimeout(200);
// Click the box (it sits out to the right after the transform above).
await page.mouse.move(1060, 560);
await page.waitForTimeout(120);
await page.mouse.down();
await page.mouse.up();
await page.waitForTimeout(600);
check("clicking a body fills it", /Box/i.test(await slotText()), await slotText());
check("…and hands the arming straight to the plane slot", /plane or face/i.test(await armedSlot()), await armedSlot());

// --- 2. One click on a datum plane fills it ------------------------------
// Click the Top datum out to the left of the body (the dialog is already clear).
await page.mouse.move(690, 470);
await page.waitForTimeout(120);
await page.mouse.down();
await page.mouse.up();
await page.waitForTimeout(600);
check("one click on a datum plane fills the plane slot", /plane/i.test(await slotText()), await slotText());
check('…named, not just "Face"', /Top plane/i.test(await slotText()), await slotText());
check("…and Create is now allowed", await dialog.getByRole("button", { name: "Create" }).isEnabled());

// --- 3. It builds where the ghost showed ---------------------------------
await dialog.getByRole("button", { name: "Create" }).click();
await waitIdle();
const after = await read({ read: "sceneSummary" });
const mir = (await read({ read: "document" })).features.filter((f) => f.type === "mirror").at(-1);
check("the mirror was created", Boolean(mir), JSON.stringify(mir?.plane));
check("…storing the plane as a reference", mir?.plane?.kind === "datum", JSON.stringify(mir?.plane));
const mirBody = after.bodies.find((b) => b.id === mir?.id);
// The box sits on z = 0, so mirroring across Top drops the copy below ground.
check("…reflected across it", mirBody && mirBody.bbox.max[2] <= 1e-6, JSON.stringify(mirBody?.bbox));
check("the original is kept", after.bodies.length === 2, String(after.bodies.length));
check("no feature errored", Object.keys(after.errors ?? {}).length === 0, JSON.stringify(after.errors));

// --- 4. A genuinely curved face is refused --------------------------------
// A SPHERE, not a cylinder: this build facets its cylinders into 48-gon prisms
// (see BACKLOG), so a cylinder's wall strip is a real planar face and mirroring
// across it is legitimate. A sphere stays analytic, so its surface is the one
// primitive that is actually curved.
const cyl = await apply({ op: "addPrimitive", kind: "sphere", params: { radius: "35" } });
await waitIdle();
await apply({ op: "select", refs: [{ kind: "feature", id: cyl.createdId }] });
await page.waitForTimeout(300);
await page.keyboard.press("m");
await dialog.waitFor({ state: "visible", timeout: 5000 });
const hb2 = await dialog.locator("[data-drag-handle]").first().boundingBox();
await page.mouse.move(hb2.x + hb2.width / 2, hb2.y + hb2.height / 2);
await page.mouse.down();
await page.mouse.move(1180, 800, { steps: 8 });
await page.mouse.up();
await page.waitForTimeout(200);
// The sphere sits at the origin, filling the middle of the frame.
await page.mouse.move(843, 440);
await page.waitForTimeout(120);
await page.mouse.down();
await page.mouse.up();
await page.waitForTimeout(600);
const stillArmed = (await dialog.locator(".ed-pick-btn.active").count()) === 1;
const msg = (
  (await page
    .locator(".sketch-msg")
    .textContent()
    .catch(() => "")) ?? ""
).trim();
check("a curved face is refused, keeping the pick armed", stillArmed, `${await slotText()}${msg ? ` / ${msg}` : ""}`);
await dialog.getByRole("button", { name: "Cancel" }).click();

console.log(failures === 0 ? "=== ALL CHECKS PASSED ===" : `=== ${failures} CHECK(S) FAILED ===`);
await close();
process.exit(failures === 0 ? 0 : 1);
