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
    stable = /up to date/i.test(s) ? stable + 1 : 0;
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
check("the armed body is named", (await rows().first().textContent()).trim().length > 0, await rows().first().textContent());
check("NO faces are armed — a plain Shell is sealed by default", (await faceRowCount()) === 0, `faceRows=${await faceRowCount()}`);
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
check("arming shows the active prompt", (await dialog.textContent()).includes("Click faces to open"));

await page.mouse.click(...centre);
await page.waitForTimeout(300);
check("clicking a face while armed adds it to the list", (await faceRowCount()) === 1, `faceRows=${await faceRowCount()}`);

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
check("it opens exactly the one face armed in the dialog", (shells[0]?.faces ?? []).length === 1, JSON.stringify(shells[0]?.faces));

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
check("dialog re-opens with the new body armed and no faces", (await faceRowCount()) === 0, `faceRows=${await faceRowCount()}`);
await dialog.getByRole("button", { name: "Create" }).click();
await waitIdle();

shells = await shellFeatures();
const sealed = shells.find((f) => f.targetId === box2.createdId);
check("the second shell was created", Boolean(sealed), JSON.stringify(shells.map((f) => f.targetId)));
check("it opens NO faces — a sealed hollow shell", (sealed?.faces ?? []).length === 0, JSON.stringify(sealed?.faces));

const scene = await read({ read: "sceneSummary" });
check("neither shell errored in the kernel", !scene.errors || Object.keys(scene.errors).length === 0, JSON.stringify(scene.errors));

await page.screenshot({ path: "/tmp/openpoly-shell-arming.png" });
console.log(failures === 0 ? "=== ALL CHECKS PASSED ===" : `=== ${failures} CHECK(S) FAILED ===`);
console.log("screenshot: /tmp/openpoly-shell-arming.png");
await browser.close();
process.exit(failures === 0 ? 0 : 1);
