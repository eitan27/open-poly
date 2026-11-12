// Assemblies: a value typed into a mate inside a loop group drives it, and an
// expression in its way is cleared only after the user confirms. A base and
// an arm held by a revolute (its angle the variable `angle`) and a planar on
// the same faces — two mates on one pair, a loop. Typing the planar's angle
// in the Mate dialog asks to clear `angle` (Cancel changes nothing, Continue
// turns the arm); a rotation typed into the Move panel takes the drag's path
// and asks the same. Built through the agent bridge for speed; the edits are
// the UI's. NB if the local open-poly MCP hub is running, this headless tab
// connects to it and can take the bridge from your own tab; reload yours after.
import { chromium } from "playwright";

const URL = process.env.URL ?? "http://localhost:5173/";
const browser = await chromium.launch(process.env.PW_EXE ? { executablePath: process.env.PW_EXE } : {});
const context = await browser.newContext({ viewport: { width: 1660, height: 920 }, deviceScaleFactor: 2 });
const page = await context.newPage();
page.on("pageerror", (e) => console.log(`[pageerror] ${e.message}`));
await page.goto(URL, { waitUntil: "domcontentloaded" });

const waitIdle = async () => {
  let stable = 0;
  for (let i = 0; i < 120; i++) {
    const s = (await page.locator(".status").textContent())?.trim() ?? "";
    stable = /up to date|error/i.test(s) ? stable + 1 : 0;
    if (stable >= 3) return;
    await page.waitForTimeout(300);
  }
  throw new Error("app never settled");
};
await waitIdle();
await page.waitForFunction(() => window.__openpoly);
/** Click `target` to switch documents, then wait for the switch to land: it
 *  comes a few hundred ms after the click, while the status still reads "up
 *  to date", so without this the next step acts on the previous document. */
const switchVia = async (target) => {
  const was = await page.locator(".doc-title").inputValue();
  await target.click();
  await page.waitForFunction((t) => document.querySelector(".doc-title")?.value !== t, was, { timeout: 10000 });
  await waitIdle();
};

let failures = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}: ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};
const apply = (op) => page.evaluate((o) => window.__openpoly.apply(o), op);
const read = (q) => page.evaluate((x) => window.__openpoly.read(x), q);
const summary = () => read({ read: "sceneSummary" });

const doc0 = await read({ read: "document" });
for (const f of [...doc0.features].reverse()) await apply({ op: "delete", featureId: f.id });
await apply({ op: "renameDocument", name: "LoopBase" });
await apply({ op: "addPrimitive", kind: "box", params: { width: "40", depth: "40", height: "10" } });
await apply({ op: "newDocument", name: "LoopArm" });
await apply({ op: "addPrimitive", kind: "box", params: { width: "30", depth: "8", height: "4" } });
await waitIdle();
await apply({ op: "newDocument", name: "LoopInput", kind: "assembly" });
await waitIdle();
const docs = await read({ read: "documents" });
const idOf = (name) => docs.find((d) => d.name === name)?.id;
await apply({ op: "insertInstance", documentId: idOf("LoopBase") });
await apply({ op: "insertInstance", documentId: idOf("LoopArm"), name: "Arm" });
let s = await summary();
const [base, arm] = s.instances;
const faces = (inst) => s.parts.find((p) => p.key === inst.part).faces;
const top = faces(base).find((f) => f.endsWith("/+z"));
const bottom = faces(arm).find((f) => f.endsWith("/-z"));
await apply({ op: "setVariable", name: "angle", expression: "10" });
const rev = await apply({
  op: "addMate",
  type: "revolute",
  a: { instanceId: base.id, face: top },
  b: { instanceId: arm.id, face: bottom },
  values: { rz: "angle" },
});
const pl = await apply({
  op: "addMate",
  type: "planar",
  a: { instanceId: base.id, face: top },
  b: { instanceId: arm.id, face: bottom },
});
s = await summary();
check(
  "a revolute and a planar on one pair make a loop",
  rev.ok && pl.ok && s.loops.length === 1,
  JSON.stringify(s.loops),
);
const angleOf = (sum, id) => sum.mates.find((m) => m.id === id).free.find((f) => f.dof === "rz");
const armTurn = async () => {
  const d = await read({ read: "document" });
  const t = d.instances.find((i) => i.id === arm.id).transform;
  return (Math.atan2(t[1], t[0]) * 180) / Math.PI;
};
const turn0 = await armTurn();
check("the arm sits at the variable's 10°", Math.abs(turn0 - 10) < 0.05, turn0.toFixed(2));

// --- The Mate dialog: type the planar's angle ------------------------------------------
const typeInDialog = async (text) => {
  await page.locator(".asm-mate-row").nth(1).click();
  await page.locator(".asm-mate").waitFor();
  const f = page.locator(".asm-mate .asm-mate-dof .ed-field", { hasText: "Angle" }).locator("input");
  await f.fill(text);
  await page.waitForTimeout(200);
  await page.locator(".asm-mate .ed-primary").click();
};
await typeInDialog("40");
await page.locator(".confirm-dialog").waitFor({ timeout: 5000 });
const msg = await page.locator(".confirm-message").textContent();
check(
  "typing the planar's angle asks to clear `angle`, naming where it is",
  /To set the Angle of Planar 1 .* to 40°, the expression `angle` on the Angle of Revolute 1 .* will be cleared/.test(
    msg,
  ),
  msg,
);
if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/loop-confirm.png` });
await page.locator(".confirm-cancel").click();
await page.waitForTimeout(500);
s = await summary();
check(
  "Cancel changes nothing",
  angleOf(s, rev.createdId).expression === "angle" && Math.abs((await armTurn()) - 10) < 0.05,
  `${angleOf(s, rev.createdId).expression}, ${(await armTurn()).toFixed(2)}`,
);
check("…and leaves the Mate dialog open to try again", (await page.locator(".asm-mate").count()) === 1);
await page.locator(".asm-mate .ed-primary").click();
await page.locator(".confirm-continue").click();
await page.waitForTimeout(800);
s = await summary();
check(
  "Continue clears it and turns the arm to 40°",
  angleOf(s, rev.createdId).expression === undefined &&
    Math.abs(angleOf(s, rev.createdId).value - 40) < 0.05 &&
    Math.abs((await armTurn()) - 40) < 0.05,
  `${JSON.stringify(angleOf(s, rev.createdId))}, arm ${(await armTurn()).toFixed(2)}`,
);
check("…closing the dialog", (await page.locator(".asm-mate").count()) === 0);

// --- Ctrl+Z puts the expression back, in one step -----------------------------------------
await page
  .locator(".viewport canvas")
  .first()
  .hover({ position: { x: 5, y: 5 } });
await page.keyboard.press("Control+z");
await page.waitForTimeout(500);
s = await summary();
check(
  "Ctrl+Z undoes it in one step",
  angleOf(s, rev.createdId).expression === "angle" && Math.abs((await armTurn()) - 10) < 0.05,
);

// --- A typed rotation in the Move panel: the drag's path ------------------------------------
await page.locator(".asm-row").nth(1).click();
await page.waitForTimeout(300);
await page.locator(".asm-move .ed-modes button", { hasText: "Rotate" }).click();
await page.waitForTimeout(200);
const angleField = page.locator(".asm-move .ed-field", { hasText: "Angle" }).locator("input");
const typeAngle = async (text) => {
  await angleField.click();
  await angleField.fill(text);
  await angleField.press("Enter");
};
await typeAngle("25");
await page.locator(".confirm-dialog").waitFor({ timeout: 5000 });
check(
  "turning the arm asks to clear `angle` too",
  /To move Arm there, the expression `angle` on the Angle of Revolute 1/.test(
    await page.locator(".confirm-message").textContent(),
  ),
);
await page.keyboard.press("Escape");
await page.waitForTimeout(500);
check(
  "Esc cancels: nothing moved",
  (await page.locator(".confirm-dialog").count()) === 0 &&
    Math.abs((await armTurn()) - 10) < 0.05 &&
    (await summary()).mates.find((m) => m.id === rev.createdId).free[0].expression === "angle",
);
await typeAngle("25");
await page.locator(".confirm-continue").click();
await page.waitForTimeout(800);
s = await summary();
check(
  "Continue turns it, the angle now a plain number",
  Math.abs((await armTurn()) - 35) < 0.5 && angleOf(s, rev.createdId).expression === undefined,
  `arm ${(await armTurn()).toFixed(2)}, ${JSON.stringify(angleOf(s, rev.createdId))}`,
);

console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL PASS");
await browser.close();
process.exit(failures ? 1 : 0);
