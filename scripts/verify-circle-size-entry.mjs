// Typing a circle's size while drawing it (issue #16).
//
// Once the centre of a centre+radius circle is down, a size field rides beside
// the cursor: focused, ringed in the accent colour, showing the live size as
// grey placeholder text. Typing fixes the size, Tab swaps R ↔ Ø, Enter (or a
// click) places the circle WITH a driving size dimension, Esc clears the typed
// value and then the centre.
//
// Checks:
//   1. after the centre click the field appears, is focused, and shows the live
//      size (in the default Ø) as a placeholder — with the Tab hint
//   2. typed Ø + Enter → a circle of half that radius + a `diameter` constraint
//   3. Tab → R; typed R + Enter → that radius + a `radius` constraint
//   4. a typed size wins over where a click lands
//   5. a variable typed in stays linked
//   6. Esc clears the typed value (field stays), a second Esc drops the centre
//   7. moving the mouse with nothing typed still sizes by the cursor (unchanged)
//   8. typing a letter doesn't switch tools (it goes into the field)
import { launch, openPoly } from "./lib/harness.mjs";

const { page, close } = await launch({ collectErrors: false });
const { waitIdle, apply, read } = openPoly(page);

let failures = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};
const settle = async () => {
  await waitIdle();
  await page.waitForTimeout(400);
  await waitIdle();
};

await waitIdle();
await apply({ op: "setVariable", name: "bore", expression: "14" });
// A sketch on Top with one far-away line, so there's a sketch to edit.
const sk = await apply({
  op: "addSketch",
  plane: { datum: "top" },
  entities: [{ shape: "line", a: [200, 200], b: [210, 200] }],
});
await settle();
const sketchId = sk.createdId;
await page.locator(".tree-row", { hasText: "Sketch" }).last().dblclick();
await page.waitForTimeout(800);

const canvas = await page.locator("canvas").first().boundingBox();
const toScreen = async (w) => {
  const p = await page.evaluate((q) => window.__openpoly.worldToScreen(q), w);
  return [canvas.x + p.x, canvas.y + p.y];
};
const moveTo = async (w) => {
  const [x, y] = await toScreen(w);
  await page.mouse.move(x, y, { steps: 4 });
  await page.waitForTimeout(120);
};
const clickAt = async (w) => {
  await moveTo(w);
  const [x, y] = await toScreen(w);
  await page.mouse.click(x, y);
  await page.waitForTimeout(250);
};
const circles = async () =>
  (await read({ read: "document" })).features
    .find((f) => f.id === sketchId)
    .entities.filter((e) => e.type === "circle");
const sizeCon = async (entId) =>
  (await read({ read: "document" })).features
    .find((f) => f.id === sketchId)
    .constraints.find((c) => (c.type === "radius" || c.type === "diameter") && c.entity === entId);
const field = page.locator('[data-testid="circle-size-field"]');
const input = field.locator("input");
const startCircle = async (centre) => {
  await page.evaluate(() => document.activeElement?.blur());
  await page.keyboard.press("c");
  await page.waitForTimeout(150);
  await clickAt(centre);
  await moveTo([centre[0] + 6, centre[1], 0]);
};

// --- 1. the field appears, focused, with the live size as placeholder -------
await startCircle([0, 0, 0]);
check("the size field appears after the centre click", (await field.count()) === 1);
const focused = await page.evaluate(() => document.activeElement?.closest('[data-testid="circle-size-field"]') != null);
check("and it has the keyboard", focused);
const ph = await input.getAttribute("placeholder");
check("the placeholder is the live diameter", Math.abs(parseFloat(ph) - 12) < 1.5, `placeholder=${ph} (want ≈12)`);
check("with an empty value (grey placeholder, not a typed value)", (await input.inputValue()) === "");
check("it says Ø", (await field.locator(".draft-size-kind").textContent()) === "Ø");
const hint = await field.locator(".draft-size-hint").textContent();
check("the hint explains Tab", /Tab/.test(hint) && /Ø → R/.test(hint), hint);
{
  const b = await field.boundingBox();
  await page.screenshot({
    path: "/tmp/circle-size-idle.png",
    clip: { x: b.x - 160, y: b.y - 60, width: 360, height: 180 },
  });
}

// --- 2. Ø + Enter --------------------------------------------------------
await page.keyboard.type("30");
await page.waitForTimeout(150);
check(
  "after typing, the hint switches to Enter/Esc",
  /Enter/.test(await field.locator(".draft-size-hint").textContent()),
);
{
  const b = await field.boundingBox();
  await page.screenshot({
    path: "/tmp/circle-size-typed.png",
    clip: { x: b.x - 160, y: b.y - 60, width: 360, height: 180 },
  });
}
await page.keyboard.press("Enter");
await settle();
let cs = await circles();
check("Enter places one circle", cs.length === 1, `circles=${cs.length}`);
check("Ø30 → r=15", cs[0] && Math.abs(cs[0].r - 15) < 1e-6, `r=${cs[0]?.r}`);
let con = cs[0] && (await sizeCon(cs[0].id));
check("with a diameter=30 constraint", con?.type === "diameter" && con.value === 30, JSON.stringify(con));
check("and the field is gone", (await field.count()) === 0);

// --- 3. Tab → R ----------------------------------------------------------
await startCircle([40, 0, 0]);
await page.keyboard.press("Tab");
await page.waitForTimeout(100);
check("Tab switches to R", (await field.locator(".draft-size-kind").textContent()) === "R");
const phR = await input.getAttribute("placeholder");
check("and the placeholder becomes the live radius", Math.abs(parseFloat(phR) - 6) < 1, `placeholder=${phR}`);
await page.keyboard.type("12");
await page.keyboard.press("Enter");
await settle();
cs = await circles();
const c3 = cs.find((c) => Math.abs(c.c[0] - 40) < 1);
check("R12 → r=12", c3 && Math.abs(c3.r - 12) < 1e-6, `r=${c3?.r}`);
con = c3 && (await sizeCon(c3.id));
check("with a radius=12 constraint", con?.type === "radius" && con.value === 12, JSON.stringify(con));

// --- 4. typed size wins over the click ------------------------------------
await startCircle([0, 50, 0]); // R is remembered from the last circle
await page.keyboard.type("5");
await clickAt([0 + 20, 50, 0]); // a click 20 away
await settle();
const c4 = (await circles()).find((c) => Math.abs(c.c[1] - 50) < 1);
check("a click places the TYPED size, not the click's", c4 && Math.abs(c4.r - 5) < 1e-6, `r=${c4?.r}`);

// --- 5. a variable stays linked -------------------------------------------
await startCircle([40, 50, 0]);
await page.keyboard.press("Tab"); // back to Ø
await page.keyboard.type("bore");
await page.waitForTimeout(100);
// "bore" is fully typed, so there's no suggestion pending — Enter commits.
await page.keyboard.press("Enter");
await settle();
const c5 = (await circles()).find((c) => Math.abs(c.c[0] - 40) < 1 && Math.abs(c.c[1] - 50) < 1);
con = c5 && (await sizeCon(c5.id));
check("Ø bore → r=7", c5 && Math.abs(c5.r - 7) < 1e-6, `r=${c5?.r}`);
check("linked to the variable", con?.type === "diameter" && con.expr === "bore", JSON.stringify(con));

// --- 6. Esc clears, then cancels ------------------------------------------
const before = (await circles()).length;
await startCircle([-40, 0, 0]);
await page.keyboard.type("9");
await page.keyboard.press("Escape");
await page.waitForTimeout(150);
check("first Esc clears the typed value", (await field.count()) === 1 && (await input.inputValue()) === "");
await page.keyboard.press("Escape");
await page.waitForTimeout(150);
check("second Esc drops the centre", (await field.count()) === 0);
check("and no circle was made", (await circles()).length === before);

// --- 7. untouched: cursor sizes the circle ---------------------------------
await startCircle([-40, 40, 0]);
await clickAt([-40 + 8, 40, 0]);
await settle();
const c7 = (await circles()).find((c) => Math.abs(c.c[0] + 40) < 1 && Math.abs(c.c[1] - 40) < 1);
check("with nothing typed, the click sets the size", c7 && Math.abs(c7.r - 8) < 0.6, `r=${c7?.r}`);
check("and adds no size constraint", c7 && !(await sizeCon(c7.id)));

// --- 8. letters go to the field, not the shortcuts -------------------------
await startCircle([0, -40, 0]);
await page.keyboard.type("s");
await page.waitForTimeout(150);
check(
  "typing 's' stays in the field (tool not switched)",
  (await field.count()) === 1 && (await input.inputValue()) === "s",
);
await page.keyboard.press("Escape");
await page.keyboard.press("Escape");

await close();
console.log(failures ? `\n${failures} FAILED` : "\nall passed");
process.exit(failures ? 1 : 0);
