// UI verification for Shell arming: the tool must arm the BODY (never a face)
// however the user clicked, and take faces to open only from the dialog.
//
// The kernel path is covered by verify-shell.mjs, which drives the agent API
// directly. This one drives the real pointer/keyboard UI, because the bug it
// guards against — "I clicked a face, so Shell opened that face" — lives
// entirely in the arming layer and never reaches the kernel.
//
// Run against a local dev server: `npm run dev`, then
// `URL=http://localhost:5174/ node scripts/verify-shell-arming.mjs`.
import { chromium } from "playwright";

const URL = process.env.URL ?? "http://localhost:5173/";
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1660, height: 920 }, deviceScaleFactor: 2 });
const page = await context.newPage();
page.on("pageerror", (e) => console.log(`[pageerror] ${e.message}`));

await page.goto(URL, { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => window.__openpoly, null, { timeout: 30000 });

const waitIdle = async () => {
  let stable = 0;
  for (let i = 0; i < 80; i++) {
    const s = (await page.locator(".status").textContent())?.trim() ?? "";
    // "N error(s)" is a SETTLED state too, not a stall: cases 6 and 7 build a
    // wall the kernel refuses on purpose, and that feature stays in the
    // timeline carrying its error — waiting only for "up to date" would spin
    // out the timeout on exactly the cases under test.
    stable = /up to date|error/i.test(s) ? stable + 1 : 0;
    if (stable >= 3) return;
    await page.waitForTimeout(300);
  }
  throw new Error("app never settled");
};
await waitIdle();

const apply = (op) => page.evaluate((o) => window.__openpoly.apply(o), op);
const read = (q) => page.evaluate((o) => window.__openpoly.read(o), q);

let failures = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}: ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

const dialog = page.locator(".extrude-dialog").filter({ hasText: "Shell" });
const rows = () => dialog.locator(".bool-operand-row");
// Row 0 is the armed body; every row after it is a face to open.
const faceRowCount = async () => Math.max(0, (await rows().count()) - 1);
const shellFeatures = async () => (await read({ read: "document" })).features.filter((f) => f.type === "shell");

// --- Setup: a face of the app's starting box, clicked in the viewport ------
// The new-document template already contains "Box 1" sitting at the origin, so
// use it rather than adding another body on top of it.
const startScene = await read({ read: "sceneSummary" });
const boxId = startScene.bodies[0]?.id;
check("starting document has a body to shell", Boolean(boxId), JSON.stringify(startScene.bodies?.map((b) => b.id)));

const canvas = page.locator("canvas").first();
const cbox = await canvas.boundingBox();
const centre = [cbox.x + cbox.width / 2, cbox.y + cbox.height / 2];
// Dead centre of the viewport lands on a face of the box — exactly the click a
// user makes before reaching for Shell.
await page.mouse.click(...centre);
await page.waitForTimeout(400);
const picked = await read({ read: "selection" });
check(
  "clicking the body selects a FACE (the pre-condition for the bug)",
  JSON.stringify(picked).includes('"face"'),
  JSON.stringify(picked).slice(0, 200),
);

// --- 1. Shell arms the BODY, not the clicked face --------------------------
await page.keyboard.press("g");
await dialog.waitFor({ state: "visible", timeout: 5000 });
const text = await dialog.textContent();
check("Shell dialog opened from a face pick", await dialog.isVisible());
check("dialog has a Body section", text.includes("Body"), text.slice(0, 160));
check(
  "the armed body is named",
  (await rows().first().textContent()).trim().length > 0,
  await rows().first().textContent(),
);
check(
  "NO faces are armed — a plain Shell is sealed by default",
  (await faceRowCount()) === 0,
  `faceRows=${await faceRowCount()}`,
);
check("the optional faces section is offered", text.includes("Faces to open (optional)"), text.slice(0, 200));

// The selection is promoted to the whole body, so what's highlighted matches
// what the dialog says is armed.
const afterOpen = await read({ read: "selection" });
check(
  "selection was promoted to the whole body",
  JSON.stringify(afterOpen).includes('"feature"') && !JSON.stringify(afterOpen).includes('"face"'),
  JSON.stringify(afterOpen).slice(0, 200),
);

// --- 2. Faces are armed only through the dialog's own picker ---------------
// A viewport click BEFORE arming must not add a face.
await page.mouse.click(...centre);
await page.waitForTimeout(300);
check("a stray viewport click does not arm a face", (await faceRowCount()) === 0, `faceRows=${await faceRowCount()}`);

await dialog.getByRole("button", { name: /Select faces/ }).click();
// "Selecting …" is the shared arming vocabulary (see PickSlot's pickLabel), and
// the accumulating slots add how to stop. This assertion is on the COPY, so it
// goes stale when the wording moves: it last read "Click faces to open", which
// 31132fd replaced when every slot was put on the one three-state cycle.
check(
  "arming shows the active prompt",
  (await dialog.textContent()).includes("Selecting faces…"),
  await dialog.textContent(),
);

await page.mouse.click(...centre);
await page.waitForTimeout(300);
check(
  "clicking a face while armed adds it to the list",
  (await faceRowCount()) === 1,
  `faceRows=${await faceRowCount()}`,
);

await page.mouse.click(...centre);
await page.waitForTimeout(300);
check("clicking the same face again un-arms it", (await faceRowCount()) === 0, `faceRows=${await faceRowCount()}`);

await page.mouse.click(...centre);
await page.waitForTimeout(300);
await page.keyboard.press("Escape");
await page.waitForTimeout(200);
check("Esc disarms the picker but keeps the dialog", await dialog.isVisible());
check("…and keeps the face already picked", (await faceRowCount()) === 1, `faceRows=${await faceRowCount()}`);

await dialog.getByRole("button", { name: "Create" }).click();
await waitIdle();
let shells = await shellFeatures();
check("a shell feature was created", shells.length === 1, JSON.stringify(shells.map((f) => f.id)));
check("it targets the clicked body", shells[0]?.targetId === boxId, String(shells[0]?.targetId));
check(
  "it opens exactly the one face armed in the dialog",
  (shells[0]?.faces ?? []).length === 1,
  JSON.stringify(shells[0]?.faces),
);

// --- 3. The default path: arm and commit without touching faces ------------
const box2 = await apply({ op: "addPrimitive", kind: "box", params: { width: 24, depth: 24, height: 24 } });
check("second box created", box2.ok, JSON.stringify(box2).slice(0, 160));
await waitIdle();
// Select it through the agent so this case doesn't depend on where it lands
// on screen; the arming path under test is the same either way.
await apply({ op: "select", refs: [{ kind: "feature", id: box2.createdId }] });
await page.waitForTimeout(200);
await page.keyboard.press("g");
await dialog.waitFor({ state: "visible", timeout: 5000 });
check(
  "dialog re-opens with the new body armed and no faces",
  (await faceRowCount()) === 0,
  `faceRows=${await faceRowCount()}`,
);
await dialog.getByRole("button", { name: "Create" }).click();
await waitIdle();

shells = await shellFeatures();
const sealed = shells.find((f) => f.targetId === box2.createdId);
check("the second shell was created", Boolean(sealed), JSON.stringify(shells.map((f) => f.targetId)));
check("it opens NO faces — a sealed hollow shell", (sealed?.faces ?? []).length === 0, JSON.stringify(sealed?.faces));

// --- 4. Shell opens with NOTHING selected, and arms its body from there ----
// The tool used to be disabled until a body was already selected, which made it
// the only body-consuming tool you couldn't reach by pressing its key. It now
// follows Revolve: always available, and the role it needs is armed inside the
// dialog. A pre-selected body still prefills it (cases 1 and 3 above) — this is
// the empty-handed path.
await apply({ op: "select", refs: [] });
await page.waitForTimeout(200);
await page.keyboard.press("g");
await dialog.waitFor({ state: "visible", timeout: 5000 });
check("Shell opens with nothing selected at all", await dialog.isVisible());
const emptyText = await dialog.textContent();
check("…with no body filled in", (await rows().count()) === 0, `rows=${await rows().count()}`);
check("…and the body slot already listening for a click", emptyText.includes("Selecting a body…"), emptyText);
check(
  "…while the faces slot stays inert until there's a body",
  await dialog.getByRole("button", { name: /Select faces/ }).isDisabled(),
);

await page.mouse.click(...centre);
await page.waitForTimeout(400);
check("clicking a body in the viewport arms it", (await rows().count()) === 1, await dialog.textContent());
check("…and no face came along with it", (await faceRowCount()) === 0, `faceRows=${await faceRowCount()}`);
check(
  "…and the faces slot is live now that a body is armed",
  !(await dialog.getByRole("button", { name: /Select faces/ }).isDisabled()),
);

// There is no speculative rebuild behind the dialog any more, so arming a body
// says nothing about whether the wall will work — the answer comes from the
// regeneration Create triggers. Nothing should be claimed before then.
await page.waitForTimeout(1200);
const armedText = await dialog.textContent();
check(
  "arming a body makes no claim about the wall before Create is pressed",
  !armedText.includes("Shell failed on this geometry"),
  armedText,
);
check(
  "…and Create is offered, not pre-emptively disabled",
  !(await dialog.getByRole("button", { name: "Create" }).isDisabled()),
);

await dialog.getByRole("button", { name: "Cancel" }).click();
await page.waitForTimeout(200);
check(
  "Cancel closes it without adding a feature",
  (await shellFeatures()).length === 2,
  `${(await shellFeatures()).length} shells`,
);

const scene = await read({ read: "sceneSummary" });
check(
  "neither shell errored in the kernel",
  !scene.errors || Object.keys(scene.errors).length === 0,
  JSON.stringify(scene.errors),
);

// --- 5. EDITING a shell to add a face to open ------------------------------
// The flow that was reported broken: shell something sealed, then go back and
// open a face. Creating a shell with faces is covered above; what this adds is
// the EDIT path — reopening the dialog from the timeline, arming the faces slot
// against a body that is already hollow, and having the pick stick through
// Done. The kernel half of it is verify-shell-loft's business; this is the UI.
// A fresh document, so the body under the cursor is unambiguous: three nested
// boxes at the origin and a centre click lands on whichever is outermost, not
// necessarily the one the dialog has armed.
await apply({ op: "newDocument", name: "verify-shell-arming-edit" });
await waitIdle();
const box3 = await apply({ op: "addPrimitive", kind: "box", params: { width: 30, depth: 30, height: 30 } });
await waitIdle();
const sealed3 = await apply({ op: "shell", targetId: box3.createdId, faces: [], thickness: 3 });
await waitIdle();
check("a sealed shell to edit", sealed3.ok, JSON.stringify(sealed3).slice(0, 120));
const shellId = (await shellFeatures()).find((f) => f.targetId === box3.createdId)?.id;
check(
  "…and it opens no faces to begin with",
  (await shellFeatures()).find((f) => f.id === shellId)?.faces.length === 0,
);

// Reopen it the way a user does: double-click its timeline row.
await page.locator(".tree-row, .feature-row").filter({ hasText: "Shell" }).first().dblclick();
await dialog.waitFor({ state: "visible", timeout: 5000 });
check("double-clicking the feature reopens it for editing", (await dialog.textContent()).includes("Edit Shell"));
check("…with the shell's own body already filled in", (await rows().count()) === 1, `${await rows().count()} rows`);
check("…and no faces, matching the feature", (await faceRowCount()) === 0, `faceRows=${await faceRowCount()}`);

await dialog.getByRole("button", { name: /Select faces/ }).click();
await page.waitForTimeout(300);
// Off the centre: the box's near vertical edge runs right through it, and an
// edge pick is not a face pick — this wants a clear patch of the left face.
await page.mouse.click(centre[0] - 60, centre[1] + 20);
await page.waitForTimeout(400);
check("clicking a face of the hollow body arms it", (await faceRowCount()) === 1, `faceRows=${await faceRowCount()}`);

await dialog.getByRole("button", { name: "Done" }).click();
await waitIdle();
const edited = (await shellFeatures()).find((f) => f.id === shellId);
check(
  "…and Done writes it to the feature — the edit sticks",
  (edited?.faces ?? []).length === 1,
  JSON.stringify(edited?.faces),
);
check("…without disturbing the thickness it already had", String(edited?.thickness) === "3", String(edited?.thickness));

// --- 6. A Create the kernel refuses ----------------------------------------
// The dialog commits the feature and reads the verdict off the real
// regeneration rather than rehearsing it in a throwaway copy. So a wall the
// geometry can't take has to leave the timeline in a coherent state: the
// feature stays, carrying its error where every other failed feature carries
// one, and the dialog stays open on top of it so the number can be fixed in
// place. Pressing Create again must UPDATE that feature, never add a second.
await apply({ op: "newDocument", name: "verify-shell-arming-refused" });
await waitIdle();
const box4 = await apply({ op: "addPrimitive", kind: "box", params: { width: 20, depth: 20, height: 20 } });
await waitIdle();
await apply({ op: "select", refs: [{ kind: "feature", id: box4.createdId }] });
await page.waitForTimeout(200);
await page.keyboard.press("g");
await dialog.waitFor({ state: "visible", timeout: 5000 });
const thickness = dialog.locator("input").first();
await thickness.fill("40"); // twice the box — the walls cannot meet
await dialog.getByRole("button", { name: "Create" }).click();
await waitIdle();
check("an impossible wall leaves the dialog open", await dialog.isVisible());
check(
  "…still presenting itself as the creation it is, not an edit",
  (await dialog.textContent()).startsWith("Shell") &&
    (await dialog.getByRole("button", { name: "Create" }).count()) === 1,
  (await dialog.textContent()).slice(0, 60),
);
check(
  "…with the kernel's reason shown in it",
  /doesn't work for this body|thinner wall|too thick|walls may collide/i.test(await dialog.textContent()),
  (await dialog.textContent()).slice(0, 220),
);
let shells4 = await shellFeatures();
check("…and exactly one shell feature in the timeline", shells4.length === 1, `${shells4.length} shells`);
check(
  "…which is flagged as failed, like any other broken feature",
  Boolean((await read({ read: "sceneSummary" })).errors?.[shells4[0]?.id]),
  JSON.stringify((await read({ read: "sceneSummary" })).errors ?? {}).slice(0, 160),
);

// Fix it in place: the retry must edit that feature, not add another.
await thickness.fill("2");
await dialog.getByRole("button", { name: "Create" }).click();
await waitIdle();
check("fixing the wall closes the dialog", !(await dialog.isVisible().catch(() => false)));
shells4 = await shellFeatures();
check("…still exactly one shell, updated in place", shells4.length === 1, `${shells4.length} shells`);
check("…carrying the corrected thickness", String(shells4[0]?.thickness) === "2", String(shells4[0]?.thickness));
check(
  "…and the document is clean again",
  Object.keys((await read({ read: "sceneSummary" })).errors ?? {}).length === 0,
  JSON.stringify((await read({ read: "sceneSummary" })).errors ?? {}),
);

// --- 7. Cancelling after a refused Create takes the feature with it --------
await apply({ op: "newDocument", name: "verify-shell-arming-cancel" });
await waitIdle();
const box5 = await apply({ op: "addPrimitive", kind: "box", params: { width: 20, depth: 20, height: 20 } });
await waitIdle();
await apply({ op: "select", refs: [{ kind: "feature", id: box5.createdId }] });
await page.waitForTimeout(200);
await page.keyboard.press("g");
await dialog.waitFor({ state: "visible", timeout: 5000 });
await dialog.locator("input").first().fill("40");
await dialog.getByRole("button", { name: "Create" }).click();
await waitIdle();
check("the refused feature is there to begin with", (await shellFeatures()).length === 1);
await dialog.getByRole("button", { name: "Cancel" }).click();
await waitIdle();
check(
  "cancelling removes the feature it never got working",
  (await shellFeatures()).length === 0,
  `${(await shellFeatures()).length} shells`,
);
check(
  "…leaving no errors behind",
  Object.keys((await read({ read: "sceneSummary" })).errors ?? {}).length === 0,
  JSON.stringify((await read({ read: "sceneSummary" })).errors ?? {}),
);

await page.screenshot({ path: "/tmp/openpoly-shell-arming.png" });
console.log(failures === 0 ? "=== ALL CHECKS PASSED ===" : `=== ${failures} CHECK(S) FAILED ===`);
console.log("screenshot: /tmp/openpoly-shell-arming.png");
await browser.close();
process.exit(failures === 0 ? 0 : 1);
