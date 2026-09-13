// Finishing a sketch must end its Mirror / Pattern session.
//
// Both sessions live on outside the sketch if finishSketch doesn't clear them.
// Their panels hide (guarded on `editingSketch`) and their commits bail, so the
// leak is invisible until a key is pressed: the `app.cancel` chain tests
// `mirrorSessionRef` / `patternSessionRef` near its top, above every dialog, so
// the first Escape after such a sketch is spent clearing a session nobody can
// see instead of closing what's on screen.
//
// The probe: finish a sketch with the tool armed, open the Reference plane
// dialog (not a Modal — Modal eats Escape on capture and would mask this),
// press Escape once, and require the dialog to be gone.
import { chromium } from "playwright";

const URL = process.env.APP_URL ?? "http://localhost:5173/";
const exe = process.env.PW_EXE ?? chromium.executablePath();
const browser = await chromium.launch({ executablePath: exe });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2 });
page.on("pageerror", (e) => console.log("PAGEERROR", e.message));
await page.goto(URL, { waitUntil: "domcontentloaded" });

const waitIdle = async () => {
  for (let i = 0; i < 80; i++) {
    const t = await page
      .locator(".status")
      .first()
      .textContent()
      .catch(() => null);
    if (t && /up to date/i.test(t)) return t;
    await page.waitForTimeout(200);
  }
  return "TIMEOUT";
};
const apply = (o) => page.evaluate((x) => window.__openpoly.apply(x), o);

let failures = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};
const press = async (k) => {
  await page.evaluate(() => document.activeElement?.blur());
  await page.keyboard.press(k);
  await page.waitForTimeout(250);
};
const planeDialogOpen = () =>
  page
    .locator(".ed-title", { hasText: "Reference plane" })
    .isVisible()
    .catch(() => false);

await waitIdle();

for (const [toolKey, toolName] of [
  ["m", "Mirror"],
  ["x", "Pattern"],
]) {
  // A sketch with one line, opened for editing.
  const r = await apply({
    op: "addSketch",
    plane: { datum: "top" },
    entities: [{ shape: "line", a: [-20, 0], b: [20, 0] }],
  });
  await waitIdle();
  await page.locator(".tree-row", { hasText: "Sketch" }).last().dblclick();
  await page.waitForTimeout(800);

  await press(toolKey); // arms the session
  await page.locator("button", { hasText: "Finish sketch" }).first().click();
  await page.waitForTimeout(400);

  await press("p");
  check(`[${toolName}] the plane dialog opened`, await planeDialogOpen());

  await press("Escape");
  check(`[${toolName}] one Escape closed it — no session ate the key`, !(await planeDialogOpen()));

  // Clean up for the next round, whatever state we're in.
  await press("Escape");
  await apply({ op: "delete", featureId: r.createdId }).catch(() => {});
  await waitIdle();
}

console.log(failures ? `\n${failures} FAILED` : "\nall checks passed");
await browser.close();
process.exit(failures ? 1 : 0);
