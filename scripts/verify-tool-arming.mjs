// UI verification for the always-enabled modeling tools.
//
// Extrude, Sweep, Loft, Chamfer, Fillet, Boolean and Mirror used to be DISABLED
// until the right things were already selected, so a tool could never be reached
// first and satisfied second. Each now opens a dialog that arms what it needs —
// the pattern Revolve, Shell, Pattern and Transform already followed.
//
// This drives the real pointer/keyboard UI, because everything under test lives
// in the arming layer: which button is enabled, which slot is listening, what a
// viewport click lands in, and whether Esc disarms before it closes. None of
// that reaches the kernel, so the agent-API scripts can't see it.
//
// Run against a local dev server: `npm run dev`, then
// `URL=http://localhost:5174/ node scripts/verify-tool-arming.mjs`.
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
    stable = /up to date|error/i.test(s) ? stable + 1 : 0;
    if (stable >= 3) return;
    await page.waitForTimeout(300);
  }
  throw new Error("app never settled");
};
await waitIdle();

const apply = (o) => page.evaluate((x) => window.__openpoly.apply(x), o);
const read = (q) => page.evaluate((x) => window.__openpoly.read(x), q);
let failures = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}: ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

const dlg = page.locator(".extrude-dialog");
const rows = () => dlg.locator(".bool-operand-row");
const armedButtons = () => dlg.locator(".ed-pick-btn.active");
const blur = () => page.evaluate(() => document.activeElement?.blur());
const features = async (type) => (await read({ read: "document" })).features.filter((f) => f.type === type);
/** Press a modeling shortcut from a clean slate: nothing selected, no focus in
 *  a dialog field (both of which would swallow the key). */
const pressTool = async (key) => {
  await apply({ op: "select", refs: [] });
  await blur();
  await page.keyboard.press(key);
  await page.waitForTimeout(400);
};
const cancel = async () => {
  const btn = dlg.getByRole("button", { name: "Cancel" });
  if (await btn.count()) await btn.first().click();
  await page.waitForTimeout(300);
};

let canvas = await page.locator("canvas").first().boundingBox();
const clickWorld = async (w) => {
  const s = await page.evaluate((p) => window.__openpoly.worldToScreen(p), w);
  if (!s) return false;
  await page.mouse.click(canvas.x + s.x, canvas.y + s.y);
  await page.waitForTimeout(400);
  return true;
};

// --- Scene ------------------------------------------------------------------
// Two stacked square sections (loft/sweep/extrude profiles) well clear of a
// box (the body Chamfer/Fillet/Mirror/Boolean work on).
await apply({ op: "newDocument" });
await waitIdle();
const skA = await apply({
  op: "addSketch",
  plane: { datum: "top" },
  entities: [{ shape: "rect", center: [-60, 0], w: 30, h: 30 }],
});
await waitIdle();
const planeUp = await apply({ op: "addPlane", method: "offset", base: { datum: "top" }, offset: 40 });
await waitIdle();
const skB = await apply({
  op: "addSketch",
  plane: { planeId: planeUp.createdId },
  entities: [{ shape: "rect", center: [-60, 0], w: 18, h: 18 }],
});
await waitIdle();
// Sweep gets its own profile + path, well clear of the loft stack (and of the
// solid the extrude leaves behind, which would otherwise sit between the camera
// and the path line).
const skC = await apply({
  op: "addSketch",
  plane: { datum: "top" },
  entities: [{ shape: "rect", center: [60, 0], w: 12, h: 12 }],
});
await waitIdle();
const skPath = await apply({
  op: "addSketch",
  plane: { datum: "front" },
  entities: [{ shape: "line", a: [60, 0], b: [60, 45] }],
});
await waitIdle();
const box = await apply({ op: "addPrimitive", kind: "box", params: { width: 30, depth: 30, height: 30 } });
await waitIdle();
check("scene built", skA.ok && skB.ok && skC.ok && skPath.ok && box.ok);

const regionA = [-60, 0, 0];
const regionB = [-60, 0, 40];
const regionC = [60, 0, 0];
const pathMid = [60, 0, 30];
const boxTop = [0, 0, 30];

// --- 1. Every one of the seven is enabled with NOTHING selected -------------
await apply({ op: "select", refs: [] });
await page.waitForTimeout(200);
for (const label of ["Extrude", "Sweep", "Loft", "Chamfer", "Fillet", "Boolean", "Mirror"]) {
  const btn = page.locator(".model-toolbar button").filter({ hasText: label }).first();
  const present = (await btn.count()) > 0;
  check(
    `${label} is enabled with an empty selection`,
    present && !(await btn.isDisabled()),
    present ? "" : "not in the visible toolbar",
  );
}

// --- 2. Extrude arms its profile list ---------------------------------------
await pressTool("e");
check("Extrude opens with nothing selected", await dlg.filter({ hasText: "Extrude" }).isVisible());
check("…with the profile slot already listening", (await armedButtons().count()) === 1, await dlg.textContent());
check("…and no profile filled in", (await rows().count()) === 0);
check("…so Create is held back", await dlg.getByRole("button", { name: "Create" }).isDisabled());

await clickWorld(regionA);
check("clicking a sketch region fills the list", (await rows().count()) === 1, await dlg.textContent());
await clickWorld(regionB);
check("a second region accumulates", (await rows().count()) === 2, await dlg.textContent());
await clickWorld(regionB);
check("clicking a listed region again drops it", (await rows().count()) === 1);
check(
  "…and Create is live once something is picked",
  !(await dlg.getByRole("button", { name: "Create" }).isDisabled()),
);

await blur();
await page.keyboard.press("Escape");
await page.waitForTimeout(250);
check("Esc disarms but keeps the dialog", await dlg.isVisible());
check("…and keeps what was picked", (await rows().count()) === 1, await dlg.textContent());
await dlg.getByRole("button", { name: "Create" }).click();
await waitIdle();
check("Extrude created from a dialog-armed profile", (await features("extrude")).length === 1);

// --- 3. Sweep: profile, then path, auto-advancing ---------------------------
await pressTool("w");
const sweepDlg = dlg.filter({ hasText: "Sweep" });
check("Sweep opens with nothing selected", await sweepDlg.isVisible());
check("…armed on the profile", (await armedButtons().count()) === 1, await dlg.textContent());
await clickWorld(regionC);
check(
  "picking the profile hands the arming to the path",
  (await armedButtons().count()) === 1 && (await dlg.textContent()).includes("Path"),
  await dlg.textContent(),
);
await clickWorld(pathMid);
check("picking the path fills the second slot", (await armedButtons().count()) === 0, await dlg.textContent());
await dlg.getByRole("button", { name: "Create" }).click();
await waitIdle();
check("Sweep created from two armed picks", (await features("sweep")).length === 1);

// --- 4. Loft accumulates sections in pick order ------------------------------
await pressTool("l");
check("Loft opens with nothing selected", await dlg.filter({ hasText: "Loft" }).isVisible());
check("…and needs two sections before Create", await dlg.getByRole("button", { name: "Create" }).isDisabled());
await clickWorld(regionA);
await clickWorld(regionB);
check("two picked sections list", (await rows().count()) === 2, await dlg.textContent());
check("…and Create is live", !(await dlg.getByRole("button", { name: "Create" }).isDisabled()));
await dlg.getByRole("button", { name: "Create" }).click();
await waitIdle();
check("Loft created from dialog-armed sections", (await features("loft")).length === 1);

// --- 5. Chamfer / Fillet arm their edge list ---------------------------------
canvas = await page.locator("canvas").first().boundingBox();
await pressTool("c");
check("Chamfer opens with nothing selected", await dlg.filter({ hasText: "Chamfer" }).isVisible());
check("…armed on the edge list", (await armedButtons().count()) === 1, await dlg.textContent());
check(
  "…with Create held back until something is picked",
  await dlg.getByRole("button", { name: "Create" }).isDisabled(),
);
await clickWorld(boxTop);
check("clicking a face of the body fills the list", (await rows().count()) === 1, await dlg.textContent());
check("…and Create comes live", !(await dlg.getByRole("button", { name: "Create" }).isDisabled()));
await dlg.getByRole("button", { name: "Create" }).click();
await waitIdle();
check("Chamfer created from a dialog-armed face", (await features("dressup")).length === 1);

await pressTool("f");
check("Fillet opens the same way", await dlg.filter({ hasText: "Fillet" }).isVisible());
check("…armed, with nothing picked", (await armedButtons().count()) === 1 && (await rows().count()) === 0);
await cancel();

// --- 6. Boolean opens even with too few bodies -------------------------------
await pressTool("b");
const boolDlg = page.locator(".boolean-dialog");
check("Boolean opens without a two-body pre-condition", await boolDlg.isVisible());
const boolText = await boolDlg.textContent();
const bodies = (await read({ read: "sceneSummary" })).bodies.length;
check(
  bodies < 2 ? "…and says why there is nothing to pick" : "…and offers the parts to pick",
  bodies < 2 ? boolText.includes("two solid bodies") : !boolText.includes("two solid bodies"),
  `${bodies} bodies :: ${boolText.slice(0, 120)}`,
);
await cancel();

// --- 7. Mirror arms its body -------------------------------------------------
await pressTool("m");
check("Mirror opens with nothing selected", await dlg.filter({ hasText: "Mirror" }).isVisible());
check("…armed on the body", (await armedButtons().count()) === 1, await dlg.textContent());
check("…with Create held back", await dlg.getByRole("button", { name: "Create" }).isDisabled());
await clickWorld(boxTop);
check("clicking the body fills the slot", (await rows().count()) === 1, await dlg.textContent());
await dlg.getByRole("button", { name: "Create" }).click();
await waitIdle();
check("Mirror created from a dialog-armed body", (await features("mirror")).length === 1);

// --- 8. A pre-selection still prefills, costing no extra pick ----------------
const scene = await read({ read: "sceneSummary" });
const boxBody = scene.bodies.find((b) => b.id === box.createdId) ?? scene.bodies[0];
await apply({ op: "select", refs: [{ kind: "feature", id: boxBody.id }] });
await blur();
// The select has to reach React state before the key is pressed — the prefill
// reads the selection at the moment the dialog opens.
await page.waitForTimeout(400);
await page.keyboard.press("m");
await page.waitForTimeout(400);
check("Mirror prefills from a selected body", (await rows().count()) === 1, await dlg.textContent());
check("…and nothing is left armed", (await armedButtons().count()) === 0, await dlg.textContent());
await cancel();

console.log(failures ? `\n${failures} FAILURE(S)` : "\nall checks passed");
await browser.close();
process.exit(failures ? 1 : 0);
