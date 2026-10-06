// The extrude dialog's two pick slots must never both be armed.
//
// They read the SAME click stream (the ordinary selection raycaster, not the
// `picking` one), and handlePick checks the up-to-face slot FIRST — so whenever
// both are armed the face silently eats every click meant for the profile list.
// Choosing "Up to face" from the Extent dropdown used to arm the face
// unconditionally, including with no profile picked at all: both slots glowed,
// and the dialog could never be filled in the order it reads.
//
// The rule under test: the PROFILE always comes first. The face arms only when
// the extent asks for it AND there is already something to extrude, and either
// slot taking the stream hands it over explicitly.
//
// Run: `npm run dev`, then `URL=http://localhost:5173/ node scripts/verify-extrude-arming.mjs`.
import { launch, openPoly } from "./lib/harness.mjs";

const { page, close } = await launch({ collectErrors: false, width: 1400, height: 900 });
const { waitIdle, apply, read } = openPoly(page);
await waitIdle();

let failures = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}: ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

// A sketch on the box's top face to extrude, and a second body to reach up to.
const scene = await read({ read: "sceneSummary" });
const box = scene.bodies[0];
const top = box.faces.find((f) => f.includes("+z"));
const sk = await apply({
  op: "addSketch",
  plane: { bodyId: box.id, faceName: top },
  entities: [{ shape: "rect", center: [0, 0], w: 14, h: 14 }],
  name: "Boss",
});
await waitIdle();

const dialog = page.locator(".feature-dialog");
const armed = async () => (await dialog.locator(".ed-pick-btn.active").allTextContents()).map((t) => t.trim());

// --- 1. Open with NOTHING selected: the profile slot is the live one -------
await apply({ op: "select", refs: [] });
await page.waitForTimeout(200);
await page.keyboard.press("e");
await dialog.waitFor({ state: "visible", timeout: 5000 });
check(
  "the profile slot is armed on open",
  (await armed()).some((t) => /profile/i.test(t)),
  (await armed()).join(" | "),
);
check("…and it is the ONLY armed slot", (await armed()).length === 1, (await armed()).join(" | "));

// --- 2. Choosing "Up to face" with no profile must NOT steal the stream ----
const extent = dialog.locator("select").last();
await extent.selectOption("upToFace");
await page.waitForTimeout(500);
check(
  "choosing Up to face with no profile leaves the profile armed",
  (await armed()).some((t) => /profile/i.test(t)),
  (await armed()).join(" | "),
);
check("…and still only one slot is armed", (await armed()).length === 1, (await armed()).join(" | "));
check(
  "…with the face slot present but waiting",
  (await dialog.locator(".ed-pick-btn").allTextContents()).some((t) => /face/i.test(t)),
  (await dialog.locator(".ed-pick-btn").allTextContents()).join(" | "),
);

// --- 3. The next click fills the PROFILE, not the face ---------------------
const hb = await dialog.locator("[data-drag-handle]").first().boundingBox();
await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
await page.mouse.down();
await page.mouse.move(1180, 800, { steps: 8 });
await page.mouse.up();
await page.waitForTimeout(200);
// The sketch rectangle sits on the box's top face, at the middle of the frame.
await page.mouse.move(843, 420);
await page.waitForTimeout(120);
await page.mouse.down();
await page.mouse.up();
await page.waitForTimeout(600);
const rows = (await dialog.locator(".bool-operand-row").allTextContents()).join(" | ");
check("the click filled the profile list", /boss|region|face/i.test(rows), rows || "(nothing picked)");
check(
  "…and the face slot is still empty",
  !(await dialog.locator(".ed-field .bool-operand-row").allTextContents()).some((t) => /^On /i.test(t)),
  rows,
);

// --- 4. Asking for the face hands the stream over, exclusively -------------
await dialog.getByRole("button", { name: /Select a face/i }).click();
await page.waitForTimeout(400);
check(
  "clicking the face slot arms it",
  (await armed()).some((t) => /face/i.test(t)),
  (await armed()).join(" | "),
);
check("…and stands the profile list down", (await armed()).length === 1, (await armed()).join(" | "));

// --- 5. …and asking for profiles again takes it back ----------------------
await dialog.getByRole("button", { name: /profile/i }).click();
await page.waitForTimeout(400);
check(
  "re-arming profiles takes the stream back",
  (await armed()).some((t) => /profile/i.test(t)),
  (await armed()).join(" | "),
);
check("…exclusively", (await armed()).length === 1, (await armed()).join(" | "));

console.log(failures === 0 ? "=== ALL CHECKS PASSED ===" : `=== ${failures} CHECK(S) FAILED ===`);
await close();
process.exit(failures === 0 ? 0 : 1);
