// Throwaway verification for the chamfer ANGLE setting:
//  1. an angled chamfer builds (OCCT's distance-angle path), and produces a
//     visibly DIFFERENT solid from the default symmetric 45° cut;
//  2. `flip` swaps which adjacent face the distance/angle are measured from,
//     so the same angle mirrors — and flipping a 45° chamfer changes nothing
//     (it's symmetric);
//  3. an angle the geometry can't fit fails with the dress-up error copy;
//  4. the angle is a real parameter: set_param re-drives it.
// Comparisons are pixel comparisons of a fixed front-view screenshot — no
// volume read is exposed to the bridge.
import { chromium } from "playwright";

const URL = process.env.URL ?? "http://localhost:5174/";
// CHROMIUM_PATH lets a sandbox point at an already-installed browser instead of
// the build Playwright would download.
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
const context = await browser.newContext({
  viewport: { width: 1660, height: 920 },
  deviceScaleFactor: 2,
});
const page = await context.newPage();
page.on("pageerror", (e) => console.log(`[pageerror] ${e.message}`));

await page.goto(URL, { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => window.__openpoly, null, { timeout: 30000 });
// Settled = the regen finished, whether it succeeded ("up to date") or left the
// document in an error state — one of the checks below deliberately provokes the
// latter, and it must not hang the run.
const waitIdle = async ({ allowError = false } = {}) => {
  let stable = 0;
  for (let i = 0; i < 80; i++) {
    const s = (await page.locator(".status").textContent())?.trim() ?? "";
    const done = /up to date/i.test(s) || (allowError && /error|fail/i.test(s));
    stable = done ? stable + 1 : 0;
    if (stable >= 3) return;
    await page.waitForTimeout(300);
  }
  throw new Error("app never settled");
};
await waitIdle();

const apply = (op) => page.evaluate((o) => window.__openpoly.apply(o), op);
const read = (q) => page.evaluate((o) => window.__openpoly.read(o), q);
const shot = () => page.evaluate(() => window.__openpoly.screenshot("front"));

let failures = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}: ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

// A box gives two perpendicular faces at every rim edge, so the bevel angle is
// unambiguous: `size` along the reference face, size*tan(angle) along the other.
const box = await apply({ op: "addPrimitive", kind: "box", params: { width: 40, depth: 40, height: 40 } });
check("box created", box.ok, JSON.stringify(box).slice(0, 200));
const boxId = box.createdId;
await waitIdle();

const scene = await read({ read: "sceneSummary" });
const edge = (scene.bodies.find((b) => b.id === boxId)?.edges ?? []).find((e) => e.includes("+z") && e.includes("+x"));
check("a top rim edge is named", Boolean(edge), JSON.stringify(scene.bodies[0]?.edges));

// --- 1. Symmetric (default) vs. angled ------------------------------------
const ch = await apply({ op: "dressUp", kind: "chamfer", targetId: boxId, edges: [edge], size: "8" });
check("default chamfer (no angle) builds", ch.ok, JSON.stringify(ch).slice(0, 200));
await waitIdle();
const at45 = await shot();

const chId = ch.createdId;
const setAngle = async (deg) => {
  const r = await apply({ op: "setParam", featureId: chId, name: "angle", value: String(deg) });
  await waitIdle();
  return r;
};
const setFlip = async (on) => {
  // `flip` is a boolean param, set through the same string-valued setter the
  // parameter panel uses.
  const r = await apply({ op: "setParam", featureId: chId, name: "flip", value: on ? "true" : "false" });
  await waitIdle();
  return r;
};

check("setting angle=45 explicitly is accepted", (await setAngle(45)).ok);
const at45Explicit = await shot();
check("45° explicit renders identically to the default chamfer", at45Explicit === at45);

check("setting angle=20 is accepted", (await setAngle(20)).ok);
const at20 = await shot();
check("a 20° chamfer renders differently from 45°", at20 !== at45);

// --- 2. Flip mirrors the bevel (and is a no-op at 45°) --------------------
check("setting flip is accepted", (await setFlip(true)).ok);
const at20Flipped = await shot();
check("flipping a 20° chamfer changes the result", at20Flipped !== at20);

await setAngle(45);
const at45Flipped = await shot();
check("flipping a 45° chamfer changes nothing (it's symmetric)", at45Flipped === at45);
await setFlip(false);

// --- 3. An unbuildable angle fails, with the dress-up error copy ----------
await setAngle(20);
const steep = await apply({ op: "setParam", featureId: chId, name: "angle", value: "120" });
await waitIdle({ allowError: true });
const errText =
  (await page
    .locator(".params .error, .row-badge.error")
    .first()
    .textContent()
    .catch(() => null)) ?? "";
const docNow = await read({ read: "document" });
check(
  "an out-of-range angle is reported, not silently built",
  !steep.ok || /between 0 and 90/.test(JSON.stringify(steep)) || /between 0 and 90/.test(errText),
  JSON.stringify({ steep, errText }).slice(0, 300),
);
check(
  "the rejected angle is still what the document stores (so it's editable)",
  docNow.features.find((f) => f.id === chId)?.angle === "120",
);
await setAngle(20);

// --- 4. The angle drives off a variable, like every other parameter -------
check("variable created", (await apply({ op: "setVariable", name: "draft", expression: "20" })).ok);
check(
  "angle accepts an expression",
  (await apply({ op: "setParam", featureId: chId, name: "angle", value: "draft" })).ok,
);
await waitIdle();
check("angle=draft(20) matches the literal 20° build", (await shot()) === at20);

check(
  "angle re-drives when the variable changes",
  (await apply({ op: "setVariable", name: "draft", expression: "35" })).ok,
);
await waitIdle();
check("a 35° build differs from the 20° one", (await shot()) !== at20);

await page.screenshot({ path: "/tmp/openpoly-chamfer-angle.png" });
console.log(failures === 0 ? "=== ALL CHECKS PASSED ===" : `=== ${failures} CHECK(S) FAILED ===`);
console.log("screenshot: /tmp/openpoly-chamfer-angle.png");
await browser.close();
process.exit(failures === 0 ? 0 : 1);
