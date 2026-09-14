// The extrude distance gizmo still drags BOTH ways after the backward arrow
// was removed (dropBackwardArrow in Viewport.tsx).
//
// TransformControls draws two arrows per translate axis and gives each its own
// invisible pick cone. Deleting the backward pair is cosmetic only *if* the
// forward cone still drives negative distances — dragging the one arrow back
// through the profile has to keep working, or the removal cost a real control.
//
// Run: `npm run dev`, then `URL=http://localhost:5173/ node scripts/verify-extrude-gizmo.mjs`.
import { launch, openPoly } from "./lib/harness.mjs";

const { page, close } = await launch({ collectErrors: false, width: 1400, height: 900 });
const { waitIdle, apply, read } = openPoly(page);
await waitIdle();

let failures = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}: ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

// --- A sketch on the box's top face, then the Extrude dialog + gizmo --------
const scene = await read({ read: "sceneSummary" });
const box = scene.bodies[0];
const top = box.faces.find((f) => f.includes("+z"));
check("starting box has a named top face", Boolean(top), String(top));
const sk = await apply({
  op: "addSketch",
  plane: { bodyId: box.id, faceName: top },
  entities: [{ shape: "rect", center: [0, 0], w: 16, h: 16 }],
  name: "Top",
});
await waitIdle();
const scene2 = await read({ read: "sceneSummary" });
const region = scene2.sketches.find((s) => s.id === sk.createdId).regions[0].id;
await apply({ op: "select", refs: [{ kind: "sketchFace", sketchId: sk.createdId, regionId: region }] });
await page.waitForTimeout(400);
await page.keyboard.press("e");

const dialog = page.locator(".extrude-dialog");
await dialog.waitFor({ state: "visible", timeout: 5000 });
const distanceInput = dialog.locator("input").first();
check("extrude dialog opened with a distance", (await distanceInput.inputValue()).trim().length > 0);

// Move the dialog clear of the gizmo so the drags land on the canvas.
const handle = dialog.locator("[data-drag-handle]").first();
const hb = await handle.boundingBox();
await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
await page.mouse.down();
await page.mouse.move(1230, 800, { steps: 10 });
await page.mouse.up();
await page.waitForTimeout(300);

const distance = async () => Number((await distanceInput.inputValue()).trim());
const flipped = async () => dialog.locator(".ed-flip input[type=checkbox]").isChecked();
const start = await distance();
check("the extrude starts un-flipped", (await flipped()) === false);

// The forward pick cone runs from the proxy (the extrude tip) up to the arrow;
// grabbing the shaft mid-way is well inside it.
const GRAB = { x: 843, y: 285 };
const drag = async (dy) => {
  await page.mouse.move(GRAB.x, GRAB.y);
  await page.mouse.down();
  // Several steps: TransformControls integrates pointer movement, and one jump
  // can be discarded as a click.
  for (let i = 1; i <= 12; i++) await page.mouse.move(GRAB.x, GRAB.y + (dy * i) / 12);
  await page.mouse.up();
  await page.waitForTimeout(600);
  // The handle follows the pointer 1:1, so the shaft is now where the drag
  // ended. Grabbing the old spot again would miss it entirely.
  GRAB.y += dy;
};

// --- 1. Dragging the one arrow AWAY grows the extrude ----------------------
await drag(-90); // up the screen = along +Z here
const grown = await distance();
check("dragging the arrow away increases the distance", grown > start, `${start} -> ${grown}`);

// --- 2. Dragging it BACK through the profile reaches the other side --------
// The case the removed arrow used to stand for, and the reason removing it is
// safe: the one remaining arrow still reaches both sides. Note the app models
// "the other side" as a DIRECTION FLIP with a positive distance (see
// emitExtrudeDistance), not as a negative number — so that's what to assert.
await drag(260);
const reversed = await distance();
check(
  "dragging the same arrow back past the profile flips to the other side",
  await flipped(),
  `flip=${await flipped()}`,
);
check("…with a real distance on that side", reversed > 0 && Number.isFinite(reversed), `${grown} -> ${reversed}`);

// --- 3. The dialog and the gizmo still agree -------------------------------
await dialog.getByRole("button", { name: "Create" }).click();
await waitIdle();
const doc = await read({ read: "document" });
const ext = doc.features.filter((f) => f.type === "extrude").at(-1);
check("the extrude committed", Boolean(ext), JSON.stringify(ext?.id));
check(
  "…at the distance the gizmo was left at",
  Math.abs(Number(ext?.distance) - reversed) < 1e-6,
  `feature=${ext?.distance} gizmo=${reversed}`,
);
check("…and on the side the gizmo was dragged to", ext?.flip === true, `flip=${ext?.flip}`);
const after = await read({ read: "sceneSummary" });
check("no feature errored", Object.keys(after.errors ?? {}).length === 0, JSON.stringify(after.errors));

console.log(failures === 0 ? "=== ALL CHECKS PASSED ===" : `=== ${failures} CHECK(S) FAILED ===`);
await close();
process.exit(failures === 0 ? 0 : 1);
